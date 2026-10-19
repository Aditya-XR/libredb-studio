/**
 * Every language pack's refusal sentences, one table per code union (#1821).
 *
 * `tool-contracts.ts` merges each with the core's rows into the table a refusal reads. A language that adds a
 * sentence adds its record to the list here, and a code two languages both claim fails at load.
 */

import { mergeDisjoint } from "../disjoint-merge";
import { KUBECTL_READING_REFUSAL_TEXT } from "./kubectl/refusals";
import { MONGO_UNAVAILABLE_TEXT } from "./mongo/refusals";

export const LANGUAGE_UNAVAILABLE_TEXT = mergeDisjoint([MONGO_UNAVAILABLE_TEXT], "LANGUAGE_UNAVAILABLE_TEXT");

export const LANGUAGE_READING_REFUSAL_TEXT = mergeDisjoint(
  [KUBECTL_READING_REFUSAL_TEXT],
  "LANGUAGE_READING_REFUSAL_TEXT",
);
