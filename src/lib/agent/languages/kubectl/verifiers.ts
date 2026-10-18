/**
 * kubectl's goal rules (#1821), keyed by the verifier id a run persists.
 */

import type { AgentGoalShortfall, AgentGoalVerifierId, VerifiableAgentRun } from "../../goal-verifier";
import { composedClaims, verifyInvestigationGoal } from "../../goal-claims";
import type { AgentEvidenceReference, AgentRunEvent } from "../../types";
import type { AgentGoalRule } from "../pack";

/** Every usage reading THIS run took, by the id a citation would name. */
function usageArtifacts(events: readonly AgentRunEvent[]): ReadonlySet<string> {
  return new Set(events.flatMap((event) => (event.kind === "usage-read" ? [event.artifact.correlationId] : [])));
}

/**
 * Resource efficiency on a cluster: the investigation baseline over the run's own artifacts, with a usage reading
 * counted as meaningful even when empty (a namespace with nothing running is an answer); then either a resources
 * recommendation citing a usage reading of this run, or a report citing one and recommending nothing, because a
 * well-sized namespace must not force an invented change. A run whose only reading was "metrics unavailable" stays
 * unanswered under its own name, so the rail can say metrics-server is missing rather than that the model failed.
 */
function verifyQueryOptimizationKubectlGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const usage = usageArtifacts(run.events);
  const baseline = verifyInvestigationGoal(run, usage);
  if (baseline.length > 0) return baseline;
  if (usage.size === 0)
    return run.events.some((event) => event.kind === "usage-unavailable") ? ["no-usage-metrics"] : ["no-usage-reading"];
  const cites = (evidence: readonly AgentEvidenceReference[]) =>
    evidence.some((reference) => reference.source === "artifact" && usage.has(reference.correlationId));
  const resources = run.events.flatMap((event) =>
    event.kind === "recommendation" && event.change === "resources" ? [event] : [],
  );
  if (resources.length > 0) return resources.some((event) => cites(event.evidence)) ? [] : ["no-usage-evidence"];
  return composedClaims(run.events).some((claim) => cites(claim.evidence)) ? [] : ["no-usage-evidence"];
}

/**
 * Cluster health: the investigation baseline over the run's own artifacts, with a workload profile counted as
 * meaningful even when empty (an empty namespace is an answer), then at least one profile.
 */
function verifyDatabaseAssessmentKubectlGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const profiles = new Set(
    run.events.flatMap((event) => (event.kind === "workloads-profiled" ? [event.artifact.correlationId] : [])),
  );
  const baseline = verifyInvestigationGoal(run, profiles);
  if (baseline.length > 0) return baseline;
  return profiles.size > 0 ? [] : ["no-workload-profile"];
}

export const KUBECTL_GOAL_RULES: Readonly<Partial<Record<AgentGoalVerifierId, AgentGoalRule>>> = Object.freeze({
  "agent-query-optimization-kubectl.1": verifyQueryOptimizationKubectlGoal,
  "agent-database-assessment-kubectl.1": verifyDatabaseAssessmentKubectlGoal,
});
