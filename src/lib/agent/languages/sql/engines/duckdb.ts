/**
 * DuckDB's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * DuckDB. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import type { AgentPlanEstimate } from "../../../composed-sql-primitives";
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

export const DUCKDB_SERVER_OVERLAY = {
  dialect: Object.freeze({
    planEstimate: DUCKDB_PLAN_ESTIMATE,
    // No verified profile composition, so `profile_table` refuses with `UNSUPPORTED_DIALECT` (B111).
    profileComposition: "unsupported",
  }),
} as const satisfies AgentEngineServerOverlay<"sql">;
