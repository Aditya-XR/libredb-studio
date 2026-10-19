/**
 * The engine packs, whole (#1821): one engine's family pack with the engine's overlays applied.
 *
 * Execution tier, like `languages/index.ts`, whose packs it overlays. Nothing in the run loop reads it yet: the run
 * reads its family pack (`agentLanguagePack`), and `tests/unit/lib/agent/engine-overlays.test.ts` holds every engine
 * pack to that family pack member for member, so moving a reader onto this resolver changes nothing it reads.
 */
import type { DatabaseType } from "@/lib/types";
import { AGENT_STATEMENT_LANGUAGE } from "../../agent-manifest";
import { agentLanguagePack } from "../index";
import { defineOverlay } from "../overlay";
import type { AgentEnginePack, AgentEngineType } from "../pack";
import { engineClientPack } from "./client";
import { engineServerOverlay } from "./server";

/**
 * The pack of `type`: its family pack itself when neither overlay changes a facet, otherwise a frozen pack holding the
 * overlaid facets and the family's execution facet. A type that speaks no statement language has none, and asking is a
 * named error from `engineClientPack`, as it is for a language pack.
 */
export function agentEnginePack(type: DatabaseType): AgentEnginePack {
  const client = engineClientPack(type);
  const family = agentLanguagePack(AGENT_STATEMENT_LANGUAGE[type as AgentEngineType]);
  const server = defineOverlay(family.server, engineServerOverlay(type));
  if (client === family.client && server === family.server) return family;
  return Object.freeze({ id: family.id, client, server, execution: family.execution });
}
