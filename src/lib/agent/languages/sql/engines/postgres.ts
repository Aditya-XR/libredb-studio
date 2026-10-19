/**
 * PostgreSQL's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them
 * on PostgreSQL. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import type { AgentPlanEstimate } from "../../../composed-sql-primitives";
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay } from "../../pack";

/** `LIKE` for the email shape and a POSIX regular expression for the digit run (B26, `PROFILE_SHAPES`). */
const POSTGRES_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    digitRun: (quoted: string, runLength: number) => `${quoted} ~ '[0-9]{${runLength},}'`,
  }),
  incomparableType: /\b(jsonb?|xml|point|line|lseg|box|path|polygon|circle)\b/i,
});

/** `EXPLAIN` executes only with `ANALYZE`, so the prefix without it describes the plan without running it. */
const POSTGRES_PLAN_ESTIMATE: AgentPlanEstimate = Object.freeze({ kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" });

export const POSTGRES_SERVER_OVERLAY = {
  dialect: Object.freeze({ planEstimate: POSTGRES_PLAN_ESTIMATE, profileComposition: POSTGRES_PROFILE_COMPOSITION }),
} as const satisfies AgentEngineServerOverlay<"sql">;
