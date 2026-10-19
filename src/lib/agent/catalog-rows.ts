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
