/**
 * Every language pack's goal rules, one table keyed by verifier id (#1821).
 *
 * `goal-verifier.ts` merges it with the core's rules into the table `goalOf` reads. It imports only the languages'
 * `verifiers.ts`, so loading the verdict loads no adapter, admission module or cluster reading. A language that adds a
 * rule adds its record to the list here, and an id two owners both claim fails at load.
 */

import { mergeDisjoint } from "../disjoint-merge";
import { KUBECTL_GOAL_RULES } from "./kubectl/verifiers";
import { MONGO_GOAL_RULES } from "./mongo/verifiers";

export const LANGUAGE_GOAL_RULES = mergeDisjoint([KUBECTL_GOAL_RULES, MONGO_GOAL_RULES], "LANGUAGE_GOAL_RULES");
