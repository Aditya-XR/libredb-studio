/**
 * What the server does for a SQL statement (#1821). It reaches `node:crypto` through `repair-ledger.ts`.
 */
import { fingerprintStatement } from "../../repair-ledger";
import { AGENT_ANSWER_CONTRACT, UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentRunWorkflowType } from "../../types";
import type { AgentLanguageGrounding, AgentLanguageServerPack } from "../pack";
import { canonicalText, OPERATIONS_TOOL_RULE } from "../shared";

const SQL_ROW_CAP_ADVICE = (_statement: string, allowed: string) =>
  `Ask for fewer rows: add LIMIT ${allowed} (or an aggregate that returns one row) and run it again.`;

/** A foreign catalog is a SQL mistake: the model queried another engine's catalog instead of calling inspect_schema. */
function sqlCatalogAdvice(message: string, engine: string): string | undefined {
  const foreignCatalog = /information_schema|pg_catalog/i.test(message) || /no such table: \w+\./i.test(message);
  if (!foreignCatalog) return undefined;
  return `That catalog belongs to another engine — this connection is ${engine}. Call inspect_schema for this database's tables and columns rather than querying a catalog directly.`;
}

/**
 * How to pursue the objective WITH THE TOOLS (#330 T3). Agent mode only, which is the
 * whole reason this is a record of its own: what each workflow is FOR is its variant's
 * `objective` in `agent-manifest.ts`, said in both modes, and what a plan of it
 * produces instead is the variant's `planDeliverable`.
 *
 * A total record, so a workflow added to the contract stops this file compiling
 * until someone decides what to ask of it. Appended to `agentRules` and never to a
 * planning run's rules: planning is toolless, and telling it to call tools would be
 * asking for something the mode cannot do.
 *
 * The optimization block names `inspect_schema`'s index selector explicitly, and
 * that is not padding. A live run on 2026-08-12 reached for
 * `PRAGMA index_list('a'); PRAGMA index_list('b')` — multi-statement text, refused
 * by the statement guard before the database — because the obvious route to an
 * index inventory is closed and nothing had said which one is open.
 *
 * It also says what to do about an index INSTEAD of comparing plans, and that
 * sentence is the model's half of #356. The verifier now accepts a cited plan in
 * place of a comparison for an index; a rule the model is not told about is a rule
 * live runs fail, which is exactly how the evidence contract failed in #350.
 */
