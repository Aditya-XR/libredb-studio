import { describe, expect, test } from "bun:test";
import { parseRunnerArgs } from "../runner/options";

const defaults = { cpuCount: 8 };

describe("runner command line", () => {
  test("no arguments runs everything, one job per CPU", () => {
    const options = parseRunnerArgs([], defaults);

    expect(options.selectors).toEqual([]);
    expect(options.jobs).toBe(8);
    expect(options.coverage).toBe(false);
    expect(options.mergeInto).toBeNull();
    expect(options.list).toBe(false);
    expect(options.bunArgs).toEqual([]);
  });

  test("positional arguments are selectors, in the order given", () => {
    expect(parseRunnerArgs(["tests/unit", "tests/api/db-objects.test.ts"], defaults).selectors).toEqual([
      "tests/unit",
      "tests/api/db-objects.test.ts",
    ]);
  });

  test("--jobs overrides the CPU count", () => {
    expect(parseRunnerArgs(["--jobs=3"], defaults).jobs).toBe(3);
  });

  test("a single job is allowed, zero and negative and fractional are not", () => {
    expect(parseRunnerArgs(["--jobs=1"], defaults).jobs).toBe(1);
    expect(() => parseRunnerArgs(["--jobs=0"], defaults)).toThrow(/--jobs/);
    expect(() => parseRunnerArgs(["--jobs=-2"], defaults)).toThrow(/--jobs/);
    expect(() => parseRunnerArgs(["--jobs=2.5"], defaults)).toThrow(/--jobs/);
    expect(() => parseRunnerArgs(["--jobs=many"], defaults)).toThrow(/--jobs/);
  });

  test("a machine that reports no CPU count still gets one job", () => {
    expect(parseRunnerArgs([], { cpuCount: 0 }).jobs).toBe(1);
  });

  test("--coverage collects per-file reports under the default directory", () => {
    const options = parseRunnerArgs(["--coverage"], defaults);

    expect(options.coverage).toBe(true);
    expect(options.coverageDir).toBe("coverage/raw");
    expect(options.mergeInto).toBeNull();
  });

  test("--merge-into implies coverage and names the merged report", () => {
    const options = parseRunnerArgs(["--merge-into=coverage/lcov.info"], defaults);

    expect(options.coverage).toBe(true);
    expect(options.mergeInto).toBe("coverage/lcov.info");
  });

  test("--coverage-dir moves the per-file reports", () => {
    expect(parseRunnerArgs(["--coverage", "--coverage-dir=out/raw"], defaults).coverageDir).toBe("out/raw");
  });

  test("--file-timeout is seconds, and must be a positive number", () => {
    expect(parseRunnerArgs(["--file-timeout=90"], defaults).fileTimeoutMs).toBe(90_000);
    expect(() => parseRunnerArgs(["--file-timeout=0"], defaults)).toThrow(/--file-timeout/);
    expect(() => parseRunnerArgs(["--file-timeout=nope"], defaults)).toThrow(/--file-timeout/);
  });

  test("--list asks what would run", () => {
    expect(parseRunnerArgs(["--list"], defaults).list).toBe(true);
  });

  test("everything after -- goes to bun test verbatim", () => {
    const options = parseRunnerArgs(["tests/unit", "--", "--bail", "--timeout=20000"], defaults);

    expect(options.selectors).toEqual(["tests/unit"]);
    expect(options.bunArgs).toEqual(["--bail", "--timeout=20000"]);
  });

  test("an unknown option is refused by name, never ignored", () => {
    expect(() => parseRunnerArgs(["--parallel"], defaults)).toThrow(/--parallel/);
  });

  test("a value written as a separate argument is refused with the form that works", () => {
    expect(() => parseRunnerArgs(["--jobs", "4"], defaults)).toThrow(/--jobs=4/);
  });
});
