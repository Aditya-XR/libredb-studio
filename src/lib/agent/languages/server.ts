/**
 * What the server does differently for each statement language agent mode reads in.
 *
 * Server only. `agent-manifest.ts` holds the facts a browser may read (which engine speaks which language, which
 * workflows a language offers, the copy the rail shows); the server packs hold the behaviour that must stay on the
 * server: the statement text a model's argument is read as, the descriptor a model-written read is evaluated under,
 * the repair ledger's identity of one call, and the advice a refused read carries back. The adapters reach
 * `node:crypto`, which is why they are separate modules and why nothing a client component imports may reach them.
 *
 * The record is total over `AgentStatementLanguageId`, so a later language does not compile until it registers its
 * pack here. A language id the record does not hold can still arrive from a ledger, and reaching one is a named
 * error rather than a quiet fall back to SQL: a statement fingerprinted as SQL, or refused with a SQL sentence, is a
 * wrong answer that looks like a right one.
 */
import type { AgentStatementLanguageId } from "../agent-manifest";
import { mergeDisjoint } from "../disjoint-merge";
import type { AgentRunWorkflowType } from "../types";
import { KUBECTL_SERVER_PACK } from "./kubectl/server";
import { MONGO_SERVER_PACK } from "./mongo/server";
import type { AgentLanguageServerAdapter, AgentLanguageServerPack } from "./pack";
import { SQL_SERVER_PACK } from "./sql/server";

const SERVER_PACKS: Readonly<Record<AgentStatementLanguageId, AgentLanguageServerPack>> = Object.freeze({
  sql: SQL_SERVER_PACK,
  kubectl: KUBECTL_SERVER_PACK,
  mongo: MONGO_SERVER_PACK,
} satisfies Record<AgentStatementLanguageId, AgentLanguageServerPack>);

/** The server pack for `language`, or a named error when the id is not a language this server knows. */
export function languageServerPack(language: AgentStatementLanguageId): AgentLanguageServerPack {
  const pack = Object.hasOwn(SERVER_PACKS, language) ? SERVER_PACKS[language] : undefined;
  if (pack === undefined) throw new Error(`no server adapter for ${language}`);
  return pack;
}

/** The server adapter for `language`, or the same named error as `languageServerPack`. */
export function languageServer(language: AgentStatementLanguageId): AgentLanguageServerAdapter {
  return languageServerPack(language).adapter;
}

/**
 * Every pack's base definitions, the tools only one language offers. Global by tool name, because
 * `AGENT_TOOL_DEFINITIONS` spreads it where those tools always stood, and a name two packs both define fails at load.
 */
export const LANGUAGE_BASE_DEFINITIONS = mergeDisjoint(
  [SQL_SERVER_PACK.baseDefinitions, KUBECTL_SERVER_PACK.baseDefinitions, MONGO_SERVER_PACK.baseDefinitions],
  "LANGUAGE_BASE_DEFINITIONS",
);

/**
 * The tool rules by language, then by workflow: each pack's own record, the very object it holds. The SQL record
 * is total. A language holds rules for the workflows it has a variant of, and no more: `systemPrompt` throws for an
 * agent-mode run whose language has none, which `requiredVariant` would already have refused. `operations` sends no
 * statement in any language, so every pack holds the SQL rules for it, `OPERATIONS_TOOL_RULE` in `shared.ts`.
 *
 * Exported so `tests/unit/lib/agent/tool-offer-census.test.ts` can hold every rule to the tools its variant offers:
 * a rule naming a tool the run does not hold costs the run a turn on "there is no tool called ..." (#350).
 */
export const WORKFLOW_TOOL_RULES: Readonly<
  Record<AgentStatementLanguageId, Readonly<Partial<Record<AgentRunWorkflowType, string>>>>
> = Object.freeze({
  sql: SQL_SERVER_PACK.workflowToolRules,
  kubectl: KUBECTL_SERVER_PACK.workflowToolRules,
  mongo: MONGO_SERVER_PACK.workflowToolRules,
} satisfies Record<AgentStatementLanguageId, Partial<Record<AgentRunWorkflowType, string>>>);

/**
 * Every pack's shortfall notices. Global by shortfall, because a resumed run is judged by its persisted verdict
 * whatever its language, and a shortfall two packs both speak for fails at load.
 */
export const LANGUAGE_SHORTFALL_NOTICES = mergeDisjoint(
  [SQL_SERVER_PACK.shortfallNotices, KUBECTL_SERVER_PACK.shortfallNotices, MONGO_SERVER_PACK.shortfallNotices],
  "LANGUAGE_SHORTFALL_NOTICES",
);

/**
 * What a run is told the moment it holds a usage reading. kubectl is the one pack that supplies it, which
 * `tests/unit/lib/agent/languages.test.ts` holds, so the run loop reads it here, beside the bar's trigger, which is
 * core vocabulary: a held tool and a ledger event kind.
 */
export const LANGUAGE_USAGE_BAR_NOTICE: string = KUBECTL_SERVER_PACK.usageBarNotice;
