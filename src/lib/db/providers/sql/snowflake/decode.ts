/**
 * Snowflake `jsonv2` cells to Studio rows, losslessly.
 *
 * Every cell arrives as a JSON string or `null`, and `null` is SQL NULL for every type. The value a grid shows is
 * read from the column's `rowType.type` (either case), and `columnTypeOf` gives the type in catalog spelling:
 *
 * - `fixed` with scale 0 is a number when the text is a safe integer that round-trips, else the exact text, so a
 *   NUMBER(38,0) from 2^53 up is never rounded; with a scale it is always the exact text, as `decfloat` is.
 * - `real` is a number when finite; `NaN` and the infinities (`inf`, `-inf`, `Infinity`, `-Infinity`) are mapped by
 *   a table to their word, never through `Number()`.
 * - `boolean` is `true` for `true` or `1` and `false` for `false` or `0`, any case; other text stays as sent.
 * - `binary` is a `Buffer` from validated hex.
 * - `date` is days since the epoch; `time`, `timestamp_ntz` and `timestamp_ltz` are seconds with up to 9 fraction
 *   digits, and `timestamp_tz` the same, one space and an offset carried as minutes plus 1440. The arithmetic is
 *   exact, in `BigInt` nanoseconds, the fraction printed with the digits received. A pre-1970 fraction is one signed
 *   decimal, so `-1.5` is 1.5 seconds before the epoch. None of these depends on the session's TIMEZONE. `ltz` is
 *   the UTC instant with `+00:00`: Snowflake sends it as bare epoch seconds and its answer does not name the session
 *   zone, so the instant is shown exactly, at UTC, rather than at a guessed zone. The calendar is proleptic Gregorian with astronomical years, as Snowflake counts days:
 *   a year outside 1 to 9999, which Snowflake stores, is written with all its digits and a `-` at or before year 0
 *   (`10000-01-01`, `-0002-06-01` for 3 BC), never refused, so one such cell cannot fail a result.
 * - `variant`, `object`, `array`, `map`, `vector` and every other type are their text verbatim, never parsed, so a
 *   10,000-deep VARIANT passes as a string. `vector` is not declared as a vector column: the trial capture
 *   (Snowflake 10.37.100, 2026-10-12) reports its `rowType` as `vector` with no element type or dimension, so the
 *   cell stays JSON array text, which the grid shows as text.
 *
 * A cell whose text does not match its type's shape is refused with the column's name, never shown as a silent
 * wrong value. `parseCellJson` is the one JSON parse of a server cell's text in the provider, depth-limited before
 * `JSON.parse` runs. Pure: no I/O, no clock.
 */
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { SnowflakeError } from "./errors";

/** The deepest nesting `parseCellJson` reads; anything deeper is refused before it is parsed. */
const SNOWFLAKE_CELL_MAX_DEPTH = 64;

/** One `rowType` entry, as the decoder reads it. */
export interface SnowflakeColumn {
  readonly name: string;
  /** Lower case. */
  readonly type: string;
  readonly precision: number | null;
  readonly scale: number | null;
  readonly length: number | null;
  /**
   * The `extTypeName` Snowflake adds to some columns: measured on 2026-10-14, a GEOGRAPHY or GEOMETRY column is
   * `type: "object"` with `extTypeName: "GEOGRAPHY"` or `"GEOMETRY"`. Absent when the entry carries none.
   */
  readonly extTypeName?: string;
}

export type SnowflakeCell = string | number | boolean | Buffer | null;

export const SNOWFLAKE_DECODE_SENTENCES = Object.freeze({
  unreadable: (columnType: string, column: string) =>
    `Snowflake sent a ${columnType} value in column "${column}" that Studio could not read, so the result is not shown.`,
  columns: "Snowflake sent a result whose column list Studio could not read.",
});

