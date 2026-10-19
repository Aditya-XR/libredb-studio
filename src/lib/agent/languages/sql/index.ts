/**
 * SQL as one pack (#1821): its client and server facets and the arms the run loop executes. Execution tier, above
 * `tools.ts`, whose SQL catalog, plan and profile tools the arms run.
 */
import {
  type AgentToolContext,
  inspectPlanTool,
  inspectSchemaTool,
  planTableProfile,
  profileTableTool,
} from "../../tools";
import { catalogSelectorSchema, profileSelectorSchema } from "../../tool-contracts";
import type { AgentLanguagePack } from "../pack";
import { SQL_CLIENT_PACK } from "./client";
import { planStatementSchema } from "./definitions";
import { SQL_SERVER_PACK } from "./server";

export const SQL_PACK = Object.freeze({
  id: "sql",
  client: SQL_CLIENT_PACK,
  server: SQL_SERVER_PACK,
  execution: Object.freeze({
    arms: Object.freeze({
      inspect_schema: Object.freeze({
        inputSchema: catalogSelectorSchema,
        run: (context: AgentToolContext, input: unknown) =>
          inspectSchemaTool(context, input as { schema?: string; table?: string }),
      }),
      inspect_plan: Object.freeze({
        inputSchema: planStatementSchema,
        run: (context: AgentToolContext, input: unknown) => inspectPlanTool(context, input as { sql: string }),
      }),
      profile_table: Object.freeze({
        inputSchema: profileSelectorSchema,
        plan: planTableProfile,
        run: profileTableTool,
      }),
    }),
    evidenceTools: Object.freeze({}),
  }),
} satisfies AgentLanguagePack);
