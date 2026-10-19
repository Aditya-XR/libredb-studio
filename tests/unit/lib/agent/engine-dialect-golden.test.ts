/**
 * The agent's dialect-bound compositions, held byte for byte to what they were before the engine overlays.
 *
 * `tests/fixtures/agent/engine-dialect/golden-engine-dialect.json` was generated on the base commit by the module this
 * test runs; its docblock says how to regenerate it. Not isolated: it builds no provider and reaches no database.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenEngineDialect } from "../../../fixtures/agent/engine-dialect/golden-engine-dialect";

const GOLDEN = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "fixtures",
  "agent",
  "engine-dialect",
  "golden-engine-dialect.json",
);

describe("the agent's dialect-bound compositions", () => {
  test("catalog reads, estimating plans, statistics probes, table profiles, packed statistics and the plan posture are what the committed golden file records", () => {
    expect(goldenEngineDialect()).toBe(readFileSync(GOLDEN, "utf8"));
  });
});
