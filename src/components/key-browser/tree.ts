/**
 * The key tree a sampled walk is drawn as.
 *
 * A KEY SPACE IS A FLAT NAMESPACE, AND THIS IS THE ONLY STRUCTURE IN IT. Redis stores keys as
 * opaque bytes: `app:cache:user:1` is not a path, it is a nineteen-byte name that happens to
 * contain two colons, and the server does not know that `app:cache:user` is a prefix of it. So
 * everything below is an ARRANGEMENT of names the caller already holds rather than a reading of
 * anything — the folders exist because the caller decided `:` separates them, and no command can
 * be given a folder to answer for.
 *
 * IT IS BUILT FROM A SAMPLE, NOT FROM A CATALOG. A walk that stopped at a batch holds some of the
 * keys; a folder's count is therefore the number of keys THAT WALK SAW under it, and a prefix
 * whose keys all arrived in a later batch does not appear at all. That is the honest shape for a
 * bounded walk, and the reason this module takes an iterable rather than promising a total.
 *
 * DUPLICATES ARE ABSORBED. `SCAN` promises that a key present for the whole walk is returned at
 * least once and says nothing about at most — a rehashing table hands the same key back twice — so
 * a caller feeding successive pages in has to be able to, and a count that double-counted a repeat
 * would make the tree disagree with the progress bar beside it.
 */
import { escapeGlob } from "@/lib/query-generators";

/**
 * What separates one segment from the next. Fixed, and declared here rather than threaded through
 * as an option: the server has no opinion on it, so a configurable separator would be a choice this
 * provider made and then had to keep consistent across a tree, a `MATCH` pattern and a documented
 * behaviour, for a setting nothing else in the product has a use for.
 */
export const KEY_SEPARATOR = ":";

/**
 * A path's identity as a map key.
 *
 * `JSON.stringify` rather than a join because a segment may contain any byte, the separator
 * included: `["a:b"]` and `["a", "b"]` are two different prefixes, and a joined key would collide
 * them onto one node's state.
 */
export function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export interface KeyTreeNode {
  /** This node's own segment. The ROOT carries the empty string and is not drawn as a row. */
  readonly segment: string;
  /** Every segment from the root to this node, so a caller never re-derives one. */
  readonly path: readonly string[];
  /** Child segments: folders first, then leaves, each group in collator order. */
  readonly children: readonly KeyTreeNode[];
  /**
   * How many DISTINCT scanned keys sit at or under this node.
   *
   * At or under, not directly under: a folder says how much is inside it, which is the number a
   * reader can act on. A key that also has children (`app` beside `app:env`) is both.
   */
  readonly count: number;
  /** True when a scanned key ends exactly here. */
  readonly isKey: boolean;
}

interface MutableNode {
  segment: string;
  path: string[];
  readonly children: Map<string, MutableNode>;
  count: number;
  isKey: boolean;
}

/**
 * Folders before leaves, then by segment.
 *
 * `Intl.Collator` rather than `<`, for two reasons. It answers the EQUAL case internally, and a
 * comparator written as two `<`/`>` branches has no truthful answer for two equal segments — a
 * branch that cannot run, in a tree whose siblings are unique by construction. And `numeric` is on
 * so `user:2` sorts before `user:10`, which is how a person reads a list of numbered keys and not
 * how a byte comparison does.
 */
const collator = new Intl.Collator("en", { numeric: true });

function compareNodes(left: KeyTreeNode, right: KeyTreeNode): number {
  const byFolders = Number(right.children.length > 0) - Number(left.children.length > 0);
  return byFolders !== 0 ? byFolders : collator.compare(left.segment, right.segment);
}

function createNode(segment: string, path: string[]): MutableNode {
  return { segment, path, children: new Map(), count: 0, isKey: false };
}

/** The segments of one key name. An empty key is one empty segment rather than no segments. */
export function splitKey(key: string): string[] {
  return key.split(KEY_SEPARATOR);
}

/**
 * Arrange scanned key names into a tree, merging duplicates.
 *
 * The input is an iterable because the caller has pages and not a list: successive `SCAN` batches
 * go in as they arrive, and the tree is rebuilt from what has accumulated. Rebuilding rather than
 * inserting into a live tree is what keeps this a pure function of the keys seen — a panel that
 * mutated one tree in place would have two sources of truth for its counts the moment a walk
 * restarted from cursor `"0"`.
 */
