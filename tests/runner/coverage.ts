/**
 * The coverage directory, which the runner empties before every coverage run.
 *
 * Emptying it is necessary: a stale report from a previous run would be merged into
 * this one, and the merge cannot tell the two apart. But `--coverage-dir` is a path
 * the caller chooses, and `rmSync(dir, { recursive: true })` on a mistyped one is
 * not a mistake anybody recovers from: `--coverage-dir=src` would delete the
 * product. Every other option in this runner validates what it is given; this is
 * that validation.
 *
 * The rule is ownership, not a name: a directory the runner may empty either does
 * not exist yet, is empty, or holds nothing but what a previous coverage run of this
 * runner put there.
 */

/** What a coverage run leaves behind: one directory per test file, plus the merge's own inputs. */
const OWNED = /^(file-\d+|lcov\.info|inputs\.txt)$/;

export function unownedCoverageEntries(entries: string[]): string[] {
  return entries.filter((entry) => !OWNED.test(entry)).sort();
}

/**
 * Raises when the directory holds anything this runner did not write, naming what it
 * found. The caller passes the entries rather than a path so the rule is testable
 * without building a directory that proves the point by being deleted.
 */
export function assertCoverageDirIsOurs(directory: string, entries: string[]): void {
  const unowned = unownedCoverageEntries(entries);
  if (unowned.length === 0) return;

  throw new Error(
    `Refusing to empty ${directory}: it holds ${unowned.length} entr${unowned.length === 1 ? "y" : "ies"} ` +
      `this runner did not write (${unowned.slice(0, 5).join(", ")}). ` +
      "Point --coverage-dir at a directory that is empty or holds only a previous coverage run.",
  );
}
