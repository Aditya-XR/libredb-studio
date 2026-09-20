import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import type { DatabaseConnection, QueryTab } from "@/lib/types";

/**
 * THE POINT OF #816, asserted directly: two pages over a seeded ordered table produce
 * DISJOINT row sets.
 *
 * Every other test in this change measures one seam. This one measures the whole path at
 * once, with as little doubled as the harness allows: a real SQLite database holding 121
 * ordered rows, the real `SQLiteProvider`, the real `POST /api/db/query` handler, and the
 * real hooks of BOTH products. Only the session, the connection resolution and the
 * provider cache are stubbed, because those are how the route reaches a provider and not
 * what it does with one.
 *
 * It exists because the two defects in the issue hid each other. The control was missing,
 * so nobody ever triggered the dropped offset behind it, and a suite of per-seam tests
 * could have passed with page two still being page one. The row ids are what tells the
 * difference, so the row ids are what this asserts.
 *
 * The two hooks are driven through one matrix, because they render in different products
 * — the standalone app and the embedded `StudioWorkspace` — and they are only kept in
 * step by being asked the same questions.
 */

// ─── The real route, over a real provider ───────────────────────────────────

const PAGE_SIZE = 50;
const SEEDED_ROWS = 121;

let provider: SQLiteProvider;

// The spread form, not a hand-written five-key stub: `src/lib/auth.ts` exports seven
// names and only one of them is being replaced here (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return { resolveConnection: mock(async (body: Record<string, unknown>) => body.connection), SeedConnectionError };
});

// Only `getOrCreateProvider` is replaced, and it hands back the REAL provider: the route's
// `prepareQuery`, the driver's `LIMIT n OFFSET m` and the engine's own answer all stay.
const dbModule = await import("@/lib/db");
mock.module("@/lib/db", () => ({ ...dbModule, getOrCreateProvider: mock(async () => provider) }));

const { POST } = await import("@/app/api/db/query/route");
const { useQueryExecution } = await import("@/hooks/use-query-execution");
const { useQueryAdapter } = await import("@/workspace/hooks/use-query-adapter");

const connection: DatabaseConnection = {
  id: "conn-1",
  name: "Seeded SQLite",
  type: "sqlite",
  database: ":memory:",
  createdAt: new Date(0),
};

/** The one request path both products share, answered by the real handler. */
async function callRoute(body: Record<string, unknown>) {
  clearRateLimitState();
  const request = new Request("http://localhost:3000/api/db/query", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ connection, ...body }),
  });
  const response = await POST(request as never);
  return (await response.json()) as {
    rows: Record<string, unknown>[];
    fields: string[];
    rowCount: number;
    executionTime: number;
    pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
  };
}

beforeAll(async () => {
  provider = new SQLiteProvider({ ...connection });
  await provider.connect();
  await provider.query("CREATE TABLE orders (id INTEGER PRIMARY KEY, label TEXT)");
  for (let id = 1; id <= SEEDED_ROWS; id++) {
    await provider.query(`INSERT INTO orders (id, label) VALUES (${id}, 'row-${id}')`);
  }
});

afterAll(async () => {
  await provider.disconnect();
});

// ─── One matrix, both products ──────────────────────────────────────────────

const makeTab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: "tab-1",
  name: "orders",
  query: "SELECT * FROM orders ORDER BY id",
  result: null,
  isExecuting: false,
  type: "sql",
  ...overrides,
});

/** A tabs array the hooks really write to, so the assertions can read the state back. */
function mutableTabs(initial: QueryTab[]) {
  const tabs = [...initial];
  const setTabs = (fn: unknown) => {
    if (typeof fn === "function") {
      tabs.splice(0, tabs.length, ...(fn as (prev: QueryTab[]) => QueryTab[])(tabs));
    }
  };
  return { tabs, setTabs: setTabs as never };
}

/** Built per mount, because `provider` is only connected in `beforeAll`. */
const metadata = () => ({ capabilities: provider.getCapabilities() }) as never;

interface Shell {
  name: string;
  /** Renders the hook over `tabs` and returns the entry points this file drives. */
  mount: (
    tabs: QueryTab[],
    setTabs: never,
  ) => {
    run: (query: string, options?: { limit?: number }) => Promise<void>;
    loadMore: () => Promise<void>;
    requests: () => number;
  };
}

