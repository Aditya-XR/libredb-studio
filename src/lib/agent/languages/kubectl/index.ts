/**
 * kubectl as one pack (#1821): its server facet and what the run loop executes. Its variants offer reads and curated
 * readings only, so it has no tool arms; its two curated readings are evidence tools (`./tools.ts`). Execution tier,
 * above `tools.ts`.
 */
import { clusterUsageReadInput, clusterWorkloadsReadInput } from "@/lib/db/operations/descriptors";
import type { AgentLanguagePack } from "../pack";
import { KUBECTL_SERVER_PACK } from "./server";
import { inspectUsageTool, profileWorkloadsTool } from "./tools";

export const KUBECTL_PACK = Object.freeze({
  id: "kubectl",
  server: KUBECTL_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({}),
    evidenceTools: Object.freeze({
      inspect_usage: Object.freeze({ input: clusterUsageReadInput, run: inspectUsageTool, event: "usage-read" }),
      profile_workloads: Object.freeze({
        input: clusterWorkloadsReadInput,
        run: profileWorkloadsTool,
        event: "workloads-profiled",
      }),
    }),
  }),
} satisfies AgentLanguagePack);
