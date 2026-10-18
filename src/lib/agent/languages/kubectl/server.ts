/**
 * What the server does for kubectl (#1821), assembled from the language's server modules.
 */
import { UNAVAILABLE_TEXT } from "../../tool-contracts";
import type { AgentLanguageServerPack } from "../pack";
import { KUBECTL_ADAPTER } from "./adapter";
import { KUBECTL_BASE_DEFINITIONS, KUBECTL_RESOURCES_CARD, KUBECTL_TOOL_OVERRIDES } from "./definitions";

export const KUBECTL_SERVER_PACK = Object.freeze({
  adapter: KUBECTL_ADAPTER,
  toolOverrides: KUBECTL_TOOL_OVERRIDES,
  baseDefinitions: KUBECTL_BASE_DEFINITIONS,
  answerNotADataRead: UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ,
  recommendationCard: KUBECTL_RESOURCES_CARD,
} satisfies AgentLanguageServerPack);
