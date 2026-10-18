/**
 * The shape of a statement language's pack (#1821). Types only: nothing here is evaluated, so every tier may read it.
 */
import type { ClusterUsageInput } from "@/lib/db/types";
import type { AgentLanguageCopy, AgentStatementLanguageId, AgentWorkflowVariant } from "../agent-manifest";
import type { AgentGoalShortfall, VerifiableAgentRun } from "../goal-verifier";
import type { AgentInventoryNoun } from "../inventory-noun";
import type { PlanStatementIdentifiers } from "../plan-statement";
import type { AgentPosture } from "../posture";
import type { AgentProfileDepth } from "../table-profile";
import type { z } from "zod";
import type {
  AgentOperationId,
  AgentRecommendationOutcome,
  AgentTableProfileOutcome,
  AgentToolContext,
  AgentToolDefinition,
  AgentToolName,
  AgentToolOutcome,
} from "../tools";
import type {
  AgentContextSnapshot,
  AgentEvidenceReference,
  AgentInventory,
  AgentRunEvent,
  AgentRunRecord,
  AgentRunWorkflowType,
} from "../types";

export interface AgentLanguageServerAdapter {
  /** The descriptor this language's model-written reads are evaluated under. */
  readonly readOperation: "sql.query.read" | "kubectl.query.read" | "mongo.query.read";
  /**
   * The model's argument as the one statement text every server layer reads: the fence, the provider, the ledger
   * and the repair identity. Null for any value that carries no statement, which the caller refuses rather than
   * sending.
   */
  readonly canonicalize: (raw: unknown) => string | null;
  /** Total over any text: the repair ledger's identity of one call. */
  readonly fingerprint: (text: string) => string;
  /** The sentence for a read refused past the row budget. */
  readonly rowCapAdvice: (statement: string, allowed: string) => string;
  /** The admission pre-check: the reader's own refusal, or null when admitted. Null for SQL, whose shape advice stays (D6). */
  readonly admit: ((text: string) => { readonly code: string; readonly message: string } | null) | null;
  /** The sentence a shape denial carries, in this language's words. Absent for SQL, whose sentence stays (D6). */
  readonly shapeAdvice?: string;
  /**
   * The check of an admitted statement against the run's captured inventory, for a language whose engine answers a
   * mistake the inventory already shows with an empty result instead of an error: the model's sentence, or null when
   * the inventory sees nothing wrong or cannot tell. Absent for SQL and kubectl, whose engines refuse such a statement
   * themselves. See `mongo/inventory-check.ts`.
   */
  readonly inventoryProblem?: (text: string, inventory: AgentInventory | null) => string | null;
  /**
   * The names a plan-mode draft in this language uses, read against the inventory, for a language whose drafts this
   * server can read for names although the SQL guard cannot read them. Absent for SQL, whose drafts the SQL reader in
   * `plan-statement.ts` checks, and for kubectl.
   */
  readonly planDraftIdentifiers?: (text: string, inventory: AgentInventory | null) => PlanStatementIdentifiers;
}

/**
 * A `recommend_change` card a language offers in place of the statement card: a change stated as data, for a
 * language whose change is no statement an editor runs. `recommendChangeTool` in `tools.ts` parses the call with the
 * offered definition's schema, and where that schema is this card's, it checks every evidence reference against the
 * run's ledger and refuses an unverifiable one before the card is read, so `record` only ever sees verified evidence.
 */
export interface AgentRecommendationCard<
  Card extends { readonly evidence: readonly AgentEvidenceReference[] } = {
    readonly evidence: readonly AgentEvidenceReference[];
  },
> {
  readonly inputSchema: z.ZodType<Card>;
  /** Called after the core verified the card's evidence; returns the outcome verbatim. */
  record(events: readonly AgentRunEvent[], card: Card): AgentRecommendationOutcome;
}

/**
 * How an agent-mode run of a language is grounded in words its own tools can act on.
 *
 * `omissionAdvice` names the tool that reads what the packing left out: `inspect_schema` on SQL, and on kubectl,
 * which holds no `inspect_schema`, a `run_read_query` get. `relations` says whether the relations block is shown at
 * all: a cluster declares no foreign keys, and the block's own omission advice names `inspect_schema` again.
 * `ungrounded` replaces the capture's own advice where the run cannot be ungrounded in the capture's words, which
 * send a model to `inspect_schema`; absent, the capture's text is forwarded as it always was. The diagnosis is
 * passed through as-is, joined with a newline, for the reasons `operationsUngroundedNote` records.
 */
