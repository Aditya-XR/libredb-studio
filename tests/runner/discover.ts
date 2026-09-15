/**
 * Which files the test runner runs, and which of them are measured for coverage.
 *
 * One rule, in one place: every `*.test.ts` / `*.test.tsx` file under `tests/`,
 * except `tests/live/`, whose files drive real database engines and are started by
 * hand (`bun tests/live/<file>.ts`). The rule is deliberately a rule and not a
 * hand-written list: `tests/components/WireCompatibilityHint.test.tsx` shipped with
 * #426 and never ran once, because the runner of the day named its files one by one.
 *
 * `scripts/security-check.mjs` asks this module (through `bun tests/run-tests.ts
 * --list`) whether a test named by `docs/SECURITY.md` is actually executed, so the
 * discovery rule is also the repository's definition of "this test runs".
 */
import { readdirSync } from "node:fs";
import path from "node:path";

const TESTS_DIRECTORY = "tests";
const TEST_FILE = /\.test\.tsx?$/;

/** Directories under `tests/` that the runner never collects, with the reason. */
const EXCLUDED = new Map([["live", "drives real engines, started by hand"]]);

/**
 * Files that run WITHOUT coverage collection.
 *
 * Both import a whole module chain without exercising it: the CJS shim pulls in
 * every component, and the loader wiring file imports the editor to observe a call
 * it makes at module scope. bun's lcov is per-function, so a process that only
 * LOADS a module emits a coarse zero-hit block for it, and `scripts/merge-lcov.mjs`
 * picks the record with the most executed lines as the authority for which lines
 * are coverable. When one of these two processes is the only one that ever loaded a
 * file, its coarse block becomes that authority and its zero lines are reported as
 * uncovered: measured 2026-09-15, `src/lib/llm/factory.ts` gains 31 phantom
 * uncovered lines from the shim alone. Today the core layer happens to supply a
 * better record for each of them, so the merged gate still reaches 100%; this list
 * is what makes that a property rather than a coincidence.
 *
 * `sonar-project.properties` states the same exemption for `src/exports/index.js`
 * from the other side.
 */
export const COVERAGE_EXEMPT_FILES: readonly string[] = [
  "tests/isolated/exports-shim.test.ts",
  "tests/isolated/monaco-loader-wiring.test.ts",
];

function collect(root: string, directory: string): string[] {
  return readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      return directory === TESTS_DIRECTORY && EXCLUDED.has(entry.name) ? [] : collect(root, child);
    }
    return entry.isFile() && TEST_FILE.test(entry.name) ? [child] : [];
  });
}

/** Every test file the runner runs, as repository-relative POSIX paths, sorted. */
export function discoverTestFiles(root: string): string[] {
  return collect(root, TESTS_DIRECTORY).sort();
}

/** A selector as the user typed it, reduced to a repository-relative POSIX path. */
function normalizeSelector(root: string, selector: string): string {
  const absolute = path.isAbsolute(selector) ? selector : path.join(root, selector);
  return path.relative(root, absolute).split(path.sep).join("/").replace(/\/+$/, "");
}

/**
 * The files named by the command line, or all of them when nothing is named.
 *
 * A selector that matches nothing raises: an empty run that exits 0 is the one
 * outcome a test runner must never produce.
 */
export function selectTestFiles(root: string, selectors: string[]): string[] {
  const all = discoverTestFiles(root);
  if (selectors.length === 0) return all;

  const selected = new Set<string>();
  for (const selector of selectors) {
    const target = normalizeSelector(root, selector);
    if (target !== TESTS_DIRECTORY && !target.startsWith(`${TESTS_DIRECTORY}/`)) {
      throw new Error(`"${selector}" is not under tests/: name a test file or a directory under tests/.`);
    }

    const matches = all.filter((file) => file === target || file.startsWith(`${target}/`));
    if (matches.length === 0) {
      throw new Error(
        `"${selector}" matched no test files. Run "bun tests/run-tests.ts --list" to see what the runner runs.`,
      );
    }
    for (const file of matches) selected.add(file);
  }

  return [...selected].sort();
}
