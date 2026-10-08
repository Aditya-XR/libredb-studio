/**
 * Reading one HTTP answer of Databend's query API (design 3.12, section 4).
 *
 * Only a 200 `application/json` body is an answer. Anything else is a refusal, read by its status, then its content
 * type: a JSON refusal names Databend's code (`{"error":{"code","message"}}`), the Cloud gateway's kind (measured
 * nested as `{"error":{"kind","message"}}`, I19, and read top-level too) or databend-go's string shape
 * (`{"error","message"}`), and a text one (a panic is 500 `text/plain`, 07 M04e) keeps its body as its text. The
 * gateway wraps a query node's refusal as `status: <n>, message: <json>: <words>`: that one shape is unwrapped into
 * the upstream status, code and message, and no other message text is read. A 200 that is not JSON, a body that does
 * not parse (a `RangeError` included), a key named `__proto__` anywhere, a field of the wrong type, a cell that is not
 * text or null, a row of another width than the schema, or an answer past one of its bounds is `protocol`. A close's
 * 200 (a kill, final or logout) acknowledges it by its status, unless its body is a gateway's refusal, which may come
 * over HTTP 200 as over any status.
 *
 * What one answer costs is bounded by what Studio asked for, not by the 16 MiB an answer may be: before a 200 is
 * parsed, one pass over its text counts what `JSON.parse` would build, outside strings, and refuses an answer holding
 * more rows than the page, more columns or column keys than the cell budget can keep, more of anything else than a
 * fixed allowance, or arrays and objects nested deeper than 64, each with a fault that names what was too large. The
 * depth bound keeps a recursive reader of the parsed answer, the `JSON.stringify` of the session a ROLLBACK echoes
 * among them, inside its stack. The parse takes no reviver, the rows are checked where they lie and never copied, and
 * a refusal is read only up to 64 KiB, past which it is read by its status alone.
 *
 * Nothing here classifies a refusal or scrubs its text: `errors.ts` does both, with the connection's secret forms.
 * Pure: no I/O.
 */
import type { NodeResponse } from "@/lib/db/http/node-transport";
import { DATABEND_PROTOCOL_FAULTS, protocolError } from "./errors";
import type { DatabendAffect, DatabendCell, DatabendColumn, DatabendNotice } from "./transport";

/** An answer's in-body `error`: the statement failed, over HTTP 200. */
export interface DatabendAnswerError {
  readonly code: number;
  /** Raw server text, not yet through `serverText`. */
  readonly message: string;
  readonly detail: string | null;
}

/** The session the answer echoed, which design 3.4 and 3.7 read and the ROLLBACK sends back verbatim. */
export interface DatabendSessionEcho {
  /** The echoed object as it arrived, never stored, logged or returned past the run (design 3.4). */
  readonly raw: Readonly<Record<string, unknown>>;
  readonly txnState: string | null;
  readonly needKeepAlive: boolean;
  readonly role: string | null;
  readonly settings: Readonly<Record<string, string>>;
}

/** One 200 JSON answer, typed. Links are as received: `routes.ts` decides whether one is followed (design 3.9). */
export interface DatabendAnswer {
  /** Empty in a fail-to-start answer, where nothing ran (02 5.3). */
  readonly id: string;
  readonly sessionId: string | null;
  readonly nodeId: string | null;
  /** Display only: `nextUri` alone ends the loop (design 3.8). */
  readonly state: string;
  readonly error: DatabendAnswerError | null;
  /** Raw server text, not yet through `serverText`. */
  readonly warnings: readonly string[];
  readonly hasResultSet: boolean;
  readonly schema: readonly DatabendColumn[];
  readonly data: readonly (readonly DatabendCell[])[];
  readonly nextUri: string | null;
  readonly affect: DatabendAffect | null;
  readonly session: DatabendSessionEcho | null;
}

