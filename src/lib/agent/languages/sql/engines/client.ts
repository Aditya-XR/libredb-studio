/**
 * The SQL engines' client overlays (#1821): what a browser bundle may hold of each SQL engine's dialect. Client tier,
 * read only through `engineClientPack` in `languages/engines/client.ts`. The SQL client dialect has no member yet, so
 * every overlay is empty and each engine's client facet is SQL's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const POSTGRES_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"sql">;
export const SQLITE_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"sql">;
export const DUCKDB_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"sql">;
export const MSSQL_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"sql">;
export const MYSQL_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"sql">;
