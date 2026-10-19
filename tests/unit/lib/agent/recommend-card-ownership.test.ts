import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import type { AgentToolContext } from "@/lib/agent/tools";
import * as MONGO from "@/lib/agent/languages/mongo/server";

/**
 * `recommendChangeTool` reads a call with the card that owns the offered schema: the run family's own card, or the
 * reference statement card. An offered `recommend_change` schema that neither owns is a pack defect, and it fails by
 * name rather than being parsed and refused as a statement card it was never written for.
 *
 * No shipped pack offers such a schema, so this file gives the mongo pack a card whose schema is not the one its
 * `toolOverrides` offer. `mock.module` is process-wide, so the substitution is made before anything that reaches the
 * pack is loaded, and the runner gives this file its own process.
 */

// Captured as a plain object before the substitution: the namespace itself follows the replacement.
const REAL_MONGO = { ...MONGO };
mock.module("@/lib/agent/languages/mongo/server", () => ({
  ...REAL_MONGO,
  MONGO_SERVER_PACK: Object.freeze({
    ...REAL_MONGO.MONGO_SERVER_PACK,
    recommendationCard: Object.freeze({
      ...REAL_MONGO.MONGO_SERVER_PACK.recommendationCard,
      inputSchema: z.object({ change: z.literal("document-index") }),
    }),
  }),
}));

const { recommendChangeTool } = await import("@/lib/agent/tools");

describe("recommend_change card ownership", () => {
  test("an offered schema that neither the family card nor the reference card owns fails by name", () => {
    const context = {
      runId: "run-1",
      modelId: "unmeasured-model-for-tests",
      mode: "agent",
      workflowType: "query-optimization",
      statementLanguage: "mongo",
    } as AgentToolContext;
    expect(() => recommendChangeTool(context, { runId: "run-1", events: [] }, {})).toThrow(
      "agent tool layer: no recommendation card owns the recommend_change schema mongo offers for query-optimization",
    );
  });
});
