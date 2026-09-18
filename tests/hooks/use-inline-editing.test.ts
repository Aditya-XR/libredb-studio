import "../setup-dom";
import { mockToastSuccess, mockToastError } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { restoreGlobalFetch } from "../helpers/mock-fetch";

import { useInlineEditing } from "@/hooks/use-inline-editing";
import type { DatabaseConnection, QueryTab, QueryResult } from "@/lib/types";
import type { CellChange } from "@/components/ResultsGrid";

// ── Test Data ───────────────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "conn-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
  user: "admin",
  password: "secret",
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

const makeResult = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  rows: [
    { id: 1, name: "Alice", email: "alice@test.com" },
    { id: 2, name: "Bob", email: "bob@test.com" },
  ],
  fields: ["id", "name", "email"],
  rowCount: 2,
  executionTime: 12,
  ...overrides,
});

const makeTab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  name: "users",
  query: "SELECT * FROM users",
  result: makeResult(),
  isExecuting: false,
  type: "sql",
  ...overrides,
});

const makeChange = (overrides: Partial<CellChange> = {}): CellChange => ({
  rowIndex: 0,
  columnId: "name",
  originalValue: "Alice",
  newValue: "Alice Updated",
  ...overrides,
});

// =============================================================================
// useInlineEditing Tests
// =============================================================================
describe("useInlineEditing", () => {
  let mockExecuteQuery: ReturnType<typeof mock>;

  beforeEach(() => {
    mockExecuteQuery = mock(() => {});
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  /**
   * The calls carrying a generated UPDATE. A successful apply ends by re-running the
   * tab's own query, so the raw call list holds one extra entry that is not a row.
   */
  const updateCalls = () =>
    (mockExecuteQuery as ReturnType<typeof mock>).mock.calls.filter((call) => String(call[0]).startsWith("UPDATE"));

  // ── Initial State ─────────────────────────────────────────────────────────

  test("initially editingEnabled is false and pendingChanges is empty", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    expect(result.current.editingEnabled).toBe(false);
    expect(result.current.pendingChanges).toEqual([]);
  });

  // ── handleCellChange adds a change ────────────────────────────────────────

  test("handleCellChange adds a change", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.pendingChanges[0].columnId).toBe("name");
    expect(result.current.pendingChanges[0].newValue).toBe("Alice Updated");
  });

  // ── handleCellChange replaces existing change for same cell ───────────────

  test("handleCellChange replaces existing change for same cell", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "First edit" }));
    });

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Second edit" }));
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.pendingChanges[0].newValue).toBe("Second edit");
  });

  // ── handleCellChange removes change when reverting to original ────────────

  test("handleCellChange removes change when reverting to original value", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Add a change first
    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Edited" }));
    });

    expect(result.current.pendingChanges).toHaveLength(1);

    // Revert to original value
    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Alice" }));
    });

    expect(result.current.pendingChanges).toHaveLength(0);
  });

  // ── handleCellChange ignores no-op change ─────────────────────────────────

  test("handleCellChange ignores no-op change", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Try to add a "change" where newValue equals originalValue
    act(() => {
      result.current.handleCellChange(
        makeChange({
          originalValue: "Alice",
          newValue: "Alice",
        }),
      );
    });

    expect(result.current.pendingChanges).toHaveLength(0);
  });

  // ── handleApplyChanges generates UPDATE SQL ───────────────────────────────

  test("handleApplyChanges generates UPDATE SQL and calls executeQuery", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Add a pending change
    act(() => {
      result.current.handleCellChange(
        makeChange({
          rowIndex: 0,
          columnId: "name",
          originalValue: "Alice",
          newValue: "Alice Updated",
        }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    // One call for the edited row, then one more that re-runs the tab's own query: the
    // UPDATE wrote its own empty result over the grid, so the rows are read back (#883).
    expect(mockExecuteQuery).toHaveBeenCalledTimes(2);
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[1][0]).toBe("SELECT * FROM users");

    const sql = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sql).toContain("UPDATE");
    expect(sql).toContain("users");
    // Column identifiers are quoted (PR #289 review): a result field is named by
    // whatever the query aliased it to, so it reaches SQL as arbitrary text. Values
    // are bound rather than quoted (#290), so the statement carries placeholders.
    expect(sql).toContain(`"name" = $1`);
    expect(sql).toContain(`WHERE "id" = $2`);
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[0][3]).toEqual({
      skipSafety: true,
      params: ["Alice Updated", 1],
    });

    // Changes should be cleared after apply
    expect(result.current.pendingChanges).toEqual([]);
    expect(result.current.editingEnabled).toBe(false);
  });
  test("takes the table from the query, whatever the tab is called", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          name: "Query 2",
          query: "SELECT id, name, category FROM products ORDER BY id",
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({
          columnId: "name",
          originalValue: "Alice",
          newValue: "Alice Updated",
        }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(1);

    const sql = updateCalls()[0][0] as string;
    expect(sql).toContain("UPDATE products");
  });
  // ── handleApplyChanges one request per edited row (#269) ──────────────────

  test("handleApplyChanges executes one statement per edited row, never a joined payload", async () => {
    // A joined payload reaches the engine as one string whenever a transaction or
    // sandbox run is active, and it makes a failure unattributable to a row even on
    // the split path. Each row is therefore sent on its own, without the trailing
    // semicolon that only ever served to join them — `splitStatements` used to strip
    // it on the multi-statement route, and oracledb rejects a plain statement that
    // carries one.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(2);

    const sent = updateCalls().map((call) => call[0] as string);
    for (const sql of sent) {
      expect(sql).not.toContain("\n");
      expect(sql.match(/UPDATE/g)).toHaveLength(1);
      expect(sql.endsWith(";")).toBe(false);
    }
    expect(sent[0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    expect(sent[1]).toBe(`UPDATE users SET "email" = $1 WHERE "id" = $2`);
    // Each row carries its own parameters, so a shared statement text is not a
    // shared payload: placeholder numbering restarts per request.
    const options = updateCalls().map((call) => call[3]);
    expect(options[0]).toEqual({ skipSafety: true, params: ["Alice Updated", 1] });
    expect(options[1]).toEqual({ skipSafety: true, params: ["bob@new.test", 2] });
  });

  test("handleApplyChanges runs each row past the safety dialog, so every row is applied", async () => {
    // useQueryExecution's safety gate returns WITHOUT executing for any
    // `UPDATE ... SET` and only remembers the last query it was handed, so an
    // unflagged per-row loop would apply nothing but the row the user then
    // confirms. Apply is itself the confirmation here: the statements are
    // generated, single-row and primary-key scoped, and the pending changes were
    // reviewed in the grid before the click.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "Bob Updated" }),
      );
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const calls = updateCalls();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect((call[3] as { skipSafety?: boolean }).skipSafety).toBe(true);
    }
  });

  test("handleApplyChanges awaits each row before sending the next", async () => {
    // executeQuery mutates the active tab's result and isExecuting, so concurrent
    // calls would race on that state; the order below is what proves it is
    // sequential rather than fired in parallel.
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const sequential = mock((sql: string) => {
      order.push(`start:${sql}`);
      if (!resolveFirst) {
        return new Promise<void>((resolve) => {
          resolveFirst = () => {
            order.push(`end:${sql}`);
            resolve();
          };
        });
      }
      order.push(`end:${sql}`);
      return Promise.resolve();
    });

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: sequential,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "A2" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "B2" }),
      );
    });

    let applied: Promise<void> | undefined;
    await act(async () => {
      applied = result.current.handleApplyChanges();
      await Promise.resolve();
    });

    // The second row must not have been sent while the first is still in flight.
    expect(order).toEqual([`start:UPDATE users SET "name" = $1 WHERE "id" = $2`]);

    await act(async () => {
      resolveFirst?.();
      await applied;
    });

    expect(order).toEqual([
      `start:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `end:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `start:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `end:UPDATE users SET "name" = $1 WHERE "id" = $2`,
      // The grid refresh is awaited too, after the last row and never beside it.
      "start:SELECT * FROM users",
      "end:SELECT * FROM users",
    ]);
  });

  // ── handleApplyChanges no primary key ─────────────────────────────────────

  test("handleApplyChanges shows toast when no primary key column found", async () => {
    const tabNoPk = makeTab({
      result: makeResult({
        fields: ["name", "email"], // No 'id' or '*_id' column
        rows: [{ name: "Alice", email: "alice@test.com" }],
      }),
    });

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: tabNoPk,
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange({
        rowIndex: 0,
        columnId: "name",
        originalValue: "Alice",
        newValue: "Bob",
      });
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("No primary key column detected"),
    });
  });

  // ── handleApplyChanges no active connection ───────────────────────────────

  test("handleApplyChanges does nothing when no active connection", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: null,
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  // ── handleApplyChanges empty pendingChanges ───────────────────────────────

  test("handleApplyChanges does nothing when pendingChanges is empty", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  // ── handleDiscardChanges ──────────────────────────────────────────────────

  test("handleDiscardChanges clears pendingChanges", () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    // Add some changes
    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: 0, columnId: "name", newValue: "X" }));
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "y@test.com" }),
      );
    });

    expect(result.current.pendingChanges.length).toBeGreaterThan(0);

    act(() => {
      result.current.handleDiscardChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
  });

  // ── Generated SQL must stay one statement (PR #289 review) ────────────────
  //
  // A result field is named by whatever the query aliased it to, so a column id is
  // arbitrary text that reaches the generated UPDATE as an identifier. Applying
  // edits skips the dangerous-query dialog, so nothing shows the user that SQL
  // first — the statement has to be inert by construction.

  test("quotes a column name that spells SQL instead of emitting it bare", async () => {
    const hostile = "x = 1; DELETE FROM users; --";
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({ fields: ["id", hostile], rows: [{ id: 1, [hostile]: "v" }] }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ columnId: hostile, originalValue: "v", newValue: "w" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()).toHaveLength(1);
    const sql = updateCalls()[0][0] as string;
    expect(sql).toBe(`UPDATE users SET "${hostile}" = $1 WHERE "id" = $2`);
    // Nothing outside the quoted identifier ends the statement.
    expect(sql.replace(/"[^"]*"/g, "")).not.toContain(";");
  });

  test("quotes an ordinary column name that needs quoting to be legal", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({
          result: makeResult({ fields: ["id", "first name"], rows: [{ id: 1, "first name": "Alice" }] }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ columnId: "first name", originalValue: "Alice", newValue: "Bob" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery.mock.calls[0][0]).toBe("UPDATE users SET `first name` = ? WHERE `id` = ?");
  });

  test("refuses to apply when the query names no table", async () => {
    // Unlike a column, the table name cannot be quoted safely: quoting a hand-typed
    // lowercase name would break Oracle, where the real table is upper-cased. So it is
    // validated as a bare identifier and refused when it is anything else. The hostile
    // tab name here is the #881 half: it is not consulted, so it cannot reach the SQL
    // even though the query offers no table of its own.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ name: "users; DROP TABLE users; --", query: "" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("accepts a schema-qualified table name", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ query: "SELECT * FROM public.users" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery.mock.calls[0][0]).toBe(`UPDATE public.users SET "name" = $1 WHERE "id" = $2`);
  });

  // ── Values are bound, not interpolated (#290) ─────────────────────────────
  //
  // The value half of the statement is arbitrary text — pasted, imported, or read
  // back from the table. Doubling the quote is enough only where a backslash is
  // data; MySQL reads `\'` as an escaped quote, so an interpolated value could
  // close its literal early and have the rest read as SQL. Applying edits skips
  // the dangerous-query dialog, so nothing shows that statement before it runs.

  test("binds the edited value in the placeholder form the dialect's driver expects", async () => {
    const cases: Array<{ type: DatabaseConnection["type"]; sql: string }> = [
      { type: "postgres", sql: `UPDATE users SET "name" = $1 WHERE "id" = $2` },
      { type: "mysql", sql: "UPDATE users SET `name` = ? WHERE `id` = ?" },
      { type: "sqlite", sql: `UPDATE users SET "name" = ? WHERE "id" = ?` },
      { type: "oracle", sql: `UPDATE users SET "name" = :1 WHERE "id" = :2` },
      { type: "mssql", sql: `UPDATE users SET [name] = @p1 WHERE [id] = @p2` },
    ];

    for (const { type, sql } of cases) {
      mockExecuteQuery.mockClear();
      const { result } = renderHook(() =>
        useInlineEditing({
          activeConnection: makeConnection({ type }),
          currentTab: makeTab(),
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      );

      act(() => {
        result.current.handleCellChange(makeChange({ newValue: "Alice Updated" }));
      });
      await act(async () => {
        await result.current.handleApplyChanges();
      });

      expect(mockExecuteQuery.mock.calls[0][0]).toBe(sql);
      expect(mockExecuteQuery.mock.calls[0][3]).toEqual({ skipSafety: true, params: ["Alice Updated", 1] });
    }
  });

  test("a backslash-escaping dialect cannot read the edited value as SQL", async () => {
    // The issue #290 payload: interpolated into a MySQL statement it closed the
    // literal early and `WHERE 1=1` became the real predicate, so every row in the
    // table was updated instead of the edited one.
    const payload = "\\' WHERE 1=1 -- ";
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: payload }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe("UPDATE users SET `name` = ? WHERE `id` = ?");
    expect(sql).not.toContain("1=1");
    expect(options).toEqual({ skipSafety: true, params: [payload, 1] });
  });

  test("binds a primary key value that is not a number instead of quoting it", async () => {
    // The key is read back from the result, so it carries whatever the table holds.
    // A natural key with a quote in it used to reach `WHERE id = '...'` with no
    // escaping at all — in every dialect, not only the backslash ones.
    const hostileKey = "x' OR '1'='1";
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({
            fields: ["id", "name"],
            rows: [{ id: hostileKey, name: "Alice" }],
          }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "Alice Updated" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    expect(options).toEqual({ skipSafety: true, params: ["Alice Updated", hostileKey] });
  });

  test("keeps NULL a keyword and numbers the remaining placeholders around it", async () => {
    // Clearing a cell means SQL NULL, which is a keyword rather than a value, so it
    // takes no parameter — and the placeholders that follow must not count it.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ columnId: "name", originalValue: "Alice", newValue: "" }));
      result.current.handleCellChange(
        makeChange({ columnId: "email", originalValue: "alice@test.com", newValue: "new@test.com" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe(`UPDATE users SET "name" = NULL, "email" = $1 WHERE "id" = $2`);
    expect(options).toEqual({ skipSafety: true, params: ["new@test.com", 1] });
  });

  test("quotes the value dialect-aware where the dialect has no positional bind form", async () => {
    // ClickHouse's provider refuses positional parameters outright, so a statement
    // built for it has to carry its values as literals — quoted the way ClickHouse
    // reads them, backslash included. Its `supportsInlineRowEdit` is false today, so
    // this is the guard that keeps issue #279 from re-opening #290 when a dialect
    // like it gains row editing.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "clickhouse" }),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "a\\'b" }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const [sql, , , options] = mockExecuteQuery.mock.calls[0];
    expect(sql).toBe(`UPDATE users SET "name" = 'a\\\\''b' WHERE "id" = 1`);
    expect(options).toEqual({ skipSafety: true });
  });

  // ── The tab title never steers the write (#881) ───────────────────────────
  //
  // A tab title is free text. It survives when the query in the tab is replaced, it is
  // not tied to the rows on screen, and renaming a tab is not a way anyone expects to
  // choose a write target. Where a title happened to name another real table carrying
  // the same key column, the UPDATE landed on that table and nothing said so.

  test("writes to the table the query reads, not the one the tab is named after", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        // The rows came from `users`; the tab is called `customers` because someone
        // renamed it, or because it was created for a query that has since been replaced.
        currentTab: makeTab({ name: "customers", query: "SELECT * FROM users" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()[0][0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
  });

  test("refuses rather than guessing when the rows have no single base table", async () => {
    // A joined result's cell may belong to either table, so there is no answer to give.
    // The tab title used to supply one anyway.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          name: "users",
          query: "SELECT u.id, u.name FROM users u JOIN orders o ON o.user_id = u.id",
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("reads to this editor as a second table"),
    });
    // The work stays on screen: nothing was written, so nothing is discarded.
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  // ── A refused write is not a successful one (#882) ────────────────────────
  //
  // `executeQuery` reports a failing statement to the user and returns; what it could
  // not do was tell the apply loop. So the loop cleared the pending changes, turned
  // editing off and said "Changes Applied" after a write the engine had rejected — the
  // edits were gone and the row was unchanged.

  test("keeps the edits and says so when every row fails", async () => {
    const failing = mock((_sql: string) => Promise.resolve(false));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: failing,
      }),
    );

    act(() => {
      result.current.setEditingEnabled(true);
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.editingEnabled).toBe(true);
    expect(mockToastSuccess).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Changes Not Applied", {
      description: expect.stringContaining("1 row could not be confirmed as saved"),
    });
    // Nothing is read back either: the grid still holds the rows the edits belong to.
    expect(failing.mock.calls.filter((call) => String(call[0]).startsWith("SELECT"))).toHaveLength(0);
  });

  test("re-reads the grid and drops the edits when only some rows applied", async () => {
    // The rows that DID apply have already written their own empty results over the grid,
    // so the rows the edits were positions into are gone. Carrying an index forward onto
    // a result this hook cannot see would put a retry's key on whatever row now sits at
    // that index — the wrong-row write #881 is about — so the refresh is what the user
    // gets instead, and the toast points at it.
    const secondRowFails = mock((sql: string) => Promise.resolve(!sql.includes("email")));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: secondRowFails,
      }),
    );

    act(() => {
      result.current.setEditingEnabled(true);
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
    // Editing stays on, so the failed row can be corrected straight away in the grid the
    // refresh just put back.
    expect(result.current.editingEnabled).toBe(true);
    expect(secondRowFails.mock.calls.map((call) => call[0])).toEqual([
      `UPDATE users SET "name" = $1 WHERE "id" = $2`,
      `UPDATE users SET "email" = $1 WHERE "id" = $2`,
      "SELECT * FROM users",
    ]);
    expect(mockToastError).toHaveBeenCalledWith("Some Changes Not Applied", {
      description: expect.stringContaining("1 of 2 rows could not be confirmed as saved"),
    });
  });

  test("treats a caller that reports nothing as the success it was before", async () => {
    // The outcome is new, so an implementation that returns void keeps the behaviour it
    // had: only an explicit refusal is read as a failure.
    const silent = mock(() => undefined);
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: silent,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
    expect(mockToastError).not.toHaveBeenCalled();
  });

  // ── The grid comes back after applying (#883) ─────────────────────────────
  //
  // Each UPDATE writes its own result into the tab as it runs, so by the time the loop
  // ends the rows the edits came from are gone and the user is left looking at the last
  // statement's empty result. Re-running the tab's own query puts them back, and shows
  // them as the engine now holds them.

  test("sends every UPDATE to the tab the edits came from", async () => {
    // Not to whichever tab happens to be active by the time a row answers: a user who
    // switches tabs mid-apply would otherwise have another tab's grid replaced by these
    // statements' empty results.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ id: "tab-7" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    for (const call of (mockExecuteQuery as ReturnType<typeof mock>).mock.calls) {
      expect(call[1]).toBe("tab-7");
    }
  });

  test("re-runs the tab's query after applying, and only after the last row", async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "A2" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "name", originalValue: "Bob", newValue: "B2" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    const sent = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls.map((call) => call[0] as string);
    expect(sent).toHaveLength(3);
    expect(sent[2]).toBe("SELECT * FROM users");
    // The refresh is an ordinary read: it carries no skipSafety and no parameters, so
    // it goes through the same path the Run button uses.
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[2][3]).toBeUndefined();
    // It goes to the tab the edits came from, not to whichever tab is active by then.
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[2][1]).toBe("tab-1");
    expect(mockToastSuccess).toHaveBeenCalledWith("Changes Applied", {
      description: "2 UPDATE statements accepted. The results are up to date.",
    });
  });

  test("does not re-run the query when a row was refused", async () => {
    const failing = mock((_sql: string) => Promise.resolve(false));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: failing,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(failing.mock.calls.map((call) => call[0] as string)).toEqual([
      `UPDATE users SET "name" = $1 WHERE "id" = $2`,
    ]);
  });

  test("does not claim a re-read that failed when only some rows applied", async () => {
    // Two things went wrong at once: a row was refused, and the read meant to show which
    // rows survived did not land either. Telling the user the results are up to date would
    // then be pointing at rows that are not.
    const rowAndRefreshFail = mock((sql: string) =>
      Promise.resolve(sql.startsWith("UPDATE") && !sql.includes("email")),
    );
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: rowAndRefreshFail,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "name", originalValue: "Alice", newValue: "Alice Updated" }),
      );
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockToastError).toHaveBeenCalledWith("Some Changes Not Applied", {
      description:
        "1 of 2 rows could not be confirmed as saved, and your edits have been cleared. " +
        "Run the query again to see what was saved.",
    });
  });

  test("says so when the rows applied but the grid could not be re-read", async () => {
    // The apply itself succeeded, so the success toast is the right one — but telling the
    // user the results are up to date would be false when the read that was meant to fetch
    // them did not land.
    const refreshFails = mock((sql: string) => Promise.resolve(sql.startsWith("UPDATE")));
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: refreshFails,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
    expect(result.current.editingEnabled).toBe(false);
    expect(mockToastSuccess).toHaveBeenCalledWith("Changes Applied", {
      description: "1 UPDATE statement accepted. Run the query again to see the saved rows.",
    });
  });

  test("reads the query under the connection's own dialect", async () => {
    // `#` opens a comment on MySQL and is an OPERATOR on PostgreSQL, so the same text is a
    // single-table read on one and a join on the other. PostgreSQL is the half that proves
    // the connection's type reached the reader: `#` opens a comment under the dialect-less
    // default too, so a MySQL fixture alone would still pass with the type dropped.
    const query = "SELECT * FROM users # JOIN orders\nWHERE id = 1";

    const mysql = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "mysql" }),
        currentTab: makeTab({ query, resultQuery: query }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );
    act(() => {
      mysql.result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await mysql.result.current.handleApplyChanges();
    });
    expect(updateCalls()[0][0]).toBe("UPDATE users SET `name` = ? WHERE `id` = ?");

    const postgres = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection({ type: "postgres" }),
        currentTab: makeTab({ id: "tab-2", query, resultQuery: query }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );
    act(() => {
      postgres.result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await postgres.result.current.handleApplyChanges();
    });
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("reads to this editor as a second table"),
    });
  });

  // ── The rows decide, not the buffer and not the tab (#881) ────────────────

  test("writes to the table the ROWS came from, not the text now in the editor", async () => {
    // `query` is the editor buffer and is rewritten on every keystroke, and a run may have
    // executed only a selection of it. Retyping the statement without running it used to
    // point the write at a table the displayed rows never came from — the same harm as a
    // renamed tab, reached by typing.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({ query: "SELECT * FROM orders", resultQuery: "SELECT * FROM users" }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()[0][0]).toBe(`UPDATE users SET "name" = $1 WHERE "id" = $2`);
    // The refresh re-runs that same statement too, so the grid it puts back is the one the
    // edits belonged to.
    expect((mockExecuteQuery as ReturnType<typeof mock>).mock.calls[1][0]).toBe("SELECT * FROM users");
  });

  test("refuses edits whose rows have been replaced under them", async () => {
    // Re-running the query is the ordinary thing to do after a failed apply, and it puts
    // different rows at the same indices. Measured before this guard: an edit typed into
    // the row whose key was 1 was written to the row whose key was 77, reported as applied.
    // The change carries what settles it — the cell's content when it was edited.
    const { result, rerender } = renderHook(
      (props: { tab: QueryTab }) =>
        useInlineEditing({
          activeConnection: makeConnection(),
          currentTab: props.tab,
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      { initialProps: { tab: makeTab() } },
    );

    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: 0, originalValue: "Alice", newValue: "Alice Updated" }));
    });

    // Same tab, same query - different rows.
    rerender({
      tab: makeTab({
        result: makeResult({ rows: [{ id: 77, name: "Carol", email: "carol@test.com" }], rowCount: 1 }),
      }),
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    // Kept, not cleared: every other refusal in this hook leaves the work on screen, the
    // check runs again on the next click, and Discard is how a user throws work away on
    // purpose.
    expect(result.current.pendingChanges).toHaveLength(1);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer on screen"),
    });
  });

  test("does not mistake a name on Object.prototype for the row's own value", async () => {
    // A driver that drops nulls leaves a declared column off the row object, and a column
    // named `constructor` or `toString` then resolves off the prototype instead of being
    // absent - which compared a function against the empty string and refused for ever,
    // with a message that was not true. The grid reads the cell with `Object.hasOwn`, so
    // this has to as well or the two are talking about different things.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab({
          result: makeResult({ fields: ["id", "constructor"], rows: [{ id: 1 }] }),
        }),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 0, columnId: "constructor", originalValue: null, newValue: "set" }),
      );
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(updateCalls()[0][0]).toBe(`UPDATE users SET "constructor" = $1 WHERE "id" = $2`);
  });

  test("refuses an edit whose row could not be placed at all", async () => {
    // `ResultsGrid` sends -1 when it cannot find the edited row in the result — a state it
    // argues is unreachable, and this is what happens if it ever is. -1 addresses no row,
    // so the apply refuses instead of writing somewhere by index.
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      }),
    );

    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: -1 }));
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer on screen"),
    });
  });

  test("refuses edits whose row is no longer there at all", async () => {
    // The re-read can also return FEWER rows, and reading the key out of a row that is not
    // there threw before this - nothing sent, nothing said.
    const { result, rerender } = renderHook(
      (props: { tab: QueryTab }) =>
        useInlineEditing({
          activeConnection: makeConnection(),
          currentTab: props.tab,
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      { initialProps: { tab: makeTab() } },
    );

    act(() => {
      result.current.handleCellChange(
        makeChange({ rowIndex: 1, columnId: "email", originalValue: "bob@test.com", newValue: "bob@new.test" }),
      );
    });

    rerender({ tab: makeTab({ result: makeResult({ rows: [{ id: 1, name: "Alice", email: "alice@test.com" }] }) }) });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.current.pendingChanges).toHaveLength(1);
  });

  test("refuses edits carried over from another tab", async () => {
    // Pending changes are not scoped to a tab, which is a defect older than this change:
    // it is reachable on main with no apply having happened. What this change owes is that
    // the rows a change was made on are checked before it is sent, and another tab's rows
    // do not hold this tab's values.
    const { result, rerender } = renderHook(
      (props: { tab: QueryTab }) =>
        useInlineEditing({
          activeConnection: makeConnection(),
          currentTab: props.tab,
          executeQuery: mockExecuteQuery as (sql: string) => void,
        }),
      { initialProps: { tab: makeTab() } },
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: "typed against users" }));
    });

    rerender({
      tab: makeTab({
        id: "tab-2",
        name: "orders",
        query: "SELECT * FROM orders",
        resultQuery: "SELECT * FROM orders",
        result: makeResult({
          rows: [{ id: 9, name: "Order nine", email: "nine@test.com" }],
          rowCount: 1,
        }),
      }),
    });
    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(result.current.pendingChanges).toHaveLength(1);
    expect(mockToastError).toHaveBeenCalledWith("Cannot Apply Changes", {
      description: expect.stringContaining("no longer on screen"),
    });
  });
});