/** An answer that is not a 200 JSON answer, for `refusalError`. `text` is raw server text. */
export interface DatabendRefusal {
  readonly status: number;
  readonly contentType: string | null;
  readonly code: number | null;
  readonly gatewayKind: string | null;
  readonly text: string;
  /**
   * When `text` is a JSON body that names no message: every key and string value in it, decoded, since the raw text
   * holds them escaped and `errors.ts` checks both against the secret forms (design 3.13).
   */
  readonly decoded?: readonly string[];
  /** The query node's HTTP status, when the gateway wrapped its refusal (I19). */
  readonly upstreamStatus?: number;
  /** The query node's code, when the gateway wrapped its refusal. */
  readonly upstreamCode?: number;
  /** The query node's message, raw server text, when the gateway wrapped its refusal. */
  readonly upstreamMessage?: string;
}

export type DatabendReading =
  | { readonly kind: "answer"; readonly answer: DatabendAnswer }
  | { readonly kind: "refusal"; readonly refusal: DatabendRefusal };

/** What one 200 answer may hold, from the statement Studio sent (design 3.12). */
export interface AnswerBounds {
  /** The page's rows: the `max_rows_per_page` of the statement's POST. */
  readonly rows: number;
  /** The columns a result can keep a row of: the cell budget, since a wider schema keeps no row. */
  readonly columns: number;
}

/** The oldest Databend that knows `http_json_result_mode` (L7, I6). */
export const RESULT_MODE_FLOOR = "v1.2.881";

/** The warning of a `result-mode` notice, for the provider doc and the test to read back (design section 4, I6). */
export const DATABEND_ANSWER_SENTENCES = Object.freeze({
  resultMode: (mode: string) =>
    mode === ""
      ? `Databend did not confirm the display result mode, which servers older than ${RESULT_MODE_FLOOR} do not have, so Studio may show some values differently from how Databend displays them. Upgrade the server to ${RESULT_MODE_FLOOR} or later.`
      : `Databend answered in the result mode "${mode}", not "display", so Studio may show some values differently from how Databend displays them.`,
});

const RESULT_MODE_SETTING = "http_json_result_mode";
const DISPLAY_MODE = "display";

/** The most characters of a refusal that are read: a longer one is read by its status alone, its text cut here. */
const REFUSAL_CHARS = 64 * 1024;
/**
 * The arrays, objects, keys and values an answer may hold outside its rows and columns: its session, settings echo,
 * error, affect, warnings and stats hold a few hundred.
 */
const ANSWER_ALLOWANCE = 65_536;
/**
 * How deep an answer may nest arrays and objects, its own object included: a real one nests 3 (a row, the session's
 * settings, a progress of its stats), and Node's `JSON.stringify` overflows its stack from a few thousand (4,460 on
 * Node 24.14).
 */
const ANSWER_DEPTH = 64;
/** The keys and separators one column of `schema` holds: its name, its type and the comma between them. */
const COLUMN_TOKENS = 3;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const COLON = 0x3a;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;

/** Where a token of the answer stands: in the value of `data`, of `schema`, or anywhere else. */
type Region = "data" | "schema" | "answer";

