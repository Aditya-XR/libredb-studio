/**
 * What a shell imports from the key browser, and nothing else.
 *
 * A barrel that re-exports its whole folder cannot be read as a statement about what the outside
 * uses, and `knip` says so: the object tree's barrel carried eighteen lines that reached nobody
 * until the required check named them (#789). `Sidebar` mounts `KeyBrowser`, and the pieces it is
 * built from — the walk, the tree, the row — are this folder's own business.
 */
export { KeyBrowser } from "./KeyBrowser";
export type { KeyPatternRequest } from "./KeyBrowser";
