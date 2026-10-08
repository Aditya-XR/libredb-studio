/**
 * The Databend evidence harness (design 9, D14): it runs the scenarios of tests/live/databend-evidence-plan.ts that
 * its target runs against the `databend-http` fixture of docker/databend/README.md over `node:http`, with no provider
 * import, and writes each scenario's exchanges as tests/fixtures/databend/<target>-<date>-<version>/<scenario>.json,
 * plus a manifest.json naming the Studio commit and the harness files it does not hold as run, the image, the server
 * version, the date and each scenario's result and time. The captures feed the transport tests and the replay;
 * tests/fixtures/databend/README.md describes them.
 *
 * Every exchange goes through the scrub of tests/helpers/databend-evidence-scrub.ts (C23): only allow-listed headers
 * and fields, placeholders for ids, IP addresses, user names and the tenant, and nothing at all written while any
 * file holds a secret form or the other names the scrub refuses. A scenario whose answers do not show what the plan
 * expects stops the run, and nothing is written either. The credentials are read from database-compose.yml and
 * docker/databend/fixture.jsonl, the files that set them.
 *
 * The harness writes nothing but temporary tables it created, which end with their client session, plus the `insert`
 * scenario's rows in `studio_demo.notes` of the local fixture, which docker/databend/seed.sh resets
 * (tests/unit/db/databend/live-environment.test.ts holds that). A query left running by a failed run is killed before
 * the run stops.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/), with the fixture up and seeded;
 * the unit test imports `runArguments` and `problems`, and the run starts only when this file is the entry point:
 *   bun tests/live/databend-evidence.ts --target local
 *   bun tests/live/databend-evidence.ts --target local --only insert,final-kill
 *
 * `--only <name>[,<name>...]` runs only the named scenarios of the target, in plan order, and writes them and a
 * manifest that lists only them into the same `<target>-<date>-v<version>/` directory. A name the target does not run
 * is refused before anything is sent, and a directory holding a file the run does not write is refused before
 * anything is written. A run that leaves `version` out still asks it first, for the manifest's server version, and
 * writes nothing of it.
 *
 * The Cloud target of plan section 7 runs `scenariosFor("cloud")` over HTTPS on 443 with the system trust store, the
 * tenant's warehouse in `x-databend-warehouse`, against the objects the Cloud setup put in `studio_demo`. Everything
 * it needs comes from the environment, never from a file of this repository: DATABEND_CLOUD_HOST, _PORT and
 * _WAREHOUSE, the `studio` pair DATABEND_CLOUD_STUDIO_USER and _PASSWORD, the `studio_reader` pair
 * DATABEND_CLOUD_RO_USER and _PASSWORD, and the `studio_scratch` pair DATABEND_CLOUD_SCRATCH_USER and _PASSWORD, whose
 * user (under no password policy) takes the one wrong password. The scrub is also given the host, the tenant (the
 * host's first label), the warehouse and the region (the host's third label), and refuses to write any of them;
 * the manifest names the region only as `<region>`:
 *   (set -a; . <the operator's env file>; set +a; bun tests/live/databend-evidence.ts --target cloud)
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  EvidenceLeakError,
  EvidenceScrubber,
  type EvidenceSecrets,
  type RawExchange,
  redactForTerminal,
  type ScrubbedExchange,
} from "../helpers/databend-evidence-scrub";
import {
  type EvidenceExpectation,
  type EvidencePrincipal,
  type EvidenceScenario,
  type EvidenceStep,
  type EvidenceTarget,
  scenariosFor,
  UNKNOWN_WAREHOUSE,
} from "./databend-evidence-plan";

const ROOT = path.resolve(import.meta.dirname, "../..");
const OUT = path.join(ROOT, "tests/fixtures/databend");
const CONTAINER = "libredb-databend-http";
const SEED_CONTAINER = "libredb-databend-http-seed";
const REQUEST_TIMEOUT_MS = 60_000;
/** Not the password of any user: the 401 capture's credential. */
const WRONG_PASSWORD = "Wrong123pass!";

