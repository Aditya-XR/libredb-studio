/**
 * DuckDB's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * DuckDB. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const DUCKDB_SERVER_OVERLAY = {
  dialect: Object.freeze({
    // No verified profile composition, so `profile_table` refuses with `UNSUPPORTED_DIALECT` (B111).
    profileComposition: "unsupported",
  }),
} as const satisfies AgentEngineServerOverlay<"sql">;
