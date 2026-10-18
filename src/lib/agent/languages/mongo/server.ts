/**
 * What the server does for MongoDB (#1821), assembled from the language's server modules.
 */
import type { AgentLanguageServerPack } from "../pack";
import { MONGO_ADAPTER } from "./adapter";
import { MONGO_ANSWER_NOT_A_DATA_READ, MONGO_TOOL_OVERRIDES } from "./definitions";

export const MONGO_SERVER_PACK = Object.freeze({
  adapter: MONGO_ADAPTER,
  toolOverrides: MONGO_TOOL_OVERRIDES,
  baseDefinitions: Object.freeze({}),
  answerNotADataRead: MONGO_ANSWER_NOT_A_DATA_READ,
} satisfies AgentLanguageServerPack);
