/**
 * The scenario plan of the Databend evidence harness (design 9, D14): every request tests/live/databend-evidence.ts
 * sends to the `databend-http` fixture of docker/databend/README.md, built here and nowhere else, so a unit test can
 * read the whole list (tests/unit/db/databend/live-environment.test.ts). Pure: no I/O and no import.
 *
 * Each scenario is one capture, tests/fixtures/databend/<target>-<date>-<version>/<name>.json, holding every exchange
 * of its steps in order. A `query` step posts to /v1/query, carrying the newest `session` object an answer of the
 * scenario held, as a driver does (a statement's last page answers `session: null`, which keeps the one before it);
 * the other steps follow a link of the last answer (`pages` every `next_uri` until there is none, `next` one, `final`,
 * `kill`) or end the client session (`logout`). A scenario with `clientSession` sends
 * `x-databend-client-caps: session_header` and its own `x-databend-session` on every request.
 *
 * The plan writes nothing but temporary tables it created, each in its own client session and gone with it, plus the
 * `insert` scenario's rows in `studio_demo.notes` of the local fixture, which docker/databend/seed.sh resets; the
 * live-environment test holds that rule. `expect` is what the scenario's answers must show, checked before anything is
 * written.
 *
 * The Cloud target of plan section 7 runs the same list through `scenariosFor("cloud")`: the tenant has no
 * `libredb_demo`, so every name of it reads `studio_demo`, where the Cloud setup put the fixture's objects; a scenario
 * with `targets` runs only on those, so `insert` and `final-kill` run locally only; and `cloudExpect`, where a
 * scenario has one, replaces `expect`, since the gateway wraps a refusal in an envelope of its own (I19). `warehouse`
 * says what a Cloud scenario sends as `x-databend-warehouse` instead of the tenant's warehouse: nothing, or a name the
 * tenant does not have.
 */

/** `default` is the server's default user, `reader` the least-privilege `studio_reader`, `wrong` a bad password. */
export type EvidencePrincipal = "default" | "reader" | "wrong";

/** The local `databend-http` fixture, or the Databend Cloud tenant of plan section 7. */
export type EvidenceTarget = "local" | "cloud";

export interface EvidencePagination {
  readonly wait_time_secs: number;
  readonly max_rows_per_page?: number;
}

export type EvidenceStep =
  | {
      readonly kind: "query";
      readonly sql: string;
      readonly pagination?: EvidencePagination;
      /** The first request's `session`; later requests carry the newest one an answer held. */
      readonly session?: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "pages" | "next" | "final" | "kill" | "logout" };

/** What the scenario's exchanges must show; every field names one fact a transport or replay test reads. */
export interface EvidenceExpectation {
  /** The status of the first exchange. */
  readonly status?: number;
  /** The error code of the first answer, in-body or not. */
  readonly code?: number;
  /** The Databend Cloud gateway's kind of the first answer, nested under `error` (I19). */
  readonly kind?: string;
  /** Text the first answer's error message holds. */
  readonly message?: string;
  /** The `txn_state` of each query step's first answer, in order. */
  readonly txnStates?: readonly string[];
  /** The first answer's `session.need_keep_alive`. */
  readonly needKeepAlive?: boolean;
  /** The first answer's `has_result_set`. */
  readonly hasResultSet?: boolean;
  /** At least this many answers of the scenario carry rows. */
  readonly pagesWithRows?: number;
  /** The rows across the scenario's answers. */
  readonly rows?: number;
  /** The first answer's `state`. */
  readonly state?: string;
  /** The error code of the last exchange's answer. */
  readonly lastCode?: number;
  /** The status of every exchange, in order. */
  readonly statuses?: readonly number[];
  /** Settings the first answer's `session.settings` echo, and names it must not echo. */
  readonly echoes?: Readonly<Record<string, string>>;
  readonly drops?: readonly string[];
}

export interface EvidenceScenario {
  readonly name: string;
  readonly principal: EvidencePrincipal;
  readonly clientSession: boolean;
  readonly steps: readonly EvidenceStep[];
  readonly expect: EvidenceExpectation;
  /** The targets the scenario runs on; every target when absent. */
  readonly targets?: readonly EvidenceTarget[];
  /** What the Cloud gateway's answers show instead of `expect`. */
  readonly cloudExpect?: EvidenceExpectation;
  /** On Cloud: send no `x-databend-warehouse`, or a warehouse the tenant does not have, instead of its own. */
  readonly warehouse?: "omit" | "unknown";
}