type Body = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Body {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJson(contentType: string | null): boolean {
  return contentType?.split(";")[0].trim().toLowerCase() === "application/json";
}

/** The member of the answer a key at its top level names, read from the key's text as it arrived. */
function regionOf(text: string, keyAt: number, keyEnd: number): Region {
  if (keyEnd - keyAt === 5 && text.startsWith('"data"', keyAt)) return "data";
  if (keyEnd - keyAt === 7 && text.startsWith('"schema"', keyAt)) return "schema";
  return "answer";
}

/**
 * What an answer holds too much of, as the protocol fault that names it, found in one pass over its text that
 * allocates nothing; null when it is within every bound. Outside strings every array, object, key and value after a
 * comma is something `JSON.parse` builds: a row of `data` counts against the page's rows, a column of `schema` and its
 * keys against the columns, and the rest of the answer against the allowance, the arrays and objects inside a row or a
 * column included; nothing nests deeper than {@link ANSWER_DEPTH}. A row's cells are bounded by the answer's bytes
 * alone: a page wider than the cell budget is legal, and the budget cuts it once it is read.
 */
function oversized(text: string, bounds: AnswerBounds): string | null {
  const faults = DATABEND_PROTOCOL_FAULTS;
  let depth = 0;
  let region: Region = "answer";
  let keyAt = -1;
  let keyEnd = -1;
  let rows = 1;
  let columns = 1;
  let columnTokens = 0;
  let rest = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code === QUOTE) {
      const start = at;
      for (at++; at < text.length && text.charCodeAt(at) !== QUOTE; at++) {
        if (text.charCodeAt(at) === BACKSLASH) at++;
      }
      if (depth === 1) {
        keyAt = start;
        keyEnd = at;
      }
      continue;
    }
    if (code === CLOSE_ARRAY || code === CLOSE_OBJECT) {
      depth -= 1;
      continue;
    }
    if (code === OPEN_ARRAY || code === OPEN_OBJECT) {
      if (++depth > ANSWER_DEPTH) return faults.depth;
    } else if (code === COLON && depth === 1) region = regionOf(text, keyAt, keyEnd);
    else if (code !== COMMA && code !== COLON) continue;
    const within = depth < 2 ? "answer" : region;
    const separates = code === COMMA;
    if (within === "data" && depth === 2 && separates) {
      if (++rows > bounds.rows) return faults.rows;
    } else if (within === "data" && depth === 3 && code !== COLON) {
      // A row, or a cell after a comma.
    } else if (within === "schema" && depth === 2 && separates) {
      if (++columns > bounds.columns) return faults.schema;
    } else if (within === "schema" && depth === 3 && (separates || code === COLON)) {
      if (++columnTokens > COLUMN_TOKENS * bounds.columns) return faults.schema;
    } else if (within === "schema" && depth === 3) {
      // A column.
    } else if (++rest > ANSWER_ALLOWANCE) return faults.values;
  }
  return null;
}

/** Whether a parsed value holds a key named `__proto__` at any depth, walked without recursion. */
function holdsPrototypeKey(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== "object" || value === null) continue;
    if (!Array.isArray(value) && Object.hasOwn(value, "__proto__")) return true;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      if (typeof item === "object" && item !== null) pending.push(item);
    }
  }
  return false;
}

/**
 * `JSON.parse` with no reviver, refusing a `__proto__` key at any depth after it; every failure, a `RangeError`
 * included, is `protocol`.
 */
function parse(text: string, status: number): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw protocolError(DATABEND_PROTOCOL_FAULTS.notJson, error, status);
  }
  if (holdsPrototypeKey(parsed)) throw protocolError(DATABEND_PROTOCOL_FAULTS.prototypeKey, undefined, status);
  return parsed;
}

function wrongType(field: string): never {
  throw protocolError(DATABEND_PROTOCOL_FAULTS.field(field));
}

/** A string or absent (null); anything else is the field's protocol failure. */
function text(body: Body, key: string, field = key): string | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : wrongType(field);
}

function required(body: Body, key: string, field = key): string {
  return text(body, key, field) ?? wrongType(field);
}

function flag(body: Body, key: string, field: string): boolean | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  return typeof value === "boolean" ? value : wrongType(field);
}

function list(body: Body, key: string, field = key): readonly unknown[] {
  const value = body[key];
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : wrongType(field);
}

function textList(values: readonly unknown[], field: string): string[] {
  return values.map((value) => (typeof value === "string" ? value : wrongType(field)));
}

function record(body: Body, key: string, field: string): Body | null {
  const value = body[key];
  if (value === undefined || value === null) return null;
  return isRecord(value) ? value : wrongType(field);
}

function readColumn(value: unknown): DatabendColumn {
  if (!isRecord(value)) return wrongType("schema");
  return { name: required(value, "name", "schema"), type: required(value, "type", "schema") };
}

function readError(body: Body): DatabendAnswerError | null {
  const error = record(body, "error", "error");
  if (error === null) return null;
  const code = error.code;
  if (typeof code !== "number") return wrongType("error");
  return { code, message: required(error, "message", "error"), detail: text(error, "detail", "error") };
}

function readSession(body: Body): DatabendSessionEcho | null {
  const session = record(body, "session", "session");
  if (session === null) return null;
  const settings = record(session, "settings", "session") ?? {};
  for (const value of Object.values(settings)) if (typeof value !== "string") wrongType("session");
  return {
    raw: session,
    txnState: text(session, "txn_state", "session"),
    needKeepAlive: flag(session, "need_keep_alive", "session") ?? false,
    role: text(session, "role", "session"),
    settings: settings as Readonly<Record<string, string>>,
  };
}

