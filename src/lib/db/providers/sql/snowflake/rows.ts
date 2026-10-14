/**
 * A statement result's raw rows: partition 0's inline `data`, then partitions 1 to n, under one decoded budget and the
 * row cut.
 *
 * One budget spans the whole result: at most `SNOWFLAKE_RESULT_BYTE_BUDGET` decoded bytes and `MAX_UNLIMITED_ROWS`
 * rows are kept. A row costs the UTF-8 bytes of its JSON text. A cut is declared only when a row remains past the
 * budget, so a result whose last row lands exactly on it is whole. Every cell is a JSON string or null, as `jsonv2`
 * sends it; any other cell is refused naming its column.
 *
 * Partition 0 arrives parsed inside the status answer. Partitions 1 to n are fetched one at a time, each body read
 * through a streaming gunzip and a strict UTF-8 decoder into a small row reader, so no more than the budget's worth of
 * decoded text is ever produced from one body, however far it would inflate.
 */
import { createGunzip, type Gunzip } from "node:zlib";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { SnowflakeError } from "./errors";
import type { SnowflakeByteAnswer } from "./transport";

/** The decoded bytes one statement result may keep, partition 0 and every later partition together. */
export const SNOWFLAKE_RESULT_BYTE_BUDGET = 16_777_216;
/** The largest status answer read, the one that carries partition 0 inline. */
export const SNOWFLAKE_FIRST_ANSWER_MAX_BYTES = 25_165_824;
/** What a partition request may carry past the budget left: gzip framing, since gzip of JSON text is not larger. */
const SNOWFLAKE_PARTITION_SLACK_BYTES = 65_536;

export type SnowflakeRawRow = readonly (string | null)[];

export interface SnowflakeRowsOutcome {
  readonly rows: SnowflakeRawRow[];
  readonly cut: "bytes" | "rows" | null;
}

export interface SnowflakeRowsDeps {
  readonly createGunzip: () => Gunzip;
}

export const SNOWFLAKE_ROWS_SENTENCES = Object.freeze({
  firstTooLarge:
    "Snowflake's first result partition is larger than Studio reads (24 MiB). Add a LIMIT, or select fewer columns.",
  unreadable: "Snowflake sent a result partition Studio could not read.",
  encoding: (encoding: string) =>
    `Snowflake sent a result partition in an encoding Studio does not read (${encoding}).`,
  nonString: (column: string) =>
    `Snowflake sent a cell that is not text in column "${column}", so the result is not shown.`,
  /**
   * `numRows` is Snowflake's count, which Studio's `rows_per_resultset` of one past the row budget caps: a count past
   * the budget is that request echoed back, so it is said as "more than" the budget, never as a total.
   */
  byteCut: (numRows: number | null | undefined) =>
    `The result reached Studio's statement budget of 16 MiB, so only the rows before it are shown.${
      typeof numRows !== "number"
        ? ""
        : numRows > MAX_UNLIMITED_ROWS
          ? ` Snowflake reported more than ${MAX_UNLIMITED_ROWS.toLocaleString("en-US")} rows.`
          : ` Snowflake reported ${numRows.toLocaleString("en-US")} rows.`
    }`,
  firstRowCut:
    "The first row of this result is larger than Studio's statement budget of 16 MiB, so no row is shown. Select fewer columns, or part of a large value with LEFT or SUBSTR.",
  rowCut: "The result reached Studio's statement budget of 100,000 rows, so only the rows before it are shown.",
  snowflakeCut:
    "Snowflake returned only part of this result because it is too large (391908), so only the rows it sent are shown. Add a LIMIT, or select fewer columns.",
});

const unreadable = (): SnowflakeError => new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.unreadable);

/** The column a cell at `index` belongs to, or its 1-based position past the named columns. */
function columnName(columns: readonly string[], index: number): string {
  return columns[index] ?? String(index + 1);
}

/** The budget of one result: what is left, the rows kept, and the cut once one is declared. */
class Budget {
  bytesLeft = SNOWFLAKE_RESULT_BYTE_BUDGET;
  readonly rows: SnowflakeRawRow[] = [];
  cut: "bytes" | "rows" | null = null;

  /** Keeps `row` at `cost` bytes, or declares the cut and answers false. */
  take(row: SnowflakeRawRow, cost: number): boolean {
    if (this.rows.length === MAX_UNLIMITED_ROWS) {
      this.cut = "rows";
      return false;
    }
    if (cost > this.bytesLeft) {
      this.cut = "bytes";
      return false;
    }
    this.bytesLeft -= cost;
    this.rows.push(row);
    return true;
  }
}

