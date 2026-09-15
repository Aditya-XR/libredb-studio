import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COVERAGE_EXEMPT_FILES, discoverTestFiles, selectTestFiles } from "../runner/discover";

// The guard that replaces tests/unit/component-runner-coverage.test.ts: that file
// existed because tests/run-components.sh named its files by hand, so a new file
// could be added and never run (#426 shipped seven tests that never ran once).
// Discovery is now automatic, so the invariant worth pinning is the other way
// round: the rule the runner applies must equal what is on disk, and no directory
// may quietly fall outside it.
const root = path.resolve(import.meta.dir, "../..");

function walk(directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return walk(child);
    return entry.isFile() && /\.test\.tsx?$/.test(entry.name) ? [child] : [];
  });
}

describe("test discovery", () => {
  test("runs every *.test.ts(x) file under tests/, except tests/live", () => {
    const onDisk = walk("tests")
      .filter((file) => !file.startsWith("tests/live/"))
      .sort();

    expect(discoverTestFiles(root)).toEqual(onDisk);
  });

  test("discovers the layers the suite is made of, and each one is non-empty", () => {
    const files = discoverTestFiles(root);
    const layers = ["unit", "api", "integration", "hooks", "security", "evals", "components", "isolated"];

    for (const layer of layers) {
      expect(files.filter((file) => file.startsWith(`tests/${layer}/`)).length).toBeGreaterThan(0);
    }
    // Nothing outside those layers: a new top-level directory has to be added to
    // the list above deliberately, which is where someone reads this test.
    const outside = files.filter((file) => !layers.some((layer) => file.startsWith(`tests/${layer}/`)));
    expect(outside).toEqual([]);
  });

  test("excludes tests/live, which drives real engines and is run by hand", () => {
    expect(discoverTestFiles(root).some((file) => file.startsWith("tests/live/"))).toBe(false);
  });

  test("returns POSIX-separated paths, sorted, with no duplicates", () => {
    const files = discoverTestFiles(root);

    expect(files.some((file) => file.includes("\\"))).toBe(false);
    expect([...files].sort()).toEqual(files);
    expect(new Set(files).size).toBe(files.length);
  });

  test("a selector may be a layer directory", () => {
    const selected = selectTestFiles(root, ["tests/unit"]);

    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((file) => file.startsWith("tests/unit/"))).toBe(true);
    expect(selected).toEqual(discoverTestFiles(root).filter((file) => file.startsWith("tests/unit/")));
  });

  test("a selector may be a single test file, spelled with either separator", () => {
    const one = "tests/unit/test-runner-discovery.test.ts";

    expect(selectTestFiles(root, [one])).toEqual([one]);
    expect(selectTestFiles(root, [one.replaceAll("/", path.sep)])).toEqual([one]);
    expect(selectTestFiles(root, [path.join(root, one)])).toEqual([one]);
  });

  test("a relative selector means what it means in the directory it was typed in", () => {
    // From tests/unit, `bun ../run-tests.ts lib/lazy.test.ts` names the file beside
    // you. Resolving against the repository root instead answered "is not under
    // tests/", a true sentence about a path nobody wrote.
    const cwd = process.cwd();
    try {
      process.chdir(path.join(root, "tests/unit"));
      expect(selectTestFiles(root, ["lib/lazy.test.ts"])).toEqual(["tests/unit/lib/lazy.test.ts"]);
    } finally {
      process.chdir(cwd);
    }
  });

  test("a root spelled differently from the working directory is still the same directory", () => {
    // Measured on windows-latest, 2026-09-15: os.tmpdir() answers the 8.3 short form
    // (C:\Users\RUNNER~1\...) while import.meta.dir answers the long one
    // (C:\Users\runneradmin\...), so a runner started from a temp directory resolved a
    // correct relative selector to a path "not under tests/" and exited 2. A junction
    // reproduces the same two spellings of one directory on every platform (on POSIX
    // the type argument is ignored and it is an ordinary directory symlink).
    const link = path.join(mkdtempSync(path.join(tmpdir(), "runner-spelling-")), "repo");
    symlinkSync(root, link, "junction");
    try {
      expect(selectTestFiles(link, ["tests/unit/lib/lazy.test.ts"])).toEqual(["tests/unit/lib/lazy.test.ts"]);
    } finally {
      rmSync(path.dirname(link), { recursive: true, force: true });
    }
  });

  test("selecting nothing selects everything", () => {
    expect(selectTestFiles(root, [])).toEqual(discoverTestFiles(root));
  });

  test("a selector that matches no test file is an error, never a quiet empty run", () => {
    expect(() => selectTestFiles(root, ["tests/unit/there-is-no-such.test.ts"])).toThrow(
      /tests\/unit\/there-is-no-such\.test\.ts/,
    );
    expect(() => selectTestFiles(root, ["tests/live"])).toThrow(/no test files/);
    expect(() => selectTestFiles(root, ["src/lib"])).toThrow(/tests\//);
  });

  test("every coverage-exempt file exists and is discovered", () => {
    const files = new Set(discoverTestFiles(root));

    expect(COVERAGE_EXEMPT_FILES.length).toBeGreaterThan(0);
    for (const file of COVERAGE_EXEMPT_FILES) {
      expect(files.has(file)).toBe(true);
    }
  });
});
