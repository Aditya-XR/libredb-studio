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

/**
 * What separates one segment from the next. Fixed, and declared here rather than threaded through
 * as an option: the server has no opinion on it, so a configurable separator would be a choice this
 * provider made and then had to keep consistent across a tree, a `MATCH` pattern and a documented
 * behaviour, for a setting nothing else in the product has a use for.
 */
export const KEY_SEPARATOR = ":";

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

export interface KeyTreeRow {
  readonly node: KeyTreeNode;
  /** How deep the row sits, which is what its indentation is computed from. */
  readonly depth: number;
  /** True when the row can be opened. A node that is also a key is a folder as well as a key. */
  readonly folder: boolean;
}

/**
 * The rows a tree draws, given which paths are open.
 *
 * A FLAT LIST RATHER THAN A COMPONENT THAT RECURSES INTO ITSELF, because the one thing a nested
 * renderer cannot state plainly is the depth — and the depth is the whole of a row's indentation.
 * A depth-first walk knows it for free, and the panel draws top to bottom without holding any of
 * the tree's shape.
 */
export function flattenKeyTree(root: KeyTreeNode, isExpanded: (path: readonly string[]) => boolean): KeyTreeRow[] {
  const rows: KeyTreeRow[] = [];

  const walk = (node: KeyTreeNode, depth: number): void => {
    for (const child of node.children) {
      rows.push({ node: child, depth, folder: child.children.length > 0 });
      if (child.children.length > 0 && isExpanded(child.path)) walk(child, depth + 1);
    }
  };

  walk(root, 0);
  return rows;
}

/**
 * The tree narrowed to what a term matches, keeping the ancestors that lead to a match.
 *
 * A MATCHING SEGMENT KEEPS ITS WHOLE SUBTREE. Somebody who typed `cache` is asking for everything
 * under `cache` and not for the rows literally named `cache`, and a filter that also pruned below a
 * match would answer a narrower question than the one that was asked.
 *
 * The counts are the FULL sample's, not the narrowed tree's. A folder saying `3` while two of its
 * keys are filtered out is the honest answer — three keys are under it — and a count that fell to
 * the size of the current view would make the same folder read differently on every keystroke.
 */
export function filterKeyTree(root: KeyTreeNode, term: string): KeyTreeNode {
  const needle = term.trim().toLowerCase();
  if (needle === "") return root;
  // Nothing matched: the root survives with no children, so a caller has one shape to draw an empty
  // state over rather than a null to remember to check.
  return pruneKeyTree(root, needle) ?? { ...root, children: [] };
}

function pruneKeyTree(node: KeyTreeNode, needle: string): KeyTreeNode | null {
  if (node.segment.toLowerCase().includes(needle)) return node;

  const children = node.children
    .map((child) => pruneKeyTree(child, needle))
    .filter((child): child is KeyTreeNode => child !== null);

  return children.length === 0 ? null : { ...node, children };
}
