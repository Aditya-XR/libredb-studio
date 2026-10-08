/**
 * The reader of the Databend captures for the replay (design 9, 11 #8), and the recording query server that replays
 * them; tests/helpers/databend-node-transport.ts `capturedAnswer` reads single answers of the same run on its own.
 * The captures are what the pinned `datafuselabs/databend:v1.2.951-nightly` answered tests/live/databend-evidence.ts
 * on 2026-10-08 (tests/fixtures/databend/local-2026-10-08-v1.2.951-nightly/), every scenario the local target runs:
 * one scenario per file, with ids, node ids and user names replaced by placeholders (`<query-2>`, `<session-5>`,
 * `<node-1>`, `<user-2>`), numbered per run. A missing or mislabelled file, or a scenario name of two runs, fails the
 * suite that reads it; nothing here falls back.
 *
 * `databendReplay` stands where the shared `createNodeTransport` stands in the provider's deps, so the real
 * provider, transport, answer reader and decoder run and only the server is fake. A statement POST is answered by
 * what it asks: the test maps its text to one captured exchange, or to a built answer for a statement no capture
 * holds. Every later request of that statement (a page, the final, the kill) takes the next unserved exchange of the
 * same capture at the same path, the statement's placeholder standing for the query id Studio sent, and a logout
 * takes the logout of the capture whose statement opened the session. Sessions are followed too: once Studio's logout
 * has been answered with a capture's logout, a statement that capture sent before that logout in the same captured
 * session (`<session-N>`) is not replayed, since its answer needed the session state the logout dropped. A request no
 * capture answers is recorded as unanswered and fails with a plain error, as a close the shared transport could not
 * send fails, so a test names every one it expects.
 *
 * Two fields of a captured answer are rewritten, both because Studio sends what the harness did not:
 *
 * - `session_id`: Studio sends a client session of its own on every statement, which the server echoes, and the
 *   harness ran most scenarios without one (`clientSession: false`), where the server answered `""`. The replay
 *   echoes the session Studio sent; the ids are the placeholders' only other rewrite.
 * - `session.settings`: the harness sent no `session` object, so the server echoed `{}`. Studio pins its settings on
 *   every statement, and the pinned server echoes each one it knows (session-echo.json drops only the unknown name,
 *   and the provider's own run against the fixture on 2026-10-08 echoed all of Studio's), so the replay echoes the
 *   settings the request carried in place of an empty echo. A non-empty captured echo is replayed as it is: only
 *   session-echo.json has one, for settings the harness pinned (`timezone: Europe/Istanbul`) rather than Studio's, so
 *   no test reads a value that depends on it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type NodeRequest,
  type NodeResponse,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import { TEST_NODE, wireIds } from "./databend-node-transport";

const DATABEND_CAPTURES_DIR = join(import.meta.dir, "..", "fixtures", "databend");

/** The capture runs the replay reads, each a directory with its manifest; a scenario name belongs to one run. */
export const DATABEND_CAPTURE_RUNS = ["local-2026-10-08-v1.2.951-nightly"] as const;
type DatabendCaptureRun = (typeof DATABEND_CAPTURE_RUNS)[number];

export interface DatabendCapturedExchange {
  readonly step: string;
  readonly request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: { readonly sql?: string } & Record<string, unknown>;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    /** A JSON answer, or `{ text }` for a body that was not JSON. */
    readonly body: unknown;
  };
}

export interface DatabendCapture {
  readonly scenario: string;
  readonly principal: "default" | "reader" | "wrong";
  readonly clientSession: boolean;
  readonly exchanges: readonly DatabendCapturedExchange[];
}

export interface DatabendCaptureManifest {
  readonly target: string;
  readonly image: string;
  readonly serverVersion: string;
  readonly capturedAt: string;
  readonly scenarios: readonly { readonly name: string; readonly exchanges: number }[];
}

export function loadDatabendManifest(run: DatabendCaptureRun = DATABEND_CAPTURE_RUNS[0]): DatabendCaptureManifest {
  return JSON.parse(readFileSync(join(DATABEND_CAPTURES_DIR, run, "manifest.json"), "utf8")) as DatabendCaptureManifest;
}