function docker(args: readonly string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

/** The running fixture's image as `tag@digest`; a server not healthy, not pinned or not seeded stops the run. */
function pinnedImage(): string {
  const state = docker([
    "inspect",
    "--format",
    "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
    CONTAINER,
  ]);
  if (state !== "running healthy")
    throw new Error(`${CONTAINER} is "${state}", not "running healthy": bring it up as docker/databend/README.md says`);
  const seed = docker(["inspect", "--format", "{{.State.Status}} {{.State.ExitCode}}", SEED_CONTAINER]);
  if (seed !== "exited 0") throw new Error(`${SEED_CONTAINER} is "${seed}", not "exited 0": seed the fixture first`);
  const image = docker(["inspect", "--format", "{{.Config.Image}}", CONTAINER]);
  if (!/:[^@/]+@sha256:[0-9a-f]{64}$/.test(image)) throw new Error(`${CONTAINER} runs ${image}, not a tag@digest`);
  return image;
}

function studioCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
}

/** What a capture depends on besides the server: the compose file, the fixture, the plan, the scrub and this file. */
const HARNESS_PATHS = [
  "database-compose.yml",
  "docker/databend/",
  "tests/helpers/databend-evidence-scrub.ts",
  "tests/live/databend-evidence-plan.ts",
  "tests/live/databend-evidence.ts",
];

/**
 * The harness files that differ from the Studio commit or are not in it, so the manifest never names a commit as the
 * source of captures that commit cannot reproduce. An empty list means the commit alone reproduces the run.
 */
function uncommitted(): string[] {
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all", "--", ...HARNESS_PATHS], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return status
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3))
    .sort();
}

// -- the targets --------------------------------------------------------------------------------------------------

interface Credential {
  readonly user: string;
  readonly password: string;
}

/** Where the requests go, as whom, and what the scrub must never let through. */
interface Endpoint {
  readonly tls: boolean;
  readonly host: string;
  readonly port: number;
  readonly warehouse: string | undefined;
  readonly credentials: Readonly<Record<EvidencePrincipal, Credential>>;
  readonly secrets: EvidenceSecrets;
  /** What the manifest says ran the server. */
  readonly image: string;
  readonly region?: string;
}

function localEndpoint(): Endpoint {
  const credentials = readCredentials();
  return {
    tls: false,
    host: "127.0.0.1",
    port: 8000,
    warehouse: undefined,
    credentials,
    secrets: { users: [credentials.default, credentials.reader, credentials.wrong] },
    image: pinnedImage(),
  };
}

function environment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set: source the operator's env file first`);
  return value;
}

function cloudEndpoint(): Endpoint {
  const host = environment("DATABEND_CLOUD_HOST");
  const labels = host.split(".");
  if (labels.length !== 6 || labels[1] !== "gw" || !host.endsWith(".default.databend.com"))
    throw new Error(
      "DATABEND_CLOUD_HOST is not a Databend Cloud gateway host <tenant>.gw.<region>.default.databend.com",
    );
  const studio = {
    user: environment("DATABEND_CLOUD_STUDIO_USER"),
    password: environment("DATABEND_CLOUD_STUDIO_PASSWORD"),
  };
  const reader = { user: environment("DATABEND_CLOUD_RO_USER"), password: environment("DATABEND_CLOUD_RO_PASSWORD") };
  const scratch = {
    user: environment("DATABEND_CLOUD_SCRATCH_USER"),
    password: environment("DATABEND_CLOUD_SCRATCH_PASSWORD"),
  };
  const wrong = { user: scratch.user, password: WRONG_PASSWORD };
  const others = ["DATABEND_CLOUD_USER", "DATABEND_CLOUD_PASSWORD"].every((name) => process.env[name])
    ? [{ user: environment("DATABEND_CLOUD_USER"), password: environment("DATABEND_CLOUD_PASSWORD") }]
    : [];
  const warehouse = environment("DATABEND_CLOUD_WAREHOUSE");
  return {
    tls: true,
    host,
    port: Number(process.env.DATABEND_CLOUD_PORT ?? "443"),
    warehouse,
    credentials: { default: studio, reader, wrong },
    secrets: {
      users: [studio, reader, wrong, scratch, ...others],
      host,
      tenant: labels[0],
      warehouse,
      region: labels[2],
    },
    image: "Databend Cloud",
    region: "<region>",
  };
}