/** How many times each product asked the route for rows, so "no further request" is assertable. */
let requestCount = 0;

const SHELLS: Shell[] = [
  {
    name: "standalone",
    mount: (tabs, setTabs) => {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.includes("/api/db/query")) return new Response("{}", { status: 200 });
        requestCount++;
        const body = JSON.parse(String(init?.body));
        const json = await callRoute({ sql: body.sql, options: body.options, queryId: body.queryId });
        return new Response(JSON.stringify(json), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as never;

      // Re-rendered from the CURRENT tabs array before each call. `currentTab` is a prop,
      // and `handleLoadMore` reads the pagination and the offset off it, so a hook left
      // holding the array as it was at mount would page from a stale offset — which is
      // the harness lying, not the hook.
      const { result, rerender } = renderHook(
        (props: { tab: QueryTab }) =>
          useQueryExecution({
            activeConnection: connection,
            metadata: metadata(),
            tabs,
            activeTabId: props.tab.id,
            currentTab: props.tab,
            setTabs,
            fetchSchema: mock(async () => {}),
            playgroundMode: false,
          } as never),
        { initialProps: { tab: tabs[0] } },
      );

      return {
        run: async (query, options) => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            await result.current.executeQuery(query, "tab-1", false, options);
          });
        },
        loadMore: async () => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            result.current.handleLoadMore();
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
        },
        requests: () => requestCount,
      };
    },
  },
  {
    name: "embedded",
    mount: (tabs, setTabs) => {
      const onQueryExecute = mock(async (_connectionId: string, sql: string, options?: object) => {
        requestCount++;
        return (await callRoute({ sql, options })) as never;
      });

      const { result, rerender } = renderHook(
        (props: { tab: QueryTab }) =>
          useQueryAdapter({
            activeConnection: connection,
            onQueryExecute,
            tabs,
            activeTabId: props.tab.id,
            currentTab: props.tab,
            setTabs,
            fetchSchema: mock(async () => {}),
            features: {},
          } as never),
        { initialProps: { tab: tabs[0] } },
      );

      return {
        run: async (query, options) => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            await result.current.executeQuery(query, "tab-1", false, options);
          });
        },
        loadMore: async () => {
          rerender({ tab: tabs[0] });
          await act(async () => {
            result.current.handleLoadMore();
            await new Promise((resolve) => setTimeout(resolve, 20));
          });
        },
        requests: () => requestCount,
      };
    },
  },
];

