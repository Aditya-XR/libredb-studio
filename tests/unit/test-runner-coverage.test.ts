import { describe, expect, test } from "bun:test";
import { assertCoverageDirIsOurs, unownedCoverageEntries } from "../runner/coverage";

// The runner empties its coverage directory before every coverage run, so the one
// argument that decides which directory that is has to be the one argument it
// validates. Without this, `--coverage-dir=src` deletes the product.
describe("emptying the coverage directory", () => {
  test("a directory that does not exist yet, or is empty, is ours to use", () => {
    expect(unownedCoverageEntries([])).toEqual([]);
    expect(() => assertCoverageDirIsOurs("coverage/raw", [])).not.toThrow();
  });

  test("a previous coverage run of this runner is ours to empty", () => {
    const previous = ["file-1", "file-2", "file-538", "lcov.info", "inputs.txt"];

    expect(unownedCoverageEntries(previous)).toEqual([]);
    expect(() => assertCoverageDirIsOurs("coverage/raw", previous)).not.toThrow();
  });

  test("anything else stops the run, and the message names what was found", () => {
    expect(() => assertCoverageDirIsOurs("src", ["app", "lib", "components", "file-1"])).toThrow(
      /Refusing to empty src: it holds 3 entries this runner did not write \(app, components, lib\)/,
    );
  });

  test("a single stranger is reported in the singular, because the sentence is read by a person", () => {
    expect(() => assertCoverageDirIsOurs("coverage", ["html"])).toThrow(/holds 1 entry this runner did not write/);
  });

  test("a name that merely looks like ours is not ours", () => {
    // `file-1` is the runner's; `file-one` and `lcov.info.bak` are somebody's work.
    expect(unownedCoverageEntries(["file-1", "file-one", "lcov.info.bak"])).toEqual(["file-one", "lcov.info.bak"]);
  });
});
