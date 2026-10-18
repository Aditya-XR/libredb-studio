/**
 * The refusal sentences only the MongoDB arms say (#1821).
 *
 * Their codes stay in the core's `AgentToolUnavailableCode`, because the ledger persists them. Only the words live
 * here, merged into `UNAVAILABLE_TEXT` by `../refusals.ts`.
 */

import type { AgentToolUnavailableCode } from "../../tools";

export const MONGO_UNAVAILABLE_TEXT = Object.freeze({
  /**
   * Said by the mongo catalog arm alone today, for a KIND the engine's catalog never answers. The detail carries the
   * reason and the reading that serves the request, so the refusal is a redirection rather than a dead end.
   */
  KIND_REFUSED:
    "That kind of inventory is not one this engine's catalog answers. The refusal's detail says why, and names the reading that serves what you asked for.",
  // Confirms the object, as `CATALOG_INVENTORY_EMPTY` does, so a model is not sent looking for a misspelling it did not
  // make; and says the emptiness is itself something it may report.
  CATALOG_OBJECT_EMPTY:
    "That object exists, and the documents sampled from it held no field, so there is nothing to describe: it is empty, or its sample held no document. Treat the emptiness as a finding rather than a misspelling, and read its documents with a read of your own if they matter.",
  // Said instead of recording an index that exists. A live MongoDB Optimize run on 2026-10-17 recommended the very
  // index its plan was already using, because nothing told it that "no change" was an answer this workflow accepts.
  INDEX_ALREADY_EXISTS:
    "An index on exactly those keys already exists on that collection, so recommending it changes nothing. If the plan already reaches its documents through it, nothing needs to change: say so in the report, citing the plan.",
} satisfies Partial<Record<AgentToolUnavailableCode, string>>);
