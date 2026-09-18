/**
 * The required-asset count in the release skill must match the workflow.
 *
 * `publish-release` in `release-artifacts.yml` refuses to publish a draft that is
 * missing any name in one hardcoded list, and that step is the only thing standing
 * between an incomplete asset set and an immutable published release. The skill at
 * `.claude/skills/cut-release/SKILL.md` restates the size of that list twice, so
 * whoever is cutting the release can count the assets on the draft and know whether
 * the set is whole.
 *
 * The list grew from 22 to 23 when the CycloneDX SBOM joined it, and the prose did
 * not follow. A number restated in prose has no gate of its own: nothing failed, and
 * the wrong figure is only discovered by someone counting assets against it during a
 * release, which is the worst moment to learn that the reference is wrong.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW_PATH = ".github/workflows/release-artifacts.yml";
const SKILL_PATH = ".claude/skills/cut-release/SKILL.md";

interface Step {
  name?: string;
  run?: string;
}
interface Job {
  steps?: Step[];
}
interface Workflow {
  jobs?: Record<string, Job>;
}

/** The asset names the publish gate iterates over, read from the step's own shell. */
function requiredAssets(): string[] {
  const workflow = parseYaml(readFileSync(join(REPO_ROOT, WORKFLOW_PATH), "utf8")) as Workflow;
  const steps = workflow.jobs?.["publish-release"]?.steps ?? [];
  const verify = steps.find((step) => step.run?.includes("for asset in"));
  if (!verify?.run) throw new Error(`${WORKFLOW_PATH}: publish-release has no asset verification step`);
  const list = /for asset in\s+((?:.|\n)*?);\s*do/.exec(verify.run);
  if (!list) throw new Error(`${WORKFLOW_PATH}: the asset list is not a 'for asset in ...; do' loop any more`);
  return [...list[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** Every figure the skill states for that list, so a second restatement cannot drift alone. */
function countsStatedInSkill(): number[] {
  const skill = readFileSync(join(REPO_ROOT, SKILL_PATH), "utf8");
  const stated = [
    /verifies a fixed list of (\d+) \*\*required\*\* assets/.exec(skill),
    /carries more than (\d+) assets/.exec(skill),
  ];
  const missing = stated.filter((match) => match === null);
  if (missing.length > 0) throw new Error(`${SKILL_PATH}: the required-asset sentences were reworded`);
  return stated.map((match) => Number((match as RegExpExecArray)[1]));
}

describe("the release skill states the real required-asset count", () => {
  test("the workflow list is read, not assumed", () => {
    const assets = requiredAssets();
    // A broken extractor returning nothing would make the comparison below pass
    // against a skill that says zero, so assert the shape of what was read.
    expect(assets.length).toBeGreaterThan(20);
    expect(assets).toContain("SHA256SUMS");
    expect(assets.every((name) => name.length > 0)).toBe(true);
  });

  test("every count the skill states equals the length of that list", () => {
    const expected = requiredAssets().length;
    for (const stated of countsStatedInSkill()) {
      expect(stated).toBe(expected);
    }
  });
});
