/**
 * kubectl's client facet (#1821): its copy, its workflow variants and its posture, as data a browser bundle may hold.
 * Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on a cluster: Studio's allowlist and the identity's RBAC bound it, not the engine.
 *
 * The body names BOTH identities the agent may run as, the connection's agent token and its
 * own token, rather than the one in use. That is not hedging: the rail is handed a
 * connection id and a type, never the connection's credential fields, so it cannot know
 * whether an agent token is set. Naming both, and recommending a token bound to `view`, is
 * the most this panel can say truthfully.
 */
function kubectlReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per statement, enforced by Studio's request allowlist`,
    title: "Agent mode reads, under a boundary Studio enforces",
    body: `Agent mode runs kubectl reads it wrote itself, bounded to ${rows} rows and ${seconds} seconds each. Studio's request allowlist admits reads only, checked on the final request before it is sent, and the identity's RBAC decides what is visible: the agent runs on the connection's agent token when one is set, and on the connection's own token otherwise, so give it a token bound to view. Values Studio masks, such as env values, annotation values, ConfigMap data and Secret names and values, never reach the model. Nothing reaches your editor.`,
  };
}

export const KUBECTL_CLIENT_PACK = Object.freeze({
  copy: Object.freeze({
    subject: "a Kubernetes cluster",
    noun: "statement",
    argument: "statement",
    writes: "writes, exec, port-forward, proxy and watches",
    reached: "the cluster",
    defect: "your kubectl statement",
    adviceKeys: Object.freeze(["get", "top", "logs", "events"]),
  }),
  variants: Object.freeze({
    /**
     * Reads alone: there is no catalog composer and no plan on a cluster, so `inspect_schema` and `inspect_plan`
     * could only refuse. What the run establishes, it establishes with `run_read_query`, and it is judged by the
     * same bar as an SQL investigation, so the verifier is the SQL one and a plan of it asks for what that one does.
     */
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the cluster that is answered from what the run establishes",
      objective: "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    /**
     * Resource efficiency: the cluster's optimization is not a slow statement but a container sized for what it does
     * not use, so the run reads usage against requests and limits and may recommend new ones.
     *
     * `inspect_usage` and `recommend_change` are kept on a narrowed run because the verdict accepts either a resources
     * recommendation citing a usage reading or a report citing one, and both need the reading first. It requires the
     * usage reading of the engine, without which every tool the verdict asks for could only refuse.
     */
    "query-optimization": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "inspect_usage", "recommend_change", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["inspect_usage", "recommend_change"]),
      classifierDescription:
        "which workloads are over- or under-provisioned: the CPU and memory their containers use against their requests and limits",
      objective:
        "Your objective is resource efficiency: which containers use far less, or far more, CPU and memory than they request, and what requests and limits would fit what they use.",
      planDeliverable: Object.freeze({
        kind: "statement",
        noun: "the kubectl read that measures usage against requests",
      }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["cluster-usage-reading"]),
      verifier: "agent-query-optimization-kubectl.1",
    }),
    /**
     * Cluster health: the cluster's assessment is not the state of its data but the state of its workloads, so the
     * run profiles a namespace and grades what it finds.
     *
     * `profile_workloads` is kept on a narrowed run because the verdict asks for a profile, and nothing else the run
     * can do establishes one. It requires the workload reading of the engine, without which that tool could only
     * refuse.
     */
    "database-assessment": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "profile_workloads", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["profile_workloads"]),
      classifierDescription:
        "the health of a namespace's workloads: replicas not ready, restarts, missing requests, limits or probes, warning events",
      objective:
        "Your objective is the health of this cluster's workloads in a namespace: what is not ready, what restarts, what runs without requests, limits or probes, and what the Warning events say.",
      planDeliverable: Object.freeze({
        kind: "statement",
        noun: "the kubectl read that establishes each workload's state",
      }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["cluster-workload-reading"]),
      verifier: "agent-database-assessment-kubectl.1",
    }),
    operations: OPERATIONS_VARIANT,
    /**
     * A read presented as the answer, the SQL analysis without its profile: a cluster has no table to count.
     *
     * It is judged by the SQL analysis verdict, so `present_answer` is kept on a narrowed run for the same reason. It
     * never auto-executes: the hand-over replays the answer's statement in the user's editor, and a kubectl answer is
     * never run on the editor's terms.
     */
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "present_answer", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the cluster whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about this cluster's objects. Establish the answer from what you read and produce something to show for it.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-data-analysis.1",
    }),
  }),
  planEstimateOperation: null,
  posture: Object.freeze({
    reads: kubectlReadsPosture,
    widened: kubectlReadsPosture,
    handoverTerms: () =>
      "A kubectl answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