const INTEGER_TEXT = /^-?\d+$/;
const DECIMAL_TEXT = /^-?\d+(\.\d+)?$/;
const DECFLOAT_TEXT = /^-?(\d+(\.\d*)?|\.\d+)([eE][-+]?\d+)?$/;
const HEX_TEXT = /^([0-9A-Fa-f]{2})*$/;
const SECONDS_TEXT = /^(-?)(\d+)(?:\.(\d{1,9}))?$/;
const ZONED_TEXT = /^(-?\d+(?:\.\d{1,9})?) (-?\d+)$/;
const NON_FINITE: ReadonlyMap<string, string> = new Map([
  ["NaN", "NaN"],
  ["inf", "Infinity"],
  ["Infinity", "Infinity"],
  ["-inf", "-Infinity"],
  ["-Infinity", "-Infinity"],
]);
const BOOLEANS: ReadonlyMap<string, boolean> = new Map([
  ["true", true],
  ["1", true],
  ["false", false],
  ["0", false],
]);

// BigInt(...) calls rather than literals: the build targets below ES2020.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const SIXTY = BigInt(60);
const NANOS_PER_SECOND = BigInt(1_000_000_000);
const SECONDS_PER_DAY = BigInt(86_400);
const SECONDS_PER_HOUR = BigInt(3_600);
/** The civil-from-days constants: the days from 0000-03-01 to the epoch, and the days of one 400-year era. */
const DAYS_TO_EPOCH_FROM_MARCH_0 = BigInt(719_468);
const DAYS_PER_ERA = BigInt(146_097);
/** The offset `timestamp_tz` carries is the offset in minutes plus this. */
const TZ_OFFSET_BIAS = BigInt(1440);

function unreadable(column: SnowflakeColumn): SnowflakeError {
  return new SnowflakeError("query", SNOWFLAKE_DECODE_SENTENCES.unreadable(columnTypeOf(column), column.name));
}

/** The `extTypeName`s that name the column's type, read only for an `object` column. */
const SPATIAL_TYPES: ReadonlySet<string> = new Set(["GEOGRAPHY", "GEOMETRY"]);

/** The type in catalog spelling, as `columnTypes` shows it. */
export function columnTypeOf(column: SnowflakeColumn): string {
  const scaled = (name: string) => (column.scale === null ? name : `${name}(${column.scale})`);
  switch (column.type.toLowerCase()) {
    case "fixed":
      return column.precision === null ? "NUMBER" : `NUMBER(${column.precision},${column.scale ?? 0})`;
    case "decfloat":
      return "DECFLOAT";
    case "real":
      return "FLOAT";
    case "text":
      return column.length === null ? "VARCHAR" : `VARCHAR(${column.length})`;
    case "boolean":
      return "BOOLEAN";
    case "object":
      return column.extTypeName !== undefined && SPATIAL_TYPES.has(column.extTypeName.toUpperCase())
        ? column.extTypeName.toUpperCase()
        : "OBJECT";
    case "binary":
      return "BINARY";
    case "date":
      return "DATE";
    case "time":
      return scaled("TIME");
    case "timestamp_ntz":
      return scaled("TIMESTAMP_NTZ");
    case "timestamp_ltz":
      return scaled("TIMESTAMP_LTZ");
    case "timestamp_tz":
      return scaled("TIMESTAMP_TZ");
    default:
      return column.type.toUpperCase();
  }
}

/** Seconds text as a sign-correct whole second and a non-negative nanosecond remainder, with the digits received. */
function readSeconds(text: string, column: SnowflakeColumn): { seconds: bigint; nanos: bigint; digits: number } {
  const match = SECONDS_TEXT.exec(text);
  if (match === null) throw unreadable(column);
  const [, sign, whole, fraction = ""] = match;
  const magnitude = BigInt(whole) * NANOS_PER_SECOND + BigInt(fraction.padEnd(9, "0"));
  const total = sign === "-" ? -magnitude : magnitude;
  // Floor division, so the remainder is never negative: -1.5 s is second -2 plus 0.5 s.
  let seconds = total / NANOS_PER_SECOND;
  let nanos = total % NANOS_PER_SECOND;
  if (nanos < ZERO) {
    seconds -= ONE;
    nanos += NANOS_PER_SECOND;
  }
  return { seconds, nanos, digits: fraction.length };
}

function fractionText(nanos: bigint, digits: number): string {
  return digits === 0 ? "" : `.${nanos.toString().padStart(9, "0").slice(0, digits)}`;
}

/** `a / b` rounded toward negative infinity, and the remainder that goes with it (never negative for b > 0). */
function floorDivide(a: bigint, b: bigint): [bigint, bigint] {
  const quotient = a / b;
  const remainder = a % b;
  return remainder < ZERO ? [quotient - ONE, remainder + b] : [quotient, remainder];
}

