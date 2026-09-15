/**
 * What the runner prints.
 *
 * The children's output is captured rather than inherited, because several files
 * run at once and interleaved output belongs to nobody. Each file therefore gets
 * one line when it lands, a failing file gets its whole output printed with it, and
 * the run ends with the population: how many files, how many tests, how many
 * skipped, and how to re-run any file that failed on its own.
 */
import type { FileOutcome, RunSummary, TestCounts } from "./execute";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching the terminal escapes bun writes
const ANSI = /\[[0-9;]*m/g;

/**
 * bun prints its per-file summary as lines like " 13 pass" / " 1 fail", to stderr,
 * coloured when it believes it is on a terminal. A file that crashed before the
 * summary prints none of them, and that is reported as unknown rather than as zero:
 * a crash counted as "0 fail" would make the run's totals a lie.
 */
export function parseTestCounts(output: string): TestCounts | null {
  const counts: TestCounts = { pass: 0, fail: 0, skip: 0, todo: 0 };
  let found = false;

  for (const line of output.replace(ANSI, "").split("\n")) {
    const match = /^\s*(\d+)\s+(pass|fail|skip|todo)\s*$/.exec(line);
    if (!match) continue;
    counts[match[2] as keyof TestCounts] += Number(match[1]);
    found = true;
  }

  return found ? counts : null;
}

function seconds(durationMs: number): string {
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function countsSuffix(counts: TestCounts | null): string {
  if (!counts) return "no summary";
  const parts = [`${counts.pass} pass`];
  if (counts.fail > 0) parts.push(`${counts.fail} fail`);
  if (counts.skip > 0) parts.push(`${counts.skip} skip`);
  if (counts.todo > 0) parts.push(`${counts.todo} todo`);
  return parts.join(" ");
}

const STATUS_LABEL = { passed: "PASS", failed: "FAIL", "timed-out": "TIMEOUT" } as const;

export function formatFileLine(outcome: FileOutcome, position: number, total: number): string {
  const width = String(total).length;
  const place = `[${String(position).padStart(width)}/${total}]`;
  const label = STATUS_LABEL[outcome.status].padEnd(7);
  return `${place} ${label} ${seconds(outcome.durationMs).padStart(6)}  ${outcome.file}  ${countsSuffix(outcome.counts)}`;
}

function failureReason(outcome: FileOutcome): string {
  if (outcome.status === "timed-out") return `timed out after ${seconds(outcome.durationMs)}`;
  if (outcome.signal) return `killed by ${outcome.signal}`;
  if (outcome.counts && outcome.counts.fail > 0) return `${outcome.counts.fail} failing`;
  return `exit ${outcome.exitCode}`;
}

export function formatSummary(summary: RunSummary): string {
  const { totals } = summary;
  const tests = [`${totals.tests.pass} pass`];
  if (totals.tests.fail > 0) tests.push(`${totals.tests.fail} fail`);
  if (totals.tests.skip > 0) tests.push(`${totals.tests.skip} skip`);
  if (totals.tests.todo > 0) tests.push(`${totals.tests.todo} todo`);

  const files = [`${totals.filesPassed} passed`];
  if (totals.filesFailed > 0) files.push(`${totals.filesFailed} failed`);
  if (totals.filesTimedOut > 0) files.push(`${totals.filesTimedOut} timed out`);

  const lines = [
    "",
    "=".repeat(72),
    `${totals.files} files: ${files.join(", ")}  |  ${totals.tests.pass + totals.tests.fail + totals.tests.skip + totals.tests.todo} tests: ${tests.join(", ")}  |  ${seconds(summary.durationMs)} with ${summary.jobs} jobs`,
  ];

  if (totals.filesWithoutCounts > 0) {
    lines.push(
      `${totals.filesWithoutCounts} ${totals.filesWithoutCounts === 1 ? "file" : "files"} printed no summary, so their tests are not in the totals above.`,
    );
  }

  if (summary.failures.length > 0) {
    lines.push("", "Failed files:");
    for (const outcome of summary.failures) {
      lines.push(`  ${outcome.file} (${failureReason(outcome)})`);
      lines.push(`    re-run alone with: bun test ./${outcome.file}`);
    }
  }

  return lines.join("\n");
}