export function buildKeyTree(keys: Iterable<string>): KeyTreeNode {
  const root = createNode("", []);
  const seen = new Set<string>();

  for (const key of keys) {
    // A repeat from a rehashing `SCAN` must not be counted twice, or a folder's badge would drift
    // above the progress bar that is meant to account for it.
    if (seen.has(key)) continue;
    seen.add(key);

    let node = root;
    node.count += 1;
    for (const segment of splitKey(key)) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = createNode(segment, [...node.path, segment]);
        node.children.set(segment, child);
      }
      child.count += 1;
      node = child;
    }
    node.isKey = true;
  }

  return toTreeNode(root);
}

function toTreeNode(node: MutableNode): KeyTreeNode {
  const children = [...node.children.values()].map(toTreeNode).sort(compareNodes);
  return { segment: node.segment, path: node.path, children, count: node.count, isKey: node.isKey };
}

/**
 * The rows a tree draws.
 *
 * TWO SHAPES RATHER THAN A NODE WITH A FLAG, because a "load more" row is not a key prefix at all:
 * it names no segment, holds no count and cannot be opened. Giving it a `KeyTreeNode` would mean
 * inventing a segment for it to display and a count for it to show — two lies to avoid one union.
 */
export type KeyTreeRow =
  | {
      readonly kind: "node";
      readonly node: KeyTreeNode;
      /** How deep the row sits, which is what its indentation is computed from. */
      readonly depth: number;
      /** True when the row can be opened. A node that is also a key is a folder as well as a key. */
      readonly folder: boolean;
      /**
       * This row's ARIA `aria-setsize`, the FULL sibling set it belongs to.
       *
       * Computed here rather than from what is drawn, because a window draws a slice: the pattern
       * wants the count of the whole set even when most of it is outside the DOM, and a number
       * derived from the mounted rows would change as the reader scrolls.
       */
      readonly setSize: number;
      /** This row's ARIA `aria-posinset`: 1-based, within `setSize`. */
      readonly posInSet: number;
    }
  | {
      readonly kind: "loadMore";
      /** The prefix this row would ask about. */
      readonly path: readonly string[];
      readonly depth: number;
      /** See the node arm: the whole sibling set, load-more row included. */
      readonly setSize: number;
      /** The load-more row is last in its set, which is why its set includes it. */
      readonly posInSet: number;
      /**
       * How many keys the walk is HOLDING under this prefix — the same `count` the folder above this
       * row draws.
       *
       * ON THE ROW BECAUSE THE PRESS IS ABOUT THAT NUMBER. A scoped page is filtered by the server and
       * then deduplicated here, so a press can legitimately come back holding only keys already in the
       * tree; a reader who cannot see the count the press is measured against reads that as a broken
       * button. It is the node's own count rather than a second walk of the list: the tree already
       * knows it.
       */
      readonly count: number;
    };

/**
 * The rows a tree draws, given which paths are open and which prefixes can be asked for more.
 *
 * A FLAT LIST RATHER THAN A COMPONENT THAT RECURSES INTO ITSELF, because the one thing a nested
 * renderer cannot state plainly is the depth — and the depth is the whole of a row's indentation.
 * A depth-first walk knows it for free, and the panel draws top to bottom without holding any of
 * the tree's shape.
 *
 * A `loadMore` ROW IS EMITTED AFTER A NODE'S CHILDREN, one level deeper than the node itself, so it
 * reads as "and there are more where these came from" rather than as one of them. It is emitted only
 * for a node that is OPEN: a collapsed folder has no children on screen for more to follow.
 */
export function flattenKeyTree(
  root: KeyTreeNode,
  isExpanded: (path: readonly string[]) => boolean,
  canLoadMore: (path: readonly string[]) => boolean = () => false,
): KeyTreeRow[] {
  const rows: KeyTreeRow[] = [];

  const walk = (node: KeyTreeNode, depth: number): void => {
    for (const child of node.children) {
      const folder = child.children.length > 0;
      rows.push({ kind: "node", node: child, depth, folder, setSize: 0, posInSet: 0 });
      if (!folder || !isExpanded(child.path)) continue;
      walk(child, depth + 1);
      if (canLoadMore(child.path)) {
        rows.push({
          kind: "loadMore",
          path: child.path,
          depth: depth + 1,
          count: child.count,
          setSize: 0,
          posInSet: 0,
        });
      }
    }
  };

  walk(root, 0);
  return numberSiblings(rows);
}

