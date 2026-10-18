/**
 * The schema a model is shown for each agent tool (`modelToolSchema`), against the SDK's own conversion.
 *
 * Measured 2026-10-17 on llama.cpp with `--jinja`: the SDK closed the MongoDB `command` record to an object with no
 * allowed key, the server held every call to it, and every MongoDB read arrived as `{"command": {}}`. These tests hold
 * the two halves of the fix over every tool of every language and workflow: a tool with no record is shown exactly
 * the bytes the SDK writes, and no object anywhere is closed with no key it may hold.
 */
import { describe, expect, test } from "bun:test";
import { asSchema } from "ai";
import { z } from "zod";
import {
  AGENT_LANGUAGE_COPY,
  AGENT_WORKFLOW_VARIANTS,
  type AgentStatementLanguageId,
} from "@/lib/agent/agent-manifest";
import { closeObjects, modelToolJsonSchema, modelToolSchema } from "@/lib/agent/model-tool-schema";
import { agentToolDefinition } from "@/lib/agent/tools";
import type { AgentRunWorkflowType } from "@/lib/agent/types";

const LANGUAGES = Object.keys(AGENT_LANGUAGE_COPY) as AgentStatementLanguageId[];

/** Every tool any variant of any language offers, once per language and name. */
function offeredDefinitions() {
  const seen = new Map<string, ReturnType<typeof agentToolDefinition>>();
  for (const language of LANGUAGES) {
    for (const [workflow, variant] of Object.entries(AGENT_WORKFLOW_VARIANTS[language])) {
      if (variant === undefined) continue;
      for (const name of variant.tools) {
        const definition = agentToolDefinition(language, workflow as AgentRunWorkflowType, name);
        seen.set(`${language}:${name}:${definition.description.length}`, definition);
      }
    }
  }
  return [...seen.entries()];
}

/** Every path to an object that is closed and declares no key: the shape a constrained decoder can only fill with `{}`. */
function closedEmptyObjects(node: unknown, path = ""): string[] {
  if (Array.isArray(node)) return node.flatMap((item, index) => closedEmptyObjects(item, `${path}[${index}]`));
  if (typeof node !== "object" || node === null) return [];
  const schema = node as Record<string, unknown>;
  const here =
    schema.type === "object" && schema.additionalProperties === false && schema.properties === undefined ? [path] : [];
  return [...here, ...Object.entries(schema).flatMap(([key, value]) => closedEmptyObjects(value, `${path}.${key}`))];
}

const hasRecord = (node: unknown): boolean =>
  typeof node === "object" &&
  node !== null &&
  (("propertyNames" in node && "additionalProperties" in node && !("properties" in node)) ||
    Object.values(node).some(hasRecord));

describe("the schema a model is shown for a tool", () => {
  const definitions = offeredDefinitions();

  test("covers the tools of every language", () => {
    const languages = new Set(definitions.map(([key]) => key.split(":")[0]));
    expect([...languages].sort()).toEqual([...LANGUAGES].sort());
  });

  test("never closes an object that declares no key", () => {
    for (const [key, definition] of definitions) {
      expect({ key, closed: closedEmptyObjects(modelToolJsonSchema(definition.inputSchema)) }).toEqual({
        key,
        closed: [],
      });
    }
  });

  test("is byte for byte the SDK's own conversion for every tool without a record", async () => {
    let compared = 0;
    for (const [key, definition] of definitions) {
      const ours = modelToolJsonSchema(definition.inputSchema);
      if (hasRecord(ours)) continue;
      const sdk = await asSchema(definition.inputSchema).jsonSchema;
      expect({ key, schema: JSON.stringify(ours) }).toEqual({ key, schema: JSON.stringify(sdk) });
      compared += 1;
    }
    expect(compared).toBeGreaterThan(10);
  });

  test("leaves the MongoDB command, index keys and index options open to any key", () => {
    const open = (language: AgentStatementLanguageId, workflow: AgentRunWorkflowType, name: string, path: string[]) => {
      const definition = agentToolDefinition(language, workflow, name as never);
      let node: unknown = modelToolJsonSchema(definition.inputSchema);
      for (const step of path) node = (node as Record<string, Record<string, unknown>>).properties[step];
      return (node as Record<string, unknown>).additionalProperties;
    };
    expect(open("mongo", "investigation", "run_read_query", ["command"])).toEqual({});
    expect(open("mongo", "query-optimization", "inspect_plan", ["command"])).toEqual({});
    expect(open("mongo", "query-optimization", "recommend_change", ["keys"])).toEqual({ type: ["number", "string"] });
    expect(open("mongo", "query-optimization", "recommend_change", ["options"])).toEqual({});
  });

  test("closes the object a record holds, as the SDK closes every declared object", () => {
    const schema = z.strictObject({ byName: z.record(z.string(), z.object({ a: z.string() })) });
    expect(modelToolJsonSchema(schema)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        byName: {
          type: "object",
          propertyNames: { type: "string" },
          additionalProperties: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
            additionalProperties: false,
          },
        },
      },
      required: ["byName"],
      additionalProperties: false,
    });
  });

  test("walks unions, arrays, tuples and definitions as the SDK does", () => {
    const node = modelToolJsonSchema(
      z.object({
        either: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
        list: z.array(z.object({ c: z.boolean() })),
        pair: z.tuple([z.object({ d: z.string() }), z.string()]),
      }),
    ) as Record<string, Record<string, Record<string, unknown>>>;
    expect(closedEmptyObjects(node)).toEqual([]);
    expect((node.properties.either.anyOf as Record<string, unknown>[])[0].additionalProperties).toBe(false);
    expect((node.properties.list.items as Record<string, unknown>).additionalProperties).toBe(false);
    expect(
      closeObjects({
        type: ["object", "null"],
        properties: { e: { type: "object" } },
        allOf: [{ type: "object", properties: {} }, true],
        oneOf: [{ type: "object", properties: {} }],
        definitions: { d: { type: "object", properties: {} } },
      }),
    ).toEqual({
      type: ["object", "null"],
      properties: { e: { type: "object", additionalProperties: false } },
      additionalProperties: false,
      allOf: [{ type: "object", properties: {}, additionalProperties: false }, true],
      oneOf: [{ type: "object", properties: {}, additionalProperties: false }],
      definitions: { d: { type: "object", properties: {}, additionalProperties: false } },
    });
    expect(closeObjects(null)).toBeNull();
  });

  test("validates a call with the zod schema it was written from", async () => {
    const schema = modelToolSchema(z.strictObject({ n: z.number() }));
    expect(await schema.validate?.({ n: 1 })).toEqual({ success: true, value: { n: 1 } });
    const refused = await schema.validate?.({ n: "one" });
    expect(refused?.success).toBe(false);
    expect(await schema.jsonSchema).toEqual(modelToolJsonSchema(z.strictObject({ n: z.number() })));
  });
});
