/**
 * Every statement the provider sends: the request body, the asynchronous submit, the poll, the partitions, the
 * deadline, the engine limiter and the run registry, returned as one neutral result type.
 *
 * A statement is `POST /api/v2/statements?async=true` with the connection's context fields and fixed parameters, so
 * an account's own `MULTI_STATEMENT_COUNT` or result chunking never changes what Studio reads. `TIMEZONE` is left to
 * the user's own setting, as Snowsight leaves it, since every temporal cell arrives as epoch seconds or days (with
 * its offset for `TIMESTAMP_TZ`) and decodes the same in any session zone. Its answer
 * carries the statement handle, which must have the UUID shape before anything else is sent; the status, partition
 * and cancel paths are built from it on the provider's origin, and a status link in an answer is checked and never
 * followed. The poll waits `SNOWFLAKE_POLL_FIRST_MS`, doubling to `SNOWFLAKE_POLL_MAX_MS`, until the 200 that carries
 * partition 0; a 429 sets the next wait to the jittered maximum.
 *
 * Every run, a user statement or one Studio sends on its own, begins in the run registry (with or without a
 * `queryId`), joins the lifetime signal, and holds one permit of the Snowflake engine limiter from its submit until its
 * result is built. Its deadline starts once the permit is held; the wait for the permit has a bound of its own. The
 * submit itself runs under the deadline alone: a cancel that arrives during it waits for the handle the submit
 * answers, so the statement can be cancelled by it.
 *
 * The wire envelope (`statementHandle`, `resultSetMetaData`, `rowType`, `partitionInfo`) stays in this module,
 * `rows.ts` and `decode.ts`; everything above reads `SnowflakeResult`.
 */
import { endpointUrl, type HttpOrigin, rejectForeignLink } from "@/lib/db/http/endpoint";
import { TransportError } from "@/lib/db/http/node-transport";
import { createRunRegistry, engineLimiter, type LimiterTicket } from "@/lib/db/utils/bounded-limiter";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { uniqueFieldNames } from "@/lib/db/utils/result-fields";
import { secretForms } from "@/lib/db/utils/server-text";
import { logger } from "@/lib/logger";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { readSqlSpan } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";
import type { QueryWarning } from "@/lib/types";
import { columnTypeOf, decodeRows, parseCellJson, readColumns, type SnowflakeCell } from "./decode";
import {
  deadlineError,
  failureError,
  SNOWFLAKE,
  SNOWFLAKE_ERROR_SENTENCES,
  type SnowflakeDeadlineBound,
  SnowflakeError,
  type SnowflakeFailure,
  type SnowflakeFailureContext,
  serverMessage,
  transportFailureError,
} from "./errors";
import {
  partitionFailureText,
  readOversizedFirstAnswer,
  readResultRows,
  SNOWFLAKE_FIRST_ANSWER_MAX_BYTES,
  SNOWFLAKE_OVERSIZED_FIRST_READ_BYTES,
  SNOWFLAKE_ROWS_SENTENCES,
  type SnowflakeOversizedFirst,
  type SnowflakeRowsOutcome,
} from "./rows";
import {
  SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES,
  type SnowflakeTextAnswer,
  type SnowflakeTransport,
  type SnowflakeTransportDeps,
} from "./transport";

export const SNOWFLAKE_POLL_FIRST_MS = 250;
export const SNOWFLAKE_POLL_MAX_MS = 2_000;
/** Snowflake's largest statement `timeout`, in seconds. */
export const SNOWFLAKE_MAX_TIMEOUT_S = 604_800;
/** The `timeout` of every statement Studio sends on its own, lowered to the connection's when that is smaller. */
export const SNOWFLAKE_SURFACE_TIMEOUT_S = 30;
/** Added to a statement's `timeout` for Studio's own deadline, so Snowflake's timeout fires first. */
export const SNOWFLAKE_DEADLINE_GRACE_MS = 5_000;
/** The bound of one cancel request. */
export const SNOWFLAKE_CANCEL_TIMEOUT_MS = 5_000;
export const SNOWFLAKE_CHUNK_SIZE_MB = 16;
/** One row past the unlimited bound, so a result that reaches it is known to be cut. */
export const SNOWFLAKE_ROWS_PER_RESULTSET = MAX_UNLIMITED_ROWS + 1;
export const SNOWFLAKE_LIMITER_OPTIONS = Object.freeze({ perProvider: 4, perEngine: 8, queueDepth: 64 } as const);

/** The `query_tag` of each kind of work, so an administrator can find Studio's statements in QUERY_HISTORY. */
export const SNOWFLAKE_QUERY_TAGS = Object.freeze({
  editor: "libredb-studio:editor",
  connect: "libredb-studio:connect",
  roleCheck: "libredb-studio:role-check",
  tree: "libredb-studio:tree",
  describe: "libredb-studio:describe",
  inventory: "libredb-studio:inventory",
  source: "libredb-studio:source",
  health: "libredb-studio:health",
  monitoring: "libredb-studio:monitoring",
} as const);