export interface AgentLanguageGrounding {
  readonly omissionAdvice: string;
  readonly relations: boolean;
  readonly ungrounded?: (detail: string, noun: AgentInventoryNoun) => string;
  /**
   * The language's engine declares no fields, so its inventory's are inferred from sampled documents and a field
   * every sample held is no constraint: the packing then states no NOT NULL (`packContextForTask`).
   */
  readonly sampledFields?: boolean;
  /** What a plan-mode draft in this language is told on top of the shared contract (`planningStatementContract`). */
  readonly planningRules?: readonly string[];
}

/** What a run is told about a shortfall, and whether it is narrowed to its verdict's tools while it acts on it. */
export interface ShortfallAdvice {
  readonly said: string;
  /**
   * Whether narrowing the run to its verdict's tools would HELP this shortfall.
   *
   * False wherever the fix lies outside that set, and an eval caught the case immediately:
   * the answer to `no-plan-evidence` is to call `inspect_plan`, which is a READING tool and
   * so not among the tools the optimization verdict accepts. Narrowing there would have
   * removed the very tool this notice asks for — telling a run to do something and taking
   * away its means of doing it, which is the shape of mistake this file has already paid
   * for twice.
   */
  readonly narrow: boolean;
}

/**
 * What the run holds and calls things, as a shortfall notice needs it: the plans it inspected, oldest first, whether it
 * is offered `compare_plans` at all, and what its language calls one unit it sends.
 */
export interface ShortfallContext {
  readonly plans: readonly string[];
  readonly readingsHeld: number;
  readonly holdsPresentable: boolean;
  readonly holdsCompare: boolean;
  readonly noun: string;
}

/**
 * One shortfall's notice: the advice for a report about to be refused, from the table it spoke of and what the run
 * holds, or null where this shortfall cannot honestly be asked about on this run.
 */
export type ShortfallNotice = (table: string | undefined, context: ShortfallContext) => ShortfallAdvice | null;

/** What a language does on the server, below `tools.ts`. Reached through `languageServerPack` in `server.ts`. */
export interface AgentLanguageServerPack {
  readonly adapter: AgentLanguageServerAdapter;
  /**
   * The tool definitions a workflow on this language replaces, keyed by workflow, because a language's tools are not
   * uniform across its workflows: one kubectl workflow may be offered a schema another is not. Keyed rather than
   * compared, so a later language or workflow registers its own row and no call site changes. Read by
   * `agentToolDefinition` in `tools.ts`; a tool no row names is the core's own definition.
   */
  readonly toolOverrides: Readonly<
    Partial<Record<AgentRunWorkflowType, Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>>>>
  >;
  /**
   * Tools only this language's workflows offer, which have no core definition to override. Merged into
   * `AGENT_TOOL_DEFINITIONS` through `LANGUAGE_BASE_DEFINITIONS` in `server.ts`, so a tool name is still defined once.
   */
  readonly baseDefinitions: Readonly<Partial<Record<AgentToolName, AgentToolDefinition>>>;
  /**
   * `ANSWER_NOT_A_DATA_READ` in the words of this language, the refusal a run meets when it presents a plan or a
   * profile.
   */
  readonly answerNotADataRead: string;
  /**
   * The advice for a statement that read another engine's catalog, from the engine's message and the engine this
   * connection is, or undefined when the message names no foreign catalog. Absent for a language with no such mistake.
   */
  readonly catalogAdvice?: (message: string, engine: string) => string | undefined;
  /** The card this language's `recommend_change` offers instead of the statement card. Absent for SQL. */
  readonly recommendationCard?: AgentRecommendationCard;
  /** How an agent-mode run of this language is grounded in words its own tools can act on. */
  readonly grounding: AgentLanguageGrounding;
  /**
   * The tool rules by workflow, for the workflows this language has a variant of and no more. Read through
   * `workflowToolRules` in `investigation.ts`, which throws for a workflow the record does not hold.
   */
  readonly workflowToolRules: Readonly<Partial<Record<AgentRunWorkflowType, string>>>;
  /**
   * The shortfall notices only this language's verdicts call for. Global by shortfall: merged into
   * `LANGUAGE_SHORTFALL_NOTICES` in `server.ts`, and with the core's in `investigation.ts`, where a shortfall two
   * owners both speak for fails at load.
   */
  readonly shortfallNotices: Readonly<Partial<Record<AgentGoalShortfall, ShortfallNotice>>>;
  /**
   * What a run is told the moment it holds a usage reading, for the one language whose workflow is judged on one.
   * Read through `LANGUAGE_USAGE_BAR_NOTICE` in `server.ts`, which exactly one pack supplies.
   */
  readonly usageBarNotice?: string;
}

