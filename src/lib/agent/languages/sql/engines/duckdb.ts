/**
 * DuckDB's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * DuckDB. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import {
  type AgentCatalogRead,
  type AgentCatalogSelector,
  type AgentPlanEstimate,
  equalsClause,
} from "../../../composed-sql-primitives";
import type { AgentEngineServerOverlay } from "../../pack";

/**
 * `EXPLAIN (FORMAT JSON)` answers the physical plan without touching a row.
 *
 * DuckDB's executing form is not merely unhelpful, it is a hazard: measured on v1.5.5,
 * `EXPLAIN ANALYZE` RUNS the statement (a probe table went from 0 rows to 1), and its
 * JSON variant answers `{"result": "error"}` rather than a plan. So the estimating form
 * is the only one this layer will ever compose for it, whatever a later version does to
 * the JSON.
 */
const DUCKDB_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" });

/**
 * DuckDB's catalog is read through its own `duckdb_*` table functions rather than
 * through `information_schema`, and the choice is measured rather than stylistic
 * (`@duckdb/node-api` 1.5.5-r.4 / DuckDB v1.5.5, against a two-schema fixture):
 *
 *  - `information_schema.tables/columns` DO answer here, Postgres-shaped, but they
 *    carry no `internal` flag, so a read through them cannot separate the engine's
 *    own catalog objects from the user's. The `duckdb_*` functions carry one.
 *  - The `internal` flag is NOT usable as `NOT internal` on `duckdb_schemas()`: it
 *    is TRUE for `main` even in a user database, so filtering schemas on it drops
 *    the default schema. Every read here is therefore bounded by
 *    `database_name = current_database()` as well, which is what excludes the
 *    `temp` and `system` catalogs.
 *  - DuckDB quotes identifiers with `"` and treats `[…]` as a LIST literal rather
 *    than a name quote, so `quoteIdentifier`'s standard branch is correct for it and
 *    `quoteLiteral` doubles a single quote as it does on the other two engines.
 *
 * The guard admits all four statements: nothing here begins a word with `PRAGMA_`,
 * which is what rules SQLite's table-valued catalog functions out.
 */
const DUCKDB_CATALOG_SCOPE = " AND database_name = current_database()";

function composeDuckdbCatalog(selector: AgentCatalogSelector): string {
  return (
    "SELECT schema_name AS table_schema, table_name, column_name, data_type, is_nullable, " +
    "column_index AS ordinal_position " +
    "FROM duckdb_columns() " +
    `WHERE NOT internal${DUCKDB_CATALOG_SCOPE}` +
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb") +
    " ORDER BY schema_name, table_name, column_index"
  );
}

/**
 * The foreign-key inventory, one row per referencing COLUMN.
 *
 * `duckdb_constraints()` publishes the two sides as LISTS — `constraint_column_names`
 * and `referenced_column_names` — so a composite key would come back as a
 * cross-product if the two were unnested independently, the same defect the
 * PostgreSQL read fixes with `unnest(conkey, confkey) WITH ORDINALITY`. DuckDB has no
 * `WITH ORDINALITY`, so the two lists are SUBSCRIPTED by one shared ordinal from
 * `generate_series` (1-based here, as every DuckDB list subscript is). Measured on a
 * fixture carrying `FOREIGN KEY (x, y) REFERENCES pair_parent(a, b)`: three rows, the
 * pairs `x→a` and `y→b`, and no cross-product.
 *
 * `referenced_schema` is the referencing table's own schema because DuckDB's
 * constraint catalog publishes no referenced schema at all and the engine resolves a
 * `REFERENCES` clause within one schema. Emitting the column keeps the projection the
 * same shape as PostgreSQL's, which is what a reader of these rows compares against.
 */
function composeDuckdbRelations(selector: AgentCatalogSelector): string {
  return (
    "SELECT schema_name AS table_schema, table_name, constraint_column_names[k.ord] AS column_name, " +
    "schema_name AS referenced_schema, referenced_table, referenced_column_names[k.ord] AS referenced_column " +
    "FROM duckdb_constraints(), generate_series(1, len(constraint_column_names)) AS k(ord) " +
    `WHERE constraint_type = 'FOREIGN KEY'${DUCKDB_CATALOG_SCOPE}` +
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb") +
    " ORDER BY schema_name, table_name, k.ord"
  );
}

