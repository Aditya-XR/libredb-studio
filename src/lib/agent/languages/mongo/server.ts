/**
 * What the server does for MongoDB (#1821), assembled from the language's server modules.
 */
import type { AgentLanguageServerPack } from "../pack";
import { MONGO_ADAPTER } from "./adapter";

export const MONGO_SERVER_PACK: AgentLanguageServerPack = Object.freeze({
  adapter: MONGO_ADAPTER,
});