/** A catalog arm: the selector it parses, and the read. `snapshot` is the inventory this run captured, or null. */
export interface InspectSchemaArm {
  readonly inputSchema: z.ZodType<unknown>;
  run(context: AgentToolContext, input: unknown, snapshot: AgentContextSnapshot | null): Promise<AgentToolOutcome>;
}

/** A plan arm: the statement it parses, and the estimating plan of it. */
export interface InspectPlanArm {
  readonly inputSchema: z.ZodType<unknown>;
  run(context: AgentToolContext, input: unknown, snapshot?: AgentContextSnapshot | null): Promise<AgentToolOutcome>;
}

/**
 * What every language's planned profile carries for the step it settles as: the target the spelling RESOLVED to, the
 * depth, and where in the object's columns the batch starts. Two requests naming one object at one depth and one
 * batch are one step, whatever spelling reached it.
 */
export interface ProfileArmPlan {
  readonly target: { readonly schema?: string; readonly table: string };
  readonly depth: AgentProfileDepth;
  readonly from: number;
}

/**
 * A profile arm: the selector its planning step parses, the planning step that resolves and composes and reaches
 * nothing, and the read of what it planned. `run` is only ever handed the plan its own `plan` produced, which is what
 * lets each language's plan carry what that language's read needs.
 */
export interface ProfileArm<Plan extends ProfileArmPlan = ProfileArmPlan> {
  readonly inputSchema: z.ZodType<unknown>;
  plan(
    context: AgentToolContext,
    run: Pick<AgentRunRecord, "runId" | "events">,
    input: unknown,
  ): { readonly kind: "planned"; readonly plan: Plan } | (AgentToolOutcome & { readonly kind: "unavailable" });
  run(context: AgentToolContext, plan: Plan): Promise<AgentTableProfileOutcome>;
}

/**
 * What a statement language does when a run calls one of the tools whose execution differs by language:
 * `inspect_schema`, `inspect_plan` and `profile_table`.
 *
 * The execution half of what a pack's `toolOverrides` is for the offer, keyed the same way, by language: a run is
 * offered a language's definition of a tool and executed by that language's arm of it, so the two cannot come to
 * disagree, and nothing anywhere tests a language id to choose between them. Each arm declares as its input the
 * exported schema its tool parses with, and `tests/unit/lib/agent/tool-offer-census.test.ts` holds that declaration
 * equal to the schema the definition offers, so what a run is offered is what it is held to. The operation a step is
 * recorded under is the definition's own (`agentToolDefinition`), as it is for every database tool, so an arm does not
 * declare a second one.
 *
 * A language that offers none of these tools has none (kubectl, whose variants offer reads and curated readings only);
 * the run loop treats a tool it is asked to execute with no arm as its own fault, never as a reason to fall back to
 * SQL's.
 */
export interface LanguageToolArms {
  readonly inspect_schema?: InspectSchemaArm;
  readonly inspect_plan?: InspectPlanArm;
  readonly profile_table?: ProfileArm;
}

/**
 * The curated cluster readings whose result is EVIDENCE of a kind a verdict asks for, so the drive writes an event of
 * that kind beside the settled step. They reach the cluster through `service.runStep` like any database tool and are
 * handled apart only because of that event; see `readEvidence` in `investigation.ts`.
 */
export type EvidenceToolName = "inspect_usage" | "profile_workloads";

