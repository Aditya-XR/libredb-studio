/**
 * What the server does for a SQL statement (#1821). It reaches `node:crypto` through `repair-ledger.ts`.
 */
import { fingerprintStatement } from "../../repair-ledger";
import type { AgentLanguageServerPack } from "../pack";
import { canonicalText } from "../shared";

const SQL_ROW_CAP_ADVICE = (_statement: string, allowed: string) =>
  `Ask for fewer rows: add LIMIT ${allowed} (or an aggregate that returns one row) and run it again.`;

export const SQL_SERVER_PACK: AgentLanguageServerPack = Object.freeze({
  adapter: Object.freeze({
    readOperation: "sql.query.read",
    canonicalize: canonicalText,
    fingerprint: fingerprintStatement,
    rowCapAdvice: SQL_ROW_CAP_ADVICE,
    admit: null,
  }),
});
