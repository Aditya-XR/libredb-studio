/**
 * MongoDB as one pack (#1821): its server facet and the arms the run loop executes (`./tools.ts`). Execution tier,
 * above `tools.ts`.
 */
import { catalogSelectorSchema } from "../../tool-contracts";
import type { AgentLanguagePack } from "../pack";
import { mongoPlanCommandSchema, mongoProfileSelectorSchema } from "./definitions";
import { MONGO_SERVER_PACK } from "./server";
import { mongoInspectPlanTool, mongoInspectSchemaTool, planMongoProfile, runMongoProfile } from "./tools";

export const MONGO_PACK = Object.freeze({
  id: "mongo",
  server: MONGO_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({
      inspect_schema: Object.freeze({ inputSchema: catalogSelectorSchema, run: mongoInspectSchemaTool }),
      inspect_plan: Object.freeze({ inputSchema: mongoPlanCommandSchema, run: mongoInspectPlanTool }),
      profile_table: Object.freeze({
        inputSchema: mongoProfileSelectorSchema,
        plan: planMongoProfile,
        run: runMongoProfile,
      }),
    }),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