/**
 * The ARIA pair every row carries: the FULL set at its level, and its 1-based place in it.
 *
 * GROUPED BY DEPTH, which is the level `aria-level` speaks in, and not by parent - and that is the
 * whole reason this is a pass over the FINISHED list rather than arithmetic at each push. A load-more
 * row is drawn one level deeper than the folder it belongs to, so it shares a level with that
 * folder's children while being neither their parent's sibling nor their own: a set computed from the
 * node being walked would number it against the wrong rows, and the pair is exactly the thing a
 * screen reader is told when the window has hidden the rest. Grouping the flat list by depth gives
 * the set by construction, and numbering in emission order gives the place, with no row needing to
 * know what came before it.
 */
function numberSiblings(rows: KeyTreeRow[]): KeyTreeRow[] {
  // ITEM rows only. A load-more row is a BUTTON, and the ARIA set is the set of `treeitem`s: counting
  // it would have every sibling announcing a set one larger than the items a screen reader can reach,
  // and the button itself may not carry the pair at all (a button's role has no place for it).
  const setSize = new Map<number, number>();
  for (const row of rows) {
    if (row.kind === "loadMore") continue;
    setSize.set(row.depth, (setSize.get(row.depth) ?? 0) + 1);
  }

  const at = new Map<number, number>();
  return rows.map((row) => {
    if (row.kind === "loadMore") return row;
    const posInSet = (at.get(row.depth) ?? 0) + 1;
    at.set(row.depth, posInSet);
    return { ...row, posInSet, setSize: setSize.get(row.depth) ?? 0 };
  });
}

/**
 * Whether a key name sits UNDER a prefix, compared segment by segment.
 *
 * THIS IS A CORRECTNESS GUARD AND NOT A CONVENIENCE. A scoped walk asks the server for
 * `MATCH <prefix>:*`, and `MATCH` is a glob with no escape: a segment that itself contains `*`, `?`
 * or `[` (Redis keys are arbitrary bytes, so they can) makes the pattern match MORE than the prefix
 * asked about. Nothing can be done about what the server sends back, so the caller filters — and a
 * filter that compared the joined strings would be wrong in the other direction, because
 * `app:env` and `app:envelope` share a prefix of characters and not of segments.
 */
export function isUnderPrefix(key: string, prefix: readonly string[]): boolean {
  const segments = splitKey(key);
  return prefix.length < segments.length && prefix.every((segment, index) => segments[index] === segment);
}

/**
 * The `MATCH` pattern for everything under a prefix.
 *
 * ONE PLACE, because the two halves are not interchangeable (#427) and two callers build this string:
 * the PREFIX is data that may contain glob metacharacters and is escaped, while the trailing `:*` is
 * the glob the pattern exists for and never is. It also accepts the form the tree ADVERTISES — a
 * folder is drawn `user:*` — so a caller holding a row's own name need not know that the trailing `*`
 * is not part of the prefix that name stands for.
 */
export function prefixPattern(prefix: string): string {
  const bare = prefix.endsWith(`${KEY_SEPARATOR}*`) ? prefix.slice(0, -2) : prefix;
  return `${escapeGlob(bare)}${KEY_SEPARATOR}*`;
}

/**
 * The tree narrowed to what a term matches, keeping the ancestors that lead to a match.
 *
 * THE TERM IS TESTED AGAINST THE WHOLE KEY NAME AND AGAINST ONE SEGMENT, and the two are different
 * questions a reader asks in the same box. A single word (`cache`) names a segment and means "the
 * branch called that", which is why a matching segment keeps its WHOLE subtree: somebody who typed
 * `cache` is asking for everything under `cache`, not for the rows literally named `cache`. A term
 * with a `:` in it (`queue:jobs:failed:2026:09:23`) names a PATH, and no segment can ever contain it
 * — so a segment-only test answers "no match" for the one input that most obviously identifies a key,
 * which is the defect this rule exists to close.
 *
 * The counts are the FULL sample's, not the narrowed tree's. A folder saying `3` while two of its
 * keys are filtered out is the honest answer — three keys are under it — and a count that fell to the
 * size of the current view would make the same folder read differently on every keystroke.
 */
export function filterKeyTree(root: KeyTreeNode, term: string): KeyTreeNode {
  const needle = searchTerm(term);
  if (needle === "") return root;
  // Nothing matched: the root survives with no children, so a caller has one shape to draw an empty
  // state over rather than a null to remember to check.
  return pruneKeyTree(root, needle, "") ?? { ...root, children: [] };
}

