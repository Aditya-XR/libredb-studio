/**
 * Running the files: one bun process per test file, several at a time.
 *
 * One process per file is not a performance choice, it is the isolation the suite
 * needs. bun's `mock.module()` is process-wide with no undo, and whole-module mocks
 * are the standard pattern in `tests/api/` (36 files mock `@/lib/auth` alone), so
 * any file that needs the real module fails when it shares a process with one that
 * mocked it. bun 1.4.2 has `--isolate`, which resets the module registry per file
 * in ONE process, and it does contain `mock.module`, but it is also the subject of
 * oven-sh/bun#41655 (a NAPI finalizer SIGSEGV that reproduces serially on 1.4.2)
 * and this suite loads three NAPI addons: `better-sqlite3`, `oracledb` and
 * `@duckdb/node-api`. A process boundary needs no upstream fix, so that is what
 * this uses, and the concurrency is what pays for it.
 *
 * Spawning is injected so this module can be tested without processes.
 */
import { parseTestCounts } from "./report";

export type TestCounts = { pass: number; fail: number; skip: number; todo: number };

export type SpawnOutcome = {
  exitCode: number | null;
  signal: string | null;
  output: string;
  durationMs: number;
  timedOut: boolean;
};

export type FileOutcome = {
  file: string;
  status: "passed" | "failed" | "timed-out";
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  output: string;
  counts: TestCounts | null;
};

export type RunSummary = {
  outcomes: FileOutcome[];
  failures: FileOutcome[];
  durationMs: number;
  jobs: number;
  totals: {
    files: number;
    filesPassed: number;
    filesFailed: number;
    filesTimedOut: number;
    filesWithoutCounts: number;
    tests: TestCounts;
  };
};

export type RunFile = (input: { file: string; coverageDir: string | null; timeoutMs: number }) => Promise<SpawnOutcome>;

export type RunTestFilesInput = {
  files: string[];
  jobs: number;
  timeoutMs: number;
  coverage: boolean;
  coverageDir: string;
  coverageExempt: readonly string[];
  runFile: RunFile;
  onResult?: (outcome: FileOutcome, position: number, total: number) => void;
  now?: () => number;
};

function toOutcome(file: string, spawned: SpawnOutcome): FileOutcome {
  const counts = parseTestCounts(spawned.output);
  // A signal death arrives as exitCode null. `exitCode === 0` is correctly false for
  // it, but any reading that coerces (`exitCode || 0`, `!exitCode`) turns a SIGSEGV
  // into a pass, so the status is derived once, here.
  const status = spawned.timedOut ? "timed-out" : spawned.exitCode === 0 ? "passed" : "failed";

  return {
    file,
    status,
    exitCode: spawned.exitCode,
    signal: spawned.signal,
    durationMs: spawned.durationMs,
    output: spawned.output,
    counts,
  };
}

/**
 * The per-file coverage directory, or null for a file that must not be measured.
 *
 * The index is the file's position in the sorted selection, which is what makes the
 * directory names stable and collision-free for `scripts/merge-lcov.mjs` to read
 * back.
 */
export function coverageDirFor(
  file: string,
  index: number,
  { coverage, coverageDir, coverageExempt }: Pick<RunTestFilesInput, "coverage" | "coverageDir" | "coverageExempt">,
): string | null {
  if (!coverage || coverageExempt.includes(file)) return null;
  return `${coverageDir}/file-${index + 1}`;
}

export async function runTestFiles(input: RunTestFilesInput): Promise<RunSummary> {
  const { files, jobs, timeoutMs, runFile, onResult, now = () => Date.now() } = input;
  if (files.length === 0) {
    throw new Error("The runner was handed no test files, so there is nothing to report as passing.");
  }

  const startedAt = now();
  const outcomes: FileOutcome[] = [];
  let next = 0;
  let finished = 0;

  async function worker(): Promise<void> {
    while (next < files.length) {
      const index = next;
      next += 1;
      const file = files[index] as string;
      const spawned = await runFile({ file, coverageDir: coverageDirFor(file, index, input), timeoutMs });
      const outcome = toOutcome(file, spawned);
      outcomes.push(outcome);
      finished += 1;
      onResult?.(outcome, finished, files.length);
    }
  }

  await Promise.all(Array.from({ length: Math.min(jobs, files.length) }, () => worker()));

  const totals = {
    files: files.length,
    filesPassed: outcomes.filter((outcome) => outcome.status === "passed").length,
    filesFailed: outcomes.filter((outcome) => outcome.status === "failed").length,
    filesTimedOut: outcomes.filter((outcome) => outcome.status === "timed-out").length,
    filesWithoutCounts: outcomes.filter((outcome) => outcome.counts === null).length,
    tests: outcomes.reduce<TestCounts>(
      (sum, outcome) => ({
        pass: sum.pass + (outcome.counts?.pass ?? 0),
        fail: sum.fail + (outcome.counts?.fail ?? 0),
        skip: sum.skip + (outcome.counts?.skip ?? 0),
        todo: sum.todo + (outcome.counts?.todo ?? 0),
      }),
      { pass: 0, fail: 0, skip: 0, todo: 0 },
    ),
  };

  // Failures in the order the files were selected, not the order they happened to
  // finish in, so two runs of the same red tree print the same list.
  const order = new Map(files.map((file, index) => [file, index]));
  const failures = outcomes
    .filter((outcome) => outcome.status !== "passed")
    .sort((a, b) => (order.get(a.file) ?? 0) - (order.get(b.file) ?? 0));

  return { outcomes, failures, durationMs: now() - startedAt, jobs, totals };
}
