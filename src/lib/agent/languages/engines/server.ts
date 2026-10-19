/**
 * The engines' server dialects (#1821): the one way the core reaches an engine's dialect-bound members.
 *
 * Server tier. The registry is total over `AgentEngineType`, so an engine that speaks a statement language does not
 * compile until it registers an overlay here, and it copies only `dialect` out of each engine module: a Shared member
 * an overlay held would compile and do nothing, because every Shared consumer reads the family pack.
 *
 * `engineServerDialect` is total over any type id: an engine with no statement language, an engine whose family has
 * no dialect, and a name that is no key at all (`toString`) each answer `NO_SERVER_DIALECT`, every member
 * `"unsupported"`. That is what grounding and statistics need, since they run on every engine in plan mode.
 */
import type { DatabaseType } from "@/lib/types";
import { KUBERNETES_SERVER_OVERLAY } from "../kubectl/engines/kubernetes";
import { MONGODB_SERVER_OVERLAY } from "../mongo/engines/mongodb";
import type { AgentEngineServerDialect, AgentEngineServerOverlays, AgentEngineType } from "../pack";
import { DUCKDB_SERVER_OVERLAY } from "../sql/engines/duckdb";
import { MSSQL_SERVER_OVERLAY } from "../sql/engines/mssql";
import { MYSQL_SERVER_OVERLAY } from "../sql/engines/mysql";
import { POSTGRES_SERVER_OVERLAY } from "../sql/engines/postgres";
import { SQLITE_SERVER_OVERLAY } from "../sql/engines/sqlite";

/** An overlay with its `dialect` alone, or with nothing for a family that has none. */
type DialectOnly<Overlay> = Overlay extends { readonly dialect: infer Dialect }
  ? { readonly dialect: Dialect }
  : Record<never, never>;

/** The `dialect` of an engine module's overlay, and nothing else it holds. */
const dialectOnly = <Overlay extends { readonly dialect?: object }>(overlay: Overlay): DialectOnly<Overlay> =>
  (overlay.dialect === undefined ? {} : { dialect: overlay.dialect }) as DialectOnly<Overlay>;

const SERVER_OVERLAYS: AgentEngineServerOverlays = Object.freeze({
  postgres: dialectOnly(POSTGRES_SERVER_OVERLAY),
  sqlite: dialectOnly(SQLITE_SERVER_OVERLAY),
  duckdb: dialectOnly(DUCKDB_SERVER_OVERLAY),
  mssql: dialectOnly(MSSQL_SERVER_OVERLAY),
  mysql: dialectOnly(MYSQL_SERVER_OVERLAY),
  mongodb: dialectOnly(MONGODB_SERVER_OVERLAY),
  kubernetes: dialectOnly(KUBERNETES_SERVER_OVERLAY),
} satisfies AgentEngineServerOverlays);

/** What an engine with no dialect answers: every member unsupported. */
const NO_SERVER_DIALECT: AgentEngineServerDialect = Object.freeze({
  planEstimate: "unsupported",
  profileComposition: "unsupported",
});

/** What an engine with no overlay holds: nothing, so its server facet is its family's own. */
const NO_SERVER_OVERLAY: { readonly dialect?: AgentEngineServerDialect } = Object.freeze({});

/**
 * The server overlay of `type` as the registry holds it, its `dialect` alone, or an empty one for a type with no
 * overlay. Read by `agentEnginePack` in `engines/index.ts`.
 */
export function engineServerOverlay(type: DatabaseType): { readonly dialect?: AgentEngineServerDialect } {
  return Object.hasOwn(SERVER_OVERLAYS, type) ? SERVER_OVERLAYS[type as AgentEngineType] : NO_SERVER_OVERLAY;
}

/** The server dialect of `type`: its overlay's own frozen `dialect`, or `NO_SERVER_DIALECT`. */
export function engineServerDialect(type: DatabaseType): AgentEngineServerDialect {
  return engineServerOverlay(type).dialect ?? NO_SERVER_DIALECT;
}
