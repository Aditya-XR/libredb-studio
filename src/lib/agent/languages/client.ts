/**
 * The statement language packs' client facets (#1821): what a browser bundle may hold of each language.
 *
 * Client tier. `agent-manifest.ts` and `posture.ts` read it, so it reaches no server module: each `<id>/client.ts`
 * imports only the leaves `workflow-tool-sets.ts` and `execution-policy.ts`. The whole pack in `index.ts` holds the
 * very objects this record holds, which `tests/unit/lib/agent/languages.test.ts` asserts.
 *
 * The record is total over `AgentStatementLanguageId`, so a later language does not compile until it registers its
 * client facet here. Its keys are declared in the order the projections in `agent-manifest.ts` list them.
 */
import type { AgentStatementLanguageId } from "../agent-manifest";
import { KUBECTL_CLIENT_PACK } from "./kubectl/client";
import { MONGO_CLIENT_PACK } from "./mongo/client";
import type { AgentLanguageClientPack } from "./pack";
import { SQL_CLIENT_PACK } from "./sql/client";

/**
 * The language a run record without one reads as. `persistedRunFacts` leaves `statementLanguage` off the record for a
 * SQL engine, for a ledger older than statement languages and for an engine with no family, and each of those runs
 * reads the SQL pack. It is also the family whose variant record is total over `AgentRunWorkflowType`.
 */
export const DEFAULT_STATEMENT_LANGUAGE = "sql" as const satisfies AgentStatementLanguageId;

/**
 * The family a run reads: its persisted language, or `DEFAULT_STATEMENT_LANGUAGE` when the record holds none. The one
 * place an absent language is read. The id is not validated, so an unknown one fails where its resolver names it.
 */
export function statementFamilyOf(language: AgentStatementLanguageId | undefined): AgentStatementLanguageId {
  return language ?? DEFAULT_STATEMENT_LANGUAGE;
}

const CLIENT_PACKS: Readonly<Record<AgentStatementLanguageId, AgentLanguageClientPack>> = Object.freeze({
  sql: SQL_CLIENT_PACK,
  kubectl: KUBECTL_CLIENT_PACK,
  mongo: MONGO_CLIENT_PACK,
} satisfies Record<AgentStatementLanguageId, AgentLanguageClientPack>);

/** The client facet for `language`. The record is total, so a typed id always has one. */
export function languageClientPack(language: AgentStatementLanguageId): AgentLanguageClientPack {
  return CLIENT_PACKS[language];
}

/**
 * One member of every client facet, keyed by language in the order the packs are declared, frozen. A null pick stays
 * an own key, so a language with nothing to say is still listed.
 */
export function projectClientPacks<Value>(
  pick: (pack: AgentLanguageClientPack) => Value,
): Readonly<Record<AgentStatementLanguageId, Value>> {
  return Object.freeze(
    Object.fromEntries(Object.entries(CLIENT_PACKS).map(([id, pack]) => [id, pick(pack)])) as Record<
      AgentStatementLanguageId,
      Value
    >,
  );
}
