/**
 * The agent's kubectl and MongoDB surface, held byte for byte to what it was before the language packs.
 *
 * `tests/fixtures/agent/language-surface/golden-language-agent-surface.json` was generated on the base commit by the
 * module this test runs; its docblock says how to regenerate it. Isolated because it builds real providers through
 * `createDatabaseProvider`, which the api layer's tests mock.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenLanguageAgentSurface } from "../fixtures/agent/language-surface/golden-language-agent-surface";

const GOLDEN = join(
  import.meta.dir,
  "..",
  "fixtures",
  "agent",
  "language-surface",
  "golden-language-agent-surface.json",
);

describe("the agent's kubectl and MongoDB surface", () => {
  test("prompts, tool schemas, notices, refusals, cards, advice and verdicts are what the committed golden file records", async () => {
    expect(await goldenLanguageAgentSurface()).toBe(readFileSync(GOLDEN, "utf8"));
  }, 120_000);
});
