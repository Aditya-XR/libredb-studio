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
