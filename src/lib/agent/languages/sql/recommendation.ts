/**
 * The statement card SQL's `recommend_change` offers (#1821): one index or one rewrite, as the statement the user's
 * editor runs. It is the reference card, the one the reference `recommend_change` definition offers, so it also reads
 * the call of every workflow a family's `toolOverrides` leave on the reference definition. Its readings and refusal
 * copy are about a statement, which is why they are this card's hooks and no other card's.
 */
import { z } from "zod";
import { inspectAgentStatement } from "@/lib/db/operations/statement-guard";
import { PLAN_ESTIMATE_OPERATIONS } from "../../agent-manifest";
import { offersRefusalExamples } from "../../models";
import { AGENT_EVIDENCE_CONTRACT, evidenceSchema, unavailable } from "../../tool-contracts";
import type { AgentToolDefinition } from "../../tools";
import type { AgentEvidenceReference, AgentRunEvent } from "../../types";
import type { AgentRecommendationCard } from "../pack";

const recommendationSchema = z.strictObject({
  change: z.enum(["index", "rewrite"]),
  statement: z.string().min(1),
  rationale: z.string().min(1),
  evidence: z.array(evidenceSchema).min(1),
});

/**
 * What a `recommend_change` call parses to on the statement card. A language's own card parses to its own shape, and
 * `recommendChangeTool` hands that to the card rather than reading it here.
 */
type RecommendationInput = z.infer<typeof recommendationSchema>;

/** The four keys `recommendationSchema` accepts, for the lone-rename reading below. */
const RECOMMENDATION_KEYS = ["change", "statement", "rationale", "evidence"] as const;

/**
 * Which kind of change a statement IS, read from the statement itself.
 *
 * Only the two openings that are unmistakable. A model that writes prose here has named no
 * statement, and guessing one would be this server composing the SQL it declines to execute.
 */
function changeKindOf(statement: string): "index" | "rewrite" | undefined {
  if (/^\s*create\s+(unique\s+)?index\b/i.test(statement)) return "index";
  if (/^\s*(select|with)\b/i.test(statement)) return "rewrite";
  return undefined;
}

/**
 * The `recommend_change` call as models send it, read back into the call the schema accepts.
 *
 * Measured 2026-09-17 by capturing the ARGUMENTS of every refused call on the two surfaces that
 * were failing - something the ledger deliberately does not record, and the reason this shape went
 * eleven measurement days unseen. Seventeen refusals, NINE of them one shape:
 *
 *     {"change": "CREATE INDEX idx_employee_emp_no ON employee(emp_no);",
 *      "reason": "...", "evidence": {"correlationId": "772210b6-...", "source": "artifact"}}
 *
 * Every value in it is right - valid DDL that answers the objective, a real rationale, and a
 * correlation id the run genuinely produced. Three are displaced, each in its only plausible
 * direction: the statement sits in a field named `change`, the rationale is called `reason`, and
 * one evidence item arrived as itself rather than as a list of one. What the model was told was
 * that three fields were missing, about a call carrying all three values, nine times.
 *
 * Read in the order that makes each step unambiguous, and no step guesses:
 *
 *   the statement names its own KIND. `CREATE INDEX` is an index and a `SELECT` is a rewrite;
 *   anything else stays refused, because prose in that field names no statement to offer.
 *
 *   then exactly one absent field and exactly one surplus key is a rename and cannot be
 *   anything else. `renamesAmong` pairs names that are the same word - it cannot pair `reason`
 *   with `rationale` - and a 1:1 remainder needs no spelling at all. Two of either and this
 *   does nothing: a model choosing between two fields must be told, not guessed at.
 *
 *   then a lone evidence object is the one-item list the contract describes.
 *
 * Nothing is invented and no value is altered; the keys a model used are structural exactly as
 * `renamesAmong` argues, and every repaired call still goes through the same schema and the same
 * citation contract as one that arrived correct.
 */
