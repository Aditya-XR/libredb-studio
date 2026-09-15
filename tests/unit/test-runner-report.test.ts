import { describe, expect, test } from "bun:test";
import type { FileOutcome, RunSummary } from "../runner/execute";
import { formatFileLine, formatSummary, parseTestCounts } from "../runner/report";

describe("reading bun's own summary", () => {
  test("reads the counts bun prints", () => {
    const output = " 13 pass\n 2 skip\n 1 fail\n 27 expect() calls\nRan 16 tests across 1 file. [76.00ms]\n";

    expect(parseTestCounts(output)).toEqual({ pass: 13, fail: 1, skip: 2, todo: 0 });
  });

  test("reads them through the colour bun writes to a terminal", () => {
    // The runner sets FORCE_COLOR for its children when it is itself on a terminal,
    // so the captured output carries escape sequences around every count.
    const output = "[0m[32m 1 pass[0m\n[0m[31m 2 fail[0m\n";

    expect(parseTestCounts(output)).toEqual({ pass: 1, fail: 2, skip: 0, todo: 0 });
  });

  test("output with no summary in it is unknown, not zero", () => {
    expect(parseTestCounts("Segmentation fault\n")).toBeNull();
    expect(parseTestCounts("")).toBeNull();
  });

  test("does not mistake a sentence that contains the word pass for a count", () => {
    expect(parseTestCounts("the password check should pass\n")).toBeNull();
  });
});

function outcome(overrides: Partial<FileOutcome> = {}): FileOutcome {
  return {
    file: "tests/unit/a.test.ts",
    status: "passed",
    exitCode: 0,
    signal: null,
    durationMs: 420,
    output: "",
    counts: { pass: 13, fail: 0, skip: 0, todo: 0 },
    ...overrides,
  };
}

describe("what the runner prints", () => {
  test("a passing file is one line with its position, time and counts", () => {
    const line = formatFileLine(outcome(), 12, 533);

    expect(line).toContain("12/533");
    expect(line).toContain("tests/unit/a.test.ts");
    expect(line).toContain("13 pass");
    expect(line).toContain("0.4s");
    expect(line).toContain("PASS");
  });

  test("a skipped test is visible on the file's line, so a platform skip is never silent", () => {
    const line = formatFileLine(outcome({ counts: { pass: 3, fail: 0, skip: 4, todo: 0 } }), 1, 1);

    expect(line).toContain("4 skip");
  });

  test("a failed file says so, and a timed-out file says how long it was given", () => {
    expect(formatFileLine(outcome({ status: "failed", exitCode: 1 }), 1, 1)).toContain("FAIL");

    const timedOut = formatFileLine(outcome({ status: "timed-out", exitCode: null, durationMs: 300_000 }), 1, 1);
    expect(timedOut).toContain("TIMEOUT");
    expect(timedOut).toContain("300.0s");
  });

  function summary(overrides: Partial<RunSummary> = {}): RunSummary {
    return {
      outcomes: [outcome()],
      failures: [],
      durationMs: 77_400,
      jobs: 16,
      totals: {
        files: 533,
        filesPassed: 533,
        filesFailed: 0,
        filesTimedOut: 0,
        filesWithoutCounts: 0,
        tests: { pass: 13_960, fail: 0, skip: 3, todo: 0 },
      },
      ...overrides,
    };
  }

  test("a green run reports the whole population, not just the failures", () => {
    const text = formatSummary(summary());

    expect(text).toContain("533 files");
    expect(text).toContain("13960");
    expect(text).toContain("3 skip");
    expect(text).toContain("77.4s");
    expect(text).toContain("16 jobs");
  });

  test("a red run names every failing file and how to re-run it alone", () => {
    const failure = outcome({ file: "tests/unit/b.test.ts", status: "failed", exitCode: 1 });
    const text = formatSummary(
      summary({
        failures: [failure],
        totals: { ...summary().totals, filesPassed: 532, filesFailed: 1 },
      }),
    );

    expect(text).toContain("tests/unit/b.test.ts");
    expect(text).toContain("bun test ./tests/unit/b.test.ts");
  });

  test("a file whose output carried no summary is called out, so the total is honest", () => {
    const text = formatSummary(summary({ totals: { ...summary().totals, filesWithoutCounts: 2 } }));

    expect(text).toMatch(/2 files? printed no summary/);
  });

  test("every file that skipped a test is named, so a skip is never only a number", () => {
    // A test skipped because the artifact it drives cannot exist on this platform
    // (a deb postinstall, a snap launcher) says so in its own title, but bun prints
    // a skipped title only to a terminal, never into a piped CI log. The file and
    // its count are what stay visible there.
    const skipping = outcome({
      file: "tests/unit/snap-launcher.test.ts",
      counts: { pass: 4, fail: 0, skip: 9, todo: 0 },
    });
    const text = formatSummary(
      summary({
        outcomes: [outcome(), skipping],
        totals: { ...summary().totals, tests: { pass: 13_960, fail: 0, skip: 9, todo: 0 } },
      }),
    );

    expect(text).toContain("Files with skipped tests:");
    expect(text).toContain("tests/unit/snap-launcher.test.ts (9 skipped)");
    expect(text).not.toContain("tests/unit/a.test.ts (");
  });

  test("a run with no skips says nothing about skips", () => {
    expect(formatSummary(summary())).not.toContain("Files with skipped tests");
  });
});
