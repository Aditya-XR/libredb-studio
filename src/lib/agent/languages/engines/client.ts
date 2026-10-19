/**
 * The engines' client facets (#1821): each engine's family client facet with its client overlay applied.
 *
 * Client tier. It reads the family client facets (`languages/client.ts`) and the engine client overlays, never
 * `agent-manifest.ts` at run time, which reads this module: an engine's family is held beside its overlay instead, and
 * `AgentEngineClientOverlays` types it as the family `AGENT_STATEMENT_LANGUAGE` maps the engine onto. The registry is
 * total over `AgentEngineType` and declared in the order postgres, sqlite, duckdb, mssql, mysql, mongodb, kubernetes.
 */
import type { DatabaseType } from "@/lib/types";
import { languageClientPack } from "../client";
import { KUBERNETES_CLIENT_OVERLAY } from "../kubectl/engines/client";
import { MONGODB_CLIENT_OVERLAY } from "../mongo/engines/client";
import { defineOverlay } from "../overlay";
import type { AgentEngineClientDialect, AgentEngineClientOverlays, AgentEnginePack, AgentEngineType } from "../pack";
import {
  DUCKDB_CLIENT_OVERLAY,
  MSSQL_CLIENT_OVERLAY,
  MYSQL_CLIENT_OVERLAY,
  POSTGRES_CLIENT_OVERLAY,
  SQLITE_CLIENT_OVERLAY,
} from "../sql/engines/client";

const CLIENT_OVERLAYS: AgentEngineClientOverlays = Object.freeze({
  postgres: { family: "sql", overlay: POSTGRES_CLIENT_OVERLAY },
  sqlite: { family: "sql", overlay: SQLITE_CLIENT_OVERLAY },
  duckdb: { family: "sql", overlay: DUCKDB_CLIENT_OVERLAY },
  mssql: { family: "sql", overlay: MSSQL_CLIENT_OVERLAY },
  mysql: { family: "sql", overlay: MYSQL_CLIENT_OVERLAY },
  mongodb: { family: "mongo", overlay: MONGODB_CLIENT_OVERLAY },
  kubernetes: { family: "kubectl", overlay: KUBERNETES_CLIENT_OVERLAY },
} satisfies AgentEngineClientOverlays);

/**
 * The client facet of `type`: its family's, with the engine's overlay applied, which is the family's own object while
 * the overlay is empty. A type that speaks no statement language has none, and asking is a named error.
 */
export function engineClientPack(type: DatabaseType): AgentEnginePack["client"] {
  const entry = Object.hasOwn(CLIENT_OVERLAYS, type) ? CLIENT_OVERLAYS[type as AgentEngineType] : undefined;
  if (entry === undefined) throw new Error(`no engine pack for ${type}`);
  const overlay: { readonly dialect?: AgentEngineClientDialect } = entry.overlay;
  return defineOverlay(languageClientPack(entry.family), overlay);
}

/**
 * The engines whose client dialect says `"supported"` for every member asked, in registry order and frozen: the
 * client's answer to which engines compose what, read from the overlays rather than restated beside them. An engine
 * whose family has no client dialect supports none.
 */
export function enginesSupporting(
  ...members: readonly [keyof AgentEngineClientDialect, ...(keyof AgentEngineClientDialect)[]]
): readonly DatabaseType[] {
  return Object.freeze(
    (Object.keys(CLIENT_OVERLAYS) as AgentEngineType[]).filter((type) => {
      const dialect: AgentEngineClientDialect | undefined = CLIENT_OVERLAYS[type].overlay.dialect;
      return dialect !== undefined && members.every((member) => dialect[member] === "supported");
    }),
  );
}