const SQL_WORKFLOW_TOOL_RULES: Readonly<Record<AgentRunWorkflowType, string>> = Object.freeze({
  investigation: "Report what the evidence supports, and nothing further.",
  "query-optimization": [
    'Read the existing indexes with inspect_schema and kind="indexes" — a multi-statement PRAGMA or SHOW is refused before the database.',
    "Inspect the plan of the current statement, then of your rewrite, and call compare_plans with the two artifact ids. They must name two different plans.",
    "An index cannot be compared that way: its second plan would need the index to already exist, and this run creates nothing. Recommend it instead, citing the inspect_plan artifact whose access path the index is meant to change.",
    "Every plan you can obtain is an ESTIMATE: nothing is executed, and there are no timings. Say so rather than implying a measurement.",
    "Propose changes with recommend_change. They are offered to the user and never applied by this run.",
    // The verifier's rule, in the model's own terms — the same #350/#356 move the
    // `operations` rules make, and the one this workflow was missing. Everything above
    // describes how the two instruments WORK; none of it says the report is judged on
    // having used one. Measured across 25 local models, 6 failed on
    // `no-plan-comparison` with the arc the gate in `tests/evals/query-optimization`
    // scripts: one `inspect_plan`, then a report. Two evaluated models and
    // `qwen3.5:9b` produced identical ledgers — a correct diagnosis, and no
    // `recommend_change` call at all. Stopping after the diagnosis is a reasonable
    // reading of "explain why it is slow" when nothing has said otherwise, so this
    // says otherwise, and names both routes because naming the tool is what made the
    // assessment bar land: a bar phrased as an activity gets satisfied by hand.
    "One plan on its own answers nothing: before you report, either inspect the plan of your rewrite too and call compare_plans with the two artifact ids, or call recommend_change for an index citing the inspect_plan artifact whose access path it would change.",
  ].join(" "),
  "database-assessment": [
    "Profile the tables that matter with profile_table, deepening only where a shallower profile left a question: basic counts rows and missing values, distribution adds distinct counts, pattern tests for personal-data shapes.",
    // The verifier's rule, in the model's own terms — the same #350/#356 move the
    // `operations` rules make below, for the same reason and now on the evidence that
    // it was needed here too. `verifyDatabaseAssessmentGoal` requires a
    // `table-profiled` event, and the sentence above it states WHERE to look rather
    // than what the report is judged by: "profile the tables that matter" reads as
    // advice a run may take or leave. Measured across 25 local models, 18 failed this
    // workflow on `no-table-profile`, and five of those composed a report having
    // called no tool at all — not refusing to profile, just never told a profile was
    // the condition. There is no honest exception to hedge: profiling an empty table
    // still produces the event, so a run with a table to profile can always clear it.
    //
    // The bar NAMES THE TOOL, and that wording was measured rather than chosen. A first
    // version said "profile at least one table", which reads as an activity: of the
    // eight models it was measured on, one satisfied those words by writing
    // eighteen `run_read_query` count statements by hand, and three more went to
    // `inspect_schema` — none produced the event the verifier reads, so all four still
    // failed while believing they had complied. The `operations` rule that works names
    // its instrument the same way ("everything you read, you read with
    // inspect_operations"). The second clause is here because a model that composes
    // counts itself is being diligent, not lazy, and deserves to be told why that does
    // not clear the bar rather than left to discover it in a verdict.
    "You must call profile_table on at least one table before you report: this workflow answers with the counts that tool takes, and counts you compose yourself with run_read_query do not establish them.",
    "Only COUNTS come back. No value is read out of any column, so do not claim what a column contains — claim what its counts show.",
    "Grade what you find against completeness, uniqueness, consistency and validity, and say which of the four each finding speaks to.",
  ].join(" "),
  operations: OPERATIONS_TOOL_RULE,
  // The model's half of `agent-data-analysis.1`. The verdict requires an
  // `answer-composed` event on top of the baseline, so the sentence naming
  // `present_answer` is what makes that bar reachable — #350's lesson, applied at the
  // moment the rule is written rather than after a live run fails it. The contract
  // itself is IMPORTED from the tool layer rather than paraphrased here: two wordings
  // of one contract is how #350 happened.
  "data-analysis": [
    "Answer from data you have READ. The schema tells you where to look; only a result you ran can be the answer.",
    "profile_table at basic depth is how you tell a fact table from a lookup one, and a date column the business fills from an audit column nobody does: it returns row counts and how many rows have a value, and reads no value out of any column. Go deeper only if a basic profile leaves a question.",
    "When you have the answer, call present_answer with the artifact id of the read that IS the answer.",
    // The tool layer's `isStatementReadOperation` rule in `presentAnswerTool`, in the model's terms (#350). A plan
    // step carries a drafted statement and settles like any other, so nothing in what
    // the model sees distinguishes a plan artifact from a read one; a rule enforced
    // only by a refusal is a rule the model meets by spending a turn on it.
    "Only a result of run_read_query can be presented: a plan describes a statement without running it, and a profile counts a table rather than answering the question. Cite either as evidence, but present a read.",
    "A chart names columns of THAT result: they are checked against the result's real column names and refused if they do not match.",
    AGENT_ANSWER_CONTRACT,
    "Then call compose_report. The presentation shows the result; the claims are what say what it means.",
    // The third arm of `agent-data-analysis.1`, in the model's own terms. The verdict
    // now requires the report to be ABOUT the result presented, and the model holds the
    // id it needs — it passed that id to `present_answer` one turn earlier and was
    // answered with it. A rule the model is never told is a rule live runs fail (#350).
    "At least one of those claims must cite the artifact you presented: a report about other evidence entirely is prose beside a picture, and the run is scored as not having answered.",
  ].join(" "),
} satisfies Record<AgentRunWorkflowType, string>);

/**
 * What to do about the tables the packing left out, said only where it can be done.
 *
 * The omission notice is `packContextForTask`'s, and until #411 it ended with this
 * sentence unconditionally — including in plan mode, which holds no tools at all, and
 * for an operations run, which holds no `inspect_schema`. A rule stated to a run whose
 * tool set cannot satisfy it is the #350 failure, so the sentence lives with the
 * caller that knows its own tool set and is passed in by that caller alone.
 */
const INSPECT_SCHEMA_OMISSION_ADVICE = "Call inspect_schema with a table selector to read any of them.";

const SQL_GROUNDING: AgentLanguageGrounding = Object.freeze({
  omissionAdvice: INSPECT_SCHEMA_OMISSION_ADVICE,
  relations: true,
});

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
  grounding: SQL_GROUNDING,
  workflowToolRules: SQL_WORKFLOW_TOOL_RULES,
  shortfallNotices: Object.freeze({}),
} satisfies AgentLanguageServerPack);