/** The database the fixture reads locally, and where the Cloud setup of plan section 7 put the same objects. */
const LOCAL_DEMO = "libredb_demo";
export const CLOUD_DEMO_DATABASE = "studio_demo";
/** A warehouse no tenant is given: Cloud warehouse names are chosen by their owner, and this one is the harness's. */
export const UNKNOWN_WAREHOUSE = "studio_no_such_wh";

const WAIT = { wait_time_secs: 10 } as const;
const PAGED = { wait_time_secs: 10, max_rows_per_page: 10 } as const;

/** A query that runs for minutes on the fixture's two CPUs, so it is still running when the kill is sent. */
const LONG_QUERY = "SELECT count(*) FROM numbers(100000000000) WHERE number % 7 = 3";

export const EVIDENCE_SCENARIOS: readonly EvidenceScenario[] = [
  {
    name: "version",
    principal: "default",
    clientSession: false,
    steps: [{ kind: "query", sql: "SELECT version()", pagination: WAIT }, { kind: "pages" }],
    expect: { status: 200, state: "Succeeded", rows: 1 },
  },
  {
    name: "select-pages",
    principal: "default",
    clientSession: false,
    steps: [
      {
        kind: "query",
        sql: "SELECT number, to_string(number) AS text FROM numbers(25) ORDER BY number",
        pagination: PAGED,
      },
      { kind: "pages" },
    ],
    expect: { status: 200, pagesWithRows: 3, rows: 25 },
  },
  {
    name: "every-type",
    principal: "default",
    clientSession: false,
    steps: [
      { kind: "query", sql: "SELECT * FROM libredb_demo.every_type ORDER BY id", pagination: WAIT },
      { kind: "pages" },
    ],
    expect: { status: 200, state: "Succeeded", rows: 4 },
  },
  {
    name: "show-create-every-type",
    principal: "default",
    clientSession: false,
    steps: [{ kind: "query", sql: "SHOW CREATE TABLE libredb_demo.every_type", pagination: WAIT }, { kind: "pages" }],
    expect: { status: 200, state: "Succeeded", rows: 1 },
  },
  {
    name: "show-create-materialized-view",
    principal: "default",
    clientSession: false,
    steps: [
      { kind: "query", sql: "SHOW CREATE MATERIALIZED VIEW libredb_demo.every_type_mv", pagination: WAIT },
      { kind: "pages" },
    ],
    expect: { status: 200, state: "Succeeded", rows: 1 },
  },
  {
    name: "ddl",
    principal: "default",
    clientSession: true,
    steps: [
      { kind: "query", sql: "CREATE TEMP TABLE ev_ddl (a INT, b VARCHAR)", pagination: WAIT },
      { kind: "pages" },
      { kind: "logout" },
    ],
    expect: { status: 200, state: "Succeeded", hasResultSet: false, needKeepAlive: true },
  },
  {
    name: "dml",
    principal: "default",
    clientSession: true,
    steps: [
      { kind: "query", sql: "CREATE TEMP TABLE ev_dml (a INT)", pagination: WAIT },
      { kind: "pages" },
      { kind: "query", sql: "INSERT INTO ev_dml VALUES (1), (2), (3)", pagination: WAIT },
      { kind: "pages" },
      { kind: "logout" },
    ],
    expect: { status: 200, state: "Succeeded", rows: 1 },
  },
  {
    name: "temp-table-logout",
    principal: "default",
    clientSession: true,
    steps: [
      { kind: "query", sql: "CREATE TEMP TABLE ev_temp (a INT)", pagination: WAIT },
      { kind: "pages" },
      { kind: "query", sql: "INSERT INTO ev_temp VALUES (42)", pagination: WAIT },
      { kind: "pages" },
      { kind: "logout" },
      { kind: "query", sql: "SELECT a FROM ev_temp", pagination: WAIT },
    ],
    expect: { status: 200, needKeepAlive: true, lastCode: 1025 },
  },
  {
    name: "begin",
    principal: "default",
    clientSession: true,
    steps: [
      { kind: "query", sql: "BEGIN", pagination: WAIT },
      { kind: "pages" },
      { kind: "query", sql: "ROLLBACK", pagination: WAIT },
      { kind: "pages" },
      { kind: "logout" },
    ],
    expect: { status: 200, txnStates: ["Active", "AutoCommit"] },
  },
  {
    name: "session-echo",
    principal: "default",
    clientSession: true,
    steps: [
      {
        kind: "query",
        sql: "SELECT current_database(), now()",
        pagination: WAIT,
        session: {
          database: "libredb_demo",
          settings: { http_json_result_mode: "display", timezone: "Europe/Istanbul", no_such_setting: "1" },
        },
      },
      { kind: "pages" },
      { kind: "logout" },
    ],
    expect: {
      status: 200,
      state: "Succeeded",
      echoes: { http_json_result_mode: "display", timezone: "Europe/Istanbul" },
      drops: ["no_such_setting"],
    },
  },
  {
    name: "error-position",
    principal: "default",
    clientSession: false,
    steps: [{ kind: "query", sql: "SELECT * FRM libredb_demo.every_type", pagination: WAIT }, { kind: "pages" }],
    expect: { status: 200, state: "Failed", code: 1005, message: "--> SQL:1:10" },
  },
  {
    name: "auth-401",
    principal: "wrong",
    clientSession: false,
    steps: [{ kind: "query", sql: "SELECT 1", pagination: WAIT }],
    expect: { status: 401, code: 5100 },
    // The gateway's envelope wraps the query node's own 401 and its 5100 in the message (I19).
    cloudExpect: { status: 401, kind: "AuthorizationFailed", message: "5100" },
  },
  {
    name: "kill",
    principal: "default",
    clientSession: false,
    steps: [{ kind: "query", sql: LONG_QUERY, pagination: { wait_time_secs: 1 } }, { kind: "kill" }, { kind: "next" }],
    expect: { status: 200, state: "Running" },
  },
  {
    name: "final",
    principal: "default",
    clientSession: false,
    steps: [
      { kind: "query", sql: "SELECT number FROM numbers(25) ORDER BY number", pagination: PAGED },
      { kind: "final" },
      { kind: "next" },
    ],
    expect: { status: 200, state: "Running", pagesWithRows: 1 },
  },
  {
    name: "reader",
    principal: "reader",
    clientSession: false,
    steps: [
      {
        kind: "query",
        sql: "SELECT current_user(), current_role(), count(*) FROM libredb_demo.every_type",
        pagination: WAIT,
      },
      { kind: "pages" },
    ],
    expect: { status: 200, state: "Succeeded", rows: 1 },
  },
  {
    // An INSERT into a table that outlives the session, so its answer needs no keep-alive and no logout follows.
    // Local only: seed.sh resets `studio_demo.notes` on the local fixture, and nothing resets it on Cloud.
    name: "insert",
    principal: "default",
    clientSession: true,
    targets: ["local"],
    steps: [
      {
        kind: "query",
        sql: "INSERT INTO studio_demo.notes VALUES (3, 'third'), (4, 'fourth'), (5, 'fifth')",
        pagination: WAIT,
      },
      { kind: "pages" },
    ],
    expect: { status: 200, state: "Succeeded", rows: 1, needKeepAlive: false },
  },
  {
    // `final`, then the kill that follows the 400 of the page after the final, as the replay sends it.
    name: "final-kill",
    principal: "default",
    clientSession: false,
    targets: ["local"],
    steps: [
      { kind: "query", sql: "SELECT number FROM numbers(25) ORDER BY number", pagination: PAGED },
      { kind: "final" },
      { kind: "next" },
      { kind: "kill" },
    ],
    expect: { status: 200, state: "Running", rows: 10, statuses: [200, 200, 400, 200] },
  },
  {
    name: "no-warehouse",
    principal: "default",
    clientSession: false,
    targets: ["cloud"],
    warehouse: "omit",
    steps: [{ kind: "query", sql: "SELECT 1", pagination: WAIT }],
    expect: { status: 400, kind: "WarehouseHeaderRequired" },
  },
  {
    name: "unknown-warehouse",
    principal: "default",
    clientSession: false,
    targets: ["cloud"],
    warehouse: "unknown",
    steps: [{ kind: "query", sql: "SELECT 1", pagination: WAIT }],
    expect: { status: 400, kind: "BadWarehouse" },
  },
  {
    name: "forbidden",
    principal: "default",
    clientSession: false,
    targets: ["cloud"],
    steps: [{ kind: "query", sql: "SHOW WAREHOUSES", pagination: WAIT }],
    expect: { status: 403, kind: "ForbiddenAccessUser" },
  },
];

function onCloud(text: string): string {
  return text.replace(new RegExp(`\\b${LOCAL_DEMO}\\b`, "g"), CLOUD_DEMO_DATABASE);
}

/** The scenarios that run on `target`, as that target runs them. */
export function scenariosFor(target: EvidenceTarget): readonly EvidenceScenario[] {
  const runs = EVIDENCE_SCENARIOS.filter((scenario) => scenario.targets?.includes(target) ?? true);
  if (target === "local") return runs;
  return runs.map((scenario) => {
    // A scenario is plain JSON, so a copy through its text renames the database in every statement and session.
    const copy = JSON.parse(onCloud(JSON.stringify(scenario))) as EvidenceScenario;
    return Object.assign(copy, { expect: scenario.cloudExpect ?? scenario.expect });
  });
}
