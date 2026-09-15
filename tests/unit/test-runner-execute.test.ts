import { describe, expect, test } from "bun:test";
import type { SpawnOutcome } from "../runner/execute";
import { runTestFiles } from "../runner/execute";

const PASS_OUTPUT = " 3 pass\n 0 fail\nRan 3 tests across 1 file. [12.00ms]\n";
const FAIL_OUTPUT = " 2 pass\n 1 fail\nRan 3 tests across 1 file. [12.00ms]\n";

function passed(output = PASS_OUTPUT): SpawnOutcome {
  return { exitCode: 0, signal: null, output, durationMs: 1, timedOut: false, skippedTests: [] };
}

const files = ["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"];

async function run(overrides: Partial<Parameters<typeof runTestFiles>[0]> = {}) {
  return runTestFiles({
    files,
    jobs: 2,
    timeoutMs: 1000,
    coverage: false,
    coverageDir: "coverage/raw",
    coverageExempt: [],
    runFile: async () => passed(),
    ...overrides,
  });
}

describe("running the files", () => {
  test("a run where every file passes is a pass, with the tests counted", async () => {
    const summary = await run();

    expect(summary.failures).toEqual([]);
    expect(summary.totals.files).toBe(3);
    expect(summary.totals.filesPassed).toBe(3);
    expect(summary.totals.tests.pass).toBe(9);
    expect(summary.totals.tests.fail).toBe(0);
  });

  test("never more than `jobs` files at once, and every file runs exactly once", async () => {
    let running = 0;
    let peak = 0;
    const seen: string[] = [];

    await run({
      jobs: 2,
      files: Array.from({ length: 9 }, (_, index) => `tests/unit/${index}.test.ts`),
      runFile: async ({ file }) => {
        seen.push(file);
        running += 1;
        peak = Math.max(peak, running);
        await Promise.resolve();
        await Promise.resolve();
        running -= 1;
        return passed();
      },
    });

    expect(peak).toBe(2);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
  });

  test("a non-zero exit is a failed file, whatever the code is", async () => {
    // A test calling process.exit(7) propagates 7 verbatim: measured with bun 1.4.2.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts")
          ? { exitCode: 7, signal: null, output: "boom", durationMs: 1, timedOut: false, skippedTests: [] }
          : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/b.test.ts"]);
    expect(summary.failures[0]?.status).toBe("failed");
    expect(summary.totals.filesFailed).toBe(1);
  });

  test("a child killed by a signal is a failed file, not a passed one", async () => {
    // bun reports a signal death as exitCode null; `exitCode === 0` is false for it,
    // but `exitCode || 0` would turn it into a pass, which is the trap this pins.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("c.test.ts")
          ? { exitCode: null, signal: "SIGSEGV", output: "", durationMs: 1, timedOut: false, skippedTests: [] }
          : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/c.test.ts"]);
    expect(summary.failures[0]?.signal).toBe("SIGSEGV");
  });

  test("a file that outran the timeout is reported as timed out, with what it printed", async () => {
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("a.test.ts")
          ? {
              exitCode: null,
              signal: "SIGTERM",
              output: "hung here",
              durationMs: 1000,
              timedOut: true,
              skippedTests: [],
            }
          : passed(),
    });

    expect(summary.failures[0]?.status).toBe("timed-out");
    expect(summary.failures[0]?.output).toBe("hung here");
    expect(summary.totals.filesTimedOut).toBe(1);
  });

  test("a failing file's counts are still read, so the summary is the whole run", async () => {
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("b.test.ts")
          ? { exitCode: 1, signal: null, output: FAIL_OUTPUT, durationMs: 1, timedOut: false, skippedTests: [] }
          : passed(),
    });

    expect(summary.totals.tests.pass).toBe(8);
    expect(summary.totals.tests.fail).toBe(1);
  });

  test("output bun printed no summary for is counted as unknown, never as zero", async () => {
    const summary = await run({
      runFile: async () => ({
        exitCode: 1,
        signal: null,
        output: "segfault",
        durationMs: 1,
        timedOut: false,
        skippedTests: [],
      }),
    });

    expect(summary.totals.tests.pass).toBe(0);
    expect(summary.totals.filesWithoutCounts).toBe(3);
  });

  test("each file is given its own coverage directory, and exempt files get none", async () => {
    const given: Array<string | null> = [];

    await run({
      coverage: true,
      coverageDir: "out/raw",
      coverageExempt: ["tests/unit/b.test.ts"],
      runFile: async ({ coverageDir }) => {
        given.push(coverageDir);
        return passed();
      },
    });

    expect(given.sort()).toEqual([null, "out/raw/file-1", "out/raw/file-3"]);
  });

  test("without --coverage no child is given a coverage directory", async () => {
    const given: Array<string | null> = [];

    await run({
      runFile: async ({ coverageDir }) => {
        given.push(coverageDir);
        return passed();
      },
    });

    expect(given).toEqual([null, null, null]);
  });

  test("every result is reported as it lands, with a running position", async () => {
    const progress: string[] = [];

    await run({
      jobs: 1,
      onResult: (outcome, position, total) => progress.push(`${position}/${total} ${outcome.file}`),
    });

    expect(progress).toEqual(["1/3 tests/unit/a.test.ts", "2/3 tests/unit/b.test.ts", "3/3 tests/unit/c.test.ts"]);
  });

  test("a file that registered no test at all is a failure, even though bun exits 0", async () => {
    // Measured with bun 1.4.2: a file with no test in it prints " 0 pass / 0 fail"
    // and exits 0. The runner's own rule is that a discovered file runs, so a file
    // that ran nothing is a defect rather than a pass.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("a.test.ts")
          ? {
              exitCode: 0,
              signal: null,
              output: " 0 pass\n 0 fail\nRan 0 tests across 1 file. [3.00ms]\n",
              durationMs: 1,
              timedOut: false,
              skippedTests: [],
            }
          : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/a.test.ts"]);
    expect(summary.totals.filesFailed).toBe(1);
  });

  test("a file that exits 0 without printing a summary is a failure, not a pass", async () => {
    // A test calling process.exit(0) ends the process there: bun exits 0, prints its
    // banner and nothing else, and every test after that line never runs. Measured
    // with bun 1.4.2. Counting that as a pass is the one way this runner could
    // report a green run over a tree whose tests did not all run.
    const summary = await run({
      runFile: async ({ file }) =>
        file.endsWith("c.test.ts")
          ? { exitCode: 0, signal: null, output: "bun test v1.4.2\n", durationMs: 1, timedOut: false, skippedTests: [] }
          : passed(),
    });

    expect(summary.failures.map((outcome) => outcome.file)).toEqual(["tests/unit/c.test.ts"]);
    expect(summary.totals.filesWithoutCounts).toBe(1);
  });

  test("a child that finished as the timeout fired is read by its exit code, not by the timer", async () => {
    const summary = await run({
      runFile: async () => ({ ...passed(), timedOut: true }),
    });

    expect(summary.failures).toEqual([]);
    expect(summary.totals.filesTimedOut).toBe(0);
  });

  test("a runner that is handed no files refuses rather than reporting a green run", async () => {
    await expect(run({ files: [] })).rejects.toThrow(/no test files/i);
  });
});