export type SnowflakeQueryTag = (typeof SNOWFLAKE_QUERY_TAGS)[keyof typeof SNOWFLAKE_QUERY_TAGS];

export const SNOWFLAKE_STATEMENT_SENTENCES = Object.freeze({
  useRefused:
    "Snowflake's SQL API does not run USE. Set Database, Schema, Warehouse or Role on the connection instead, or use fully qualified names such as database.schema.table. Nothing was sent.",
  settingNotCarried:
    "Each Snowflake statement runs in its own session, so a session setting or variable does not carry over to the next statement.",
  temporaryNotCarried:
    "Each Snowflake statement runs in its own session, so this temporary object belongs to a session no later statement joins: the next statement cannot use or drop it, and Snowflake removes it only when that session ends. Create a permanent or TRANSIENT object instead, or use it inside one EXECUTE IMMEDIATE $$ ... $$ block.",
  noLastQuery:
    "Each Snowflake statement runs in its own session, so LAST_QUERY_ID() names no earlier statement here and answers NULL. Use the query ID from Query History instead, or call it inside one EXECUTE IMMEDIATE $$ ... $$ block.",
  noTransactions:
    "Snowflake's SQL API runs each statement in its own session, so a transaction cannot span statements. Nothing was sent. Run the whole transaction inside one EXECUTE IMMEDIATE $$ ... $$ block.",
  secondaryRoles: (roles: string, role: string) =>
    `Secondary roles are active for this user (${roles}), so this connection can read and change what those roles can, not only role ${role}. An administrator can set DEFAULT_SECONDARY_ROLES = () on the user.`,
  unresolvedDatabase: (name: string, role: string) =>
    `Snowflake resolves no database named ${name} for role ${role}, so statements run with no current database and unqualified names fail. Check the name, its case, and that the role has USAGE on it.`,
  unresolvedSchema: (name: string, role: string) =>
    `Snowflake resolves no schema named ${name} in the connection's database for role ${role}, so statements run with no current schema and unqualified names fail. Check the name, its case, and that the role has USAGE on it.`,
  unresolvedWarehouse: (name: string, role: string) =>
    `Snowflake resolves no warehouse named ${name} for role ${role}, so queries fail although browsing works. Check the name, its case, and that the role has USAGE on it.`,
  badHandle: "Snowflake answered without a statement handle Studio can use.",
  foreignLink: "Snowflake answered with a link outside this account's statements, so Studio did not follow it.",
});

/**
 * The role check `connect()` sends; M100 measured it to answer with the warehouse suspended, and with none at all.
 * `CURRENT_USER()` and the three context names ride in the same statement, so the token sign-in's user check and the
 * unresolved-name cautions cost no request of their own; the six-column form answered the same way on 2026-10-14.
 */
export const SNOWFLAKE_ROLE_CHECK_SQL =
  "SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s, CURRENT_USER() AS u, CURRENT_DATABASE() AS d, CURRENT_SCHEMA() AS c, CURRENT_WAREHOUSE() AS w";

/** The `code` of each unresolved-name caution the role check gives, so `connect()` can drop one said twice. */
export const SNOWFLAKE_UNRESOLVED_CODES = Object.freeze({
  database: "SNOWFLAKE_UNRESOLVED_DATABASE",
  schema: "SNOWFLAKE_UNRESOLVED_SCHEMA",
  warehouse: "SNOWFLAKE_UNRESOLVED_WAREHOUSE",
} as const);

/** The connection's `queryTimeoutMs` as Snowflake's `timeout`: whole seconds, rounded up, 1 to the maximum. */
export function clampedTimeoutS(queryTimeoutMs: number): number {
  return Math.min(Math.max(Math.ceil(queryTimeoutMs / 1000), 1), SNOWFLAKE_MAX_TIMEOUT_S);
}

/** The `timeout` of a statement Studio sends on its own. */
export function surfaceTimeoutS(queryTimeoutMs: number): number {
  return Math.min(SNOWFLAKE_SURFACE_TIMEOUT_S, clampedTimeoutS(queryTimeoutMs));
}

/** A Studio statement's bound: its own 30 s cap, or the query timeout when that is the shorter. */
function surfaceBound(timeoutS: number): SnowflakeDeadlineBound {
  return timeoutS === SNOWFLAKE_SURFACE_TIMEOUT_S ? "surface" : "query-timeout";
}

/** Studio's deadline for a statement of `timeoutS`: at most 604,805,000 ms, under Node's 32-bit timer limit. */
export function deadlineMsFor(timeoutS: number): number {
  return timeoutS * 1000 + SNOWFLAKE_DEADLINE_GRACE_MS;
}

const BARE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const QUOTED_IDENTIFIER = /^"((?:[^"]|"")+)"$/;

/** A name as Snowflake resolves it: a bare name upper-cased, a quoted one exact without its quotes, else as typed. */
export function foldIdentifier(name: string): string {
  if (BARE_IDENTIFIER.test(name)) return name.toUpperCase();
  const quoted = QUOTED_IDENTIFIER.exec(name);
  return quoted === null ? name : quoted[1].replaceAll('""', '"');
}

