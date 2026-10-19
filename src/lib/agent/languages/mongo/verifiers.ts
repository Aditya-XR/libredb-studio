/**
 * MongoDB's goal rules (#1821), keyed by the verifier id a run persists.
 */

import type { AgentGoalShortfall, AgentGoalVerifierId, VerifiableAgentRun } from "../../goal-verifier";
import { composedClaims, planArtifacts, recommendsIndex, verifyInvestigationGoal } from "../../goal-claims";
import type { AgentEvidenceReference } from "../../types";
import type { AgentGoalRule } from "../pack";

/**
 * The optimization bar where plans cannot be compared: the baseline with plans exempt from its emptiness census, as
 * in `verifyQueryOptimizationGoal` in `goal-verifier.ts`; then an index recommendation citing a plan of this run, or,
 * with no index recommended, a report citing one, which is how "the plan already uses an index, nothing needs to
 * change" answers.
 */
function verifyQueryOptimizationMongoGoal(run: VerifiableAgentRun): readonly AgentGoalShortfall[] {
  const plans = planArtifacts(run.events);
  const baseline = verifyInvestigationGoal(run, plans);
  if (baseline.length > 0) return baseline;
  const cites = (evidence: readonly AgentEvidenceReference[]) =>
    evidence.some((reference) => reference.source === "artifact" && plans.has(reference.correlationId));
  const indexes = run.events.filter(recommendsIndex);
  if (indexes.length > 0) return indexes.some((event) => cites(event.evidence)) ? [] : ["no-plan-evidence"];
  return composedClaims(run.events).some((claim) => cites(claim.evidence)) ? [] : ["no-plan-cited"];
}

export const MONGO_GOAL_RULES: Readonly<Partial<Record<AgentGoalVerifierId, AgentGoalRule>>> = Object.freeze({
  "agent-query-optimization-mongo.1": verifyQueryOptimizationMongoGoal,
});