/** Partition 0's inline rows, each checked as it is kept; rows past a cut are never read. */
function readFirstData(columns: readonly string[], firstData: unknown, budget: Budget): void {
  if (!Array.isArray(firstData)) throw unreadable();
  for (const row of firstData as unknown[]) {
    if (!Array.isArray(row)) throw unreadable();
    row.forEach((cell: unknown, index) => {
      if (cell !== null && typeof cell !== "string") {
        throw new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.nonString(columnName(columns, index)));
      }
    });
    if (!budget.take(row as SnowflakeRawRow, Buffer.byteLength(JSON.stringify(row)))) return;
  }
}

// --- The streaming row reader ---------------------------------------------------------------------------------------

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const LETTER_N = 0x6e;
const NULL_TAIL = "ull";

const isSpace = (c: number): boolean => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

type ReaderState =
  | "start"
  | "key"
  | "colon"
  | "dataValue"
  | "afterValue"
  | "skip"
  | "rows"
  | "rowsNext"
  | "rowsItem"
  | "end"
  | "firstCell"
  | "nextCell"
  | "cell"
  | "null"
  | "string";

/**
 * The rows of one partition body, fed as decoded text in chunks of any size: a bare array of rows, or an object whose
 * `data` key holds it, every other key's value skipped with strings and nesting honoured. A row is `[` cells `]`, a
 * cell a JSON string (decoded by `JSON.parse` of its token, escapes included) or `null`; anything else is the
 * not-text refusal for its column. Each completed row goes to the budget, costing the decoded bytes consumed since the
 * previous row ended. Text held between rows is bounded: inside a row by the bytes left, outside one by the bytes left
 * and the partition slack, checked at every chunk's end, so a hostile body stops within one chunk of the budget.
 *
 * With a `captureKey`, the first value of that key is kept as its JSON text while it is skipped, and handed to
 * `onCapture` once it ends, before any later key is read.
 */
class RowReader {
  private state: ReaderState = "start";
  private bare = false;
  private seenData = false;
  private key = "";
  private stringIsKey = false;
  private parts: string[] = [];
  private escaped = false;
  private skipStarted = false;
  private skipDepth = 0;
  private skipInString = false;
  private skipEscaped = false;
  private nullSeen = 0;
  private row: (string | null)[] = [];
  /** Decoded bytes consumed since the previous row ended. */
  private pending = 0;
  /** The captured value's text so far, while it is being skipped; null when nothing is being captured. */
  private capture: string[] | null = null;
  private captured = false;

  constructor(
    private readonly columns: readonly string[],
    private readonly budget: Budget,
    private readonly captureKey: string | null = null,
    private readonly onCapture: (text: string) => void = () => {},
  ) {}

  /** Ends a capture with the value's last text. */
  private endCapture(last: string): void {
    if (this.capture === null) return;
    const text = this.capture.join("") + last;
    this.capture = null;
    this.onCapture(text);
  }

  get done(): boolean {
    return this.state === "end";
  }

  private get inRow(): boolean {
    return (
      this.state === "firstCell" ||
      this.state === "nextCell" ||
      this.state === "cell" ||
      this.state === "null" ||
      (this.state === "string" && !this.stringIsKey)
    );
  }

