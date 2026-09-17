import { afterEach, describe, expect, test } from "bun:test";
import { basename, dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { evaluateChannel, parseChannels, renderTable, strictFailures } from "../../scripts/distribution-check.mjs";
import { missingPosixShell, resolveUnixTool, testIf } from "../helpers/posix-tools";

const ROOT = resolve(import.meta.dir, "../..");
const expected = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
const channel = parseChannels(readFileSync(join(ROOT, "distribution/channels.yaml"), "utf8")).find(
  (entry: { id: string }) => entry.id === "digitalocean",
)!;
const release = parseYaml(readFileSync(join(ROOT, ".github/workflows/release-artifacts.yml"), "utf8"));
const fixtureRoots: string[] = [];

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "do-distribution-"));
  fixtureRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith("do-distribution-")) {
      throw new Error("Refusing to remove an unowned fixture directory");
    }
    rmSync(root, { recursive: true, force: true });
  }
});

// The live page serializes this object inside a Next.js flight string, escaping its quotes.
function listing(version: string, escaped = true): string {
  const data = JSON.stringify({ custom_data: { version, os_version: "Ubuntu 24.04" } });
  return `<html><p>Release ${expected}</p><script>${escaped ? JSON.stringify(data) : data}</script></html>`;
}

function report(content: string | null) {
  return evaluateChannel(channel, expected, { [channel.pin.url]: content });
}

describe("DigitalOcean published listing pin (#910)", () => {
  test("measures the public listing rather than local build inputs", () => {
    expect(channel.pin.strategy).toBe("remote_file");
    expect(channel.pin.url).toBe("https://marketplace.digitalocean.com/apps/libredb-studio");
    expect(channel.update.method).toBe("manual_ui");
  });

  test.each([true, false])("reports the old image as drift with escaped quotes: %s", (escaped) => {
    const row = report(listing("0.9.59", escaped));
    expect(row.status).toBe("drift");
    expect(row.observed).toBe("0.9.59");
    expect(row.expected).toBe(expected);
    expect(renderTable([row], expected)).toContain("DRIFT");
    expect(strictFailures([row])).toEqual([]);
  });

  test.each([true, false])("accepts the current listing with escaped quotes: %s", (escaped) => {
    expect(report(listing(expected, escaped)).status).toBe("ok");
  });

  test.each([
    null,
    `<html>Version ${expected}</html>`,
    JSON.stringify({ custom_data: null, software: { version: expected } }),
    listing("not-a-version"),
    listing("0.9.59") + listing(expected),
  ])("missing, invalid or ambiguous listing metadata is UNKNOWN, never SKIP/OK (%#)", (content) => {
    expect(report(content).status).toBe("unknown");
  });

  test("the real CLI fetches the listing and writes drift to the job summary without blocking a release", async () => {
    let reads = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        reads += 1;
        return new Response(listing("0.9.59"));
      },
    });
    try {
      const root = fixtureRoot();
      mkdirSync(join(root, "distribution"));
      writeFileSync(join(root, "package.json"), JSON.stringify({ version: expected }));
      writeFileSync(
        join(root, "distribution/channels.yaml"),
        stringifyYaml({
          channels: [{ ...channel, pin: { ...channel.pin, url: `http://127.0.0.1:${server.port}/listing` } }],
        }),
      );
      const summary = join(root, "summary.md");
      const child = Bun.spawn(["node", join(ROOT, "scripts/distribution-check.mjs"), "--root", root, "--strict"], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(reads).toBe(1);
      expect(stdout).toContain("DRIFT");
      expect(readFileSync(summary, "utf8")).toContain("0.9.59");
      expect(readFileSync(summary, "utf8")).toContain("DRIFT");
    } finally {
      server.stop(true);
    }
  });
});

describe("DigitalOcean manual release handoff (#910)", () => {
  test("the Packer workflow requires an explicit version, with no stale default", () => {
    const packer = parseYaml(readFileSync(join(ROOT, ".github/workflows/do-packer-build.yml"), "utf8"));
    expect(Object.keys(packer.on)).toEqual(["workflow_dispatch"]);
    expect(packer.on.workflow_dispatch.inputs.version.required).toBe(true);
    expect(packer.on.workflow_dispatch.inputs.version.default).toBeUndefined();
  });

  test("the reminder runs after a successful publish and uses the validated release version", () => {
    const steps = release.jobs["publish-release"].steps;
    const index = steps.findIndex(
      (step: { name: string }) => step.name === "DigitalOcean Marketplace release checklist",
    );
    const publishIndex = steps.findIndex((step: { name: string }) => step.name === "Publish the release");
    expect(index).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThanOrEqual(0);
    expect(index).toBeGreaterThan(publishIndex);
    expect(steps[index].if).toBe("${{ !contains(needs.guard.outputs.version, '-') }}");
    expect(steps[index]["continue-on-error"]).toBe(true);
    expect(steps[index].env.VERSION).toBe("${{ needs.guard.outputs.version }}");
    expect(steps[index].run).not.toContain("${{");
  });

  testIf(
    missingPosixShell("bash"),
    "the release checklist prints actionable versioned instructions without cloud writes",
    async () => {
      const step = release.jobs["publish-release"].steps.find(
        (entry: { name: string }) => entry.name === "DigitalOcean Marketplace release checklist",
      );
      expect(step).toBeDefined();
      const summary = join(fixtureRoot(), "release-summary.md");
      const child = Bun.spawn(
        [resolveUnixTool("bash")!, "--noprofile", "--norc", "-e", "-o", "pipefail", "-c", step.run],
        {
          env: {
            ...process.env,
            VERSION: expected,
            REPOSITORY: "libredb/libredb-studio",
            GITHUB_STEP_SUMMARY: summary.replaceAll("\\", "/"),
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("::notice::");
      const text = readFileSync(summary, "utf8");
      expect(text).toContain(`ghcr.io/libredb/libredb-studio:${expected}`);
      expect(text).toContain("actions/workflows/do-packer-build.yml");
      expect(text).toContain(`version=${expected}`);
      expect(text).toContain("AUTH_COOKIE_SECURE=false");
      expect(text).toContain("cloud.digitalocean.com/vendorportal");
      expect(text).toContain("bun run distribution:check");
      expect(text).toContain("- [ ]");
    },
  );
});