function readCredentials(): Readonly<Record<EvidencePrincipal, Credential>> {
  const compose = parseYaml(readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"), { merge: true }) as {
    services: Record<string, { environment?: Record<string, string> }>;
  };
  const environment = compose.services["databend-http"]?.environment ?? {};
  const user = environment.QUERY_DEFAULT_USER;
  const password = environment.QUERY_DEFAULT_PASSWORD;
  if (user === undefined || password === undefined) throw new Error("databend-http sets no default user");
  const fixture = readFileSync(path.join(ROOT, "docker/databend/fixture.jsonl"), "utf8");
  const reader = /USER studio_reader IDENTIFIED BY '([^']+)'/.exec(fixture)?.[1];
  if (reader === undefined) throw new Error("fixture.jsonl creates no studio_reader");
  return {
    default: { user, password },
    reader: { user: "studio_reader", password: reader },
    wrong: { user, password: WRONG_PASSWORD },
  };
}

// -- requests -----------------------------------------------------------------------------------------------------

interface Sent {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function send(
  endpoint: Endpoint,
  method: "GET" | "POST",
  target: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<Sent> {
  const text = payload === undefined ? undefined : JSON.stringify(payload);
  const all = { ...headers, ...(text === undefined ? {} : { "content-length": String(Buffer.byteLength(text)) }) };
  // Over TLS the system trust store verifies the gateway's certificate against the host, as verify-system does.
  const client = endpoint.tls ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      {
        host: endpoint.host,
        port: endpoint.port,
        method,
        path: target,
        headers: all,
        timeout: REQUEST_TIMEOUT_MS,
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const received: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers))
            if (value !== undefined) received[name] = Array.isArray(value) ? value.join(", ") : value;
          resolve({
            status: response.statusCode ?? 0,
            headers: received,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error(`${method} ${target} did not answer in ${REQUEST_TIMEOUT_MS} ms`)),
    );
    request.on("error", reject);
    if (text !== undefined) request.write(text);
    request.end();
  });
}

export interface Answer {
  readonly id?: string;
  readonly state?: string;
  readonly session?: Record<string, unknown> & { txn_state?: string; need_keep_alive?: boolean };
  readonly error?: { code?: number; kind?: string; message?: string } | null;
  readonly has_result_set?: boolean;
  readonly data?: unknown[];
  readonly next_uri?: string | null;
  readonly final_uri?: string | null;
  readonly kill_uri?: string | null;
}

function parsed(body: string): Answer {
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === "object" && value !== null ? (value as Answer) : {};
  } catch {
    return {};
  }
}

/**
 * The session a query carries after an exchange: the newest one an answer held, as BendSQL's `handle_session` keeps
 * its state when an answer has none (the last page of a statement answers `session: null`, which keeps the one before
 * it). A logout ends the client, and BendSQL sends nothing after it, so a statement the plan sends after one carries
 * no session, as a new client of the same session id would.
 */
export function carriedSession(
  current: Answer["session"],
  step: EvidenceStep["kind"],
  answer: Answer,
): Answer["session"] {
  return step === "logout" ? undefined : (answer.session ?? current);
}

export interface Exchange {
  readonly raw: RawExchange;
  readonly answer: Answer;
  readonly step: EvidenceStep["kind"];
}

