/**
 * Unit tests for the checksums that ship beside the snap and the SBOM (#913).
 *
 * Why a test for YAML, for the same reason `release-sbom.test.ts` gives: dropping a
 * checksum breaks no release. Every asset still uploads and the draft still flips; the
 * absence is discovered by whoever wanted to verify a download, and by then the release is
 * immutable and the sidecar can never be added to it.
 *
 * `SHA256SUMS` cannot cover these two. It is written in the standalone job and read by
 * winget, Chocolatey and the npx launcher, while the snap and the SBOM are built in later
 * jobs - rewriting that file after its consumers have taken it is a worse problem than the
 * one being fixed. So each of these carries its own.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { parse as parseYaml } from "yaml";

interface Step {
  name?: string;
  run?: string;
}
interface Job {
  steps?: Step[];
}
interface Workflow {
  jobs: Record<string, Job>;
}

const workflow = parseYaml(
  fs.readFileSync(path.join(process.cwd(), ".github/workflows/release-artifacts.yml"), "utf8"),
) as Workflow;

const uploadStep = (job: string, needle: string): Step => {
  const step = (workflow.jobs[job]?.steps ?? []).find((s) => (s.run ?? "").includes(needle));
  if (step === undefined) throw new Error(`no step in ${job} runs ${needle}`);
  return step;
};

describe("release artifact checksums", () => {
  test("the snap is uploaded with a .sha256 beside it", () => {
    const run = uploadStep("snap", "gh release upload").run ?? "";
    expect(run).toContain("sha256sum");
    expect(run).toMatch(/\.sha256/);
    // Hashed from inside its own directory, so the sidecar names the file rather than the
    // build path - `sha256sum -c` has to work where the file is downloaded to.
    expect(run).toContain('cd "$(dirname "$SNAP_FILE")"');
  });

  test("the SBOM is uploaded with a .sha256 beside it", () => {
    const run = uploadStep("sbom", "gh release upload").run ?? "";
    expect(run).toContain("sha256sum");
    expect(run).toMatch(/cdx\.json\.sha256/);
    expect(run).toContain("cd sbom");
  });

  test("the standalone SHA256SUMS is left alone", () => {
    // The two sidecars exist precisely so this file keeps its contract with winget,
    // Chocolatey and the npx launcher.
    const run = uploadStep("publish", "> SHA256SUMS").run ?? "";
    expect(run).toContain("sha256sum libredb-studio-standalone-*.tar.gz libredb-studio-standalone-*.zip > SHA256SUMS");
  });

  test("the SBOM's checksum is required before the draft is published", () => {
    // A sidecar that silently failed to upload would otherwise still publish an immutable
    // release. The snap's is deliberately NOT required, for the reason the step above it
    // already gives: the snap job skips cleanly when the store credentials are absent.
    const run = uploadStep("publish-release", "gh release view").run ?? "";
    expect(run).toContain('"libredb-studio-${TAG}.cdx.json.sha256"');
    expect(run).not.toContain(".snap.sha256");
  });
});