/**
 * What the box's text asks for, once it is trimmed and taken out of the form the tree ADVERTISES.
 *
 * A FOLDER IS DRAWN AS `app:*`, so a reader who copies one has typed a name no key has: no key
 * contains a `*` unless the key itself does, and `app:*` would answer "no match" for exactly the
 * branch the row above the box is showing. The trailing `:*` is therefore dropped, and only that
 * form — a `*` anywhere else stays literal, because a real key segment may contain one (#427).
 *
 * An empty result is NO FILTER rather than a term nothing matches, which is what `:*` alone and an
 * all-whitespace box both mean.
 */
function searchTerm(term: string): string {
  const trimmed = term.trim().toLowerCase();
  return trimmed.endsWith(`${KEY_SEPARATOR}*`) ? trimmed.slice(0, -2) : trimmed;
}

/**
 * How tall one row is, fixed because a window is arithmetic over a slice of them.
 *
 * 24 is the row this panel already draws (`h-6`). The object tree's own 28 is ITS number, and a
 * shared constant would be two trees agreeing on something neither of them needs to share — what has
 * to agree is the shape of `keyTreeWindow` and `treeWindow`, which is what the test pins.
 */
export const KEY_ROW_HEIGHT = 24;

/** Rows kept mounted beyond each edge of the viewport, so a scroll does not flash empty. */
const KEY_WINDOW_OVERSCAN = 4;

/**
 * The half-open row range to mount, for a tree drawn as a flat list.
 *
 * AN UNMEASURED BOX MOUNTS EVERYTHING IT HAS. Height 0 means the container has not been laid out
 * yet — it is `display:none`, or the panel was mounted hidden — and guessing a height there would
 * hide rows a reader cannot yet scroll to, behind a scrollbar they will not see. The object tree
 * answers the same fact differently (it mounts `2 * overscan` rows and waits for a scroll) because
 * its rows are windowed against a box it measures on every scroll; this panel takes the other side
 * deliberately: the honest reading of "I do not know how tall this is" is "show what I have".
 *
 * `focusIndex` shifts the window to CONTAIN that row rather than widening it, so a row the reader
 * has focused is never unmounted under them — focus cannot move to a node that is not in the DOM,
 * and losing focus mid-scroll is the one way virtualising a tree can make a keyboard reader worse
 * off than no virtualisation at all.
 */
export function keyTreeWindow(
  count: number,
  scrollTop: number,
  height: number,
  focusIndex = -1,
): readonly [number, number] {
  if (height <= 0) return [0, count];
  const size = Math.min(count, Math.ceil(height / KEY_ROW_HEIGHT) + KEY_WINDOW_OVERSCAN * 2);
  /*
   * CLAMPED TO ZERO ONCE, FOR BOTH BRANCHES BELOW, and that is a correctness rule rather than tidiness:
   * the overscan subtraction makes this negative anywhere in the first four rows, and a NEGATIVE window
   * start is not a window that begins early - `slice(-4, 14)` reads from the END of the list and, in a
   * list longer than fourteen rows, returns NOTHING. The panel then draws no rows at all, the database
   * row included, which is exactly what a reader sees after clicking a row near the top: the focus pin
   * below is asked for a window around that row, and the arithmetic handed it a negative start.
   */
  const byScroll = Math.max(Math.floor(scrollTop / KEY_ROW_HEIGHT) - KEY_WINDOW_OVERSCAN, 0);
  const nearEnd = Math.max(count - size, 0);
  const start =
    focusIndex < 0
      ? Math.min(byScroll, nearEnd)
      : Math.min(
          Math.max(byScroll, focusIndex - size + 1),
          Math.max(focusIndex, 0),
          // A focus index can outlive the rows it pointed into - a rescan or a collapse shrinks them
          // while the row is still focused - and an index past the end would otherwise push the whole
          // window off the list and blank the panel, so it is held to the last window start.
          nearEnd,
        );
  return [start, start + size];
}

/**
 * The node and the ancestors that lead to a match, or null.
 *
 * `prefix` is the parent's own full name, passed down rather than rebuilt by joining the path at
 * every node: the walk already knows it, and a join per node per keystroke is work a filter does not
 * need to do over ten thousand keys.
 */
function pruneKeyTree(node: KeyTreeNode, needle: string, prefix: string): KeyTreeNode | null {
  const name = prefix === "" ? node.segment : `${prefix}${KEY_SEPARATOR}${node.segment}`;
  if (node.segment.toLowerCase().includes(needle) || name.toLowerCase().includes(needle)) return node;

  const children = node.children
    .map((child) => pruneKeyTree(child, needle, name))
    .filter((child): child is KeyTreeNode => child !== null);

  return children.length === 0 ? null : { ...node, children };
}
