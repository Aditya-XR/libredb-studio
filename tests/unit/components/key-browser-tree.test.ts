import { describe, test, expect } from "bun:test";
import {
  buildKeyTree,
  filterKeyTree,
  flattenKeyTree,
  splitKey,
  KEY_SEPARATOR,
  type KeyTreeNode,
} from "@/components/key-browser/tree";

/** The child segments of a node, which is what most of these assertions are about. */
function segments(node: KeyTreeNode): string[] {
  return node.children.map((child) => child.segment);
}

/** One node by path, so an assertion can name the folder it is about rather than walk. */
function at(root: KeyTreeNode, ...path: string[]): KeyTreeNode {
  let node = root;
  for (const segment of path) {
    const next = node.children.find((child) => child.segment === segment);
    if (next === undefined) throw new Error(`no child "${segment}" under ${JSON.stringify(node.path)}`);
    node = next;
  }
  return node;
}

describe("splitKey()", () => {
  test("splits on the one separator the tree is built from", () => {
    expect(KEY_SEPARATOR).toBe(":");
    expect(splitKey("app:cache:user:1")).toEqual(["app", "cache", "user", "1"]);
  });

  test("a key with no separator is one segment", () => {
    expect(splitKey("healthcheck")).toEqual(["healthcheck"]);
  });

  test("an empty key is one empty segment rather than no segments", () => {
    // Redis accepts the empty string as a key. `"".split(":")` already answers `[""]`, and this
    // pins it because the alternative spelling (`[]`) would make such a key vanish from the tree
    // while still counting toward the root.
    expect(splitKey("")).toEqual([""]);
  });

  test("empty segments are kept, because the key really does contain them", () => {
    // `:foo`, `foo:` and `a::b` are three distinct keys on the server. Collapsing the empty
    // segment would draw them as the same path and merge three keys into one row.
    expect(splitKey(":foo")).toEqual(["", "foo"]);
    expect(splitKey("foo:")).toEqual(["foo", ""]);
    expect(splitKey("a::b")).toEqual(["a", "", "b"]);
  });
});

describe("buildKeyTree()", () => {
  test("an empty input is an empty root", () => {
    const root = buildKeyTree([]);

    expect(root.segment).toBe("");
    expect(root.path).toEqual([]);
    expect(root.children).toEqual([]);
    expect(root.count).toBe(0);
    expect(root.isKey).toBe(false);
  });

  test("a key with no separator is a single leaf", () => {
    const root = buildKeyTree(["healthcheck"]);

    expect(segments(root)).toEqual(["healthcheck"]);
    expect(root.count).toBe(1);
    expect(at(root, "healthcheck")).toMatchObject({ path: ["healthcheck"], count: 1, isKey: true, children: [] });
  });

  test("counts every key at or under a node, and nothing above it", () => {
    const root = buildKeyTree(["app:env", "app:cache:ttl", "user:1001:name"]);

    // The root counts everything the walk saw: it is the one number a caller can compare against
    // the progress indicator, and it counts DISTINCT keys rather than rows drawn.
    expect(root.count).toBe(3);
    expect(at(root, "app").count).toBe(2);
    expect(at(root, "app", "env").count).toBe(1);
    expect(at(root, "app", "cache").count).toBe(1);
    expect(at(root, "user").count).toBe(1);
    // A leaf carries the count of the keys that end there, which is one by definition — two keys
    // cannot share a full name.
    expect(at(root, "app", "cache", "ttl").count).toBe(1);
  });

  test("a node is both a key and a folder when a key is a prefix of another", () => {
    // The case the tree exists for, and the one a naive build gets wrong: `app` is a real key AND
    // the parent of `app:env`, so it must draw as an expandable row that is also openable.
    const root = buildKeyTree(["app", "app:env"]);
    const app = at(root, "app");

    expect(app.isKey).toBe(true);
    expect(segments(app)).toEqual(["env"]);
    expect(app.count).toBe(2);
    expect(root.count).toBe(2);
  });

  test("absorbs duplicate keys across pages rather than counting them twice", () => {
    // `SCAN` may hand the same key back on a second batch while the table rehashes, so the caller
    // feeds pages in without deduplicating them first. A double-count here would put a folder's
    // badge above the progress bar that is meant to account for it.
    const root = buildKeyTree(["app:env", "app:env", "app:cache:ttl", "app:env"]);

    expect(root.count).toBe(2);
    expect(at(root, "app").count).toBe(2);
    expect(at(root, "app", "env").count).toBe(1);
  });

  test("drives a node's path from its ancestors", () => {
    const root = buildKeyTree(["app:cache:user:1"]);

    expect(at(root, "app", "cache", "user", "1").path).toEqual(["app", "cache", "user", "1"]);
    // A folder's path is the segments ABOVE it, so a caller never has to re-derive a prefix from
    // the name it is looking at.
    expect(at(root, "app", "cache").path).toEqual(["app", "cache"]);
  });

  test("puts folders before leaves, ahead of the alphabetical order", () => {
    // `zzz` sorts after `aaa` and is drawn first because it is a folder: the tree groups what can
    // be expanded, and a list that interleaved the two would make a reader scan every row to find
    // the one twisty they were looking for.
    const root = buildKeyTree(["aaa", "zzz:inner"]);

    expect(segments(root)).toEqual(["zzz", "aaa"]);
  });

  test("orders sibling segments the way a person reads numbered keys", () => {
    const root = buildKeyTree(["user:10", "user:2", "user:1"]);

    // Numeric collation, so `2` precedes `10` instead of following it the way a byte comparison
    // would have it.
    expect(segments(at(root, "user"))).toEqual(["1", "2", "10"]);
  });

  test("gives empty segments their own rows instead of merging the keys that carry them", () => {
    const root = buildKeyTree([":foo", "foo:", "a::b"]);

    // Three keys, and none of them collapses into another: the empty segment is a segment.
    expect(root.count).toBe(3);
    expect(segments(root)).toEqual(["", "a", "foo"]);
    expect(at(root, "", "foo").isKey).toBe(true);
    expect(at(root, "foo", "").isKey).toBe(true);
    expect(at(root, "a", "", "b").isKey).toBe(true);
  });

  test("is a pure function of the keys, so a restarted walk rebuilds the same tree", () => {
    const keys = ["app:env", "app:cache:ttl", "user:1001:name"];

    // The panel accumulates its pages and rebuilds; that is only safe because two calls with the
    // same keys agree, including on ordering. A tree mutated in place would have two sources of
    // truth for its counts the moment a walk restarted from cursor "0".
    expect(buildKeyTree(keys)).toEqual(buildKeyTree([...keys]));
  });
});

