"use client";

import { useCallback, useState } from "react";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { CellChange } from "@/components/ResultsGrid";
import { useToast } from "@/hooks/use-toast";
import { quoteIdentifier } from "@/lib/sql/identifier";
import { resolveUpdateTarget } from "@/lib/sql/update-target";
import { positionalPlaceholder, quoteLiteral } from "@/lib/sql/values";

interface UseInlineEditingParams {
  activeConnection: DatabaseConnection | null;
  currentTab: QueryTab;
  /**
   * `useQueryExecution`'s `executeQuery`. `handleApplyChanges` awaits it between
   * rows and passes its execution options, so the signature carries both.
   *
   * It resolves to whether the statement landed. Only an explicit `false` is read as
   * a failure here: an implementation that reports nothing keeps the behaviour it had
   * before the outcome existed, so a caller passing a void-returning function is not
   * silently told every row failed.
   */
  executeQuery: (
    sql: string,
    tabId?: string,
    isExplain?: boolean,
    options?: { skipSafety?: boolean; params?: unknown[] },
  ) => void | Promise<boolean | void>;
}

/** `1 row` / `2 rows`, because a count the user reads should read like one. */
const rows = (count: number) => `${count} row${count === 1 ? "" : "s"}`;

/** The same, for the statements a run is made of. */
const updates = (count: number) => `${count} UPDATE statement${count === 1 ? "" : "s"}`;

