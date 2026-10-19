/**
 * MySQL's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * MySQL and MariaDB. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import type { AgentPlanEstimate } from "../../../composed-sql-primitives";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay } from "../../pack";

/** `LIKE` for the email shape and `REGEXP` for the digit run (B26, `PROFILE_SHAPES`). */
const MYSQL_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    // LIKE is spelled the same way on MySQL and MariaDB, `_` meaning "any character"
    // included, measured on both engines as the least-privilege account.
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // Both engines of this family take the SQL:1999 REGEXP operator with a POSIX-ish
    // pattern, measured on MySQL 26.7.0 and MariaDB 13.0.2 as the least-privilege
    // account: the nine-digit run counted 1, the eight-digit one 0.
    digitRun: (quoted: string, runLength: number) => `${quoted} REGEXP '[0-9]{${runLength},}'`,
  }),
  // PER DIALECT, and this arm matches NOTHING - measured, not assumed. On MySQL
  // 26.7.0 and MariaDB 13.0.2, as the least-privilege account, one
  // `count(DISTINCT …)` per column of a probe table holding `json`, `blob`,
  // `geometry`, `bigint` past 2^53, `varchar` and `text`: every one of them counted
  // (the two engines compare by the value's own form, so each answered 1 for the one
  // row). Neither engine of this family refuses a DISTINCT the way PostgreSQL
  // refuses `json`, so listing any type here would cost a column its distinct count
  // for nothing. `\b\B` cannot match ANY text, by construction: no position is both
  // a word boundary and not one (`$^`, the first spelling of this, matches the empty
  // string, which would have ruled out a column whose declared type read back empty).
  //
  // The engines DO refuse `ORDER BY` and comparison on some of these types - that is
  // a different operation than the COUNT this test guards, and nothing this module
  // composes orders by a column value.
  incomparableType: /\b\B/,
});

/**
 * One spelling for MySQL and MariaDB: both accept `EXPLAIN FORMAT=JSON` with no
 * privilege beyond SELECT (measured as the least-privilege account on 26.7.0 and
 * 13.0.2), and the JSON shapes differ (`query_plan` on MySQL, `query_block` on
 * MariaDB) without either refusing the prefix. `EXPLAIN ANALYZE` is deliberately
 * not composed: it EXECUTES, see `withoutEstimatingPrefix` in `composed-sql.ts`.
 */
const MYSQL_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN FORMAT=JSON" });

export const MYSQL_SERVER_OVERLAY = {
  dialect: Object.freeze({ planEstimate: MYSQL_PLAN_ESTIMATE, profileComposition: MYSQL_PROFILE_COMPOSITION }),
} as const satisfies AgentEngineServerOverlay<"sql">;
