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

const XML_ENTITY: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

/**
 * The titles of the tests a file skipped, read from bun's own junit report.
 *
 * bun prints a skipped test's title NOWHERE: measured on 1.4.2 piped, with
 * FORCE_COLOR set, and under a real pty, the output carries the count (" 4 skip")
 * and nothing else. In this repository a skip always states its reason in its title
 * (a deb postinstall, a snap launcher, an AppImage permission audit: artifacts that
 * cannot exist on the platform), so the count alone hides the only thing worth
 * reading. The junit reporter names them, so the runner asks each child for one.
 *
 * A report that is missing or truncated (a child killed mid-write) names nothing
 * rather than raising: the run's verdict comes from exit codes, never from here.
 */
export function parseSkippedTests(report: string): string[] {
  const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITY[entity] as string);
  const skipped: string[] = [];
  for (const match of report.matchAll(/<testcase\b([^>]*)>\s*<skipped\b/g)) {
    const attributes = match[1] as string;
    const name = /\bname="([^"]*)"/.exec(attributes)?.[1];
    if (name === undefined) continue;
    // The describe path matters as much as the name: a skip made with `describe.skip`
    // carries its reason in the DESCRIBE title, and the tests inside it are named for
    // what they check. bun writes that path in `classname`, innermost first and joined
    // with " > " (measured 1.4.2: "nested > snap launcher [skipped: no sh]"), so it is
    // turned round to read the way the file does.
    const classname = /\bclassname="([^"]*)"/.exec(attributes)?.[1] ?? "";
    const path = classname === "" ? [] : decode(classname).split(" > ").reverse();
    skipped.push([...path, decode(name)].join(" > "));
  }
  return skipped;
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

function failureReason(outcome: FileOutcome, timeoutMs: number): string {
  // The BUDGET, not the elapsed time: a killed child is given a few more seconds to
  // die before SIGKILL, so the elapsed time is always the larger, unrelated number.
  if (outcome.status === "timed-out") return `timed out, the budget is ${seconds(timeoutMs)} per file`;
  if (outcome.signal) return `killed by ${outcome.signal}`;
  if (outcome.counts && outcome.counts.fail > 0) return `${outcome.counts.fail} failing`;
  if (outcome.counts === null)
    return `exit ${outcome.exitCode}, and it printed no summary, so its tests are unaccounted for`;
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

  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const totalTests = totals.tests.pass + totals.tests.fail + totals.tests.skip + totals.tests.todo;
  const lines = [
    "",
    "=".repeat(72),
    `${plural(totals.files, "file")}: ${files.join(", ")}  |  ${plural(totalTests, "test")}: ${tests.join(", ")}  |  ${seconds(summary.durationMs)} with ${plural(summary.jobs, "job")}`,
  ];

  if (totals.filesWithoutCounts > 0) {
    lines.push(
      `${totals.filesWithoutCounts} ${totals.filesWithoutCounts === 1 ? "file" : "files"} printed no summary, so their tests are not in the totals above.`,
    );
  }

  // A skipped test is not a passing test, and bun prints its title nowhere (see
  // parseSkippedTests), so this is where a reader meets it. Each such title states
  // the reason: a platform that cannot host the artifact, a tool that is not
  // installed. A run that says only "3 skip" has told nobody anything.
  const skipping = summary.outcomes.filter((outcome) => (outcome.counts?.skip ?? 0) > 0);
  if (skipping.length > 0) {
    lines.push("", "Files with skipped tests:");
    for (const outcome of skipping.sort((a, b) => a.file.localeCompare(b.file))) {
      lines.push(`  ${outcome.file} (${outcome.counts?.skip} skipped)`);
      for (const title of outcome.skippedTests) lines.push(`    ${title}`);
    }
  }

  if (summary.failures.length > 0) {
    lines.push("", "Failed files:");
    for (const outcome of summary.failures) {
      lines.push(`  ${outcome.file} (${failureReason(outcome, summary.timeoutMs)})`);
      lines.push(`    re-run alone with: bun test ./${outcome.file}`);
    }
  }

  return lines.join("\n");
}
