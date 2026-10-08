/**
 * Databend wire cells to Studio rows (design section 4).
 *
 * In the `display` result mode every cell is text or `null` (measured, M08c), so the value a grid shows is read from
 * the column's declared type, with one outer `Nullable(...)` stripped for the read and the declared type kept
 * verbatim in `columnTypes`:
 *
 * - `Boolean` `"1"` and `"0"` are `true` and `false`; any other text stays a string.
 * - The integer types are numbers when the text is a safe integer that round-trips, else the exact text, so an
 *   `Int64` or `UInt64` from 2^53 up is never rounded.
 * - `Float32` and `Float64` are numbers when finite; `NaN` and the infinities stay their text.
 * - Every other type (Decimal, dates, timestamps, intervals, String, hex Binary, geo, Variant, Array, Map, Tuple,
 *   Vector, Bitmap) is its text verbatim and is never refused; a nested NULL there is a bare `NULL`, not JSON.
 *
 * Columns are named by `uniqueFieldNames` and rows keyed positionally by `keyRowsByPosition`, which refuses a row
 * whose width is not the schema's. A one-row answer in a single `UInt64` column `number of rows inserted|updated|deleted`
 * is a DML statement's (M08b, M08f, M08i): its count is the `rowCount`, as Trino reports a statement's update count,
 * and a count from 2^53 up, which the row keeps as its exact text, is the nearest number there, so not exact.
 * A SELECT aliasing a `UInt64` value to that name in that shape cannot be told apart on the wire and is read the same.
 */
import { keyRowsByPosition } from "@/lib/db/utils/positional-rows";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import type { DatabendCell, StatementOutcome } from "./transport";

/** The decoded result: names, keyed rows, the declared types by name, and the count the result reports. */
export interface DecodedResult {
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  columnTypes: Record<string, string>;
}

const INTEGER_TYPES = new Set(["Int8", "Int16", "Int32", "Int64", "UInt8", "UInt16", "UInt32", "UInt64"]);
const FLOAT_TYPES = new Set(["Float32", "Float64"]);

/** The column a DML statement answers its count in, and its declared type (M08b, M08f, M08i). */
const DML_COUNT_COLUMN = /^number of rows (?:inserted|updated|deleted)$/;
const DML_COUNT_TYPE = "UInt64";
/** A count's exact text from 2^53 up, which the cell keeps and the result's count reads as its nearest number. */
const WHOLE_NUMBER_TEXT = /^\d+$/;

const NULLABLE = /^Nullable\((.*)\)$/;

/** The type a cell is read by: the declared type with one outer `Nullable(...)` stripped. */
function readType(declared: string): string {
  return NULLABLE.exec(declared)?.[1] ?? declared;
}

function decodeCell(type: string, cell: DatabendCell): unknown {
  if (cell === null) return null;
  if (type === "Boolean") {
    if (cell === "1") return true;
    if (cell === "0") return false;
    return cell;
  }
  if (INTEGER_TYPES.has(type)) {
    const value = Number(cell);
    return Number.isSafeInteger(value) && String(value) === cell ? value : cell;
  }
  if (FLOAT_TYPES.has(type)) {
    const value = Number(cell);
    return Number.isFinite(value) ? value : cell;
  }
  return cell;
}

/** Decodes one completed statement's schema and wire rows; `sql` names the statement in a refusal. */
export function decodeOutcome(outcome: Pick<StatementOutcome, "schema" | "rows">, sql: string): DecodedResult {
  const fields = uniqueFieldNames(outcome.schema.map((column) => column.name));
  const types = outcome.schema.map((column) => readType(column.type));
  const values = outcome.rows.map((row) => row.map((cell, position) => decodeCell(types[position], cell)));
  const rows = keyRowsByPosition(fields, values, "databend", sql);
  const columnTypes = Object.fromEntries(fields.map((field, position) => [field, outcome.schema[position].type]));

  let rowCount = rows.length;
  const [only] = outcome.schema;
  if (
    outcome.schema.length === 1 &&
    rows.length === 1 &&
    only.type === DML_COUNT_TYPE &&
    DML_COUNT_COLUMN.test(only.name)
  ) {
    const count = values[0][0];
    if (typeof count === "number") rowCount = count;
    // `rowCount` is a number, so a count from 2^53 up is its nearest one there and exact only in the row.
    else if (typeof count === "string" && WHOLE_NUMBER_TEXT.test(count)) rowCount = Number(count);
  }
  return { fields, rows, rowCount, columnTypes };
}