/** USE and SET only (07 M09); an affect of any other type is not carried. */
function readAffect(body: Body): DatabendAffect | null {
  const affect = record(body, "affect", "affect");
  if (affect === null) return null;
  switch (affect.type) {
    case "UseDB":
    case "UseCatalog":
      return { type: affect.type, name: required(affect, "name", "affect") };
    case "ChangeSettings":
      return {
        type: "ChangeSettings",
        keys: textList(list(affect, "keys", "affect"), "affect"),
        values: textList(list(affect, "values", "affect"), "affect"),
        isGlobals: list(affect, "is_globals", "affect").map((value) =>
          typeof value === "boolean" ? value : wrongType("affect"),
        ),
      };
    default:
      return null;
  }
}

/** The rows as parsed, each checked where it lies and none copied: at most the page's, each as wide as the schema. */
function readRows(body: Body, width: number, bounds: AnswerBounds): readonly (readonly DatabendCell[])[] {
  const rows = list(body, "data");
  // Rows under a key spelled with an escape reach here uncounted by the scan.
  if (rows.length > bounds.rows) throw protocolError(DATABEND_PROTOCOL_FAULTS.rows);
  for (const row of rows) {
    if (!Array.isArray(row)) throw protocolError(DATABEND_PROTOCOL_FAULTS.cell);
    if (row.length !== width) throw protocolError(DATABEND_PROTOCOL_FAULTS.width(row.length, width));
    for (const cell of row) {
      if (cell !== null && typeof cell !== "string") throw protocolError(DATABEND_PROTOCOL_FAULTS.cell);
    }
  }
  return rows as readonly (readonly DatabendCell[])[];
}

function readBody(body: Body, bounds: AnswerBounds): DatabendAnswer {
  const schema = list(body, "schema").map(readColumn);
  return {
    id: required(body, "id"),
    sessionId: text(body, "session_id"),
    nodeId: text(body, "node_id"),
    state: required(body, "state"),
    error: readError(body),
    warnings: textList(list(body, "warnings"), "warnings"),
    hasResultSet: flag(body, "has_result_set", "has_result_set") ?? schema.length > 0,
    schema,
    data: readRows(body, schema.length, bounds),
    nextUri: text(body, "next_uri"),
    affect: readAffect(body),
    session: readSession(body),
  };
}

/** Every key and string value of a parsed JSON document, walked without recursion so depth cannot overflow. */
function decodedStrings(root: unknown): string[] {
  const found: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") found.push(value);
    else if (typeof value === "object" && value !== null) {
      for (const [key, item] of Object.entries(value)) {
        found.push(key);
        pending.push(item);
      }
    }
  }
  return found;
}

/** The gateway's wrapper of a query node's refusal (I19): `status: 401, message: {...}: Authorization failed`. */
const UPSTREAM_WRAPPER = /^status: (\d{3}), message: (\{[\s\S]*\}): ([\s\S]+)$/;

type Upstream = Pick<DatabendRefusal, "upstreamStatus" | "upstreamCode" | "upstreamMessage">;

/**
 * The query node's status, code and message from a gateway message in the wrapper, parsed as strictly as an answer (a
 * `__proto__` key refuses it); anything else, a wrapper whose JSON does not parse or lacks the code or message among
 * it, is no upstream.
 */
function upstreamOf(message: string): Upstream {
  const match = UPSTREAM_WRAPPER.exec(message);
  if (match === null) return {};
  let inner: unknown;
  try {
    inner = JSON.parse(match[2]);
  } catch {
    // A wrapper whose JSON does not parse is no upstream, read so below as one that lacks the code or message.
  }
  if (holdsPrototypeKey(inner)) return {};
  const error = isRecord(inner) && isRecord(inner.error) ? inner.error : null;
  if (typeof error?.code !== "number" || typeof error.message !== "string") return {};
  return { upstreamStatus: Number(match[1]), upstreamCode: error.code, upstreamMessage: error.message };
}