/** Runs one scenario's steps in order, every request with the scenario's principal and client session. */
async function runScenario(endpoint: Endpoint, scenario: EvidenceScenario): Promise<Exchange[]> {
  const credential = endpoint.credentials[scenario.principal];
  const headers: Record<string, string> = {
    authorization: `Basic ${Buffer.from(`${credential.user}:${credential.password}`).toString("base64")}`,
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": "libredb-studio-evidence",
  };
  const warehouse = scenario.warehouse === "unknown" ? UNKNOWN_WAREHOUSE : endpoint.warehouse;
  if (warehouse !== undefined && scenario.warehouse !== "omit") headers["x-databend-warehouse"] = warehouse;
  if (scenario.clientSession) {
    headers["x-databend-client-caps"] = "session_header";
    headers["x-databend-session"] = Buffer.from(
      JSON.stringify({ id: randomUUID(), last_refresh_time: Math.floor(Date.now() / 1000) }),
    )
      // URL-safe base64 with its `=` padding, which Databend requires and Node's base64url leaves out.
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
  }
  const exchanges: Exchange[] = [];
  let last: Answer = {};
  let session: Answer["session"];
  const exchange = async (kind: EvidenceStep["kind"], method: "GET" | "POST", target: string, body?: unknown) => {
    const sent = await send(endpoint, method, target, headers, body);
    const answer = parsed(sent.body);
    exchanges.push({
      raw: {
        request: { method, path: target, headers: { ...headers }, ...(body === undefined ? {} : { body }) },
        response: { status: sent.status, headers: sent.headers, body: sent.body },
      },
      answer,
      step: kind,
    });
    if (sent.headers["x-databend-session"] !== undefined)
      headers["x-databend-session"] = sent.headers["x-databend-session"];
    session = carriedSession(session, kind, answer);
    return answer;
  };
  try {
    for (const step of scenario.steps) {
      switch (step.kind) {
        case "query": {
          const payload = { sql: step.sql, pagination: step.pagination, session: session ?? step.session };
          // oxlint-disable-next-line no-await-in-loop -- one request at a time, in plan order.
          last = await exchange("query", "POST", "/v1/query", payload);
          break;
        }
        case "pages":
          while (typeof last.next_uri === "string") {
            // oxlint-disable-next-line no-await-in-loop -- each page names the next.
            const page = await exchange("pages", "GET", last.next_uri);
            if (last.next_uri === last.final_uri) break;
            last = page;
          }
          break;
        case "next":
          if (typeof last.next_uri !== "string") throw new Error(`${scenario.name}: no next_uri to follow`);
          // oxlint-disable-next-line no-await-in-loop -- in plan order.
          await exchange("next", "GET", last.next_uri);
          break;
        case "final":
        case "kill": {
          const link = step.kind === "final" ? last.final_uri : last.kill_uri;
          if (typeof link !== "string") throw new Error(`${scenario.name}: no ${step.kind}_uri to follow`);
          // oxlint-disable-next-line no-await-in-loop -- in plan order.
          await exchange(step.kind, "GET", link);
          break;
        }
        case "logout":
          // oxlint-disable-next-line no-await-in-loop -- in plan order.
          await exchange("logout", "POST", "/v1/session/logout", {});
          break;
      }
    }
  } catch (error) {
    // A failed scenario leaves no query running on the fixture.
    if (typeof last.kill_uri === "string" && last.state === "Running")
      await send(endpoint, "GET", last.kill_uri, headers, undefined).catch(() => undefined);
    throw error;
  }
  return exchanges;
}

