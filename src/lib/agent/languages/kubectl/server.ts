/**
 * What the server does for kubectl (#1821), assembled from the language's server modules.
 */
import type { AgentLanguageServerPack } from "../pack";
import { KUBECTL_ADAPTER } from "./adapter";

export const KUBECTL_SERVER_PACK: AgentLanguageServerPack = Object.freeze({
  adapter: KUBECTL_ADAPTER,
});