export interface SnowflakeContext {
  readonly database?: string;
  readonly schema?: string;
  readonly warehouse?: string;
  readonly role: string;
}

/** The one result type introspect.ts, monitoring.ts and index.ts read; no wire field names. */
export interface SnowflakeResult {
  readonly rows: Record<string, SnowflakeCell>[];
  readonly fields: string[];
  readonly columnTypes: Record<string, string>;
  readonly warnings: QueryWarning[];
  readonly cut: boolean;
  readonly numRows: number | null;
}

export type SnowflakeStatementRunner = (sql: string, tag: SnowflakeQueryTag) => Promise<SnowflakeResult>;

export interface SnowflakeStatementsOptions {
  readonly transport: SnowflakeTransport;
  readonly origin: HttpOrigin;
  readonly context: SnowflakeContext;
  readonly queryTimeoutMs: number;
  /** The static half of every failure's context (part b's SnowflakeFailureContext without the per-failure fields). */
  readonly failure: Omit<
    SnowflakeFailureContext,
    "secretForms" | "operativeKeyword" | "attempts" | "timeoutS" | "deadlineBound" | "submitAccepted"
  >;
  /** The PAT and the passphrase, read from the connection object at each call. */
  readonly secrets: () => readonly string[];
  readonly deps: Pick<SnowflakeTransportDeps, "sleep" | "random" | "deadline">;
}

export interface SnowflakeStatements {
  /** A user statement under `queryId` (or none), with the notices, the refusal and the user timeout. */
  runUser(sql: string, queryId: string | undefined): Promise<SnowflakeResult>;
  /** A statement Studio sends on its own, under the surface timeout, with its tag. */
  runSurface: SnowflakeStatementRunner;
  /**
   * The role check, as a surface statement: another role than the configured one is an auth failure; active
   * secondary roles answer their caution.
   */
  checkRole(): Promise<QueryWarning[]>;
  /** Aborts a run by id and answers true only once it ended cancelled; false for an unknown id. */
  cancel(queryId: string): Promise<boolean>;
  runsInFlight(): number;
  /** Aborts every run, cancels every tracked handle in parallel under its own 5 s, waits up to 5 s for the runs to end, closes the transport. */
  close(): Promise<void>;
}

/** One process-wide table for the engine: every Snowflake connection's statements share its bound. */
const snowflakeLimiter = engineLimiter(SNOWFLAKE, SNOWFLAKE_LIMITER_OPTIONS);

const STATEMENTS_PATH = "/api/v2/statements";
const STATEMENT_PREFIX = `${STATEMENTS_PATH}/`;
const HANDLE_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A status answer the transport returned past its resend cap: the statement may still run, so it is cancelled. */
const STATUS_GAVE_UP: ReadonlySet<number> = new Set([500, 502, 503, 504]);
const PARTITION_GAVE_UP: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const SNOWFLAKE_CUT_CODE = "391908";
const CANCEL_CONFIRMED_CODE = "000709";

const statusPath = (handle: string): string => `${STATEMENT_PREFIX}${handle}`;
const cancelPath = (handle: string): string => `${statusPath(handle)}/cancel`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isDeadline = (reason: unknown): boolean => reason instanceof DOMException && reason.name === "TimeoutError";

const cancelledError = (): SnowflakeError => new SnowflakeError("cancelled", SNOWFLAKE_ERROR_SENTENCES.cancelled);

/** The code, sqlState and message of a failed answer; a body that is not a JSON object leaves them null. */
function failureOf(status: number, text: string, request: SnowflakeFailure["request"]): SnowflakeFailure {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (isRecord(parsed)) body = parsed;
  } catch {
    // A gateway's HTML page or an empty body: the status alone classifies it.
  }
  const field = (value: unknown): string | null => (typeof value === "string" ? value : null);
  return { status, code: field(body.code), sqlState: field(body.sqlState), message: field(body.message), request };
}

function parseAnswer(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.unreadable);
  }
  if (!isRecord(parsed)) throw new SnowflakeError("query", SNOWFLAKE_ROWS_SENTENCES.unreadable);
  return parsed;
}

const SNOWFLAKE_GRAMMAR = resolveSqlGrammar(SNOWFLAKE);
const TRIVIA: ReadonlySet<string> = new Set(["whitespace", "line-comment", "block-comment"]);

/** One code token: a word upper-cased, a quoted identifier as a name, or any other code text. */
type CodeToken =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "name" }
  | { readonly kind: "other"; readonly text: string };