/** One evidence tool, as the run loop executes it. */
export interface AgentEvidenceTool {
  /**
   * The argument schema, which names the namespace the event records. Typed as the usage reading's input because it is
   * the wider of the two: a profile's namespace alone is one with no selector.
   */
  readonly input: z.ZodType<ClusterUsageInput>;
  readonly run: (context: AgentToolContext, input: unknown) => Promise<AgentToolOutcome>;
  /**
   * The event the tool writes when it completes. Typed through the event union, so a kind the ledger does not admit
   * cannot be named here.
   */
  readonly event: Extract<AgentRunEvent["kind"], "usage-read" | "workloads-profiled">;
}

/**
 * One verifier id's rule. A language's rules live in `<id>/verifiers.ts` and reach `goal-verifier.ts` only through
 * `LANGUAGE_GOAL_RULES` in `verifiers.ts`, keyed by the persisted id, so a resumed run is judged by its own id whatever
 * its language.
 */
export type AgentGoalRule = (run: VerifiableAgentRun) => readonly AgentGoalShortfall[];

/** What a language executes, above `tools.ts`. Reached through `agentLanguagePack` in `index.ts`. */
export interface AgentLanguageExecutionPack {
  readonly arms: LanguageToolArms;
  /** Global by tool name: merged into `AGENT_EVIDENCE_TOOLS` in `index.ts`, where a name two packs hold fails. */
  readonly evidenceTools: Readonly<Partial<Record<EvidenceToolName, AgentEvidenceTool>>>;
}

/** The per-statement bounds a posture or a consent sentence names: rows and seconds, from one policy row. */
export type StatementBudgets = { readonly maxResultRows: number; readonly statementTimeoutMs: number };

/**
 * What a language contributes to the browser: data a client bundle may hold, with no server code behind it. Reached
 * through `languageClientPack` in `client.ts`, and read whole by `agent-manifest.ts` through its projections.
 */
export interface AgentLanguageClientPack {
  /** The words the run's sentences use: `AGENT_LANGUAGE_COPY` in `agent-manifest.ts` projects it. */
  readonly copy: AgentLanguageCopy;
  /** The language's workflow variants: `AGENT_WORKFLOW_VARIANTS` in `agent-manifest.ts` projects it. */
  readonly variants: Readonly<Partial<Record<AgentRunWorkflowType, AgentWorkflowVariant>>>;
  /** The operation the language's `inspect_plan` drives, or null with no plan to read: `AGENT_PLAN_ESTIMATE_OPERATION`. */
  readonly planEstimateOperation: AgentOperationId | null;
  /** What `posture.ts` says of an agent-mode run in this language. */
  readonly posture: {
    /**
     * Agent mode, executing on its own path and nowhere else, under the boundary its language declares. Keyed by
     * language rather than compared, like the hand-over terms.
     */
    readonly reads: (bounds: StatementBudgets) => AgentPosture;
    /**
     * Agent mode with the editor hand-over consented: still read-only, and one statement wider.
     *
     * Only SQL has a widened reading. On a cluster and on MongoDB no workflow variant offers the
     * hand-over, so a tick there consents to nothing and the posture stays the reads one: a
     * "widened" pill would claim an editor run the engine never performs.
     */
    readonly widened: (bounds: StatementBudgets) => AgentPosture;
    /**
     * One consent sentence per statement language, keyed rather than compared, so a language
     * registered in the manifest does not compile until it says what its hand-over is.
     */
    readonly handoverTerms: (budgets: StatementBudgets) => string;
  };
}

/**
 * One statement language, whole. Each facet is reachable alone through its tier's accessor, which returns the very
 * object the pack holds: `languageClientPack` in `client.ts` for the client facet, which the browser modules read,
 * `languageServerPack` in `server.ts` for the server facet, which `tools.ts` reads below the execution tier, and
 * `agentLanguagePack` in `index.ts` for the whole pack, which only the run loop reads.
 */
export interface AgentLanguagePack {
  readonly id: AgentStatementLanguageId;
  readonly client: AgentLanguageClientPack;
  readonly server: AgentLanguageServerPack;
  readonly execution: AgentLanguageExecutionPack;
}
