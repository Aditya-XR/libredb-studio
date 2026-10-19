/**
 * SQLite's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them on
 * SQLite. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay } from "../../pack";

/** `LIKE` for the email shape and `GLOB` for the digit run (B26, `PROFILE_SHAPES`). */
const SQLITE_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // SQLite has no quantifier, so the run is spelled out one class at a time.
    digitRun: (quoted: string, runLength: number) => `${quoted} GLOB '*${"[0-9]".repeat(runLength)}*'`,
  }),
  incomparableType: /\b(jsonb?|xml|point|line|lseg|box|path|polygon|circle)\b/i,
});

export const SQLITE_SERVER_OVERLAY = {
  dialect: Object.freeze({ profileComposition: SQLITE_PROFILE_COMPOSITION }),
} as const satisfies AgentEngineServerOverlay<"sql">;
