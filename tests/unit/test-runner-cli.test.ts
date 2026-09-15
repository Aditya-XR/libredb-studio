import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The runner end to end, driven the way a contributor and CI drive it. The unit
// tests beside this one cover discovery, the command line, the pool and the
// report against injected data; these cases are here because three of the
// runner's decisions can only be wrong against the real bun binary: that a file
// is addressed as a path and not as a substring filter, that a child's exit code
// reaches the runner's own exit code, and that coverage lands where the merge
// expects it.
const root = path.resolve(import.meta.dir, "../..");
const RUNNER = "tests/run-tests.ts";

// The cases that need a deliberately failing, skipping or empty test file run the
// runner in a SANDBOX: a temporary directory holding a copy of tests/run-tests.ts and
// tests/runner/, whose own tests/ tree holds nothing but the fixture. The runner finds
// its root from its own location, so the copy discovers only that tree.
//
// The fixture used to be written into this repository's tests/unit/. That had two
// costs: a run interrupted between the write and the cleanup left a failing file the
// discovery rule then collects in every later run, and every other test file that
// walks tests/ while this one runs (the discovery test, the backlog guard, the
// security gate asking --list) could see a file that exists for half a second.
const sandboxes: string[] = [];

afterEach(() => {
  for (const sandbox of sandboxes.splice(0)) rmSync(sandbox, { recursive: true, force: true });
});

function sandboxWith(fixture: string): string {
  const sandbox = mkdtempSync(path.join(tmpdir(), "runner-sandbox-"));
  sandboxes.push(sandbox);
  cpSync(path.join(root, "tests/run-tests.ts"), path.join(sandbox, "tests/run-tests.ts"));
  cpSync(path.join(root, "tests/runner"), path.join(sandbox, "tests/runner"), { recursive: true });
  mkdirSync(path.join(sandbox, "tests/unit"), { recursive: true });
  // writeFileSync, not Bun.write: Bun.write returns a promise, and leaving it
  // unawaited let the runner start against a file that was still empty. bun then
  // ran 0 tests and exited 0, so this passed on Linux and failed on windows-latest
  // (measured 2026-09-15).
  writeFileSync(path.join(sandbox, "tests/unit/fixture.test.ts"), fixture);
  return sandbox;
}

function runInSandbox(sandbox: string): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, "tests/run-tests.ts", "tests/unit/fixture.test.ts"], {
    cwd: sandbox,
  });
  return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

function runRunner(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([process.execPath, RUNNER, ...args], { cwd: root });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("the test runner, end to end", () => {
  test("--list prints one repository-relative path per line and nothing else", () => {
    const { exitCode, stdout } = runRunner(["--list", "tests/unit/test-runner-cli.test.ts"]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe("tests/unit/test-runner-cli.test.ts\n");
  });

  test("a passing file exits 0 and is reported with its test count", () => {
    const { exitCode, stdout } = runRunner(["tests/unit/test-runner-options.test.ts"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("tests/unit/test-runner-options.test.ts");
    expect(stdout).toContain("PASS");
    expect(stdout).toContain("1 file: 1 passed");
  });

  test("a single file is addressed as a path, so a name that is a substring of another does not drag it in", () => {
    // `bun test tests/unit/x.test.ts` without a leading ./ is a SUBSTRING FILTER,
    // which would also run every file whose path contains that string. The runner
    // passes ./<path>, so exactly one file runs. tests/unit/lib/auth.test.ts is the
    // live example: tests/unit/lib/auth-jwt-config.test.ts and
    // tests/unit/lib/auth-compare.test.ts share its prefix.
    const { exitCode, stdout } = runRunner(["tests/unit/lib/auth.test.ts"]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("1 file: 1 passed");
    expect(stdout).not.toContain("auth-jwt-config");
  });

  test("a selector that names nothing exits 2 and says so, rather than passing an empty run", () => {
    const { exitCode, stderr } = runRunner(["tests/unit/there-is-no-such-file.test.ts"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("matched no test files");
  });

  test("an unknown option exits 2 and names the option", () => {
    const { exitCode, stderr } = runRunner(["--parallel"]);

    expect(exitCode).toBe(2);
    expect(stderr).toContain("--parallel");
  });

  test("a failing test file makes the runner exit 1 and prints the child's own failure output", () => {
    const sandbox = sandboxWith(
      'import { expect, test } from "bun:test";\ntest("deliberately failing fixture", () => {\n  expect(1).toBe(2);\n});\n',
    );
    const { exitCode, stdout } = runInSandbox(sandbox);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("deliberately failing fixture");
    expect(stdout).toContain("re-run alone with: bun test ./tests/unit/fixture.test.ts");
  });

  test("a skipped test reaches the summary by name, because bun prints that name nowhere", () => {
    // The reason a test did not run lives in its title by convention here, and bun
    // reports only a count, so the runner reads its junit report. Without this, a
    // Windows run that skips a dozen files says "0 fail" and names nothing.
    // The second shape is the one the Windows packaging tests use: the reason sits on a
    // skipped DESCRIBE, and the test inside is named only for what it checks.
    const sandbox = sandboxWith(
      'import { describe, expect, test } from "bun:test";\n' +
        'test.skipIf(true)("needs a POSIX shell, which this platform has not", () => {\n' +
        "  expect(1).toBe(1);\n});\n" +
        'describe.skip("snap launcher [skipped: no sh on this platform]", () => {\n' +
        '  test("exports SNAP_DATA", () => {\n    expect(1).toBe(1);\n  });\n});\n' +
        'test("runs anyway", () => {\n  expect(1).toBe(1);\n});\n',
    );
    const { exitCode, stdout } = runInSandbox(sandbox);

    expect(exitCode).toBe(0);
    expect(stdout).toContain("Files with skipped tests:");
    expect(stdout).toContain("needs a POSIX shell, which this platform has not");
    expect(stdout).toContain("snap launcher [skipped: no sh on this platform] > exports SNAP_DATA");
  });

  test("a file that registers no test is a failure, not a green line", () => {
    const sandbox = sandboxWith('import { expect } from "bun:test";\nexpect(1).toBe(1);\n');
    const { exitCode, stdout } = runInSandbox(sandbox);

    expect(exitCode).toBe(1);
    expect(stdout).toContain("FAIL");
  });

  test("--coverage writes one report per file and --merge-into merges them", () => {
    const workDir = mkdtempSync(path.join(tmpdir(), "runner-coverage-"));
    try {
      const rawDir = path.join(workDir, "raw");
      const merged = path.join(workDir, "lcov.info");
      const { exitCode, stdout } = runRunner([
        "tests/unit/test-runner-discovery.test.ts",
        "--coverage",
        `--coverage-dir=${rawDir}`,
        `--merge-into=${merged}`,
      ]);

      expect(exitCode).toBe(0);
      expect(stdout).toContain("with coverage");
      expect(existsSync(path.join(rawDir, "file-1", "lcov.info"))).toBe(true);
      // The merged report keeps only src/ records, so the runner's own module is
      // absent from it by design; what matters here is that the merge ran and
      // wrote a report the coverage gate can read.
      expect(existsSync(merged)).toBe(true);
      expect(readFileSync(path.join(rawDir, "inputs.txt"), "utf8")).toContain("file-1/lcov.info");
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});