/** The scenario names of a run's capture files, sorted: every file of its directory but the manifest. */
export function databendCaptureFiles(run: DatabendCaptureRun): string[] {
  return readdirSync(join(DATABEND_CAPTURES_DIR, run))
    .filter((file) => file !== "manifest.json")
    .map((file) => file.replace(/\.json$/, ""))
    .sort();
}

export function loadDatabendCapture(name: string): DatabendCapture {
  const runs = DATABEND_CAPTURE_RUNS.filter((run) =>
    loadDatabendManifest(run).scenarios.some((scenario) => scenario.name === name),
  );
  if (runs.length !== 1) throw new Error(`${name} is a scenario of ${runs.length} capture runs, not of one`);
  const loaded = JSON.parse(
    readFileSync(join(DATABEND_CAPTURES_DIR, runs[0], `${name}.json`), "utf8"),
  ) as DatabendCapture;
  if (loaded.scenario !== name) throw new Error(`${name}.json holds the scenario ${loaded.scenario}`);
  return loaded;
}

/** The statement text exchange `index` of a capture posted. */
export function capturedSql(name: string, index: number): string {
  const sql = loadDatabendCapture(name).exchanges[index]?.request.body?.sql;
  if (sql === undefined) throw new Error(`${name} exchange ${index} posted no statement`);
  return sql;
}

/** What a statement POST is answered with: one captured exchange, or a built answer's fields. */
export type ReplayAnswer =
  | { readonly capture: string; readonly index: number }
  | { readonly built: Readonly<Record<string, unknown>> };

export interface ReplayedRequest {
  readonly method: "GET" | "POST";
  /** The path as sent. */
  readonly path: string;
  /** The path with the statement's capture placeholder in place of Studio's query id. */
  readonly capturePath: string;
  readonly sql?: string;
  readonly body?: Record<string, unknown>;
  readonly headers: Readonly<Record<string, string>>;
  /** `<scenario>#<index>` of the exchange that answered, `built`, `held`, or null when nothing answered. */
  readonly servedBy: string | null;
}

/** One statement Studio posted: its capture and placeholder, or a built answer, and its session. */
interface Statement {
  readonly capture: string | null;
  readonly placeholder: string;
  readonly sessionId: string;
}

/** The shared transport's failure for an aborted signal: a deadline or a cancellation, told apart by the reason. */
function abortFailure(signal: AbortSignal): TransportError {
  const reason: unknown = signal.reason;
  return reason instanceof DOMException && reason.name === "TimeoutError"
    ? new TransportError("timeout", "The request did not finish within its time limit")
    : new TransportError("aborted", "The request was cancelled");
}

/** What `servedBy` reads for a built answer, and for a request `hold` kept unanswered. */
const BUILT = "built";
export const HELD = "held";
const SESSION_PLACEHOLDER = /<session-\d+>/g;
const NODE_PLACEHOLDER = /<node-\d+>/g;

export interface DatabendReplay {
  readonly factory: (options: NodeTransportOptions) => NodeTransport;
  /** Every request received, in order. */
  readonly requests: ReplayedRequest[];
  /** Every `<scenario>#<index>` that answered a request, in order of first use. */
  served(): string[];
  /** Every request no capture answered, as `METHOD capture path`. */
  unanswered(): string[];
}

/**
 * A query server answering from the captures. `answer` decides each statement POST by its text; `hold` keeps a
 * request unanswered until its signal fires, as a long poll the server has not ended; `role` is the role a built
 * answer echoes, the principal's.
 */