const two = (value: bigint): string => value.toString().padStart(2, "0");

/**
 * `YYYY-MM-DD` of a day count from the epoch, on the proleptic Gregorian calendar with astronomical years (H. Hinnant's
 * civil-from-days, in `BigInt` so any count Snowflake sends is exact). The year has at least four digits and a `-`
 * at or before year 0.
 */
function civilDate(days: bigint): string {
  const [era, dayOfEra] = floorDivide(days + DAYS_TO_EPOCH_FROM_MARCH_0, DAYS_PER_ERA);
  const yearOfEra =
    (dayOfEra - dayOfEra / BigInt(1_460) + dayOfEra / BigInt(36_524) - dayOfEra / BigInt(146_096)) / BigInt(365);
  const dayOfYear = dayOfEra - (BigInt(365) * yearOfEra + yearOfEra / BigInt(4) - yearOfEra / BigInt(100));
  const shiftedMonth = (BigInt(5) * dayOfYear + BigInt(2)) / BigInt(153);
  const day = dayOfYear - (BigInt(153) * shiftedMonth + BigInt(2)) / BigInt(5) + ONE;
  const month = shiftedMonth < BigInt(10) ? shiftedMonth + BigInt(3) : shiftedMonth - BigInt(9);
  const year = yearOfEra + era * BigInt(400) + (month <= BigInt(2) ? ONE : ZERO);
  const yearText = (year < ZERO ? -year : year).toString().padStart(4, "0");
  return `${year < ZERO ? "-" : ""}${yearText}-${two(month)}-${two(day)}`;
}

/** `HH:MM:SS` of a second within its day. */
function clockTime(secondOfDay: bigint): string {
  return `${two(secondOfDay / SECONDS_PER_HOUR)}:${two((secondOfDay / SIXTY) % SIXTY)}:${two(secondOfDay % SIXTY)}`;
}

/** `YYYY-MM-DD HH:MM:SS` of a whole second since the epoch, for any year. */
function wallTime(seconds: bigint): string {
  const [days, secondOfDay] = floorDivide(seconds, SECONDS_PER_DAY);
  return `${civilDate(days)} ${clockTime(secondOfDay)}`;
}

function timestamp(text: string, column: SnowflakeColumn, offsetMinutes = ZERO): string {
  const { seconds, nanos, digits } = readSeconds(text, column);
  return `${wallTime(seconds + offsetMinutes * SIXTY)}${fractionText(nanos, digits)}`;
}

function offsetText(minutes: bigint): string {
  const sign = minutes < ZERO ? "-" : "+";
  const magnitude = minutes < ZERO ? -minutes : minutes;
  const hours = (magnitude / SIXTY).toString().padStart(2, "0");
  return `${sign}${hours}:${(magnitude % SIXTY).toString().padStart(2, "0")}`;
}

function zoned(text: string, column: SnowflakeColumn): string {
  const match = ZONED_TEXT.exec(text);
  if (match === null) throw unreadable(column);
  const minutes = BigInt(match[2]) - TZ_OFFSET_BIAS;
  return `${timestamp(match[1], column, minutes)}${offsetText(minutes)}`;
}

function timeOfDay(text: string, column: SnowflakeColumn): string {
  const { seconds, nanos, digits } = readSeconds(text, column);
  if (seconds < ZERO || seconds >= SECONDS_PER_DAY) throw unreadable(column);
  return `${clockTime(seconds)}${fractionText(nanos, digits)}`;
}

function date(text: string, column: SnowflakeColumn): string {
  if (!INTEGER_TEXT.test(text)) throw unreadable(column);
  return civilDate(BigInt(text));
}

function fixed(text: string, column: SnowflakeColumn): SnowflakeCell {
  if ((column.scale ?? 0) > 0) {
    if (!DECIMAL_TEXT.test(text)) throw unreadable(column);
    return text;
  }
  if (!INTEGER_TEXT.test(text)) throw unreadable(column);
  const value = Number(text);
  return Number.isSafeInteger(value) && String(value) === text ? value : text;
}