/** The statement's code tokens, comments and whitespace skipped, and one trailing `;` dropped. */
function codeTokens(sql: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const span = readSqlSpan(sql, index, SNOWFLAKE_GRAMMAR);
    const word = span === null ? readSqlWord(sql, index) : null;
    if (span !== null) {
      if (span.kind === "quoted-identifier") tokens.push({ kind: "name" });
      else if (!TRIVIA.has(span.kind)) tokens.push({ kind: "other", text: span.kind });
      index = span.end;
    } else if (word !== null) {
      tokens.push({ kind: "word", text: word.text });
      index = word.end;
    } else {
      tokens.push({ kind: "other", text: sql[index] });
      index += 1;
    }
  }
  const last = tokens.at(-1);
  if (last?.kind === "other" && last.text === ";") tokens.pop();
  return tokens;
}

/** The lone transaction forms, `NAME` standing for the one name token that follows it. */
const LONE_TRANSACTION_FORMS: readonly (readonly string[])[] = [
  ["BEGIN"],
  ["BEGIN", "TRANSACTION"],
  ["BEGIN", "WORK"],
  ["BEGIN", "NAME", "<name>"],
  ["BEGIN", "TRANSACTION", "NAME", "<name>"],
  ["BEGIN", "WORK", "NAME", "<name>"],
  ["START", "TRANSACTION"],
  ["START", "TRANSACTION", "NAME", "<name>"],
  ["COMMIT"],
  ["COMMIT", "WORK"],
  ["ROLLBACK"],
  ["ROLLBACK", "WORK"],
];

/** Whether the statement is one transaction-control statement alone, which a sessionless request cannot honour. */
function isLoneTransaction(tokens: readonly CodeToken[]): boolean {
  return LONE_TRANSACTION_FORMS.some(
    (form) =>
      form.length === tokens.length &&
      form.every((expected, position) => {
        const token = tokens[position];
        if (expected === "<name>") return token.kind === "name" || token.kind === "word";
        return token.kind === "word" && token.text === expected;
      }),
  );
}

/** The words that may stand between `CREATE` and the object kind; three of them make the object temporary. */
const CREATE_MODIFIERS: ReadonlySet<string> = new Set([
  "OR",
  "REPLACE",
  "ALTER",
  "LOCAL",
  "GLOBAL",
  "TEMP",
  "TEMPORARY",
  "VOLATILE",
  "TRANSIENT",
]);
const TEMPORARY_WORDS: ReadonlySet<string> = new Set(["TEMP", "TEMPORARY", "VOLATILE"]);

/** Whether `CREATE` is followed, among its modifiers, by `TEMP`, `TEMPORARY` or `VOLATILE`. */
function createsTemporary(tokens: readonly CodeToken[]): boolean {
  if (tokens[0]?.kind !== "word" || tokens[0].text !== "CREATE") return false;
  for (const token of tokens.slice(1)) {
    if (token.kind !== "word" || !CREATE_MODIFIERS.has(token.text)) return false;
    if (TEMPORARY_WORDS.has(token.text)) return true;
  }
  return false;
}

/** Whether the statement's code calls `LAST_QUERY_ID(`; text inside a string or a `$$` block is not code. */
function callsLastQueryId(tokens: readonly CodeToken[]): boolean {
  return tokens.some((token, index) => {
    const next = tokens[index + 1];
    return token.kind === "word" && token.text === "LAST_QUERY_ID" && next?.kind === "other" && next.text === "(";
  });
}

/** The notice of a statement whose effect a sessionless request does not keep, or null. */
function sessionNotice(keyword: string | null, tokens: readonly CodeToken[]): QueryWarning | null {
  const [, second, third] = tokens;
  // `ALTER SESSION POLICY` alters an account object, which does outlive the statement.
  const alterSession =
    keyword === "ALTER" &&
    second?.kind === "word" &&
    second.text === "SESSION" &&
    third?.kind === "word" &&
    (third.text === "SET" || third.text === "UNSET");
  if (keyword === "SET" || keyword === "UNSET" || alterSession) {
    return { code: "SNOWFLAKE_SETTING_NOT_CARRIED", message: SNOWFLAKE_STATEMENT_SENTENCES.settingNotCarried };
  }
  if (createsTemporary(tokens)) {
    return { code: "SNOWFLAKE_TEMPORARY_NOT_CARRIED", message: SNOWFLAKE_STATEMENT_SENTENCES.temporaryNotCarried };
  }
  if (callsLastQueryId(tokens)) {
    return { code: "SNOWFLAKE_NO_LAST_QUERY", message: SNOWFLAKE_STATEMENT_SENTENCES.noLastQuery };
  }
  return null;
}

/**
 * Whether the user Snowflake signed in is the one typed in User: a double-quoted name exactly, without its quotes,
 * and anything else ignoring case, since a login name is case-insensitive and Snowflake upper-cases an unquoted name.
 */
function sameUser(typed: string, actual: string): boolean {
  const name = typed.trim();
  if (QUOTED_IDENTIFIER.test(name)) return foldIdentifier(name) === actual;
  return name.toUpperCase() === actual.toUpperCase();
}

/** A decoded text cell as text; an absent or null cell is empty. */
function cellText(cell: SnowflakeCell | undefined): string {
  if (cell === undefined || cell === null) return "";
  return typeof cell === "string" ? cell : String(cell);
}

