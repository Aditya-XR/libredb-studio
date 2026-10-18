/**
 * What the server does for MongoDB (#1821), assembled from the language's server modules.
 */
import type { AgentGoalShortfall } from "../../goal-verifier";
import { AGENT_ANSWER_CONTRACT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack, ShortfallNotice } from "../pack";
import { OPERATIONS_TOOL_RULE } from "../shared";
import { MONGO_ADAPTER } from "./adapter";
import { MONGO_ANSWER_NOT_A_DATA_READ, MONGO_DOCUMENT_INDEX_CARD, MONGO_TOOL_OVERRIDES } from "./definitions";

/**
 * How a MongoDB command spells a collection the inventory names. The inventory names each collection by its database
 * and its name (`app.orders`), while a command's `collection` is the name alone: written whole, `app.orders` is a
 * collection of that name inside the connection's database, which does not exist, and a read of it returns nothing
 * rather than an error, so nothing would tell the run its spelling was wrong.
 */
const MONGO_COLLECTION_RULE =
  'The inventory names each collection with its database in front, as in app.orders; a command names the collection alone, as in "collection": "orders", and reads the database this run\'s connection is bound to.';

/**
 * How a command reads a field's value, said beside the collection rule because the server cannot say it: a model that
 * wrote `{"$sum": "total"}` was answered 0 for every group, since `$sum` ignores a string, and nothing refused it.
 */
const MONGO_FIELD_PATH_RULE =
  'Where an aggregation reads a field\'s value, as $group and $project do, write "$<field>", with the dollar sign, as in {"$sum": "$total"}: a bare "total" is the string itself, which $sum ignores, so the sum reads 0. A filter, in a find or a $match stage, names its fields without the dollar sign.';

/**
 * The MongoDB tool rules: the read-class four exist here, so the rules say how THIS engine spells them - the
 * command envelope rather than SQL, the aggregation that stands in for a GROUP BY, and the sample-inferred
 * schema the inventory carries, which is the one honest limit a MongoDB run is told about its own grounding.
 * Every workflow that writes a command is told how a collection is spelled in one (`MONGO_COLLECTION_RULE`) and how
 * it reads a field (`MONGO_FIELD_PATH_RULE`).
 */
const MONGO_WORKFLOW_TOOL_RULES: Readonly<Partial<Record<AgentRunWorkflowType, string>>> = Object.freeze({
  investigation: [
    "Read the database with run_read_query, one command envelope at a time: find, findOne, aggregate, count and distinct are the reads there are, each as JSON.",
    MONGO_COLLECTION_RULE,
    MONGO_FIELD_PATH_RULE,
    "Narrow every read to what the question needs with a filter, or a $match stage before any $group: a read past the row budget is refused, never cut.",
    "A pipeline stage that writes ($out, $merge) is refused, as is any write operation: this run reads and reports, and what it establishes goes into the report.",
    "The schema inventory was sampled from documents, not declared: a field the sample never saw is absent from it, so say what you read rather than what the schema implies.",
    "Report what the evidence supports, and nothing further.",
  ].join(" "),
  // Built around the two routes `agent-query-optimization-mongo.1` accepts: an index recommended because of a plan
  // it inspected, or a report citing a plan that already uses an index. It names no comparison, because the variant
  // offers none (`agent-manifest.ts` says why).
  "query-optimization": [
    "inspect_plan runs the explain command at queryPlanner verbosity: it answers with the plan the engine would choose for a command and returns none of its documents, and where several plans are candidates the engine tries each for a bounded trial, under the same deadline your reads have.",
    "What a plan names is this engine's own vocabulary - COLLSCAN, IXSCAN, the index it chose - and that is what an index changes.",
    "Before you report, read the plan: if it scans the whole collection (COLLSCAN), call recommend_change for an index citing the inspect_plan artifact whose access path it would change; if it already reaches its documents through an index (IXSCAN), nothing needs to change, so recommend nothing and cite that inspect_plan artifact in a claim that says so. Never recommend an index the collection already has. A different filter or a different shape of the command is a finding for your report, not a card.",
    "Every plan you can obtain is an estimate with no timings in it. Say so rather than implying a measurement.",
    "recommend_change offers the index to the user and never creates it: this run is read-only by construction.",
    MONGO_COLLECTION_RULE,
    MONGO_FIELD_PATH_RULE,
  ].join(" "),
  "database-assessment": [
    "You must call profile_table on at least one collection before you report: this workflow answers with the counts that tool takes, and counts you compose yourself with run_read_query do not establish them.",
    "Only COUNTS come back. No value is read out of any field, so do not claim what a field contains — claim what its counts show.",
    "MongoDB declares no foreign keys and no nullability: a field may be absent or null, and the profile's counts are the honest way to tell which is which.",
    "Grade what you find against completeness, uniqueness, consistency and validity, and say which of the four each finding speaks to.",
    MONGO_COLLECTION_RULE,
    MONGO_FIELD_PATH_RULE,
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  "data-analysis": [
    "Answer from data you have READ. The schema inventory tells you where to look; only a result you ran can be the answer.",
    MONGO_COLLECTION_RULE,
    MONGO_FIELD_PATH_RULE,
    "profile_table at basic depth tells a large collection from a small one, and a field the documents fill from one they do not: it returns document counts and how many documents have a value, and reads no value out of any field.",
    "When you have the answer, call present_answer with the artifact id of the read that IS the answer.",
    "Only a result of run_read_query can be presented: a plan returns none of the command's documents, and a profile counts a collection rather than answering the question. Cite either as evidence, but present a read.",
    "A chart names columns of THAT result: they are checked against the result's real column names and refused if they do not match.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
});

/**
 * MongoDB holds `inspect_schema` (its catalog arm reads the provider's own inventory), so its omission advice
 * names that tool the way SQL's does. `relations` is false because MongoDB declares no foreign keys, and a
 * relations block that can only ever be empty is a block the model reads as a claim of absence it cannot check.
 */
const MONGO_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: "Ask inspect_schema for the collection to list its fields.",
  relations: false,
  sampledFields: true,
  planningRules: [MONGO_COLLECTION_RULE],
});