/**
 * The index inventory, and it takes TWO reads unioned rather than one.
 *
 * Measured: `duckdb_indexes()` lists only indexes somebody wrote a `CREATE INDEX`
 * for. A `PRIMARY KEY` or `UNIQUE` constraint builds an ART index that the engine
 * uses and that this function does not list at all — on a fixture with a
 * `PRIMARY KEY (id)`, a `UNIQUE INDEX` and a plain index, `duckdb_indexes()` returned
 * the two written ones and `is_primary` was `false` on both. So the constraint-backed
 * indexes come from `duckdb_constraints()`, unioned in.
 *
 * That is the same hole B25 recorded on SQLite, where a UNIQUE-covered foreign key
 * read as unindexed because the constraint's index carries no DDL text. It also
 * carries the only primary-key information on this engine's agent path: the column
 * read publishes no `is_primary`, so without this union nothing a run can read says
 * which columns are the key.
 *
 * `expressions` is cast to a real list (`expressions::VARCHAR[]`) rather than parsed:
 * it prints as `[a, b]` in its VARCHAR form and the cast is measured to produce
 * `["a","b"]`, so an expression index needs no hand parsing here. Both halves are
 * subscripted by a shared ordinal for the reason `composeDuckdbRelations` records, and
 * the union is ordered by that ordinal so a composite key reads in its own order.
 */
function composeDuckdbIndexes(selector: AgentCatalogSelector): string {
  const narrowing =
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb");
  const written =
    "SELECT schema_name AS table_schema, table_name, index_name, is_unique, is_primary, " +
    "(expressions::VARCHAR[])[k.ord] AS column_name, k.ord AS ordinal_position " +
    "FROM duckdb_indexes(), generate_series(1, len(expressions::VARCHAR[])) AS k(ord) " +
    `WHERE true${DUCKDB_CATALOG_SCOPE}${narrowing}`;
  const constraintBacked =
    "SELECT schema_name AS table_schema, table_name, constraint_name AS index_name, true AS is_unique, " +
    "constraint_type = 'PRIMARY KEY' AS is_primary, constraint_column_names[k.ord] AS column_name, " +
    "k.ord AS ordinal_position " +
    "FROM duckdb_constraints(), generate_series(1, len(constraint_column_names)) AS k(ord) " +
    `WHERE constraint_type IN ('PRIMARY KEY', 'UNIQUE')${DUCKDB_CATALOG_SCOPE}${narrowing}`;
  // Ordered by position rather than by name: the two halves are one inventory, and the
  // ordinals are what makes a composite index readable.
  return `${written} UNION ALL ${constraintBacked} ORDER BY 1, 2, 3, 7`;
}

/**
 * The statistics inventory: one row per table, carrying the engine's own row estimate.
 *
 * `duckdb_tables().estimated_size` is a ROW COUNT and not a byte size — measured, and
 * it is the one estimate this catalog publishes. There is NO per-column distribution
 * anywhere in it: no distinct count, no null fraction, nothing `pg_stats` answers. So
 * this projection carries the table half and says nothing about columns, which is the
 * same shape SQLite's `sqlite_stat1` read produces and the reason
 * `AgentTableEstimate.columns` is allowed to be empty.
 *
 * Nothing here scans: it is a catalog read like every other statistics composition,
 * which is what lets a plan run be pointed at production.
 */
function composeDuckdbStatistics(selector: AgentCatalogSelector): string {
  return (
    "SELECT schema_name AS table_schema, table_name, estimated_size AS estimated_rows " +
    "FROM duckdb_tables() " +
    `WHERE NOT internal${DUCKDB_CATALOG_SCOPE}` +
    equalsClause("schema_name", selector.schema, "schema", "duckdb") +
    equalsClause("table_name", selector.table, "table", "duckdb") +
    " ORDER BY schema_name, table_name"
  );
}

/** DuckDB's catalog read: one composer per kind. */
const DUCKDB_CATALOG_READ: AgentCatalogRead = Object.freeze({
  compose: Object.freeze({
    columns: composeDuckdbCatalog,
    relations: composeDuckdbRelations,
    indexes: composeDuckdbIndexes,
    statistics: composeDuckdbStatistics,
  }),
});

export const DUCKDB_SERVER_OVERLAY = {
  dialect: Object.freeze({
    catalogRead: DUCKDB_CATALOG_READ,
    planEstimate: DUCKDB_PLAN_ESTIMATE,
    // No verified profile composition, so `profile_table` refuses with `UNSUPPORTED_DIALECT` (B111).
    profileComposition: "unsupported",
  }),
} as const satisfies AgentEngineServerOverlay<"sql">;