function readDisplacedRecommendation(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  let read = { ...(input as Record<string, unknown>) };

  const { change, statement } = read;
  if (typeof change === "string" && change !== "index" && change !== "rewrite" && statement === undefined) {
    const kind = changeKindOf(change);
    if (kind !== undefined) read = { ...read, change: kind, statement: change };
  }
  /*
    The statement decides the kind whenever the card cannot say it, or says it wrong.
    121 refusals in one sweep, three inputs, one question:

      `change: null`                                        - nothing said
      `change: "CREATE INDEX ..."` with `statement` FILLED   - the clause above only moves SQL
                                                              out of `change` when `statement` is
                                                              empty, so a model that filled both
                                                              got nothing
      `change: "index"` with a SELECT in `statement`         - said, and contradicted by the SQL
                                                              (50 of these; five consecutive
                                                              `granite4.2:3b` confirmations died
                                                              on this one refusal)

    Only one of the two fields can be trusted and it is the statement: `CREATE INDEX` or `SELECT`
    IS the kind of change, while `change` is a label chosen before the SQL was written. Applied
    only where the statement names its own kind, so prose still reaches the refusal it earns.
  */
  const written = read["statement"];
  if (typeof written === "string") {
    const kind = changeKindOf(written);
    if (kind !== undefined && read["change"] !== kind) read = { ...read, change: kind };
  }

  /*
    The statement under a key the model chose, when `statement` is empty.

    The largest single refusal in the measurement, and the statement was never missing. Of 1595
    captured `recommend_change` refusals carrying `statement: expected string, received nothing`,
    949 hold a complete `CREATE INDEX` somewhere else: 576 as `{"sql": "CREATE INDEX ..."}` alone,
    301 with an `index_name` beside it, 72 with the table and column spelled out too. One model
    sent that shape 1189 times - which is the proof that the sentence it got back was unusable,
    because a model able to act on "statement: expected string, received nothing" does not repeat
    the bytes it just sent 1189 times.

    Read by the statement's own opening rather than by a list of blessed key names: `CREATE INDEX`
    or `SELECT` IS the kind of change, so `changeKindOf` both identifies the value and decides the
    kind, and prose under the same key still names no statement and is still refused. The key the
    model reached for is not evidence of anything and is deliberately not consulted.

    Only where `statement` is absent, so a call that filled it correctly is never touched. And the
    lone-rename rule below cannot serve this: it needs exactly one absent field and exactly one
    surplus key, while these calls are missing three and often carry two or three extras.

    It buys 37 calls outright. Its real work is on the other 1196, which carry ONLY the statement:
    reading it leaves the refusal naming `rationale` and `evidence` - the two that are genuinely
    absent - instead of four fields of which three had arrived.
  */
  if (read["statement"] === undefined) {
    for (const [key, value] of Object.entries(read)) {
      if ((RECOMMENDATION_KEYS as readonly string[]).includes(key)) continue;
      if (typeof value !== "string") continue;
      const kind = changeKindOf(value);
      if (kind === undefined) continue;
      const { [key]: _moved, ...rest } = read;
      read = { ...rest, change: kind, statement: value };
      break;
    }
  }

  const absent = RECOMMENDATION_KEYS.filter((key) => read[key] === undefined);
  const surplus = Object.keys(read).filter((key) => !(RECOMMENDATION_KEYS as readonly string[]).includes(key));
  if (absent.length === 1 && surplus.length === 1) {
    const [to] = absent as [(typeof RECOMMENDATION_KEYS)[number]];
    const [from] = surplus as [string];
    const { [from]: moved, ...rest } = read;
    read = { ...rest, [to]: moved };
  }

  /*
    An evidence item inside a wrapper named after its own source.

    150 refusals from `granite4.1:3b` in one sweep, 71 of them exactly
    `{"artifact": {"correlationId": "...", "source": "artifact"}}` - the reference complete and
    correct, one level down. The lone-object reading below then made it the single member of a
    list and the schema reported `evidence.0.source: invalid union`, which is true of the WRAPPER
    and says nothing about what it holds. That cell is `granite4.1:3b` optimize, 0/5 over five
    readings and the last one between that model and 30/30.

    One key whose value carries `source` is unambiguous. Two keys is a model saying something this
    cannot read, and choosing a half would be the server choosing the citation.
  */
  const acilan = (item: unknown): unknown => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
    const fields = item as Record<string, unknown>;
    if ("source" in fields) return item;
    const keys = Object.keys(fields);
    if (keys.length !== 1) return item;
    const inner = fields[keys[0] as string];
    if (typeof inner === "object" && inner !== null && !Array.isArray(inner) && "source" in inner) return inner;
    return item;
  };

  const { evidence } = read;
  if (Array.isArray(evidence)) {
    read = { ...read, evidence: evidence.map(acilan) };
  } else if (typeof evidence === "object" && evidence !== null) {
    read = { ...read, evidence: [acilan(evidence)] };
  }
  /*
    And the array serialized as a string, which is `readSerializedClaims`' case one field over.

    Captured on `llama3.1:8b` optimize: `change`, `statement` and `rationale` all correct and
    `evidence` a JSON string holding the array. A transport that stringifies one argument
    stringifies it wherever it appears, so the reading claims already get is the reading this
    needs. Left alone when it will not parse, for `AGENT_CLAIMS_NOT_JSON`'s reason: a sentence
    where an array goes is not an encoding to read.
  */
  if (typeof evidence === "string") {
    try {
      read = { ...read, evidence: JSON.parse(evidence) };
    } catch {
      return read;
    }
  }
  return read;
}