  private notText(): SnowflakeError {
    return new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.nonString(columnName(this.columns, this.row.length)));
  }

  /** Reads `text`; answers false when the budget stopped the read, with the cut declared. */
  feed(text: string): boolean {
    let segment = 0;
    let token = this.state === "string" ? 0 : -1;
    let captureFrom = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text.charCodeAt(i);
      switch (this.state) {
        case "string": {
          if (this.escaped) this.escaped = false;
          else if (c === BACKSLASH) this.escaped = true;
          else if (c === QUOTE) {
            this.parts.push(text.slice(token, i + 1));
            token = -1;
            const value = parseStringToken(this.parts.join(""));
            this.parts = [];
            if (this.stringIsKey) {
              this.key = value;
              this.state = "colon";
            } else {
              this.row.push(value);
              this.state = "nextCell";
            }
          }
          break;
        }
        case "firstCell":
        case "nextCell":
        case "cell": {
          if (isSpace(c)) break;
          if (this.state !== "cell" && c === CLOSE_BRACKET) {
            const cost = this.pending + Buffer.byteLength(text.slice(segment, i + 1));
            this.pending = 0;
            segment = i + 1;
            if (!this.budget.take(this.row, cost)) return false;
            this.row = [];
            this.state = "rowsNext";
          } else if (this.state === "nextCell") {
            if (c !== COMMA) throw unreadable();
            this.state = "cell";
          } else if (c === QUOTE) {
            this.stringIsKey = false;
            this.state = "string";
            token = i;
          } else if (c === LETTER_N) {
            this.nullSeen = 0;
            this.state = "null";
          } else if (c === COMMA || c === CLOSE_BRACKET) {
            throw unreadable();
          } else {
            throw this.notText();
          }
          break;
        }
        case "null": {
          if (c !== NULL_TAIL.charCodeAt(this.nullSeen)) throw unreadable();
          this.nullSeen += 1;
          if (this.nullSeen === NULL_TAIL.length) {
            this.row.push(null);
            this.state = "nextCell";
          }
          break;
        }
        case "rows":
        case "rowsNext":
        case "rowsItem": {
          if (isSpace(c)) break;
          if (this.state !== "rowsItem" && c === CLOSE_BRACKET) {
            this.state = this.bare ? "end" : "afterValue";
          } else if (this.state === "rowsNext") {
            if (c !== COMMA) throw unreadable();
            this.state = "rowsItem";
          } else if (c === OPEN_BRACKET) {
            this.state = "firstCell";
          } else {
            throw unreadable();
          }
          break;
        }
        case "start": {
          if (isSpace(c)) break;
          if (c === OPEN_BRACKET) {
            this.bare = true;
            this.state = "rows";
          } else if (c === OPEN_BRACE) {
            this.state = "key";
          } else {
            throw unreadable();
          }
          break;
        }
        case "key": {
          if (isSpace(c)) break;
          if (c === QUOTE) {
            this.stringIsKey = true;
            this.state = "string";
            token = i;
          } else {
            throw unreadable();
          }
          break;
        }
        case "colon": {
          if (isSpace(c)) break;
          if (c !== COLON) throw unreadable();
          if (this.key === "data" && !this.seenData) {
            this.state = "dataValue";
          } else {
            this.skipStarted = false;
            this.skipDepth = 0;
            this.state = "skip";
            if (!this.captured && this.key === this.captureKey) {
              this.captured = true;
              this.capture = [];
              captureFrom = i + 1;
            }
          }
          break;
        }
        case "dataValue": {
          if (isSpace(c)) break;
          if (c !== OPEN_BRACKET) throw unreadable();
          this.seenData = true;
          this.state = "rows";
          break;
        }
        case "afterValue": {
          if (isSpace(c)) break;
          if (c === COMMA) this.state = "key";
          else if (c === CLOSE_BRACE && this.seenData) this.state = "end";
          else throw unreadable();
          break;
        }
        case "skip": {
          if (this.skipInString) {
            if (this.skipEscaped) this.skipEscaped = false;
            else if (c === BACKSLASH) this.skipEscaped = true;
            else if (c === QUOTE) {
              this.skipInString = false;
              if (this.skipDepth === 0) this.state = "afterValue";
            }
          } else if (!this.skipStarted) {
            if (isSpace(c)) break;
            if (c === COMMA || c === CLOSE_BRACE || c === CLOSE_BRACKET) throw unreadable();
            this.skipStarted = true;
            if (c === QUOTE) this.skipInString = true;
            else if (c === OPEN_BRACE || c === OPEN_BRACKET) this.skipDepth = 1;
          } else if (this.skipDepth === 0) {
            // Inside a scalar: its end is the next separator, read again as the object's.
            if (c === COMMA || c === CLOSE_BRACE || c === CLOSE_BRACKET || isSpace(c)) {
              this.state = "afterValue";
              this.endCapture(text.slice(captureFrom, i));
              i -= 1;
              break;
            }
          } else if (c === QUOTE) {
            this.skipInString = true;
          } else if (c === OPEN_BRACE || c === OPEN_BRACKET) {
            this.skipDepth += 1;
          } else if (c === CLOSE_BRACE || c === CLOSE_BRACKET) {
            this.skipDepth -= 1;
            if (this.skipDepth === 0) this.state = "afterValue";
          }
          if (this.state === "afterValue") this.endCapture(text.slice(captureFrom, i + 1));
          break;
        }
        case "end": {
          if (!isSpace(c)) throw unreadable();
          break;
        }
      }
    }
    if (token >= 0) this.parts.push(text.slice(token));
    this.capture?.push(text.slice(captureFrom));
    this.pending += Buffer.byteLength(text.slice(segment));
    const bound = this.inRow ? this.budget.bytesLeft : this.budget.bytesLeft + SNOWFLAKE_PARTITION_SLACK_BYTES;
    if (this.pending > bound) {
      this.budget.cut = "bytes";
      return false;
    }
    return true;
  }
}

