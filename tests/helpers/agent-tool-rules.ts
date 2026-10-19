import { AGENT_TOOL_DEFINITIONS, type AgentToolName } from "@/lib/agent/tools";

/**
 * The tools a rule text tells the model to use: every tool name it contains, except one written as an absence
 * ("there is no inspect_schema"), which is the operations rules saying what the run does not hold.
 *
 * Shared by the per-language census in `tests/unit/lib/agent/tool-offer-census.test.ts` and the per-engine contract in
 * `tests/unit/lib/agent/engine-pack-contract.test.ts`, so the two read a rule text the same way.
 */
export const toolsNamedIn = (rules: string): AgentToolName[] =>
  (Object.keys(AGENT_TOOL_DEFINITIONS) as AgentToolName[]).filter((tool) =>
    new RegExp(`(?<!\\bno )\\b${tool}\\b`).test(rules),
  );
