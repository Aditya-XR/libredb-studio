/**
 * One table built from several owners' rows, where no name may be said twice (#1821).
 *
 * A table keyed by a global name, such as a refusal code or a verifier id, is the union of the core's rows and the
 * language packs' rows. A pack row that shadowed a core row would change what the core says without either side
 * seeing it, so a collision is a load-time error naming the table and the key rather than a silent overwrite.
 *
 * A leaf with no imports, so client and server modules alike may build their tables with it.
 */

/** The intersection of every record in a tuple, so a merge keeps each owner's keys in its type. */
type Merged<R extends readonly object[]> = R extends readonly [infer Head, ...infer Tail extends readonly object[]]
  ? Head & Merged<Tail>
  : unknown;

/** The frozen union of `records`, keys in the order given; throws `${what}: ${key} is registered twice` on a collision. */
export function mergeDisjoint<const R extends readonly object[]>(records: R, what: string): Readonly<Merged<R>> {
  const merged: Record<string, unknown> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (Object.hasOwn(merged, key)) throw new Error(`${what}: ${key} is registered twice`);
      merged[key] = value;
    }
  }
  return Object.freeze(merged) as Readonly<Merged<R>>;
}
