#!/usr/bin/env bun
/**
 * The test runner: `bun run test`.
 *
 * It runs every test file in its own bun process, several files at a time, and it
 * is written in TypeScript rather than shell so that the one command a contributor
 * is told to run behaves the same on Linux, macOS and Windows. The two bash scripts
 * it replaces could not: `tests/run-core.sh` used `mapfile`, a bash 4 builtin, and
 * macOS ships bash 3.2, so the documented gate never ran there at all.
 *
 * Why a process per file rather than `bun test <dir>`: see the docblock in
 * `tests/runner/execute.ts`.
 *
 *   bun tests/run-tests.ts                       every test file
 *   bun tests/run-tests.ts tests/api             one layer
 *   bun tests/run-tests.ts tests/api/db.test.ts  one file
 *   bun tests/run-tests.ts --jobs=4              bound the concurrency
 *   bun tests/run-tests.ts --list                what would run
 *   bun tests/run-tests.ts --coverage --merge-into=coverage/lcov.info
 *   bun tests/run-tests.ts tests/unit -- --bail  pass flags to bun test
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { assertCoverageDirIsOurs } from "./runner/coverage";
import { COVERAGE_EXEMPT_FILES, selectTestFiles } from "./runner/discover";
import { coverageDirFor, type RunFile, runTestFiles, type SpawnOutcome } from "./runner/execute";
import { parseRunnerArgs, type RunnerOptions } from "./runner/options";
import { formatFileLine, formatSummary, parseSkippedTests } from "./runner/report";

const root = path.resolve(import.meta.dir, "..");

/** How long a child that was asked to stop is given before it is killed outright. */
const KILL_ESCALATION_MS = 5_000;

const live = new Set<Bun.Subprocess>();

/**
 * Children inherit the environment, plus one decision: `FORCE_COLOR` when this
 * runner is on a terminal. Each child's output is a pipe, so bun would drop its
 * colour and the failure diffs are much harder to read without it. `NO_COLOR` wins
 * over that, because it is the user's own word.
 *
 * Nothing else is set here. The environment tests run under is pinned by
 * `tests/setup.ts`, which bunfig preloads into every child.
 */
function childEnvironment(): Record<string, string | undefined> {
  const wantsColour = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  return wantsColour ? { ...process.env, FORCE_COLOR: "1" } : { ...process.env };
}