/** The reference `recommend_change` definition, the one `AGENT_TOOL_DEFINITIONS` holds. */
export const SQL_RECOMMEND_CHANGE: AgentToolDefinition = Object.freeze({
  name: "recommend_change",
  description: `Propose one index or one rewrite for the user to apply themselves. The statement is never executed by this run; it is offered to the user's editor. Every recommendation must cite evidence this run produced. ${AGENT_EVIDENCE_CONTRACT}`,
  inputSchema: recommendationSchema,
});

/**
 * `recommend_change`'s own call shape — the one evidence-bearing tool that never stated it.
 *
 * `compose_report` has `AGENT_CLAIM_SHAPE` and `present_answer` has `AGENT_ANSWER_SHAPE`, both
 * ungated. This tool had neither: `isShapeFailure` tests for a `claims` path and this call has no
 * `claims` field, so that branch could never fire for it, and the only place its shape could reach
 * a model was `exampleRecommendCall` behind the `refusalExamples` lever.
 *
 * Measured on `qwen2.5:7b`, query-optimization, 25 runs: the 9 that passed recorded a `statement`,
 * the 16 that lost recorded none — and nothing else separated them. What the losing runs sent was
 * `{"change","evidence","rationale"}`, three keys and never a fourth, while the SAME TURN wrote
 * the value the missing field wants as prose: "Here is the SQL statement for creating the index:
 * ```sql CREATE INDEX idx_employee_name ON employee(first_name, last_name); ```". The passing runs
 * carry that exact string in `statement`. The model did not know the field existed.
 *
 * What it read instead was `statement: expected string` followed by a paragraph about `evidence` —
 * the one field it had got right on all 134 attempts.
 */
const AGENT_RECOMMENDATION_SHAPE =
  'The call is ONE object: {"change": "index", "statement": "<the CREATE INDEX or the rewritten SELECT, as SQL text>", "rationale": "<why it answers the objective>", "evidence": [ ... ]} — "statement" is that SQL itself, as a plain string in this call; SQL written only in your reply is not part of it.';

/**
 * What a run is told when its call describes the change in PARTS rather than as a statement.
 *
 * The largest shape in the 2026-09-17 argument capture - five of six refusals on `llama3.1:8b`
 * optimize - carries none of the four fields at all:
 *
 *     {"table_name": "employee", "column_name": "emp_no", "index_name": "emp_no_idx"}
 *
 * Nothing is misfiled. The model believes this tool BUILDS the index from its parts, the way most
 * index APIs do, and the refusal it was getting - three fields absent - describes fields it does
 * not believe in. `AGENT_RECOMMENDATION_SHAPE` was being sent too and answers the other question,
 * what the call looks like, which to a model that thinks the server writes the SQL reads as
 * agreement.
 *
 * The server does not compose it, and that is the same line `changeKindOf` draws on prose in
 * `change`: the DDL here is fully determined by three names, and writing it would be this server
 * authoring the statement it declines to execute - for a run that also supplied no evidence for it.
 * So the sentence says which of the two writes the SQL, and says it only where the call carries
 * none of the four fields: a model that sent three of them is misfiling, not misunderstanding, and
 * would be answered with a lecture.
 */
const AGENT_RECOMMENDATION_NOT_ASSEMBLED =
  "This tool does not compose the statement from parts: there is no table, column or index-name field, and the server will not build the SQL for you. Write the statement yourself — the CREATE INDEX or the rewritten SELECT, as SQL text — and cite a result this run read.";

/** Whether a call named none of the four fields, which is the parts case rather than a misfiling. */
function describedInParts(input: unknown): boolean {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return false;
  return RECOMMENDATION_KEYS.every((key) => (input as Record<string, unknown>)[key] === undefined);
}

/**
 * Whether a `recommend_change` call failed on one of its OWN top-level fields.
 *
 * Whole-path tokens only, the same restraint `isShapeFailure` shows: a fault inside an evidence
 * item (`evidence.0.source`) is a one-word correction, and answering it with the whole wrapper
 * would bury the word that has to change.
 */
function isRecommendationShapeFailure(problems: string): boolean {
  return /(^|[\s,])(change|statement|rationale|evidence): /.test(problems);
}

