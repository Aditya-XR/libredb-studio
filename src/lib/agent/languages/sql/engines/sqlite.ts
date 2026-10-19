/**
 * SQLite's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * SQLite. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  AgentComposedSqlError,
  type AgentPlanEstimate,
  assertSelector,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay } from "../../pack";

/** `LIKE` for the email shape and `GLOB` for the digit run (B26, `PROFILE_SHAPES`). */
const SQLITE_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // SQLite has no quantifier, so the run is spelled out one class at a time.
    digitRun: (quoted: string, runLength: number) => `${quoted} GLOB '*${"[0-9]".repeat(runLength)}*'`,
  }),
  incomparableType: /\b(jsonb?|xml|point|line|lseg|box|path|polygon|circle)\b/i,
});

/** `EXPLAIN QUERY PLAN` reports the plan the compiler produced, without running it. */
const SQLITE_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN QUERY PLAN" });

/**
 * SQLite's only schema for a profiled provider. The read-only profile opens one
 * file and attaching another is refused at the input stage, so `main` is not merely
 * the default — it is the whole set.
 */
const SQLITE_ONLY_SCHEMA = "main";

/**
 * SQLite serves one schema, and a selector naming another is refused rather than
 * quietly read as `main`.
 */
function assertSqliteSchema(selector: AgentCatalogSelector): void {
  if (selector.schema === undefined) return;
  const schema = assertSelector(selector.schema, "schema");
  if (schema.toLowerCase() !== SQLITE_ONLY_SCHEMA) {
    throw new AgentComposedSqlError(
      `SQLite serves one schema on the agent path ("${SQLITE_ONLY_SCHEMA}"), so "${schema}" cannot be selected`,
      "SELECTOR_UNSUPPORTED_BY_DIALECT",
    );
  }
  // `main` needs no clause: sqlite_master IS main's catalog, so filtering on it
  // would be a no-op dressed up as a narrowing.
}

function composeSqliteCatalog(selector: AgentCatalogSelector): string {
  assertSqliteSchema(selector);
  return (
    "SELECT name, type, sql FROM sqlite_master " +
    // The escape character is `@` rather than a backslash on purpose: `'\'` is the
    // literal the dialect-less span reader cannot settle (see `assertSelector`).
    "WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("name", selector.table, "table", "sqlite") +
    " ORDER BY type, name"
  );
}

/**
 * SQLite's index inventory.
 *
 * `sql IS NOT NULL` is what excludes the indexes SQLite creates for a `UNIQUE` or
 * `PRIMARY KEY` constraint: they carry no DDL text at all, so an inventory that
 * kept them would list an index nothing can describe. Their columns are not lost —
 * the constraint that created them is in the table's own DDL, which the object read
 * returns. The `sqlite_` name filter stays as a second line for the same objects.
 *
 * The selector narrows on `tbl_name` (the indexed TABLE), not on `name`: a caller
 * asking about a table wants that table's indexes, and nobody knows an index's name
 * before reading the inventory.
 */
function composeSqliteIndexes(selector: AgentCatalogSelector): string {
  assertSqliteSchema(selector);
  return (
    "SELECT name, tbl_name, sql FROM sqlite_master " +
    "WHERE type = 'index' AND sql IS NOT NULL AND name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("tbl_name", selector.table, "table", "sqlite") +
    " ORDER BY tbl_name, name"
  );
}

/**
 * SQLite's statistics inventory, from `sqlite_stat1`.
 *
 * `ANALYZE` writes one row per INDEX, whose `stat` column is a space-separated list
 * of integers: the first is the number of rows in the table, and each one after it
 * is the average number of rows matching an equal prefix of the index's columns. So
 * the row estimate and a per-index-prefix distinctness estimate are both derivable
 * from that string — by the reader, which is where the parsing and the labelling
 * belong — and a NULL FRACTION IS NOT AVAILABLE AT ALL on this engine. The reader
 * must report it absent rather than assume zero.
 *
 * The join direction is the load-bearing part, and it is verified against a live
 * engine in the tests rather than reasoned about:
 *
 *  - driving from `sqlite_master` with a LEFT JOIN keeps every table in the
 *    inventory, including one SQLite holds no statistics for. That is not a rare
 *    case: `ANALYZE` writes NOTHING for a table with no indexes, so an inner join
 *    would silently omit exactly the tables whose sizes are least known.
 *  - the estimate is therefore per index, not per column. This engine has no
 *    per-column distribution to read.
 *
 * WHY A SEPARATE PROBE, and not a self-guarding statement: `sqlite_stat1` does not
 * exist until an explicit `ANALYZE` has run, and SQLite resolves table names when it
 * PREPARES a statement. So there is no single statement that reads the table when it
 * is there and returns nothing when it is not — a `WHERE EXISTS (SELECT … FROM
 * sqlite_master …)` guard still mentions `sqlite_stat1` in a FROM clause and still
 * fails to prepare with `no such table`. The sqlite_master check is therefore its own
 * statement, `composeStatisticsAvailabilityProbe`, and a caller runs it FIRST; a
 * zero-row answer means "this database has never been analysed", which is reported
 * as statistics absent and must not be reported as a database failure.
 */
function composeSqliteStatistics(selector: AgentCatalogSelector): string {
  assertSqliteSchema(selector);
  return (
    "SELECT m.name AS table_name, s.idx AS index_name, s.stat AS stat " +
    "FROM sqlite_master m LEFT JOIN sqlite_stat1 s ON s.tbl = m.name " +
    "WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite@_%' ESCAPE '@'" +
    equalsClause("m.name", selector.table, "table", "sqlite") +
    " ORDER BY m.name, s.idx"
  );
}

/**
 * SQLite's catalog read. Its relation read IS its object read: foreign keys
 * are declared inside `CREATE TABLE` and the only structured alternative
 * (`pragma_foreign_key_list`) is refused by the guard, so the same statement serves
 * both and the DDL text is parsed for the edges.
 */
const SQLITE_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeSqliteCatalog,
    relations: composeSqliteCatalog,
    indexes: composeSqliteIndexes,
    statistics: composeSqliteStatistics,
  }),
  /**
   * The schema name to DECLARE as the policy target, given what the composer accepted.
   *
   * Only SQLite needs the fold: `main` is its whole schema set and the composer matches
   * it case-insensitively, so the canonical spelling is the one a scope allowlist can be
   * written against. PostgreSQL is left exactly as supplied — `information_schema`
   * compares `table_schema` case-sensitively, so folding it would declare a target that
   * is not the one the composed statement reads.
   */
  declaredSchema: (schema: string) => schema.toLowerCase(),
});

export const SQLITE_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: SQLITE_CATALOG_READ,
    planEstimate: SQLITE_PLAN_ESTIMATE,
    profileComposition: SQLITE_PROFILE_COMPOSITION,
  }),
} as const satisfies AgentEngineServerOverlay<"sql">;