function spawnTestFile(bunArgs: string[], junitDir: string): RunFile {
  return async ({ file, index, coverageDir, timeoutMs }): Promise<SpawnOutcome> => {
    const coverageArgs = coverageDir ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${coverageDir}`] : [];
    // Every child writes a junit report, because it is the only place bun names the
    // tests a file SKIPPED, and in this repository a skip carries its reason in its
    // title. The file is small, it is read only when the child reports a skip, and
    // the whole directory is removed when the run ends.
    const junitPath = path.join(junitDir, `file-${index + 1}.xml`);

    const command = [
      process.execPath,
      // Reap whatever the file spawned (helm, node, sh) if this child is killed:
      // bun uses PR_SET_PDEATHSIG on Linux, EVFILT_PROC on macOS and a
      // kill-on-close Job Object on Windows, so a timeout leaves nothing behind.
      "--no-orphans",
      "test",
      "--reporter=junit",
      `--reporter-outfile=${junitPath}`,
      ...bunArgs,
      ...coverageArgs,
      // "./" matters: bun reads a bare relative path as a SUBSTRING FILTER over the
      // whole tree, so `bun test tests/a/b.test.ts` also runs any other file whose
      // path contains that string. With the prefix it is a path, on every platform.
      `./${file}`,
    ];

    const startedAt = Date.now();
    const child = Bun.spawn(command, {
      // Every child runs from the repository root: bunfig.toml's preload, the `@/`
      // alias and the tests that read repository files all resolve from there.
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: childEnvironment(),
    });
    live.add(child);

    let timedOut = false;
    const softKill = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    const hardKill = setTimeout(() => {
      if (timedOut) child.kill("SIGKILL");
    }, timeoutMs + KILL_ESCALATION_MS);

    // bun writes its file header, failure diffs and per-file summary to stderr, and
    // the tests' own console output to stdout, so both are captured.
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
    ]);
    const exitCode = await child.exited;

    clearTimeout(softKill);
    clearTimeout(hardKill);
    live.delete(child);

    return {
      exitCode: child.signalCode ? null : exitCode,
      signal: child.signalCode,
      output: `${stderr}${stdout}`,
      durationMs: Date.now() - startedAt,
      timedOut,
      skippedTests: existsSync(junitPath) ? parseSkippedTests(readFileSync(junitPath, "utf8")) : [],
    };
  };
}

function mergeCoverage(options: RunnerOptions, files: string[]): void {
  const reports = files
    .map((file, index) =>
      coverageDirFor(file, index, {
        coverage: options.coverage,
        coverageDir: options.coverageDir,
        coverageExempt: COVERAGE_EXEMPT_FILES,
      }),
    )
    .filter((directory): directory is string => directory !== null)
    .map((directory) => `${directory}/lcov.info`)
    // bun writes no report at all for a test file that covered no source file, so a
    // missing one is expected here rather than an error.
    // A coverage directory may be given as an absolute path, so resolve rather
    // than join: path.join("/repo", "/tmp/raw") is "/repo/tmp/raw".
    .filter((report) => existsSync(path.resolve(root, report)));

  if (reports.length === 0) {
    throw new Error(`No coverage report was written under ${options.coverageDir}.`);
  }

  // The list goes in a file rather than in argv: Windows caps a command line at
  // 32767 characters and this repository already has over 500 test files.
  const manifest = `${options.coverageDir}/inputs.txt`;
  writeFileSync(path.resolve(root, manifest), `${reports.join("\n")}\n`);

  const merged = Bun.spawnSync(
    ["node", "scripts/merge-lcov.mjs", `--inputs-from=${manifest}`, options.mergeInto as string],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (merged.exitCode !== 0) {
    throw new Error(`Merging ${reports.length} coverage reports failed with exit ${merged.exitCode}.`);
  }
}

async function main(): Promise<number> {
  const options = parseRunnerArgs(process.argv.slice(2), { cpuCount: availableParallelism() });
  const files = selectTestFiles(root, options.selectors);

  if (options.list) {
    process.stdout.write(`${files.join("\n")}\n`);
    return 0;
  }

  if (options.coverage) {
    const coverageDir = path.resolve(root, options.coverageDir);
    // --coverage-dir is a path the caller chooses and this line deletes it, so it is
    // checked before it is emptied. See tests/runner/coverage.ts.
    if (existsSync(coverageDir)) assertCoverageDirIsOurs(options.coverageDir, readdirSync(coverageDir));
    rmSync(coverageDir, { recursive: true, force: true });
    mkdirSync(coverageDir, { recursive: true });
  }
  // The merged report goes too, and before the run rather than after it: a run that
  // ends red never reaches the merge, and a stale lcov left beside it is a report of
  // a tree that no longer exists, which `coverage:check` would happily pass.
  if (options.mergeInto) rmSync(path.resolve(root, options.mergeInto), { force: true });

  const junitDir = mkdtempSync(path.join(tmpdir(), "libredb-test-junit-"));

  const selection = options.selectors.length > 0 ? options.selectors.join(" ") : "tests/";
  process.stdout.write(
    `bun ${Bun.version} on ${process.platform}-${process.arch}: ${files.length} files from ${selection}, ` +
      `${options.jobs} at a time${options.coverage ? ", with coverage" : ""}\n\n`,
  );

  const summary = await runTestFiles({
    files,
    jobs: options.jobs,
    timeoutMs: options.fileTimeoutMs,
    coverage: options.coverage,
    coverageDir: options.coverageDir,
    coverageExempt: COVERAGE_EXEMPT_FILES,
    runFile: spawnTestFile(options.bunArgs, junitDir),
    onResult: (outcome, position, total) => {
      process.stdout.write(`${formatFileLine(outcome, position, total)}\n`);
      // A failing file's whole output is printed where it lands rather than kept for
      // the end: a CI log is read from the first red line downwards.
      if (outcome.status !== "passed") process.stdout.write(`${outcome.output}\n`);
    },
  });

  rmSync(junitDir, { recursive: true, force: true });

  process.stdout.write(`${formatSummary(summary)}\n`);
  if (summary.failures.length > 0) return 1;

  if (options.mergeInto) mergeCoverage(options, files);
  return 0;
}

process.on("SIGINT", () => {
  for (const child of live) child.kill("SIGTERM");
  process.stdout.write("\nInterrupted.\n");
  process.exit(130);
});

try {
  process.exit(await main());
} catch (error) {
  // Usage and setup errors exit 2, so a caller can tell "the tests failed" (1) from
  // "the runner could not run them" (2).
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}