/** What the scenario's answers show that the plan does not expect, as one problem per fact. */
export function problems(expect: EvidenceExpectation, exchanges: readonly Exchange[]): string[] {
  const first = exchanges[0];
  const queries = exchanges.filter((exchange) => exchange.step === "query");
  const lastAnswer = exchanges[exchanges.length - 1]?.answer;
  const rowsOf = (exchange: Exchange) => (Array.isArray(exchange.answer.data) ? exchange.answer.data.length : 0);
  const echoed = (first?.answer.session?.settings ?? {}) as Record<string, unknown>;
  const facts: [string, unknown, unknown][] = [
    ["status", expect.status, first?.raw.response.status],
    ["state", expect.state, first?.answer.state],
    ["code", expect.code, first?.answer.error?.code],
    ["kind", expect.kind, first?.answer.error?.kind],
    ["need_keep_alive", expect.needKeepAlive, first?.answer.session?.need_keep_alive],
    ["has_result_set", expect.hasResultSet, first?.answer.has_result_set],
    ["rows", expect.rows, exchanges.reduce((sum, exchange) => sum + rowsOf(exchange), 0)],
    ["last code", expect.lastCode, lastAnswer?.error?.code],
    ["txn_state", expect.txnStates?.join(","), queries.map((exchange) => exchange.answer.session?.txn_state).join(",")],
    ["statuses", expect.statuses?.join(","), exchanges.map((exchange) => exchange.raw.response.status).join(",")],
  ];
  const found = facts
    .filter(([, want, saw]) => want !== undefined && want !== saw)
    .map(([name, want, saw]) => `${name} ${JSON.stringify(saw)}, expected ${JSON.stringify(want)}`);
  if (expect.message !== undefined && !(first?.answer.error?.message ?? "").includes(expect.message))
    found.push(`the error message does not hold ${JSON.stringify(expect.message)}`);
  const pages = exchanges.filter((exchange) => rowsOf(exchange) > 0).length;
  if (expect.pagesWithRows !== undefined && pages < expect.pagesWithRows)
    found.push(`${pages} answers carry rows, expected at least ${expect.pagesWithRows}`);
  for (const [name, value] of Object.entries(expect.echoes ?? {}))
    if (echoed[name] !== value) found.push(`the session echoes ${name}=${JSON.stringify(echoed[name])}`);
  for (const name of expect.drops ?? []) if (name in echoed) found.push(`the session echoes ${name}`);
  return found;
}

interface ScenarioResult {
  readonly name: string;
  readonly result: "pass";
  readonly ms: number;
  readonly exchanges: number;
}

const USAGE = "usage: bun tests/live/databend-evidence.ts --target local|cloud [--only <name>[,<name>...]]";

/** The scenario whose `SELECT version()` the manifest names as the server version. */
const VERSION_SCENARIO = "version";

export interface EvidenceRun {
  readonly target: EvidenceTarget;
  readonly scenarios: readonly EvidenceScenario[];
}

/**
 * The target and the scenarios a run asks: every scenario of `--target`, or only those `--only` names, in plan order.
 * A name the target does not run is refused before anything is sent.
 */
export function runArguments(argv: readonly string[]): EvidenceRun {
  const target = argv[argv.indexOf("--target") + 1] as EvidenceTarget | undefined;
  if (!argv.includes("--target") || (target !== "local" && target !== "cloud")) throw new Error(USAGE);
  const scenarios = scenariosFor(target);
  if (!argv.includes("--only")) return { target, scenarios };
  const only = argv[argv.indexOf("--only") + 1];
  if (only === undefined) throw new Error(USAGE);
  const names = only.split(",");
  const unknown = names.filter((name) => !scenarios.some((scenario) => scenario.name === name));
  if (unknown.length > 0) {
    const listed = unknown.map((name) => JSON.stringify(name)).join(", ");
    const runs = scenarios.map((scenario) => scenario.name).join(", ");
    throw new Error(`--only names ${listed}, which the ${target} target does not run; it runs ${runs}`);
  }
  return { target, scenarios: scenarios.filter((scenario) => names.includes(scenario.name)) };
}

/** What a line on the terminal may not show, once the endpoint is known: a DNS or TLS error names the host. */
let printed: EvidenceSecrets | undefined;