/**
 * The secondary roles `CURRENT_SECONDARY_ROLES()` names: the `roles` string of its JSON object, or the trimmed text
 * when the value is not an object. The trial captured `{"roles":"","value":"ALL"}` with none active and
 * `{"roles":"STUDIO_NOWH","value":"ALL"}` with one (M38, connect-no-warehouse).
 */
function secondaryRoleNames(value: string): string {
  let parsed: unknown;
  try {
    parsed = parseCellJson(value, "s");
  } catch {
    return value.trim();
  }
  if (!isRecord(parsed)) return value.trim();
  return typeof parsed.roles === "string" ? parsed.roles.trim() : "";
}

/** What one run sends and is bounded by. */
interface Run {
  readonly sql: string;
  readonly tag: SnowflakeQueryTag;
  readonly timeoutS: number;
  readonly deadlineBound: SnowflakeDeadlineBound;
  /** The registry's signal joined with the lifetime: a cancel, the deadline or `close()`. */
  readonly signal: AbortSignal;
  /** The deadline alone, which the submit runs under. */
  readonly deadline: AbortSignal;
  readonly keyword: string | null;
}

export function createSnowflakeStatements(options: SnowflakeStatementsOptions): SnowflakeStatements {
  const { transport, origin, context, deps } = options;
  const limiter = snowflakeLimiter();
  const runs = createRunRegistry();
  const lifetime = new AbortController();
  /** The handles of runs not yet ended whose submit answered before the lifetime aborted; `close()` cancels them. */
  const handles = new Set<string>();
  /** Each run with a `queryId`, by id: its end, true when it ended cancelled. */
  const runEnds = new Map<string, Promise<boolean>>();
  /** The end of every run not yet ended, for `close()` to wait on. */
  const active = new Set<Promise<boolean>>();

  /** Resolves when `signal` fires; never rejects. */
  const fired = (signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener("abort", () => resolve(), { once: true });
    });

  const failureContext = (run: Run, attempts: number, submitAccepted: boolean): SnowflakeFailureContext => ({
    ...options.failure,
    secretForms: secretForms([...options.secrets(), ...transport.recentTokens()]),
    operativeKeyword: run.keyword,
    attempts,
    timeoutS: run.timeoutS,
    deadlineBound: run.deadlineBound,
    submitAccepted,
  });

  /**
   * The SQL API reads the body's four names exactly (measured on the trial: a lower-case role is refused, a lower-case
   * database, schema or warehouse leaves that context unset), so each is sent as Snowflake SQL resolves it.
   */
  function requestBody(run: Run): string {
    const { database, schema, warehouse, role } = context;
    const present = (value: string | undefined): value is string => value !== undefined && value !== "";
    return JSON.stringify({
      statement: run.sql,
      timeout: run.timeoutS,
      ...(present(database) ? { database: foldIdentifier(database) } : {}),
      ...(present(schema) ? { schema: foldIdentifier(schema) } : {}),
      ...(present(warehouse) ? { warehouse: foldIdentifier(warehouse) } : {}),
      role: foldIdentifier(role),
      parameters: {
        multi_statement_count: "1",
        query_tag: run.tag,
        client_result_chunk_size: SNOWFLAKE_CHUNK_SIZE_MB,
        rows_per_resultset: SNOWFLAKE_ROWS_PER_RESULTSET,
      },
    });
  }

  /** Refuses a status link that would leave this account's statements; the link itself is never requested. */
  function checkLink(link: unknown): void {
    const refused = (): SnowflakeError => new SnowflakeError("defect", SNOWFLAKE_STATEMENT_SENTENCES.foreignLink);
    if (link === undefined) return;
    if (typeof link !== "string") throw refused();
    let target: URL;
    try {
      target = new URL(link, endpointUrl(origin, "/"));
      rejectForeignLink(target.href, origin);
    } catch {
      throw refused();
    }
    if (!target.pathname.startsWith(STATEMENT_PREFIX)) throw refused();
  }

  function readHandle(answer: Record<string, unknown>): string {
    checkLink(answer.statementStatusUrl);
    const handle = answer.statementHandle;
    if (typeof handle !== "string" || !HANDLE_SHAPE.test(handle)) {
      throw new SnowflakeError("defect", SNOWFLAKE_STATEMENT_SENTENCES.badHandle);
    }
    return handle;
  }

  /** One cancel request, never retried; any answer but the two confirmations is logged with its status alone. */
  async function sendCancel(handle: string): Promise<void> {
    let status: number | null = null;
    try {
      const answer = await transport.cancel(
        cancelPath(handle),
        deps.deadline(SNOWFLAKE_CANCEL_TIMEOUT_MS),
        SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES,
      );
      const confirmed =
        answer.status === 200 ||
        (answer.status === 422 && failureOf(answer.status, answer.text, "cancel").code === CANCEL_CONFIRMED_CODE);
      if (confirmed) return;
      status = answer.status;
    } catch {
      // A cancel that got no answer is logged as one that was refused; the run ends cancelled either way.
    }
    logger.warn("A Snowflake statement cancel was not confirmed", { status });
  }

  /** The run's own cancel: the handle leaves the set first, so `close()` never sends a second one. */
  async function cancelOwn(handle: string): Promise<void> {
    handles.delete(handle);
    await sendCancel(handle);
  }

  /**
   * A run whose signal aborted: its own cancel, unless the lifetime aborted while the handle was in the set, which
   * `close()` cancels; then the cancelled or the deadline sentence.
   */
  async function stopped(run: Run, handle: string | null): Promise<never> {
    const deadline = isDeadline(run.signal.reason);
    if (handle !== null && !(lifetime.signal.aborted && handles.has(handle))) await cancelOwn(handle);
    throw deadline ? deadlineError(run.timeoutS, run.deadlineBound) : cancelledError();
  }

  /**
   * A transport failure as a `SnowflakeError`; one that is not the transport's is returned unchanged. A status answer
   * too large to read never reaches here: the poll reads it again as a stream.
   */
  function transportError(error: unknown): unknown {
    const mapped = transportFailureError(error, options.failure.host);
    if (!(mapped instanceof TransportError)) return mapped;
    return new SnowflakeError("unavailable", mapped.message);
  }

  /** One partition's bytes (`query` empty for the status answer itself); an answer that is not 200 is thrown. */
  async function fetchBytes(run: Run, handle: string, query: string, maxResponseBytes: number, truncateAt: number) {
    const part = await transport.partition(statusPath(handle), query, run.signal, maxResponseBytes, truncateAt);
    if (part.status === 200) return part;
    if (PARTITION_GAVE_UP.has(part.status)) await cancelOwn(handle);
    throw failureError(
      failureOf(part.status, await partitionFailureText(part, maxResponseBytes), "partition"),
      failureContext(run, part.attempts, true),
    );
  }

  /**
   * The result of a finished statement: from its status answer, or, when that answer was too large to read whole,
   * from `first`, partition 0 read again as a stream under the budget (SF-032).
   */
  async function buildResult(
    run: Run,
    handle: string,
    answer: Record<string, unknown>,
    first?: SnowflakeOversizedFirst,
  ): Promise<SnowflakeResult> {
    const metaOf = first?.meta ?? answer.resultSetMetaData;
    const meta = isRecord(metaOf) ? metaOf : {};
    const columns = readColumns(meta.rowType);
    const names = columns.map((column) => column.name);
    const partitionInfo = meta.partitionInfo;
    const outcome: SnowflakeRowsOutcome =
      first !== undefined && first.outcome.cut !== null
        ? first.outcome
        : await readResultRows({
            columns: names,
            firstData: first === undefined ? answer.data : first.outcome.rows,
            partitionCount: Array.isArray(partitionInfo) ? Math.max(partitionInfo.length, 1) : 1,
            fetchPartition: (index, maxResponseBytes, truncateAt) =>
              fetchBytes(run, handle, `partition=${index}`, maxResponseBytes, truncateAt),
            signal: run.signal,
          });
    const numRows = typeof meta.numRows === "number" ? meta.numRows : null;
    const warnings: QueryWarning[] = [];
    if (outcome.cut === "bytes") {
      warnings.push({
        message:
          outcome.rows.length === 0 ? SNOWFLAKE_ROWS_SENTENCES.firstRowCut : SNOWFLAKE_ROWS_SENTENCES.byteCut(numRows),
      });
    }
    if (outcome.cut === "rows") warnings.push({ message: SNOWFLAKE_ROWS_SENTENCES.rowCut });
    const snowflakeCut = answer.code === SNOWFLAKE_CUT_CODE;
    if (snowflakeCut) warnings.push({ message: SNOWFLAKE_ROWS_SENTENCES.snowflakeCut });
    const fields = uniqueFieldNames(names);
    return {
      rows: decodeRows(columns, outcome.rows),
      fields,
      columnTypes: Object.fromEntries(columns.map((column, position) => [fields[position], columnTypeOf(column)])),
      warnings,
      cut: outcome.cut !== null || snowflakeCut,
      numRows,
    };
  }

  /** Submit, poll and read one statement; the caller holds its permit. */
  async function execute(run: Run): Promise<SnowflakeResult> {
    let handle: string | null = null;
    try {
      let answer: SnowflakeTextAnswer = await transport.submit(
        STATEMENTS_PATH,
        requestBody(run),
        run.deadline,
        SNOWFLAKE_CONTROL_ANSWER_MAX_BYTES,
      );
      if (answer.status !== 200 && answer.status !== 202) {
        throw failureError(
          failureOf(answer.status, answer.text, "submit"),
          failureContext(run, answer.attempts, false),
        );
      }
      let parsed = parseAnswer(answer.text);
      handle = readHandle(parsed);
      if (!lifetime.signal.aborted) handles.add(handle);
      run.signal.throwIfAborted();

      let interval = SNOWFLAKE_POLL_FIRST_MS;
      while (answer.status !== 200) {
        // oxlint-disable-next-line no-await-in-loop -- each poll waits its interval before the next status read.
        await deps.sleep(interval, run.signal);
        try {
          // oxlint-disable-next-line no-await-in-loop -- each status answer decides whether there is another poll.
          answer = await transport.status(statusPath(handle), run.signal, SNOWFLAKE_FIRST_ANSWER_MAX_BYTES);
        } catch (error) {
          if (!(error instanceof TransportError && error.kind === "too-large")) throw error;
          // Partition 0 is larger than the status read holds: read it again as a stream, under the budget.
          const bound = SNOWFLAKE_OVERSIZED_FIRST_READ_BYTES;
          // oxlint-disable-next-line no-await-in-loop -- the loop ends here, with this read.
          const first = await readOversizedFirstAnswer(await fetchBytes(run, handle, "", bound, bound));
          // oxlint-disable-next-line no-await-in-loop -- the loop ends here, with this read.
          return await buildResult(run, handle, {}, first);
        }
        if (answer.status === 202) {
          interval = Math.min(interval * 2, SNOWFLAKE_POLL_MAX_MS);
        } else if (answer.status === 429) {
          interval = Math.round(SNOWFLAKE_POLL_MAX_MS * (0.5 + deps.random() / 2));
        } else if (answer.status === 200) {
          parsed = parseAnswer(answer.text);
          checkLink(parsed.statementStatusUrl);
        } else {
          // oxlint-disable-next-line no-await-in-loop -- the cancel goes out before the failure is thrown.
          if (STATUS_GAVE_UP.has(answer.status)) await cancelOwn(handle);
          throw failureError(
            failureOf(answer.status, answer.text, "status"),
            failureContext(run, answer.attempts, true),
          );
        }
      }

      return await buildResult(run, handle, parsed);
    } catch (error) {
      if (run.signal.aborted) return await stopped(run, handle);
      throw transportError(error);
    } finally {
      if (handle !== null) handles.delete(handle);
    }
  }

  /**
   * One run: registered, joined to the lifetime, and under one permit from its submit to its result.
   *
   * Two bounds of the same length follow each other. While the run waits for a permit, the wait's own bound runs, and
   * passing it is the slots sentence with nothing sent. The statement's deadline starts only once the permit is held,
   * so a statement that queued behind others still gets its whole `timeout` and grace on Snowflake.
   */
  async function runStatement(input: {
    readonly queryId: string | undefined;
    readonly sql: string;
    readonly tag: SnowflakeQueryTag;
    readonly timeoutS: number;
    readonly deadlineBound: SnowflakeDeadlineBound;
    readonly keyword: string | null;
  }): Promise<SnowflakeResult> {
    const boundMs = deadlineMsFor(input.timeoutS);
    /** The run's deadline as the registry sees it: the wait's bound until admission, then the statement's. */
    const bound = new AbortController();
    let admitted = false;
    const follow = (timer: AbortSignal, whileAdmitted: boolean): void => {
      timer.addEventListener("abort", () => {
        if (admitted === whileAdmitted) bound.abort(timer.reason);
      });
    };
    follow(deps.deadline(boundMs), false);
    const registered = runs.begin(input.queryId, bound.signal);
    const signal = AbortSignal.any([registered.signal, lifetime.signal]);
    let finish: (cancelled: boolean) => void = () => {};
    const ended = new Promise<boolean>((resolve) => {
      finish = resolve;
    });
    if (input.queryId !== undefined) runEnds.set(input.queryId, ended);
    active.add(ended);
    let cancelled = false;
    try {
      let ticket: LimiterTicket;
      try {
        ticket = await limiter.acquire(signal);
      } catch (error) {
        if (!signal.aborted) throw error;
        if (!isDeadline(signal.reason)) throw cancelledError();
        throw new SnowflakeError("unavailable", SNOWFLAKE_ERROR_SENTENCES.slotsBusy(boundMs / 1000));
      }
      admitted = true;
      const deadline = deps.deadline(boundMs);
      follow(deadline, true);
      const run: Run = {
        sql: input.sql,
        tag: input.tag,
        timeoutS: input.timeoutS,
        deadlineBound: input.deadlineBound,
        keyword: input.keyword,
        signal,
        deadline,
      };
      try {
        return await execute(run);
      } finally {
        ticket.release();
      }
    } catch (error) {
      cancelled = error instanceof SnowflakeError && error.category === "cancelled";
      throw error;
    } finally {
      registered.end();
      // Only this run's own entry: once it ended, the same id may name a newer run.
      if (input.queryId !== undefined && runEnds.get(input.queryId) === ended) runEnds.delete(input.queryId);
      active.delete(ended);
      finish(cancelled);
    }
  }

  function runSurface(sql: string, tag: SnowflakeQueryTag): Promise<SnowflakeResult> {
    const timeoutS = surfaceTimeoutS(options.queryTimeoutMs);
    return runStatement({
      queryId: undefined,
      sql,
      tag,
      timeoutS,
      deadlineBound: surfaceBound(timeoutS),
      keyword: null,
    });
  }

  return {
    async runUser(sql, queryId) {
      const keyword = readOperativeKeyword(sql, SNOWFLAKE_GRAMMAR)?.keyword ?? null;
      const tokens = codeTokens(sql);
      if (isLoneTransaction(tokens)) throw new SnowflakeError("query", SNOWFLAKE_STATEMENT_SENTENCES.noTransactions);
      // The SQL API answers every USE with 391911, so it is refused here, unsent.
      if (keyword === "USE") throw new SnowflakeError("query", SNOWFLAKE_STATEMENT_SENTENCES.useRefused);
      const notice = sessionNotice(keyword, tokens);
      let result: SnowflakeResult;
      try {
        result = await runStatement({
          queryId,
          sql,
          tag: SNOWFLAKE_QUERY_TAGS.editor,
          timeoutS: clampedTimeoutS(options.queryTimeoutMs),
          deadlineBound: "query-timeout",
          keyword,
        });
      } catch (error) {
        // A statement that fails for want of an earlier one ("Statement null not found") says why, after Snowflake.
        if (notice?.code === "SNOWFLAKE_NO_LAST_QUERY" && error instanceof SnowflakeError) {
          error.message = `${error.message} ${notice.message}`;
        }
        throw error;
      }
      return notice === null ? result : { ...result, warnings: [...result.warnings, notice] };
    },

    runSurface,

    async checkRole() {
      const result = await runSurface(SNOWFLAKE_ROLE_CHECK_SQL, SNOWFLAKE_QUERY_TAGS.roleCheck);
      const [roleField, secondaryField, userField, databaseField, schemaField, warehouseField] = result.fields;
      const row = result.rows[0] ?? {};
      const actual = cellText(row[roleField]);
      const forms = secretForms([...options.secrets(), ...transport.recentTokens()]);
      if (actual !== foldIdentifier(context.role)) {
        throw new SnowflakeError(
          "auth",
          SNOWFLAKE_ERROR_SENTENCES.roleMismatch(serverMessage(actual, forms), context.role),
        );
      }
      // A token names its own user and the SQL API takes no user beside it, so User is checked against the session.
      const { authMethod, user } = options.failure;
      const signedIn = cellText(row[userField]);
      if (authMethod === "pat" && !sameUser(user, signedIn)) {
        throw new SnowflakeError(
          "auth",
          SNOWFLAKE_ERROR_SENTENCES.tokenUserMismatch(serverMessage(signedIn, forms), user),
        );
      }
      const roles = secondaryRoleNames(cellText(row[secondaryField]));
      const cautions: QueryWarning[] =
        roles === ""
          ? []
          : [{ message: SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles(serverMessage(roles, forms), context.role) }];
      // The SQL API leaves a name it cannot resolve unset without an error (measured 2026-10-13), so a configured
      // name answered as NULL is cautioned here; a schema is not, once its database already was.
      const unset = (field: string | undefined, configured: string | undefined): configured is string =>
        configured !== undefined && configured !== "" && cellText(row[field ?? ""]) === "";
      const { database, schema, warehouse, role } = context;
      if (unset(databaseField, database)) {
        cautions.push({
          code: SNOWFLAKE_UNRESOLVED_CODES.database,
          message: SNOWFLAKE_STATEMENT_SENTENCES.unresolvedDatabase(database, role),
        });
      } else if (unset(schemaField, schema)) {
        cautions.push({
          code: SNOWFLAKE_UNRESOLVED_CODES.schema,
          message: SNOWFLAKE_STATEMENT_SENTENCES.unresolvedSchema(schema, role),
        });
      }
      if (unset(warehouseField, warehouse)) {
        cautions.push({
          code: SNOWFLAKE_UNRESOLVED_CODES.warehouse,
          message: SNOWFLAKE_STATEMENT_SENTENCES.unresolvedWarehouse(warehouse, role),
        });
      }
      return cautions;
    },

    async cancel(queryId) {
      const ended = runEnds.get(queryId);
      if (ended === undefined || !runs.cancel(queryId)) return false;
      // The run's own cancel request is bounded by its 5 s, and the poll or submit it interrupts by as much again.
      const bound = deps.deadline(SNOWFLAKE_CANCEL_TIMEOUT_MS * 2);
      return Promise.race([ended, fired(bound).then(() => false)]);
    },

    runsInFlight: () => runs.runsInFlight(),

    async close() {
      lifetime.abort(cancelledError());
      const tracked = [...handles];
      await Promise.allSettled(tracked.map((handle) => sendCancel(handle)));
      // A run still in its submit keeps the transport until it ends or this bound fires, so its own cancel can go out.
      const bound = deps.deadline(SNOWFLAKE_CANCEL_TIMEOUT_MS);
      await Promise.race([Promise.allSettled([...active]), fired(bound)]);
      transport.close();
    },
  };
}