function parseStringToken(token: string): string {
  try {
    return JSON.parse(token) as string;
  } catch {
    throw unreadable();
  }
}

/** The slice of a body written to the gunzip, or fed to the reader, at a time. */
const BODY_SLICE_BYTES = 65_536;

type BodyOutcome = "end" | "stopped" | "error";

/** Feeds `bytes` through `gunzip` into `sink` until the end, the sink's stop, or a gunzip error. */
function inflate(bytes: Buffer, gunzip: Gunzip, sink: (chunk: Buffer) => boolean): Promise<BodyOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (outcome: BodyOutcome, failure?: unknown): void => {
      if (settled) return;
      settled = true;
      if (outcome !== "end") gunzip.destroy();
      if (failure === undefined) resolve(outcome);
      else reject(failure);
    };
    gunzip.on("data", (chunk: Buffer) => {
      if (settled) return;
      try {
        if (!sink(chunk)) settle("stopped");
      } catch (failure) {
        settle("stopped", failure);
      }
    });
    gunzip.on("end", () => settle("end"));
    gunzip.on("error", () => settle("error"));
    let offset = 0;
    const pump = (): void => {
      while (offset < bytes.length) {
        if (settled) return;
        const slice = bytes.subarray(offset, offset + BODY_SLICE_BYTES);
        offset += slice.length;
        if (!gunzip.write(slice)) {
          gunzip.once("drain", pump);
          return;
        }
      }
      if (!settled) gunzip.end();
    };
    pump();
  });
}

function feedSlices(bytes: Buffer, sink: (chunk: Buffer) => boolean): BodyOutcome {
  for (let offset = 0; offset < bytes.length; offset += BODY_SLICE_BYTES) {
    if (!sink(bytes.subarray(offset, offset + BODY_SLICE_BYTES))) return "stopped";
  }
  return "end";
}

const PRODUCTION_ROWS_DEPS: SnowflakeRowsDeps = { createGunzip: () => createGunzip() };

/** Whether a body is gzip: `gzip` (any case) as its encoding, or the gzip magic bytes at its start. */
function isGzip(answer: SnowflakeByteAnswer, named: string): boolean {
  return named === "gzip" || (answer.bytes[0] === 0x1f && answer.bytes[1] === 0x8b);
}

/**
 * A failed partition answer's text, decoded as a success body is: gunzipped when it is gzip, the inflated text cut off
 * at `maxBytes`, the same bound the request's response took. A body that inflates past it, or does not inflate, is
 * empty text, so its status alone classifies it.
 */
export async function partitionFailureText(
  answer: SnowflakeByteAnswer,
  maxBytes: number,
  deps: SnowflakeRowsDeps = PRODUCTION_ROWS_DEPS,
): Promise<string> {
  const named = (answer.contentEncoding ?? "").trim().toLowerCase();
  if (!isGzip(answer, named)) return answer.bytes.toString("utf8");
  const chunks: Buffer[] = [];
  let size = 0;
  const outcome = await inflate(answer.bytes, deps.createGunzip(), (chunk) => {
    size += chunk.length;
    chunks.push(chunk);
    return size <= maxBytes;
  });
  return outcome === "end" ? Buffer.concat(chunks).toString("utf8") : "";
}

/**
 * One partition body into the budget. The encoding is checked before any decoding: `gzip` (any case) or a body that
 * starts with the gzip magic bytes is gunzipped, no encoding or `identity` is read as text, anything else is refused by
 * name. A body the transport cut (`truncated`) ends as the byte cut with its trailing incomplete row dropped, and so
 * does the gunzip's premature end on it; the same faults on a whole body are refused as unreadable.
 */
async function readPartition(
  answer: SnowflakeByteAnswer,
  reader: RowReader,
  budget: Budget,
  deps: SnowflakeRowsDeps,
): Promise<void> {
  const encoding = answer.contentEncoding === null ? "" : answer.contentEncoding.trim();
  const named = encoding.toLowerCase();
  if (named !== "" && named !== "gzip" && named !== "identity") {
    throw new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.encoding(encoding));
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const decode = (chunk?: Buffer): string => {
    try {
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk, { stream: true });
    } catch {
      throw unreadable();
    }
  };
  const sink = (chunk: Buffer): boolean => reader.feed(decode(chunk));
  const outcome = isGzip(answer, named)
    ? await inflate(answer.bytes, deps.createGunzip(), sink)
    : feedSlices(answer.bytes, sink);
  if (outcome === "stopped") return;
  if (answer.truncated) {
    budget.cut = "bytes";
    return;
  }
  if (outcome === "error") throw unreadable();
  decode();
  if (!reader.done) throw unreadable();
}