describe("flattenKeyTree()", () => {
  const KEYS = ["app:env", "app:cache:ttl", "healthcheck"];

  test("draws the top level when nothing is open", () => {
    const rows = flattenKeyTree(buildKeyTree(KEYS), () => false);

    // Folders before leaves, as the tree orders them: `app` and then `healthcheck`.
    expect(rows.map((row) => [row.node.segment, row.depth, row.folder])).toEqual([
      ["app", 0, true],
      ["healthcheck", 0, false],
    ]);
  });

  test("walks into an open path and deepens each level", () => {
    const root = buildKeyTree(KEYS);
    // Only the top level is open, so `cache` is drawn and its own child is not.
    const rows = flattenKeyTree(root, (path) => path.length === 1 && path[0] === "app");

    expect(rows.map((row) => [row.node.segment, row.depth])).toEqual([
      ["app", 0],
      ["cache", 1],
      ["env", 1],
      ["healthcheck", 0],
    ]);

    // Opening one more level is a property of the PATH and not of the row, which is what makes a
    // second sibling's children stay closed while the first one's open.
    const deeper = flattenKeyTree(root, (path) => path.length <= 2 && path[0] === "app");
    expect(deeper.map((row) => [row.node.segment, row.depth])).toEqual([
      ["app", 0],
      ["cache", 1],
      ["ttl", 2],
      ["env", 1],
      ["healthcheck", 0],
    ]);
  });

  test("calls a node that is both a key and a folder a folder", () => {
    const rows = flattenKeyTree(buildKeyTree(["app", "app:env"]), () => false);

    // `app` is a real key and the parent of one. It has to draw as openable, and it is the only
    // node here where `isKey` and `folder` are both true.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ depth: 0, folder: true });
    expect(rows[0].node.isKey).toBe(true);
  });
});

describe("filterKeyTree()", () => {
  const KEYS = ["app:cache:ttl", "app:env", "user:1001:name", "healthcheck"];

  test("returns the tree untouched for a blank term", () => {
    const root = buildKeyTree(KEYS);

    // Identity rather than a copy, so a panel that filters on every keystroke does no work until
    // somebody types a character, and "no filter" cannot drift from "no filter applied".
    expect(filterKeyTree(root, "")).toBe(root);
    expect(filterKeyTree(root, "   ")).toBe(root);
  });

  test("keeps everything under a segment that matches", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "cache");

    // The whole subtree, not just the row named `cache`: somebody who typed a prefix is asking
    // what is under it.
    expect(segments(filtered)).toEqual(["app"]);
    expect(segments(at(filtered, "app"))).toEqual(["cache"]);
    expect(at(filtered, "app", "cache", "ttl").isKey).toBe(true);
  });

  test("keeps the ancestors that lead to a match and drops the siblings beside them", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "1001");

    expect(segments(filtered)).toEqual(["user"]);
    expect(segments(at(filtered, "user"))).toEqual(["1001"]);
    // `app` and `healthcheck` are gone, and `user` survives only as the path to the match.
    expect(at(filtered, "user", "1001", "name").isKey).toBe(true);
  });

  test("matches without regard to case", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "HEALTH");

    expect(segments(filtered)).toEqual(["healthcheck"]);
  });

  test("answers an empty tree rather than nothing when no segment matches", () => {
    const filtered = filterKeyTree(buildKeyTree(KEYS), "nothing-here");

    // One shape to draw an empty state over, rather than a null every caller has to remember.
    expect(filtered.children).toEqual([]);
    expect(filtered.segment).toBe("");
  });

  test("keeps the sample's own counts rather than the narrowed view's", () => {
    const root = buildKeyTree(KEYS);
    const filtered = filterKeyTree(root, "1001");

    // `user` holds one key and its count says so. A count recomputed from the filtered tree would
    // read differently on every keystroke for the same folder, which is how a reader stops
    // trusting the number.
    expect(at(filtered, "user").count).toBe(at(root, "user").count);
    expect(filtered.count).toBe(root.count);
  });
});