export function databendReplay({
  answer,
  hold = () => false,
  role = "account_admin",
}: {
  readonly answer: (sql: string) => ReplayAnswer | undefined;
  readonly hold?: (request: ReplayedRequest) => boolean;
  readonly role?: string;
}): DatabendReplay {
  const requests: ReplayedRequest[] = [];
  const statements = new Map<string, Statement>();
  const sessions = new Map<string, string>();
  /** The captured session of the statement that opened each of Studio's sessions. */
  const capturedSessions = new Map<string, string>();
  /** `<capture> <session-N>` of each captured session a served logout ended, and the index of that logout. */
  const ended = new Map<string, number>();
  const served: string[] = [];
  const used = new Set<string>();
  let built = 0;

  const markServed = (label: string): void => {
    if (!used.has(label)) served.push(label);
    used.add(label);
  };

  /** The captured answer with Studio's ids in place of the placeholders and the two rewrites of the header note. */
  const replayed = (
    exchange: DatabendCapturedExchange,
    ids: { readonly placeholder: string; readonly queryId: string; readonly sessionId: string },
    settings: unknown,
  ): NodeResponse => {
    const contentType = exchange.response.headers["content-type"] ?? null;
    const body = exchange.response.body as Record<string, unknown>;
    if (typeof body.text === "string" && Object.keys(body).length === 1) {
      return { status: exchange.response.status, contentType, retryAfter: null, text: body.text };
    }
    // A refusal or a logout names no statement, so it has no placeholder to replace.
    const named =
      ids.placeholder === "" ? JSON.stringify(body) : JSON.stringify(body).replaceAll(ids.placeholder, ids.queryId);
    const text = named.replace(SESSION_PLACEHOLDER, ids.sessionId).replace(NODE_PLACEHOLDER, TEST_NODE);
    const answer = JSON.parse(text) as Record<string, unknown>;
    if (answer.session_id === "" && answer.id !== "" && answer.id !== undefined) answer.session_id = ids.sessionId;
    const session = answer.session as { settings?: Record<string, unknown> } | null | undefined;
    if (session?.settings !== undefined && Object.keys(session.settings).length === 0 && settings !== undefined) {
      session.settings = settings as Record<string, unknown>;
    }
    return { status: exchange.response.status, contentType, retryAfter: null, text: JSON.stringify(answer) };
  };

  /** A built answer: finished in its first answer, with the final link every pinned answer carries. */
  const builtAnswer = (
    fields: Readonly<Record<string, unknown>>,
    queryId: string,
    sessionId: string,
    request: Record<string, unknown> | undefined,
  ): NodeResponse => {
    const asked = (request?.session ?? {}) as { database?: string; settings?: Record<string, unknown> };
    const body = {
      id: queryId,
      session_id: sessionId,
      node_id: TEST_NODE,
      state: "Succeeded",
      session: {
        catalog: "default",
        database: asked.database ?? "default",
        role,
        settings: asked.settings ?? {},
        txn_state: "AutoCommit",
        need_sticky: false,
        need_keep_alive: false,
      },
      error: null,
      warnings: [],
      has_result_set: true,
      schema: [],
      data: [],
      affect: null,
      next_uri: `/v1/query/${queryId}/final`,
      ...fields,
    };
    return { status: 200, contentType: "application/json", retryAfter: null, text: JSON.stringify(body) };
  };

  /** The next unserved exchange of `capture` at `method capturePath`, else the first one there. */
  const followUp = (capture: string, method: string, capturePath: string) => {
    const { exchanges } = loadDatabendCapture(capture);
    const at = exchanges
      .map((exchange, index) => ({ exchange, index }))
      .filter(({ exchange }) => exchange.request.method === method && exchange.request.path === capturePath);
    return at.find(({ index }) => !used.has(`${capture}#${index}`)) ?? at[0];
  };

  const respond = (
    request: NodeRequest,
    headers: Readonly<Record<string, string>>,
  ): { readonly seen: ReplayedRequest; readonly response: NodeResponse | null } => {
    const path = new URL(request.url).pathname;
    const body =
      request.body === undefined ? undefined : (JSON.parse(request.body) as Record<string, unknown> & { sql?: string });
    const ids = wireIds(headers);
    const base = { method: request.method, path, headers, ...(body === undefined ? {} : { body }) };

    if (request.method === "POST" && path === "/v1/query") {
      const sql = body?.sql as string;
      const decided = answer(sql);
      if (decided === undefined) return { seen: { ...base, capturePath: path, sql, servedBy: null }, response: null };
      sessions.set(ids.sessionId, "capture" in decided ? decided.capture : BUILT);
      if ("built" in decided) {
        built += 1;
        statements.set(ids.queryId, { capture: null, placeholder: `<built-${built}>`, sessionId: ids.sessionId });
        return {
          seen: { ...base, capturePath: path, sql, servedBy: BUILT },
          response: builtAnswer(decided.built, ids.queryId, ids.sessionId, body),
        };
      }
      const exchange = loadDatabendCapture(decided.capture).exchanges[decided.index];
      const capturedSession = String((exchange.response.body as { session_id?: string }).session_id ?? "");
      if (decided.index < (ended.get(`${decided.capture} ${capturedSession}`) ?? -1)) {
        sessions.delete(ids.sessionId);
        return { seen: { ...base, capturePath: path, sql, servedBy: null }, response: null };
      }
      capturedSessions.set(ids.sessionId, capturedSession);
      const placeholder = String((exchange.response.body as { id?: string }).id ?? "");
      statements.set(ids.queryId, { capture: decided.capture, placeholder, sessionId: ids.sessionId });
      const servedBy = `${decided.capture}#${decided.index}`;
      return {
        seen: { ...base, capturePath: path, sql, servedBy },
        response: replayed(
          exchange,
          { placeholder, queryId: ids.queryId, sessionId: ids.sessionId },
          (body?.session as { settings?: unknown } | undefined)?.settings,
        ),
      };
    }

    if (path === "/v1/session/logout") {
      const capture = sessions.get(ids.sessionId);
      const found = capture === undefined || capture === BUILT ? undefined : followUp(capture, "POST", path);
      if (found === undefined) return { seen: { ...base, capturePath: path, servedBy: null }, response: null };
      const servedBy = `${capture}#${found.index}`;
      ended.set(`${capture} ${capturedSessions.get(ids.sessionId)}`, found.index);
      const response = replayed(found.exchange, { placeholder: "", queryId: "", sessionId: ids.sessionId }, undefined);
      return { seen: { ...base, capturePath: path, servedBy }, response };
    }

    const queryId = path.split("/")[3] ?? "";
    const statement = statements.get(queryId);
    const capturePath = statement === undefined ? path : path.replace(queryId, statement.placeholder);
    if (statement?.capture === null && path.endsWith("/final")) {
      return {
        seen: { ...base, capturePath, servedBy: BUILT },
        response: builtAnswer({ next_uri: null }, queryId, statement.sessionId, undefined),
      };
    }
    const found =
      statement?.capture === null || statement === undefined
        ? undefined
        : followUp(statement.capture, request.method, capturePath);
    if (statement === undefined || found === undefined) {
      return { seen: { ...base, capturePath, servedBy: null }, response: null };
    }
    const servedBy = `${statement.capture}#${found.index}`;
    return {
      seen: { ...base, capturePath, servedBy },
      response: replayed(
        found.exchange,
        { placeholder: statement.placeholder, queryId, sessionId: statement.sessionId },
        undefined,
      ),
    };
  };

  const factory = (options: NodeTransportOptions): NodeTransport => ({
    async request(request: NodeRequest): Promise<NodeResponse> {
      if (request.signal.aborted) throw abortFailure(request.signal);
      const answered = respond(request, { ...options.headers, ...request.headers });
      // A held request is answered by nothing: its exchange stays unserved.
      const seen = hold(answered.seen) ? { ...answered.seen, servedBy: HELD } : answered.seen;
      requests.push(seen);
      if (seen.servedBy === HELD) {
        return new Promise<NodeResponse>((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(abortFailure(request.signal)), { once: true });
        });
      }
      const { response } = answered;
      if (response === null) throw new Error(`No capture answers ${seen.method} ${seen.capturePath}`);
      if (seen.servedBy !== null && seen.servedBy !== BUILT) markServed(seen.servedBy);
      if (Buffer.byteLength(response.text) > request.maxResponseBytes) {
        throw new TransportError("too-large", "The response exceeded the limit for one response");
      }
      return response;
    },
    close() {},
  });

  return {
    factory,
    requests,
    served: () => [...served],
    unanswered: () =>
      requests
        .filter((request) => request.servedBy === null)
        .map((request) => `${request.method} ${request.capturePath}`),
  };
}