/** The gateway kind, nested under `error` as Databend Cloud sends it (I19) or top-level. */
function gatewayKindOf(body: Body | null, error: Body | null): string | null {
  const kind = [error?.kind, body?.kind].find((value) => typeof value === "string");
  return typeof kind === "string" ? kind : null;
}

/**
 * A refusal's code, gateway kind, message and wrapped upstream from a JSON body, else the raw text. `parsed` is the
 * body a 200 refusal already had, through `parse`; any other is parsed here only when it is at most 64 KiB, and each
 * text read from it is cut there too.
 */
function refusalOf(response: NodeResponse, parsed?: unknown): DatabendRefusal {
  const whole = response.text.length <= REFUSAL_CHARS;
  let json = parsed;
  if (json === undefined && whole && isJson(response.contentType)) {
    try {
      json = JSON.parse(response.text);
    } catch {
      // A refusal whose JSON does not parse is read by its status alone, with its raw text.
    }
  }
  const body = isRecord(json) ? json : null;
  const error = isRecord(body?.error) ? body.error : null;
  const found = [error?.message, body?.message, body?.error].find((value) => typeof value === "string");
  const message = typeof found === "string" ? found.slice(0, REFUSAL_CHARS) : null;
  return {
    status: response.status,
    contentType: response.contentType,
    code: typeof error?.code === "number" ? error.code : null,
    gatewayKind: gatewayKindOf(body, error),
    text: message ?? response.text.slice(0, REFUSAL_CHARS),
    decoded: message !== null || json === undefined || !whole ? undefined : decodedStrings(json),
    ...(message === null ? {} : upstreamOf(message)),
  };
}

/**
 * One HTTP answer as an answer or a refusal; throws a `protocol` `DatabendError` for a malformed 200, or for one that
 * holds more than `bounds` and the allowance allow or nests deeper than its depth, which is refused before it is
 * parsed.
 */
export function readAnswer(response: NodeResponse, bounds: AnswerBounds): DatabendReading {
  if (response.status !== 200) return { kind: "refusal", refusal: refusalOf(response) };
  if (!isJson(response.contentType)) throw protocolError(DATABEND_PROTOCOL_FAULTS.notAnswer, undefined, 200);
  const fault = oversized(response.text, bounds);
  if (fault !== null) throw protocolError(fault, undefined, 200);
  const body = parse(response.text, 200);
  if (!isRecord(body)) return wrongType("answer");
  return gatewayRefusal(response, body) ?? { kind: "answer", answer: readBody(body, bounds) };
}

/**
 * A close's 200 (a kill, final or logout), which acknowledges the close by its status: null, unless its body is a
 * gateway's refusal, JSON of at most 64 KiB naming a kind and no state. An empty kill answer, a final's answer, the
 * logout's `{"error":null}` and a body that does not parse are each null: a close's body is never a fault.
 */
export function readCloseAnswer(response: NodeResponse): DatabendReading | null {
  if (!isJson(response.contentType) || response.text.length > REFUSAL_CHARS) return null;
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    return null;
  }
  return isRecord(body) ? gatewayRefusal(response, body) : null;
}

/**
 * A parsed 200 body as the Cloud gateway's refusal, which may come over any status, ProvisionWarehouseTimeout among
 * them (design 3.11): a kind, top-level or nested under `error` (I19), and no state; null for anything else.
 */
function gatewayRefusal(response: NodeResponse, body: Body): DatabendReading | null {
  const nested = isRecord(body.error) ? body.error : null;
  if (gatewayKindOf(body, nested) === null || body.state !== undefined) return null;
  return { kind: "refusal", refusal: refusalOf(response, body) };
}

/**
 * The first answer's `result-mode` notice, or null when its session echoed `http_json_result_mode` as `display`. A
 * missing echo is a notice with an empty mode: a server below {@link RESULT_MODE_FLOOR} drops the setting it does
 * not know (L7, I6). Nothing is refused.
 */
export function resultModeNotice(answer: DatabendAnswer): Extract<DatabendNotice, { kind: "result-mode" }> | null {
  const mode = answer.session?.settings[RESULT_MODE_SETTING] ?? "";
  return mode === DISPLAY_MODE ? null : { kind: "result-mode", mode };
}
