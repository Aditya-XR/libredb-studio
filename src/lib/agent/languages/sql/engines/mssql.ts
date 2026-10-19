/**
 * SQL Server's server overlay (#1821): the dialect-bound members of the SQL server facet, as agent mode composes them
 * on SQL Server. Server tier, read only through `engineServerDialect` in `languages/engines/server.ts`.
 */
import type { AgentProfileComposition } from "../../../table-profile";
import type { AgentEngineServerOverlay } from "../../pack";

/** `LIKE` for both shapes, the digit run as a character class repeated (B26, `PROFILE_SHAPES`). */
const MSSQL_PROFILE_COMPOSITION: AgentProfileComposition = Object.freeze({
  shapeTests: Object.freeze({
    email: (quoted: string, likePattern: string) => `${quoted} LIKE '${likePattern}'`,
    // T-SQL has no regular expressions and no GLOB. Its `LIKE` DOES take a character
    // class, so the run is spelled as the class repeated: there is no quantifier, so
    // nine `[0-9]`s is the shortest faithful spelling of "nine or more digits".
    // The same run as a T-SQL `LIKE` pattern: the class repeated, between two `%`s.
    digitRun: (quoted: string, runLength: number) => `${quoted} LIKE '%${"[0-9]".repeat(runLength)}%'`,
  }),
  // PER DIALECT because the sets genuinely differ, and one shared regex would have to
  // be wrong about one of them.
  //
  // Every SQL Server entry was MEASURED on 2022 CU26, one `count(DISTINCT …)` per type,
  // rather than reasoned about: `xml`, `geography` and `geometry` each answer
  // "Operand data type <type> is invalid for count operator" (Msg 8117), while
  // `varbinary(max)` and `uniqueidentifier` both count without complaint. `hierarchyid`
  // was listed here and is NOT incomparable: the same probe counts it, and
  // `count(DISTINCT DocumentNode)` over `Production.Document` answers 13 for 13 rows.
  // Listing it cost that column its distinct count for nothing, so it is gone.
  //
  // `text`, `ntext` and `image` are absent for a different reason: SQL Server refuses
  // PLAIN `count` on them too, so they are excluded from the projection entirely by
  // `uncountableType` below and never reach this test. `text` is also why this cannot
  // be one shared list, since PostgreSQL's `text` is its ordinary string type.
  incomparableType: /\b(xml|geography|geometry)\b/i,
  uncountableType: /\b(text|ntext|image)\b/i,
});

export const MSSQL_SERVER_OVERLAY = {
  dialect: Object.freeze({ profileComposition: MSSQL_PROFILE_COMPOSITION }),
} as const satisfies AgentEngineServerOverlay<"sql">;