describe.each(SHELLS)("$name: paging a seeded table end to end (#816)", (shell) => {
  beforeEach(() => {
    requestCount = 0;
  });

  /**
   * CRITERION 2, stated as row identity rather than as a row count. A grid that appended
   * the same fifty rows twice also reaches a hundred rows, and the user cannot tell the
   * duplicates from new ones — which is exactly the failure the Cassandra provider refuses
   * rather than commit.
   */
  test("a 50-row first page is followed by disjoint pages of 50 and 21, then stops", async () => {
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    // Page one, asked for the way a tree click asks: the bound is an OPTION, not text.
    await hook.run("SELECT * FROM orders ORDER BY id", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);
    expect(tabs[0].result!.pagination!.wasLimited).toBe(true);
    expect(tabs[0].currentOffset).toBe(PAGE_SIZE);
    const firstPageIds = tabs[0].result!.rows.map((row) => row.id);
    expect(firstPageIds[0]).toBe(1);
    expect(firstPageIds[PAGE_SIZE - 1]).toBe(50);

    // Page two. Every id must be new.
    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE));
    const afterTwo = tabs[0].result!.rows.map((row) => row.id);
    expect(new Set(afterTwo).size).toBe(2 * PAGE_SIZE);
    expect(afterTwo.slice(PAGE_SIZE)[0]).toBe(51);
    expect(tabs[0].currentOffset).toBe(2 * PAGE_SIZE);
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);

    // Page three is short, so the offset advances by what ARRIVED and the route stops
    // offering more: 21 rows against a limit of 50.
    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(SEEDED_ROWS));
    const all = tabs[0].result!.rows.map((row) => row.id);
    expect(new Set(all).size).toBe(SEEDED_ROWS);
    expect(all).toEqual(Array.from({ length: SEEDED_ROWS }, (_, i) => i + 1));
    expect(tabs[0].currentOffset).toBe(SEEDED_ROWS);
    expect(tabs[0].result!.pagination!.hasMore).toBe(false);

    // And a fourth click asks for nothing, because there is nothing to ask for.
    const before = hook.requests();
    await hook.loadMore();
    expect(hook.requests()).toBe(before);
  });

  /**
   * CRITERION 5. A `LIMIT n` the user typed is a hard bound: the limiter returns the
   * statement untouched with `wasLimited: false`, the route's `hasMore` requires that
   * flag, and no page two is offered however many rows come back. This is the case that
   * used to be indistinguishable from a preview cap, because both were text in the same
   * string.
   */
  test("a bound the user typed is honoured and never paged past", async () => {
    const { tabs, setTabs } = mutableTabs([makeTab({ query: "SELECT * FROM orders ORDER BY id LIMIT 50" })]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run("SELECT * FROM orders ORDER BY id LIMIT 50", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // Exactly `limit` rows came back, which is the whole trap: the old rule, `rows.length
    // === prepared.limit`, said "there is more" for a statement whose offset would have
    // been silently dropped on the next click.
    expect(tabs[0].result!.pagination!.totalReturned).toBe(PAGE_SIZE);
    expect(tabs[0].result!.pagination!.wasLimited).toBe(false);
    expect(tabs[0].result!.pagination!.hasMore).toBe(false);

    const before = hook.requests();
    await hook.loadMore();
    expect(hook.requests()).toBe(before);
    expect(tabs[0].result!.rows).toHaveLength(PAGE_SIZE);
  });

  /**
   * THE LAST PAGE OF A TABLE WHOSE SIZE IS AN EXACT MULTIPLE OF THE PAGE SIZE.
   *
   * 100 rows at 50 a page fills the second page exactly, so `hasMore` is true and the
   * control is offered a third time — and the third page is empty. SQLite answers a
   * query that matched nothing with `fields: []` (measured: `SELECT * FROM orders ORDER
   * BY id LIMIT 50 OFFSET 100` returns `rows: 0, fields: []`), and both hooks rebuilt the
   * tab's result from the NEW page, so the grid kept its hundred rows and lost the
   * columns they are rendered under: "100 rows / 0 columns", no headers and no cells.
   *
   * A page of the same statement cannot legitimately change the shape, so the shape the
   * rows on screen were rendered under is what survives.
   */
  test("a page that comes back empty leaves the columns the rows are rendered under", async () => {
    const EXACT = "SELECT * FROM orders WHERE id <= 100 ORDER BY id";
    const { tabs, setTabs } = mutableTabs([makeTab({ query: EXACT })]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run(EXACT, { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));
    const fields = tabs[0].result!.fields;
    expect(fields).toEqual(["id", "label"]);

    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE));
    // The trap: the second page filled its bound exactly, so a third page is offered.
    expect(tabs[0].result!.pagination!.hasMore).toBe(true);

    await hook.loadMore();
    await waitFor(() => expect(tabs[0].result!.pagination!.hasMore).toBe(false));
    expect(tabs[0].result!.rows).toHaveLength(2 * PAGE_SIZE);
    expect(tabs[0].result!.rowCount).toBe(2 * PAGE_SIZE);
    expect(tabs[0].result!.fields).toEqual(fields);
  });

  /**
   * CRITERION 8, over the real path: a failed page leaves the rows and the offset alone,
   * so a retry asks for the same page rather than skipping one.
   */
  test("a failed page leaves the loaded rows and the offset untouched", async () => {
    const { tabs, setTabs } = mutableTabs([makeTab()]);
    const hook = shell.mount(tabs, setTabs);

    await hook.run("SELECT * FROM orders ORDER BY id", { limit: PAGE_SIZE });
    await waitFor(() => expect(tabs[0].result?.rows).toHaveLength(PAGE_SIZE));

    // The next page names a table that is not there, so the engine refuses it.
    const healthy = tabs[0].resultQuery;
    tabs.splice(0, 1, { ...tabs[0], resultQuery: "SELECT * FROM no_such_table ORDER BY id" });
    await hook.loadMore();

    await waitFor(() => expect(tabs[0].isLoadingMore ?? false).toBe(false));
    expect(tabs[0].result!.rows).toHaveLength(PAGE_SIZE);
    expect(tabs[0].currentOffset).toBe(PAGE_SIZE);
    expect(healthy).toBe("SELECT * FROM orders ORDER BY id");
  });
});
