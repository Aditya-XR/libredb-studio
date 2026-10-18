/**
 * The JSON schema a model is shown for one agent tool, and the validation the SDK runs on its call.
 *
 * The SDK's own conversion (`zod4Schema()` in `@ai-sdk/provider-utils`) writes the zod schema as
 * draft-7 input JSON and then sets `additionalProperties: false` on EVERY object it meets. That is
 * right for an object with declared `properties`, and wrong for a record: zod writes
 * `z.record(z.string(), z.unknown())` as `{"type": "object", "propertyNames": {...},
 * "additionalProperties": {}}`, an object whose keys are free, and after the SDK's pass it reads
 * `"additionalProperties": false` with no `properties`, an object that may hold NO key at all.
 *
 * A model server that holds tool arguments to their schema while decoding (llama.cpp with
 * `--jinja`, measured 2026-10-17) can then only emit `{}` for it. The MongoDB `command` of
 * `run_read_query` and `inspect_plan`, and the `keys` and `options` of the MongoDB
 * `recommend_change`, are records, so every MongoDB read arrived empty and no run reached the
 * database, while SQL, whose statement is a string, was unaffected.
 *
 * This is the SDK's conversion with one difference: a record keeps its open
 * `additionalProperties`, and its value schema is closed the same way as everything else. Every
 * tool without a record gets the exact bytes the SDK would have produced, which
 * `tests/isolated/agent-sql-surface-golden.test.ts` holds for the SQL surface and
 * `tests/unit/lib/agent/model-tool-schema.test.ts` holds for every tool of every language.
 */
import { type Schema, jsonSchema } from "ai";
import type { z } from "zod";
import { toJSONSchema } from "zod/v4/core";

type JsonSchemaNode = Record<string, unknown>;

/** The SDK's JSON schema type, read off `jsonSchema`'s own lazy form so no second package is imported for it. */
type SdkJsonSchema = Awaited<ReturnType<Extract<Parameters<typeof jsonSchema>[0], () => unknown>>>;

const isObjectSchema = (node: JsonSchemaNode): boolean =>
  node.type === "object" || (Array.isArray(node.type) && node.type.includes("object"));

/** A record as zod writes one: no declared `properties`, and an `additionalProperties` that is a schema. */
const isRecordSchema = (node: JsonSchemaNode): boolean =>
  node.properties === undefined && typeof node.additionalProperties === "object" && node.additionalProperties !== null;

/**
 * `addAdditionalPropertiesToJsonSchema` from `@ai-sdk/provider-utils`, in place and in the same order of visits, except
 * that a record's `additionalProperties` is visited as a schema instead of being replaced by `false`.
 */
export function closeObjects(node: unknown): unknown {
  if (typeof node !== "object" || node === null) return node;
  const schema = node as JsonSchemaNode;
  if (isObjectSchema(schema)) {
    if (isRecordSchema(schema)) {
      schema.additionalProperties = closeObjects(schema.additionalProperties);
    } else {
      schema.additionalProperties = false;
      const properties = schema.properties as Record<string, unknown> | undefined;
      if (properties != null) {
        for (const key of Object.keys(properties)) properties[key] = closeObjects(properties[key]);
      }
    }
  }
  if (schema.items != null) {
    schema.items = Array.isArray(schema.items) ? schema.items.map(closeObjects) : closeObjects(schema.items);
  }
  for (const key of ["anyOf", "allOf", "oneOf"] as const) {
    if (Array.isArray(schema[key])) schema[key] = (schema[key] as unknown[]).map(closeObjects);
  }
  const definitions = schema.definitions as Record<string, unknown> | undefined;
  if (definitions != null) {
    for (const key of Object.keys(definitions)) definitions[key] = closeObjects(definitions[key]);
  }
  return schema;
}

/** The schema the model is shown for `inputSchema`, written exactly as the SDK writes it but for records. */
export function modelToolJsonSchema(inputSchema: z.ZodType): JsonSchemaNode {
  return closeObjects(
    toJSONSchema(inputSchema, { target: "draft-7", io: "input", reused: "inline" }) as JsonSchemaNode,
  ) as JsonSchemaNode;
}

/** The tool input schema handed to the SDK: the model's copy above, validated by the zod schema itself. */
export function modelToolSchema(inputSchema: z.ZodType): Schema<unknown> {
  return jsonSchema(() => modelToolJsonSchema(inputSchema) as SdkJsonSchema, {
    validate: async (value) => {
      const result = await inputSchema.safeParseAsync(value);
      return result.success ? { success: true, value: result.data } : { success: false, error: result.error };
    },
  });
}