/**
 * Partition 0's inline `data`, then partitions 1 to partitionCount - 1 in order through `fetchPartition`, under one
 * decoded budget and the row cut; stops early at the budget, the cut or the signal.
 *
 * `fetchPartition` is the caller's: it has already refused an answer whose status is not 200, so every answer it
 * returns is a body to read. Each request is bounded by the bytes left plus `SNOWFLAKE_PARTITION_SLACK_BYTES`, as both
 * its response cap and its cut, so no partition holds more compressed bytes than the budget can still use.
 */
export async function readResultRows(input: {
  readonly columns: readonly string[];
  readonly firstData: unknown;
  readonly partitionCount: number;
  readonly fetchPartition: (
    index: number,
    maxResponseBytes: number,
    truncateAt: number,
  ) => Promise<SnowflakeByteAnswer>;
  readonly signal: AbortSignal;
  readonly deps?: SnowflakeRowsDeps;
}): Promise<SnowflakeRowsOutcome> {
  const budget = new Budget();
  const deps = input.deps ?? PRODUCTION_ROWS_DEPS;
  readFirstData(input.columns, input.firstData, budget);
  for (let index = 1; index < input.partitionCount && budget.cut === null; index += 1) {
    input.signal.throwIfAborted();
    if (budget.rows.length === MAX_UNLIMITED_ROWS) {
      budget.cut = "rows";
    } else if (budget.bytesLeft === 0) {
      budget.cut = "bytes";
    } else {
      const bound = budget.bytesLeft + SNOWFLAKE_PARTITION_SLACK_BYTES;
      // oxlint-disable-next-line no-await-in-loop -- partitions are read one at a time, under the budget the one before left.
      const answer = await input.fetchPartition(index, bound, bound);
      // oxlint-disable-next-line no-await-in-loop -- the same partition, read before the next is asked for.
      await readPartition(answer, new RowReader(input.columns, budget), budget, deps);
    }
  }
  return { rows: budget.rows, cut: budget.cut };
}

/** The bytes a read of an oversized first answer asks for: the budget and the slack a partition request may carry. */
export const SNOWFLAKE_OVERSIZED_FIRST_READ_BYTES = SNOWFLAKE_RESULT_BYTE_BUDGET + SNOWFLAKE_PARTITION_SLACK_BYTES;

export interface SnowflakeOversizedFirst {
  /** The answer's `resultSetMetaData`, parsed. */
  readonly meta: Record<string, unknown>;
  readonly outcome: SnowflakeRowsOutcome;
}

/**
 * Partition 0 from a status answer too large to read whole (SF-032): the answer fetched again as bytes, cut at
 * `SNOWFLAKE_OVERSIZED_FIRST_READ_BYTES`, and read as a stream. Snowflake writes `resultSetMetaData` before `data`
 * (measured on the trial), so the metadata is captured whole while the reader skips it, and the rows that fit the
 * budget are kept, the cut declared as any byte cut is. An answer whose metadata is not whole within the read, or not
 * an object, is still the first-partition refusal.
 */
export async function readOversizedFirstAnswer(
  answer: SnowflakeByteAnswer,
  deps: SnowflakeRowsDeps = PRODUCTION_ROWS_DEPS,
): Promise<SnowflakeOversizedFirst> {
  const budget = new Budget();
  const columns: string[] = [];
  let meta: Record<string, unknown> | null = null;
  const reader = new RowReader(columns, budget, "resultSetMetaData", (text) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw unreadable();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw unreadable();
    meta = parsed as Record<string, unknown>;
    const rowType = meta.rowType;
    if (Array.isArray(rowType)) {
      for (const column of rowType as unknown[]) {
        const name = (column as { name?: unknown } | null)?.name;
        columns.push(typeof name === "string" ? name : String(columns.length + 1));
      }
    }
  });
  await readPartition(answer, reader, budget, deps);
  if (meta === null) throw new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.firstTooLarge);
  return { meta, outcome: { rows: budget.rows, cut: budget.cut } };
}