async function main(argv: readonly string[]): Promise<number> {
  const { target, scenarios } = runArguments(argv);
  const endpoint = target === "cloud" ? cloudEndpoint() : localEndpoint();
  printed = endpoint.secrets;
  const scrubber = new EvidenceScrubber(endpoint.secrets);
  const date = new Date().toISOString().slice(0, 10);

  const files: Record<string, unknown> = {};
  const results: ScenarioResult[] = [];
  let version: string | undefined;
  let serverVersion: unknown;
  // A run that leaves `version` out asks it all the same, first as the plan does, for the manifest; none of it is
  // scrubbed or written, so the placeholders of the files start where they would without it.
  const probe: readonly EvidenceScenario[] = scenarios.some((scenario) => scenario.name === VERSION_SCENARIO)
    ? []
    : scenariosFor(target).filter((scenario) => scenario.name === VERSION_SCENARIO);
  for (const scenario of [...probe, ...scenarios]) {
    const started = performance.now();
    // oxlint-disable-next-line no-await-in-loop -- one scenario at a time, so timings and sessions do not overlap.
    const exchanges = await runScenario(endpoint, scenario);
    const ms = Math.round(performance.now() - started);
    const found = problems(scenario.expect, exchanges);
    if (found.length > 0) throw new Error(`${scenario.name}: ${found.join("; ")}: nothing written`);
    if (exchanges[0]?.raw.response.status === 200) version ??= exchanges[0]?.raw.response.headers["x-databend-version"];
    if (scenario.name === VERSION_SCENARIO) {
      const [row] = (exchanges[0]?.answer.data ?? []) as unknown[][];
      serverVersion = row?.[0];
    }
    if (probe.includes(scenario)) {
      console.error(`asked ${scenario.name} for the manifest, not written (${exchanges.length} exchanges, ${ms} ms)`);
      continue;
    }
    const scrubbed: (ScrubbedExchange & { step: EvidenceStep["kind"] })[] = exchanges.map((exchange) => {
      const { request, response } = scrubber.exchange(exchange.raw);
      return { step: exchange.step, request, response };
    });
    files[`${scenario.name}.json`] = {
      scenario: scenario.name,
      principal: scenario.principal,
      clientSession: scenario.clientSession,
      exchanges: scrubbed,
    };
    results.push({ name: scenario.name, result: "pass", ms, exchanges: exchanges.length });
    console.error(`pass ${scenario.name} (${exchanges.length} exchanges, ${ms} ms)`);
  }
  if (version === undefined) throw new Error("no answer carried x-databend-version");
  if (typeof serverVersion !== "string") throw new Error("SELECT version() answered no version");
  files["manifest.json"] = {
    target,
    studioCommit: studioCommit(),
    uncommitted: uncommitted(),
    image: endpoint.image,
    ...(endpoint.region === undefined ? {} : { region: endpoint.region }),
    serverVersion,
    capturedAt: date,
    scenarios: results,
  };

  const rendered = scrubber.render(files);
  const directory = path.join(OUT, `${target}-${date}-v${version}`);
  // A file this run does not write would stay beside a manifest that does not name it, as after an --only run into
  // the directory of a full one.
  const stray = existsSync(directory) ? readdirSync(directory).filter((name) => !Object.hasOwn(rendered, name)) : [];
  if (stray.length > 0)
    throw new Error(
      `${path.relative(ROOT, directory)} holds ${stray.join(", ")}, which this run does not write: nothing written`,
    );
  mkdirSync(directory, { recursive: true });
  for (const [name, text] of Object.entries(rendered)) writeFileSync(path.join(directory, name), text);
  console.error(`wrote ${Object.keys(rendered).length} files under ${path.relative(ROOT, directory)}`);
  return 0;
}

// The run starts only when this file is the process's entry point: the unit test imports its checks.
if (import.meta.main)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      const text = error instanceof Error ? (error.stack ?? error.message) : String(error);
      console.error(printed === undefined ? text : redactForTerminal(text, printed));
      // The scrub's findings name a file and a label, never the value.
      if (error instanceof EvidenceLeakError) for (const finding of error.findings) console.error(`  ${finding}`);
      process.exit(1);
    },
  );