function real(text: string, column: SnowflakeColumn): SnowflakeCell {
  const word = NON_FINITE.get(text);
  if (word !== undefined) return word;
  if (!DECFLOAT_TEXT.test(text)) throw unreadable(column);
  const value = Number(text);
  if (!Number.isFinite(value)) throw unreadable(column);
  return value;
}

/** One cell by its column's type; `null` is SQL NULL, and text that does not fit the type is refused. */
export function decodeCell(column: SnowflakeColumn, cell: string | null): SnowflakeCell {
  if (cell === null) return null;
  if (typeof cell !== "string") throw unreadable(column);
  switch (column.type.toLowerCase()) {
    case "fixed":
      return fixed(cell, column);
    case "decfloat":
      if (!DECFLOAT_TEXT.test(cell)) throw unreadable(column);
      return cell;
    case "real":
      return real(cell, column);
    case "boolean":
      return BOOLEANS.get(cell.toLowerCase()) ?? cell;
    case "binary":
      if (!HEX_TEXT.test(cell)) throw unreadable(column);
      return Buffer.from(cell, "hex");
    case "date":
      return date(cell, column);
    case "time":
      return timeOfDay(cell, column);
    case "timestamp_ntz":
      return timestamp(cell, column);
    case "timestamp_ltz":
      return `${timestamp(cell, column)}+00:00`;
    case "timestamp_tz":
      return zoned(cell, column);
    default:
      // text, the semi-structured and structured types, vector, and every type this module does not name.
      return cell;
  }
}

/**
 * Every row keyed by the column names (a repeated name numbered by `uniqueFieldNames`, so no value is lost), each
 * cell decoded. A row whose width is not the column count is refused, since a value would land under another name.
 */
export function decodeRows(
  columns: readonly SnowflakeColumn[],
  rows: readonly (readonly (string | null)[])[],
): Record<string, SnowflakeCell>[] {
  const fields = uniqueFieldNames(columns.map((column) => column.name));
  return rows.map((row) => {
    if (row.length !== columns.length) throw new SnowflakeError("defect", SNOWFLAKE_DECODE_SENTENCES.columns);
    // Object.fromEntries, since a column name is arbitrary SQL output and `__proto__` must stay a plain key.
    return Object.fromEntries(columns.map((column, position) => [fields[position], decodeCell(column, row[position])]));
  });
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The `rowType` of a result: an array of objects, each with a string name and type and optional numeric sizes. */
export function readColumns(rowType: unknown): SnowflakeColumn[] {
  if (!Array.isArray(rowType)) throw new SnowflakeError("defect", SNOWFLAKE_DECODE_SENTENCES.columns);
  return rowType.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new SnowflakeError("defect", SNOWFLAKE_DECODE_SENTENCES.columns);
    }
    const { name, type, precision, scale, length, extTypeName } = entry as Record<string, unknown>;
    const sizes = [optionalNumber(precision), optionalNumber(scale), optionalNumber(length)];
    if (typeof name !== "string" || typeof type !== "string" || sizes.includes(undefined)) {
      throw new SnowflakeError("defect", SNOWFLAKE_DECODE_SENTENCES.columns);
    }
    const [p, s, l] = sizes as (number | null)[];
    const column = { name, type: type.toLowerCase(), precision: p, scale: s, length: l };
    return typeof extTypeName === "string" ? { ...column, extTypeName } : column;
  });
}

/** The deepest bracket nesting of a JSON text, scanned once without recursion, brackets inside strings skipped. */
function nestingDepth(text: string): number {
  let depth = 0;
  let deepest = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    } else if (char === "[" || char === "{") {
      depth++;
      if (depth > deepest) deepest = depth;
    } else if (char === "]" || char === "}") {
      depth--;
    }
  }
  return deepest;
}

/** A server cell's JSON text, parsed; refused, naming the column, when it nests deeper than the bound or is not JSON. */
export function parseCellJson(text: string, column: string): unknown {
  const refused = () => new SnowflakeError("query", SNOWFLAKE_DECODE_SENTENCES.unreadable("VARIANT", column));
  if (nestingDepth(text) > SNOWFLAKE_CELL_MAX_DEPTH) throw refused();
  try {
    return JSON.parse(text);
  } catch {
    throw refused();
  }
}
