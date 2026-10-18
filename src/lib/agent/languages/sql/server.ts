/**
 * What the server does for a SQL statement (#1821). It reaches `node:crypto` through `repair-ledger.ts`.
 */
import { fingerprintStatement } from "../../repair-ledger";
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentLanguageServerPack } from "../pack";
import { canonicalText } from "../shared";

const SQL_ROW_CAP_ADVICE = (_statement: string, allowed: string) =>
  `Ask for fewer rows: add LIMIT ${allowed} (or an aggregate that returns one row) and run it again.`;

/** A foreign catalog is a SQL mistake: the model queried another engine's catalog instead of calling inspect_schema. */
function sqlCatalogAdvice(message: string, engine: string): string | undefined {
  const foreignCatalog = /information_schema|pg_catalog/i.test(message) || /no such table: \w+\./i.test(message);
  if (!foreignCatalog) return undefined;
  return `That catalog belongs to another engine — this connection is ${engine}. Call inspect_schema for this database's tables and columns rather than querying a catalog directly.`;
}

export const SQL_SERVER_PACK = Object.freeze({
  adapter: Object.freeze({
    readOperation: "sql.query.read",
    canonicalize: canonicalText,
    fingerprint: fingerprintStatement,
    rowCapAdvice: SQL_ROW_CAP_ADVICE,
    admit: null,
  }),
  // SQL replaces nothing: its definitions are `AGENT_TOOL_DEFINITIONS`.
  toolOverrides: Object.freeze({}),
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  catalogAdvice: sqlCatalogAdvice,
} satisfies AgentLanguageServerPack);