const MONGO_SHORTFALL_NOTICES: Readonly<Partial<Record<AgentGoalShortfall, ShortfallNotice>>> = Object.freeze({
  /*
    The MongoDB optimization's shortfall (`agent-query-optimization-mongo.1`): no `compare_plans`, so its two routes are
    an index recommended because of a plan, or a report citing the plan when it already reaches its documents through an
    index. Both routes are named, because naming only the first is what had a live run on 2026-10-17 recommend the
    index its plan was already using. With a plan in hand the sentence names it and narrows, keeping `recommend_change`
    and `compose_report`, the two tools these routes need; without one it sends the run to `inspect_plan` unnarrowed.
  */
  "no-plan-cited": (_table, { plans, noun }) => {
    const latest = plans.at(-1);
    if (latest !== undefined) {
      return {
        said: [
          "This workflow answers with how the engine reaches its documents, and this run holds a plan that neither an index recommendation nor the report cites, so the report would be scored as having established nothing.",
          `Your compose_report call was not run. If plan "${latest}" scans the whole collection (COLLSCAN), call recommend_change for an index citing it; if it already uses an index (IXSCAN), nothing needs to change: cite "${latest}" in a claim that says so. Then call compose_report.`,
        ].join(" "),
        narrow: true,
      };
    }
    return {
      said: [
        "This workflow is judged on plans: a report is scored on whether it shows HOW the engine reaches its documents, and this run has inspected none, so it would be scored as having established nothing.",
        `Your compose_report call was not run. Call inspect_plan on the ${noun} in question, then either recommend_change for an index citing that plan's artifact id, or, if the plan already uses an index, cite it in a claim that nothing needs to change, and then call compose_report.`,
      ].join(" "),
      narrow: false,
    };
  },
});

export const MONGO_SERVER_PACK = Object.freeze({
  adapter: MONGO_ADAPTER,
  toolOverrides: MONGO_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: MONGO_ANSWER_NOT_A_DATA_READ,
  recommendationCard: MONGO_DOCUMENT_INDEX_CARD,
  grounding: MONGO_GROUNDING,
  workflowToolRules: MONGO_WORKFLOW_TOOL_RULES,
  shortfallNotices: MONGO_SHORTFALL_NOTICES,
} satisfies AgentLanguageServerPack);
