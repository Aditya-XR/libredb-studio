/**
 * Reading a catalog statement's rows back into tables (#1821): the cell readers that tolerate
 * what each driver returns, and the mutable table index an engine's row builder fills.
 *
 * A leaf on purpose, with no runtime import, so an engine module that turns its own catalog rows
 * into an inventory takes these without importing `context-snapshot.ts`.
 */

import type { AgentCatalogKind } from "./composed-sql-primitives";
import type { ColumnSchema, ForeignKeySchema, IndexSchema } from "@/lib/types";

/** The rows of each catalog kind one capture read, keyed by the kind that read them. */
export type CatalogRows = ReadonlyMap<AgentCatalogKind, readonly Record<string, unknown>[]>;

export interface MutableTable {
  readonly name: string;
  readonly columns: ColumnSchema[];
  readonly indexes: IndexSchema[];
  readonly foreignKeys: ForeignKeySchema[];
  /** The declared kind id this entry was identified as, where the catalog said. */
  readonly kind?: string;
}

export type TableIndex = Map<string, MutableTable>;

/** What a catalog row's engine word resolves to: a declared kind id, or nothing. */
export type ComposedKindResolver = (word: unknown) => string | undefined;

/**
 * How one dialect's inventory is read: which catalog kinds to ask for, and how to
 * turn their rows into tables.
 *
 * A dialect whose `catalogCapture` is `"unsupported"` gets no composed snapshot: its
 * inventory is the provider's own (`captureFromProvider` in `context-snapshot.ts`).
 * `catalogRead` holds the same served-dialect decision for the tool the model
 * drives; the duplication is deliberate rather than shared, because the two answer
 * different questions — one is "can a statement be composed", the other is "can its
 * rows be read back into an inventory" — and a dialect can honestly gain the first
 * before the second. A dialect that composes but declares no capture yields no
 * composed snapshot, which is the safe direction.
 */
export interface AgentCatalogCapture {
  /** The catalog kinds read, in order: the statement order, and so the fingerprint and the ledger bytes. */
  readonly kinds: readonly AgentCatalogKind[];
  readonly build: (rows: CatalogRows, kindOf: ComposedKindResolver) => TableIndex;
  /**
   * The engine's own word for what a relation IS, mapped onto the kind id the PROVIDER
   * declares (#789 fix round 3).
   *
   * The composed path does not ask a provider to describe itself: it writes the catalog
   * statement for the dialect and drives it through `queryReadOnly` inside the run's
   * read-only envelope, which is why `catalogCapture` exists at all. The kind is carried the
   * same way as every other fact that path carries - selected by the statement and folded
   * out of the rows - rather than by reaching for the curated object surface, whose four
   * methods send their statements through `provider.query` and would leave the envelope
   * (fix round 2, and the tests that pin it stay exactly as they are).
   *
   * TWO VOCABULARIES MEET HERE and only one of them may reach a run. The catalog answers
   * the ENGINE's word - a `pg_class.relkind` character, a `sqlite_schema.type` string - and
   * what the tree, the object routes and `addressableObjects` all speak is the PROVIDER's
   * declared kind id. So the map's right-hand side is copied from the provider's own
   * mapping and pinned to it by a source test, the same way `POSTGRES_SYSTEM_SCHEMAS` is:
   *
   *  - PostgreSQL: `postgres.ts`'s `COUNTS_RELATION_ARM` is the CASE its own counts and
   *    listings are taken from, so a relation this path calls a `view` is the one its
   *    object browser draws under Views.
   *  - SQLite: `sqlite_schema.type` carries exactly the four words `sqlite.ts` declares as
   *    ids, so the map is the identity. The composed catalog read selects `table` and
   *    `view` only; the other two are here because the map is the engine's vocabulary and
   *    not this reading's sample of it (ruling 5a).
   *
   * An engine word with no entry - a PostgreSQL foreign table, `relkind = 'f'`, which
   * `information_schema.columns` really does answer for - and an id this CONNECTION does
   * not declare both resolve to NO KIND. The object still reaches the model, named and with
   * its columns, under no word at all: a missing fact filled in with the commonest value is
   * exactly how a view came to be handed over as a table, and a kind the provider never
   * declared is one the tree draws no folder for, so a run and the tree would disagree
   * about what a thing is.
   */
  readonly kindWords: Readonly<Record<string, string>>;
}

/** A row value as text. Engine drivers return numbers and booleans for some columns. */
export function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

/** PostgreSQL booleans arrive as booleans from `pg`, and as `t`/`true` from elsewhere. */
export function truthy(value: unknown): boolean {
  return value === true || value === "t" || value === "true" || value === 1;
}

export const qualified = (schema: unknown, table: unknown): string => `${text(schema)}.${text(table)}`;

/**
 * A number an engine reported, or `null` when it reported nothing readable.
 *
 * Drivers disagree about the JavaScript type of a numeric column — `pg` returns
 * `numeric` as a string — so the text form is accepted, and anything that does not
 * read as a finite number becomes absence rather than a `NaN` that would later print
 * as a row count.
 */
export function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Applies `change` to a known table, and drops the row when there is no such table. */
export function attach(tables: TableIndex, name: string, change: (table: MutableTable) => void): void {
  const table = tables.get(name);
  if (table !== undefined) change(table);
}

export function markPrimary(table: MutableTable, columnName: string): void {
  for (const column of table.columns) {
    if (column.name === columnName) column.isPrimary = true;
  }
}

export function emptyTable(name: string): MutableTable {
  return { name, columns: [], indexes: [], foreignKeys: [] };
}
