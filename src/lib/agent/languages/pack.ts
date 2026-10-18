/**
 * The shape of a statement language's pack (#1821). Types only: nothing here is evaluated, so every tier may read it.
 */
import type { ClusterUsageInput } from "@/lib/db/types";
import type { AgentStatementLanguageId } from "../agent-manifest";
import type { PlanStatementIdentifiers } from "../plan-statement";
import type { AgentProfileDepth } from "../table-profile";
import type { z } from "zod";
import type {
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

/** What a language executes, above `tools.ts`. Reached through `agentLanguagePack` in `index.ts`. */
export interface AgentLanguageExecutionPack {
  readonly arms: LanguageToolArms;
  /** Global by tool name: merged into `AGENT_EVIDENCE_TOOLS` in `index.ts`, where a name two packs hold fails. */
  readonly evidenceTools: Readonly<Partial<Record<EvidenceToolName, AgentEvidenceTool>>>;
}

/**
 * One statement language, whole. Each facet is reachable alone through its tier's accessor, which returns the very
 * object the pack holds: `languageServerPack` in `server.ts` for the server facet, which `tools.ts` reads below the
 * execution tier, and `agentLanguagePack` in `index.ts` for the whole pack, which only the run loop reads.
 */
export interface AgentLanguagePack {
  readonly id: AgentStatementLanguageId;
  readonly server: AgentLanguageServerPack;
  readonly execution: AgentLanguageExecutionPack;
}