export function useInlineEditing({ activeConnection, currentTab, executeQuery }: UseInlineEditingParams) {
  const [editingEnabled, setEditingEnabled] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<CellChange[]>([]);
  const { toast } = useToast();

  const handleCellChange = useCallback((change: CellChange) => {
    setPendingChanges((prev) => {
      // Replace existing change for same cell, or add new
      const existing = prev.findIndex((c) => c.rowIndex === change.rowIndex && c.columnId === change.columnId);
      if (existing >= 0) {
        // If reverting to original value, remove the change
        if (String(change.originalValue ?? "") === change.newValue) {
          return prev.filter((_, i) => i !== existing);
        }
        const updated = [...prev];
        updated[existing] = change;
        return updated;
      }
      // Don't add if no actual change
      if (String(change.originalValue ?? "") === change.newValue) return prev;
      return [...prev, change];
    });
  }, []);

  const handleApplyChanges = useCallback(async () => {
    if (!activeConnection || pendingChanges.length === 0) return;

    // A pending change addresses its row BY POSITION, so it only means anything against
    // the rows it was made on. Applying always ended by clearing the changes, which is
    // what kept a position from outliving those rows; keeping them after a refused apply
    // — which is what #882 asks for — removes that, and re-running the query is the
    // ordinary next move after a failure. Measured before this: an edit typed into the row
    // whose key was 1 was written to the row whose key was 77, and reported as applied.
    //
    // The change already carries what settles it: `originalValue`, the cell's content when
    // it was edited. The edits are KEPT on a refusal, the way every other refusal in this
    // hook keeps them — the check runs again on the next click, and Discard is how a user
    // throws work away on purpose.
    const rowsMoved = pendingChanges.some((change) => {
      const row = currentTab.result?.rows[change.rowIndex];
      if (row === undefined) return true;
      const current = Object.hasOwn(row, change.columnId) ? row[change.columnId] : undefined;
      return String(current ?? "") !== String(change.originalValue ?? "");
    });
    if (!currentTab.result || rowsMoved) {
      toast({
        title: "Cannot Apply Changes",
        description: "The rows these edits were made on are no longer on screen. Run the query again.",
        variant: "destructive",
      });
      return;
    }

    // Detect primary key column
    const pkColumn = currentTab.result.fields.find((f) => f.toLowerCase() === "id" || f.toLowerCase().endsWith("_id"));

    if (!pkColumn) {
      toast({
        title: "Cannot Apply Changes",
        description: "No primary key column detected (id or *_id). Edit the SQL manually.",
        variant: "destructive",
      });
      return;
    }

    // Group changes by row
    const changesByRow = new Map<number, CellChange[]>();
    for (const change of pendingChanges) {
      const existing = changesByRow.get(change.rowIndex) || [];
      existing.push(change);
      changesByRow.set(change.rowIndex, existing);
    }

    // The rows on screen came from this tab's query, so the query is the only thing in
    // the tab that names the table they may be written back to. The tab's TITLE named it
    // until #881, and a title is free text: it outlives the query it was created for, and
    // renaming a tab is not a way anyone expects to pick a write target. Where the title
    // happened to name another real table carrying the same key column, the UPDATE landed
    // on that table and said nothing.
    //
    // `resolveUpdateTarget` reads the query instead, and refuses every shape whose rows
    // have no single base table — joins, subqueries, CTEs, set operations. Refusing is
    // the honest answer there: the user edits the SQL by hand, which is what the old code
    // asked for only when its guess failed to parse. It reads the statement under the
    // connection's own dialect, and hands back the table reference exactly as the query
    // spells it, so a name the engine only accepts quoted stays quoted and a bare one is
    // validated as an identifier rather than quoted — quoting a hand-typed lowercase name
    // would break Oracle, where the real table is upper-cased.
    // `resultQuery` and not `query`: the buffer is rewritten on every keystroke and a run
    // may have executed only a selection of it, so the buffer can name a different table
    // than the one on screen — the same wrong-table write as #881, reached by typing
    // instead of by renaming.
    //
    // The `??` is a total function, not a live path. Every commit that writes a non-null
    // `result` writes `resultQuery` beside it, and a tab restored from storage comes back
    // with `result: null`, which returns above — so there is no state in which rows are on
    // screen and this falls through to the buffer.
    const target = resolveUpdateTarget(currentTab.resultQuery ?? currentTab.query, activeConnection.type);
    if (target.kind === "refused") {
      toast({
        title: "Cannot Apply Changes",
        description: `${target.reason}. Edit the SQL manually.`,
        variant: "destructive",
      });
      return;
    }
    const tableName = target.table;

    const dialect = activeConnection.type;
    const quote = (identifier: string) => quoteIdentifier(identifier, dialect);

    // Generate UPDATE statements
    const statements: Array<{ sql: string; params: unknown[]; rowIndex: number }> = [];
    for (const [rowIndex, changes] of changesByRow) {
      const row = currentTab.result.rows[rowIndex];
      const pkValue = row[pkColumn];
      const params: unknown[] = [];
      // A value is arbitrary text — pasted, imported, or read back from the table —
      // so it is bound rather than written into the statement. Interpolating it and
      // doubling the quote is only enough where a backslash is data: MySQL reads
      // `\'` as an escaped quote, so a value could close its own literal and have
      // the rest read as SQL, and applying edits skips the dangerous-query dialog
      // that would otherwise show the user that statement (#290). Where the dialect
      // has no positional bind form, a dialect-aware quoted literal is the fallback.
      const emit = (value: string | number): string => {
        const placeholder = positionalPlaceholder(dialect, params.length + 1);
        if (placeholder !== null) {
          params.push(value);
          return placeholder;
        }
        return typeof value === "number" ? String(value) : quoteLiteral(value, dialect);
      };
      const setClauses = changes.map((c) => {
        const isNull = c.newValue === "" || c.newValue.toUpperCase() === "NULL";
        // Column names come from the result's own field list, so they are exactly
        // what the engine reports and can be quoted: that keeps a name holding a
        // space or a reserved word legal, and keeps one that spells SQL inert.
        // NULL stays a keyword: it is not a value, so it takes no parameter.
        return `${quote(c.columnId)} = ${isNull ? "NULL" : emit(c.newValue)}`;
      });
      // The key keeps the number/text split it always had — a number goes to the
      // driver as a number — but neither form is written into the statement now.
      const pkVal = emit(typeof pkValue === "number" ? pkValue : String(pkValue));
      // No trailing semicolon: it only ever served to join the statements, and each
      // one now goes to /api/db/query verbatim rather than through
      // `splitStatements`, which used to strip it. oracledb rejects a plain
      // statement that carries one (ORA-00933).
      statements.push({
        sql: `UPDATE ${tableName} SET ${setClauses.join(", ")} WHERE ${quote(pkColumn)} = ${pkVal}`,
        params,
        rowIndex,
      });
    }

    // One request per row (issue #269), sequentially and with the safety dialog
    // skipped. Each part matters:
    //  - per row, because a joined payload reaches the engine as ONE string whenever
    //    a transaction or sandbox run is active, and because a failure is only
    //    attributable to a row when the row is its own request. (On the default path
    //    `/api/db/multi-query` did split it, so this is about the other path and
    //    about error attribution, not about every engine rejecting the join.)
    //  - sequentially, because executeQuery mutates the active tab's result and
    //    isExecuting, so concurrent calls would race on that state (the tab ends up
    //    showing the last row's result);
    //  - skipSafety, because isDangerousQuery matches every `UPDATE ... SET` and the
    //    gate returns WITHOUT executing while remembering only the last query it was
    //    handed — so an unflagged loop would apply nothing but the row the user then
    //    confirms, silently dropping the rest. Apply is the confirmation here: these
    //    statements are generated rather than typed, each carries a WHERE on the
    //    detected key, and the pending changes were reviewed in the grid first.
    const failedRows = new Set<number>();
    for (const statement of statements) {
      const outcome = await executeQuery(statement.sql, currentTab.id, false, {
        skipSafety: true,
        ...(statement.params.length > 0 && { params: statement.params }),
      });
      // Only an explicit refusal counts. `executeQuery` reports the failure to the
      // user itself; what it could not do before was tell THIS loop, which went on to
      // clear the pending changes and claim success whatever happened (#882).
      if (outcome === false) failedRows.add(statement.rowIndex);
    }

    if (failedRows.size === statements.length) {
      // Nothing was written, so nothing on screen was overwritten either: a run that
      // never reached the engine leaves the tab's result alone. The grid the edits
      // belong to is still there, the edits are still lined up with it, and the user
      // can correct and retry without retyping anything.
      toast({
        title: "Changes Not Applied",
        // "confirmed as saved" rather than "updated": a run the user superseded by pressing
        // Run again reports failure here without the engine having refused it, so the
        // strongest true claim is that none of them came back confirmed.
        description: `${rows(statements.length)} could not be confirmed as saved. Your edits are still here.`,
        variant: "destructive",
      });
      return;
    }

    // At least one UPDATE ran, and each one wrote its own result into the tab as it went,
    // so the rows the edits came from are no longer on screen (#883). Re-running the
    // tab's own query puts them back AND shows them as the engine now holds them, which
    // is the confirmation a toast can only assert. It goes to the tab the edits came
    // from, not to whichever tab is active by the time the last row answers.
    const refreshed = await executeQuery(currentTab.resultQuery ?? currentTab.query, currentTab.id);

    // Pending changes address rows BY POSITION, and the refresh has just replaced the
    // rows they were positions into. Keeping the ones that failed would mean carrying an
    // index forward onto a result this hook cannot see from here — and a retry would then
    // read its key from whatever row now sits at that index, which is the wrong-row write
    // #881 is about. They are dropped instead, and the toast says so: the refreshed grid
    // shows exactly which rows still hold their old values.
    setPendingChanges([]);
    setEditingEnabled(failedRows.size > 0);

    if (failedRows.size > 0) {
      toast({
        title: "Some Changes Not Applied",
        description:
          `${failedRows.size} of ${statements.length} rows could not be confirmed as saved, and your edits have ` +
          "been cleared. " +
          (refreshed === false ? "Run the query again to see what was saved." : "The results are up to date."),
        variant: "destructive",
      });
      return;
    }

    // "accepted", not "updated": a statement the engine accepts may still have matched no
    // row, and this loop cannot tell those apart. The re-read grid is what actually shows
    // the user what changed, so the toast points at it rather than claiming a count.
    toast({
      title: "Changes Applied",
      description:
        // Read the same way a row's outcome is: only an explicit refusal is a failure, so
        // a caller that reports nothing keeps the behaviour it had before the outcome
        // existed.
        refreshed === false
          ? `${updates(statements.length)} accepted. Run the query again to see the saved rows.`
          : `${updates(statements.length)} accepted. The results are up to date.`,
    });
  }, [activeConnection, currentTab, pendingChanges, executeQuery, toast]);

  const handleDiscardChanges = useCallback(() => {
    setPendingChanges([]);
  }, []);

  return {
    editingEnabled,
    setEditingEnabled,
    pendingChanges,
    handleCellChange,
    handleApplyChanges,
    handleDiscardChanges,
  };
}