/**
 * A minimal, VALID `recommend_change` call for this run, or nothing when it holds no plan.
 *
 * The index arm, because that is the one an optimization verdict accepts without a comparison:
 * a run holding ONE plan satisfies its bar by recommending an index that cites that plan, and
 * that is exactly the call one evaluated model failed on the shape of four times in a single run
 * while its prose showed it knew what to say.
 *
 * The statement is a placeholder naming no table on purpose. This layer knows which plan the
 * run holds; it does not know which column the model thinks should be indexed, and inventing
 * one would be this server writing a recommendation and attributing it to the model.
 */
function exampleRecommendCall(events: readonly AgentRunEvent[]): string | undefined {
  let plan: string | undefined;
  for (const event of events) {
    if (event.kind === "tool-completed" && PLAN_ESTIMATE_OPERATIONS.has(event.artifact.operationId))
      plan = event.artifact.correlationId;
  }
  if (plan === undefined) return undefined;
  return JSON.stringify({
    change: "index",
    statement: "CREATE INDEX <name> ON <table> (<column>)",
    rationale: "<why this index answers the objective>",
    evidence: [{ source: "artifact", correlationId: plan }],
  });
}

const CREATE_INDEX_STATEMENT = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i;

/**
 * Does the statement match the card it is offered under? Found by review on #344.
 *
 * The headline the rail renders — "Index recommended" — is the APP's own words, and
 * it has to be true. Without this, a model could file a `DROP TABLE` under an index
 * card, and the rail would assert the app's claim over it and offer the statement to
 * the user's editor. Nothing here executes anything, so this is not a security
 * boundary; it is the app refusing to say something it cannot support.
 *
 * The structural checks are the SHARED guard's rather than a second parser: one
 * determinate statement, no second statement after a terminator. `NON_READ_STATEMENT`
 * is the only violation an index card may carry, because a `CREATE INDEX` is by
 * definition not a read.
 */
function matchesCard(change: "index" | "rewrite", statement: string): boolean {
  const violation = inspectAgentStatement(statement);
  if (change === "rewrite") return violation === null;
  return (violation === null || violation === "NON_READ_STATEMENT") && CREATE_INDEX_STATEMENT.test(statement);
}

/**
 * The statement card. `recommendChangeTool` in `tools.ts` reads a call with it wherever the offered definition is the
 * reference one: the displaced-field repair before the call is parsed, the shape sentences and the worked call when it
 * does not parse, and the card match before the core checks the evidence, so a statement card refuses in the order
 * parse, shape mismatch, evidence.
 */
export const SQL_STATEMENT_CARD = Object.freeze<AgentRecommendationCard<RecommendationInput>>({
  inputSchema: recommendationSchema,
  prepare: readDisplacedRecommendation,
  refuseParse(input, problems, events, modelId) {
    return {
      example: offersRefusalExamples(modelId) ? exampleRecommendCall(events) : undefined,
      // The only site that passes a shape, and the reason this parameter exists: see
      // `AGENT_RECOMMENDATION_SHAPE`. The worked call above stays behind the lever it was
      // measured on; the one line stating the contract goes to every model, as it does for
      // this tool's two evidence-bearing siblings.
      shape: describedInParts(input)
        ? AGENT_RECOMMENDATION_NOT_ASSEMBLED
        : isRecommendationShapeFailure(problems)
          ? AGENT_RECOMMENDATION_SHAPE
          : undefined,
    };
  },
  refuseBeforeEvidence(card, events, modelId) {
    if (!matchesCard(card.change, card.statement)) {
      /*
        With a worked call where the model has earned one. One model hit this refusal five times
        in a single optimization run — the card said `index` and the statement was not a CREATE
        INDEX, or the reverse — and the sentence above names the rule without showing either
        shape. It is the one evidence-bearing refusal that carried no example.
      */
      return unavailable(
        "RECOMMENDATION_SHAPE_MISMATCH",
        offersRefusalExamples(modelId) ? exampleRecommendCall(events) : undefined,
      );
    }
    return undefined;
  },
  record(_events, card) {
    return {
      kind: "recommended",
      recommendation: {
        change: card.change,
        statement: card.statement,
        rationale: card.rationale,
        // Carried by the schema's `.min(1)`, which the type system cannot see; an
        // unreachable emptiness guard would be a line no test could cover.
        evidence: card.evidence as [AgentEvidenceReference, ...AgentEvidenceReference[]],
      },
      modelText: `Recommendation recorded: one ${card.change}, offered to the user and not executed. It is theirs to apply.`,
    };
  },
});
