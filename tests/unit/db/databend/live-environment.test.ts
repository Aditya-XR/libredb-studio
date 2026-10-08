/**
 * The live Databend fixture in `database-compose.yml` and the files of `docker/databend`, held to the rules of the
 * Databend delivery plan (section 5, D14, K 13).
 *
 * `databend-http` is pinned by tag and digest, because a capture is a claim about one server build; its port is on
 * 127.0.0.1, because its credentials are throwaway; it is bounded, and a plain `up` starts it with no profile. The
 * seed `databend-http-seed` is a one-shot in the same image that runs docker/databend/seed.sh over
 * docker/databend/fixture.jsonl, mounted read-only. The compat `databend` service, the mysql provider's MySQL-wire
 * probe, is left exactly as it was.
 *
 * The fixture writes only the two databases the live tools read, `libredb_demo` and `studio_demo`, plus the
 * least-privilege role `studio_ro` and its one user `studio_reader`, which holds that role and nothing else (agent
 * plan mode refuses a superuser).
 *
 * The write-surface block holds tests/live/databend-*.ts: only `databend-live-check.ts` and the evidence plan write.
 * The live check writes only to `studio_demo` and `libredb_demo`, besides its own scratch user and that user's
 * password policy (S7); the evidence plan writes nothing but temporary tables it created, plus the `insert` scenario's
 * rows in `studio_demo.notes` of the local fixture, which seed.sh resets; every other file names no write.
 *
 * The evidence harness's run arguments and expectation checks are held too, and the last block holds the captures
 * the replay reads to the plan: each was sent as the plan's local scenario of its name sends it, and shows what that
 * scenario expects. Every local capture also renders again through the evidence scrub with the fixture's secrets,
 * refused nowhere and written back unchanged.
 *
 * Each rule is a pure function from the parsed fixtures to a list of findings, so it is proven both ways: the real
 * tree gives none, and a planted copy with one fault gives the finding that names it.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { parse as parseYaml } from "yaml";
import { EvidenceLeakError, EvidenceScrubber, type EvidenceSecrets } from "../../../helpers/databend-evidence-scrub";
import {
  DATABEND_CAPTURE_RUNS,
  type DatabendCapture,
  databendCaptureFiles,
  loadDatabendCapture,
} from "../../../helpers/databend-fixtures";
import { carriedSession, type Exchange, problems, runArguments } from "../../../live/databend-evidence";
import {
  CLOUD_DEMO_DATABASE,
  EVIDENCE_SCENARIOS,
  type EvidenceScenario,
  scenariosFor,
} from "../../../live/databend-evidence-plan";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DATABEND_DIR = path.join(ROOT, "docker/databend");
const LIVE_DIR = path.join(ROOT, "tests/live");
const CAPTURES_DIR = path.join(ROOT, "tests/fixtures/databend");

interface ComposeLimits {
  readonly cpus?: string;
  readonly memory?: string;
}

interface ComposeService {
  readonly image?: string;
  readonly container_name?: string;
  readonly profiles?: readonly string[];
  readonly restart?: string;
  readonly entrypoint?: readonly string[];
  readonly ports?: readonly string[];
  readonly volumes?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly ulimits?: unknown;
  readonly healthcheck?: { readonly test?: readonly string[]; readonly start_period?: string };
  readonly depends_on?: Readonly<Record<string, { readonly condition: string }>>;
  readonly deploy?: { readonly resources?: { readonly limits?: ComposeLimits } };
  readonly memswap_limit?: string;
}

interface DatabendFixtures {
  /** The services whose name starts with "databend". */
  readonly services: Readonly<Record<string, ComposeService>>;
  /** docker/databend/<name> to its text. */
  readonly files: Readonly<Record<string, string>>;
  /** tests/live/databend-*.ts by file name. */
  readonly live: Readonly<Record<string, string>>;
  readonly scenarios: readonly EvidenceScenario[];
  /** The captures the replay reads, every file of every run of `DATABEND_CAPTURE_RUNS`. */
  readonly captures: readonly DatabendCapture[];
  /** Every committed capture run under tests/fixtures/databend: its directory to each file's name and text. */
  readonly runs: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

function loadFixtures(): DatabendFixtures {
  // `merge: true` because the file shares settings through `<<:` merge keys.
  const compose = parseYaml(readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"), { merge: true }) as {
    readonly services: Readonly<Record<string, ComposeService>>;
  };
  const services = Object.fromEntries(Object.entries(compose.services).filter(([name]) => name.startsWith("databend")));
  const files = Object.fromEntries(
    readdirSync(DATABEND_DIR).map((name) => [name, readFileSync(path.join(DATABEND_DIR, name), "utf8")]),
  );
  const live = Object.fromEntries(
    readdirSync(LIVE_DIR)
      .filter((name) => name.startsWith("databend-") && name.endsWith(".ts"))
      .map((name) => [name, readFileSync(path.join(LIVE_DIR, name), "utf8")]),
  );
  const captures = DATABEND_CAPTURE_RUNS.flatMap((run) => databendCaptureFiles(run)).map(loadDatabendCapture);
  const runs = Object.fromEntries(
    readdirSync(CAPTURES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const directory = path.join(CAPTURES_DIR, entry.name);
        const texts = readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]);
        return [entry.name, Object.fromEntries(texts)];
      }),
  );
  return { services, files, live, scenarios: EVIDENCE_SCENARIOS, captures, runs };
}

/** A deep copy with one change, for the planted half of each rule. */
function planted(fixtures: DatabendFixtures, change: (draft: Mutable<DatabendFixtures>) => void): DatabendFixtures {
  const draft = structuredClone(fixtures) as Mutable<DatabendFixtures>;
  change(draft);
  return draft;
}

/** The draft's scenario `name`; a plan without it fails the planting rather than planting nothing. */
function draftScenario(draft: Mutable<DatabendFixtures>, name: string): Mutable<EvidenceScenario> {
  const scenario = draft.scenarios.find((entry) => entry.name === name);
  if (scenario === undefined) throw new Error(`the plan has no scenario ${name}`);
  return scenario;
}

const PIN =
  "datafuselabs/databend:v1.2.951-nightly@sha256:f63585cae3e096d62580ad51d92abd2f64b57b196af3b51cb01ecae381ec874b";
const SERVER = "databend-http";
const SEED = "databend-http-seed";
const COMPAT = "databend";
const FIXTURE_DATABASES = ["libredb_demo", "studio_demo"] as const;
const LIVE_CHECK = "databend-live-check.ts";
const PLAN = "databend-evidence-plan.ts";
/** What a capture depends on besides the server, as tests/live/databend-evidence.ts lists it in the manifest. */
const HARNESS_PATHS = [
  "database-compose.yml",
  "docker/databend/",
  "tests/helpers/databend-evidence-scrub.ts",
  "tests/live/databend-evidence-plan.ts",
  "tests/live/databend-evidence.ts",
];

/** The compat service exactly as main had it before the fixture was added. */
const COMPAT_SERVICE: ComposeService = {
  image: "datafuselabs/databend:v1.2.925-patch-11",
  container_name: "libredb-databend",
  profiles: ["compat"],
  environment: { QUERY_DEFAULT_USER: "root", QUERY_DEFAULT_PASSWORD: "Probe123pass!" },
  ports: ["13308:3307", "18000:8000"],
};

// -- compose -----------------------------------------------------------------------------------------------------

function serviceSetFindings({ services }: DatabendFixtures): string[] {
  const expected = [COMPAT, SERVER, SEED];
  return [
    ...Object.keys(services)
      .filter((name) => !expected.includes(name))
      .map((name) => `${name} is a Databend service the plan does not name`),
    ...expected.filter((name) => services[name] === undefined).map((name) => `${name} is missing`),
  ];
}

function compatFindings({ services }: DatabendFixtures): string[] {
  return Bun.deepEquals(services[COMPAT], COMPAT_SERVICE, true) ? [] : [`the compat ${COMPAT} service changed`];
}

function imageFindings({ services }: DatabendFixtures): string[] {
  return [SERVER, SEED]
    .filter((name) => services[name]?.image !== PIN)
    .map((name) => `${name} runs ${services[name]?.image}, not ${PIN}`);
}

function containerNameFindings({ services }: DatabendFixtures): string[] {
  return [SERVER, SEED]
    .filter((name) => services[name]?.container_name !== `libredb-${name}`)
    .map((name) => `${name} is named ${services[name]?.container_name}`);
}

function portFindings({ services }: DatabendFixtures): string[] {
  const findings: string[] = [];
  const ports = services[SERVER]?.ports ?? [];
  if (!Bun.deepEquals(ports, ["127.0.0.1:8000:8000"])) findings.push(`${SERVER} publishes ${ports.join(", ")}`);
  if (services[SEED]?.ports !== undefined) findings.push(`${SEED} publishes ${services[SEED].ports?.join(", ")}`);
  return findings;
}

function profileFindings({ services }: DatabendFixtures): string[] {
  return [SERVER, SEED]
    .filter((name) => services[name]?.profiles !== undefined)
    .map((name) => `${name} has the profiles ${services[name]?.profiles?.join(", ")}, so a plain up skips it`);
}

function boundFindings({ services }: DatabendFixtures): string[] {
  const findings: string[] = [];
  for (const name of [SERVER, SEED]) {
    const limits = services[name]?.deploy?.resources?.limits;
    if (limits?.cpus === undefined || limits.memory === undefined) findings.push(`${name} is not bounded`);
    else if (services[name]?.memswap_limit !== limits.memory) findings.push(`${name} may swap past its bound`);
  }
  return findings;
}

function healthFindings({ services }: DatabendFixtures): string[] {
  const check = services[SERVER]?.healthcheck;
  const health = ["CMD", "curl", "-fsS", "-o", "/dev/null", "http://127.0.0.1:8000/health"];
  const findings: string[] = [];
  if (!Bun.deepEquals(check?.test, health)) findings.push(`${SERVER} does not probe /health`);
  if (check?.start_period === undefined) findings.push(`${SERVER} has no start_period`);
  return findings;
}

function seedFindings({ services, files }: DatabendFixtures): string[] {
  const seed = services[SEED];
  const findings: string[] = [];
  if (seed?.restart !== "no") findings.push(`${SEED} restarts (${seed?.restart}), so it is not a one-shot`);
  if (!Bun.deepEquals(seed?.depends_on, { [SERVER]: { condition: "service_healthy" } }))
    findings.push(`${SEED} does not wait for a healthy ${SERVER}`);
  if (!Bun.deepEquals(seed?.volumes, ["./docker/databend:/fixtures:ro"]))
    findings.push(`${SEED} does not mount docker/databend read-only`);
  if (!Bun.deepEquals(seed?.entrypoint, ["sh", "/fixtures/seed.sh", `http://${SERVER}:8000`]))
    findings.push(`${SEED} does not run seed.sh against ${SERVER}`);
  if (files["seed.sh"] === undefined) findings.push("docker/databend/seed.sh is missing");
  return findings;
}

/** The README records the bound and the start period the compose file sets, so they are traceable to a measure. */
function readmeBoundFindings({ services, files }: DatabendFixtures): string[] {
  const readme = files["README.md"] ?? "";
  const memory = services[SERVER]?.deploy?.resources?.limits?.memory;
  const startPeriod = services[SERVER]?.healthcheck?.start_period;
  return [
    ...(readme.includes(`\`memory: ${memory}\``) ? [] : [`README.md does not record memory: ${memory}`]),
    ...(readme.includes(`\`start_period: ${startPeriod}\``)
      ? []
      : [`README.md does not record start_period: ${startPeriod}`]),
  ];
}

function fileSetFindings({ files }: DatabendFixtures): string[] {
  const expected = ["README.md", "fixture.jsonl", "seed.sh"];
  return [
    ...Object.keys(files)
      .filter((name) => !expected.includes(name))
      .map((name) => `docker/databend/${name} is not a fixture file`),
    ...expected.filter((name) => files[name] === undefined).map((name) => `docker/databend/${name} is missing`),
  ];
}

// -- docker/databend/fixture.jsonl -------------------------------------------------------------------------------

/** The statements of fixture.jsonl, or a finding per line that is not `{"sql": "<one statement>"}`. */
function fixtureStatements(files: DatabendFixtures["files"]): { statements: string[]; findings: string[] } {
  const statements: string[] = [];
  const findings: string[] = [];
  const lines = (files["fixture.jsonl"] ?? "").split("\n").filter((line) => line !== "");
  lines.forEach((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      findings.push(`fixture.jsonl line ${index + 1} is not JSON`);
      return;
    }
    const keys = typeof parsed === "object" && parsed !== null ? Object.keys(parsed) : [];
    const sql = (parsed as { sql?: unknown }).sql;
    if (!Bun.deepEquals(keys, ["sql"]) || typeof sql !== "string") {
      findings.push(`fixture.jsonl line ${index + 1} is not {"sql": "..."}`);
      return;
    }
    if (withoutLiterals(sql).includes(";")) findings.push(`fixture.jsonl line ${index + 1} holds two statements`);
    statements.push(sql);
  });
  return { statements, findings };
}

/** The text with each single-quoted literal emptied, so a name or a semicolon inside a value is not read. */
function withoutLiterals(sql: string): string {
  return sql.replace(/'(?:[^'\\]|\\.|'')*'/g, "''");
}

const QUALIFIED = /\b([A-Za-z_]\w*)\.(?:[A-Za-z_*]\w*|\*)/g;

function fixtureScopeFindings({ files }: DatabendFixtures): string[] {
  const { statements, findings } = fixtureStatements(files);
  for (const sql of statements) {
    const code = withoutLiterals(sql);
    for (const [, database] of code.matchAll(QUALIFIED)) {
      if (!(FIXTURE_DATABASES as readonly string[]).includes(database))
        findings.push(`fixture.jsonl writes to ${database}: ${sql.slice(0, 60)}`);
    }
    const created = /^CREATE DATABASE (?:IF NOT EXISTS )?(\w+)/i.exec(code);
    if (created && !(FIXTURE_DATABASES as readonly string[]).includes(created[1]))
      findings.push(`fixture.jsonl creates the database ${created[1]}`);
  }
  return findings;
}

/** The column types of design section 4, as `every_type` spells them: one column of each. */
const EVERY_TYPE_TYPES = [
  "TINYINT",
  "SMALLINT",
  "INT",
  "BIGINT",
  "TINYINT UNSIGNED",
  "SMALLINT UNSIGNED",
  "INT UNSIGNED",
  "BIGINT UNSIGNED",
  "FLOAT",
  "DOUBLE",
  "DECIMAL",
  "BOOLEAN",
  "VARCHAR",
  "BINARY",
  "DATE",
  "TIMESTAMP",
  "TIMESTAMP_TZ",
  "INTERVAL",
  "GEOMETRY",
  "GEOGRAPHY",
  "VARIANT",
  "ARRAY",
  "MAP",
  "TUPLE",
  "VECTOR",
  "BITMAP",
] as const;

/** The types of design section 4 that `libredb_demo.every_type` declares no column of. */
function everyTypeFindings({ files }: DatabendFixtures): string[] {
  const { statements } = fixtureStatements(files);
  const ddl = statements.find((sql) => /^CREATE OR REPLACE TABLE libredb_demo\.every_type \(/.test(sql)) ?? "";
  const declared = new Set<string>();
  let depth = 0;
  let column = "";
  for (const char of `${ddl.slice(ddl.indexOf("(") + 1, ddl.lastIndexOf(")"))},`) {
    if (char === "," && depth === 0) {
      declared.add(
        column
          .trim()
          .replace(/^\w+\s+/, "")
          .replace(/\(.*$/, "")
          .replace(/\s+(?:NOT\s+)?NULL$/i, "")
          .toUpperCase(),
      );
      column = "";
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    column += char;
  }
  return EVERY_TYPE_TYPES.filter((type) => !declared.has(type)).map(
    (type) => `libredb_demo.every_type declares no ${type} column`,
  );
}

/** What the fixture must hold: every database, the materialized view (I5), the 60-column table, role and user. */
function fixtureContentFindings({ files }: DatabendFixtures): string[] {
  const { statements } = fixtureStatements(files);
  const text = statements.join("\n");
  const findings: string[] = [];
  for (const database of FIXTURE_DATABASES)
    if (!new RegExp(`^CREATE DATABASE IF NOT EXISTS ${database}$`, "m").test(text))
      findings.push(`fixture.jsonl does not create ${database}`);
  if (!/CREATE MATERIALIZED VIEW libredb_demo\.\w+ AS SELECT/.test(text))
    findings.push("fixture.jsonl creates no materialized view");
  if (!/CREATE (?:OR REPLACE )?VIEW libredb_demo\.\w+ AS SELECT/.test(text))
    findings.push("fixture.jsonl creates no view");
  const wide = statements.find((sql) => /^CREATE OR REPLACE TABLE libredb_demo\.wide_60 \(/.test(sql));
  const columns = wide?.slice(wide.indexOf("(") + 1, wide.lastIndexOf(")")).split(",").length;
  if (columns !== 60) findings.push(`libredb_demo.wide_60 declares ${columns} columns, not 60`);
  return findings;
}

/** `studio_reader` holds only `studio_ro`, which holds only SELECT on libredb_demo. */
function leastPrivilegeFindings({ files }: DatabendFixtures): string[] {
  const { statements } = fixtureStatements(files);
  const grants = statements.filter((sql) => /^GRANT\b/i.test(sql));
  const expected = ["GRANT SELECT ON libredb_demo.* TO ROLE studio_ro", "GRANT ROLE studio_ro TO studio_reader"];
  const findings = grants.filter((sql) => !expected.includes(sql)).map((sql) => `fixture.jsonl grants: ${sql}`);
  for (const grant of expected) if (!grants.includes(grant)) findings.push(`fixture.jsonl does not run: ${grant}`);
  const user = statements.find((sql) => /^CREATE (?:OR REPLACE )?USER studio_reader\b/.test(sql));
  if (user === undefined) findings.push("fixture.jsonl creates no studio_reader");
  else if (!/IDENTIFIED BY '[A-Z][a-z]+123pass!' WITH DEFAULT_ROLE = 'studio_ro'$/.test(user))
    findings.push("studio_reader's password or default role is not the fixture's shape");
  if (!statements.includes("CREATE ROLE IF NOT EXISTS studio_ro")) findings.push("fixture.jsonl creates no studio_ro");
  return findings;
}

// -- the write surface of tests/live/databend-*.ts ---------------------------------------------------------------

/** Every string and template literal of a file's code, comments excluded. */
function literalsOf(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const literals: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literals.push(node.text);
    else if (ts.isTemplateExpression(node)) literals.push(node.getText(source).slice(1, -1));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return literals;
}

const WRITE_WORDS =
  /\b(?:INSERT|UPDATE|DELETE|MERGE|REPLACE|CREATE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|COPY|OPTIMIZE|VACUUM|UNDROP|RENAME)\b/;
const WRITE_TARGET =
  /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|MERGE\s+INTO|REPLACE\s+INTO|TRUNCATE\s+TABLE|ALTER\s+TABLE|DROP\s+(?:TABLE|VIEW)|CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW))\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\S+)/i;

/**
 * The one principal the live check may create and drop besides its tables: S7's `studio_scratch`, under a password
 * policy of its own, so a wrong password counts toward a lockout of that user only and never of `libredb` or
 * `studio_reader`.
 */
const SCRATCH_PRINCIPAL = [
  /^DROP (?:USER|PASSWORD POLICY) IF EXISTS studio_scratch(?:_policy)?$/,
  /^CREATE PASSWORD POLICY studio_scratch_policy PASSWORD_MAX_RETRIES = \d+$/,
  /^CREATE USER studio_scratch IDENTIFIED BY '\$\{\w+\}' WITH SET PASSWORD POLICY = 'studio_scratch_policy'$/,
];

/**
 * The table argument of every `replay(...)` call: the export replay's INSERTs are built at run time, so no literal
 * holds them, and the table they write is bounded here instead, as a `studio_demo.<name>` literal.
 */
function replayTargetsOf(name: string, text: string): string[] {
  const source = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
  const targets: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "replay") {
      const table = node.arguments[3];
      targets.push(table !== undefined && ts.isStringLiteral(table) ? table.text : (table?.getText(source) ?? ""));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return targets;
}

const REPLAY_TARGET = /^studio_demo\.\w+$/;

function writeSurfaceFindings({ live }: DatabendFixtures): string[] {
  const findings: string[] = [];
  for (const [name, text] of Object.entries(live)) {
    if (name === PLAN) continue;
    if (name === LIVE_CHECK)
      for (const target of replayTargetsOf(name, text))
        if (!REPLAY_TARGET.test(target))
          findings.push(`tests/live/${LIVE_CHECK} replays an export into ${target}, not a studio_demo table literal`);
    for (const literal of literalsOf(name, text)) {
      if (!WRITE_WORDS.test(literal)) continue;
      if (name !== LIVE_CHECK) {
        findings.push(`tests/live/${name} names a write: ${literal.slice(0, 60)}`);
        continue;
      }
      // A `DROP USER studio_scratch` must not pass as a `DROP` of the qualified name it does not have.
      if (SCRATCH_PRINCIPAL.some((pattern) => pattern.test(literal))) continue;
      const target = WRITE_TARGET.exec(literal)?.[1];
      const database = target?.split(".")[0];
      if (
        target === undefined ||
        !target.includes(".") ||
        !(FIXTURE_DATABASES as readonly string[]).includes(database ?? "")
      )
        findings.push(`tests/live/${LIVE_CHECK} writes outside studio_demo and libredb_demo: ${literal.slice(0, 60)}`);
    }
  }
  return findings;
}

const READ_VERBS = /^(?:SELECT|SHOW|EXPLAIN|DESC|DESCRIBE|BEGIN|ROLLBACK)\b/i;
const TEMP_CREATE = /^CREATE TEMP TABLE (\w+) \(/;
const TEMP_WRITE = /^(?:INSERT INTO|DROP TABLE) (\w+)\b/;
/** The one write outside a temporary table: rows the `insert` scenario adds to the table seed.sh resets. */
const NOTES_INSERT = /^INSERT INTO studio_demo\.notes VALUES \(/;

/**
 * The evidence plan writes nothing but temporary tables it created earlier in the same scenario, plus the `insert`
 * scenario's rows in `studio_demo.notes` of the local fixture, which seed.sh resets: on Cloud nothing resets them.
 */
function planWriteFindings({ scenarios }: DatabendFixtures): string[] {
  const findings: string[] = [];
  for (const scenario of scenarios) {
    const temporary = new Set<string>();
    for (const step of scenario.steps) {
      if (step.kind !== "query") continue;
      const created = TEMP_CREATE.exec(step.sql);
      if (created) {
        if (!scenario.clientSession) findings.push(`${scenario.name} creates a temporary table with no client session`);
        temporary.add(created[1]);
        continue;
      }
      const written = TEMP_WRITE.exec(step.sql);
      if (written && temporary.has(written[1])) continue;
      if (scenario.name === "insert" && NOTES_INSERT.test(step.sql)) {
        if (!Bun.deepEquals(scenario.targets, ["local"]))
          findings.push("insert writes studio_demo.notes on a target seed.sh does not reset");
        continue;
      }
      if (!READ_VERBS.test(step.sql)) findings.push(`${scenario.name} writes: ${step.sql.slice(0, 60)}`);
    }
  }
  return findings;
}

function clean(findings: readonly string[]): void {
  expect(findings).toEqual([]);
}

/** Asserts that one finding names every needle. */
function finds(findings: readonly string[], ...needles: string[]): void {
  expect({ findings, named: findings.some((finding) => needles.every((needle) => finding.includes(needle))) }).toEqual({
    findings,
    named: true,
  });
}

const real = loadFixtures();

describe("the live Databend fixture in database-compose.yml", () => {
  test("the Databend services are the compat probe, the fixture server and its seed", () => {
    clean(serviceSetFindings(real));
    const extra = planted(real, (draft) => {
      draft.services["databend-extra"] = { image: PIN };
    });
    finds(serviceSetFindings(extra), "databend-extra");
    const missing = planted(real, (draft) => {
      delete draft.services[SEED];
    });
    finds(serviceSetFindings(missing), `${SEED} is missing`);
  });

  test("the compat databend service is unchanged", () => {
    clean(compatFindings(real));
    const changed = planted(real, (draft) => {
      draft.services[COMPAT].ports = ["13308:3307", "8000:8000"];
    });
    finds(compatFindings(changed), "compat databend service changed");
  });

  test("the server and the seed run the pinned image by tag and digest", () => {
    clean(imageFindings(real));
    const undigested = planted(real, (draft) => {
      draft.services[SEED].image = "datafuselabs/databend:v1.2.951-nightly";
    });
    finds(imageFindings(undigested), SEED, "v1.2.951-nightly,");
  });

  test("every container is named libredb-<service>", () => {
    clean(containerNameFindings(real));
    const renamed = planted(real, (draft) => {
      draft.services[SERVER].container_name = "databend-http";
    });
    finds(containerNameFindings(renamed), `${SERVER} is named databend-http`);
  });

  test("the server publishes 8000 on 127.0.0.1 only, and the seed publishes nothing", () => {
    clean(portFindings(real));
    const open = planted(real, (draft) => {
      draft.services[SERVER].ports = ["8000:8000"];
    });
    finds(portFindings(open), `${SERVER} publishes 8000:8000`);
    const seed = planted(real, (draft) => {
      draft.services[SEED].ports = ["127.0.0.1:8001:8000"];
    });
    finds(portFindings(seed), `${SEED} publishes`);
  });

  test("neither service has a profile, so a plain up starts both", () => {
    clean(profileFindings(real));
    const profiled = planted(real, (draft) => {
      draft.services[SERVER].profiles = ["databend"];
    });
    finds(profileFindings(profiled), SERVER, "a plain up skips it");
  });

  test("both containers are bounded in CPU and memory, with no swap past the bound", () => {
    clean(boundFindings(real));
    const unbounded = planted(real, (draft) => {
      delete draft.services[SEED].deploy;
    });
    finds(boundFindings(unbounded), `${SEED} is not bounded`);
    const swapping = planted(real, (draft) => {
      delete draft.services[SERVER].memswap_limit;
    });
    finds(boundFindings(swapping), `${SERVER} may swap`);
  });

  test("the server's healthcheck probes /health and waits a start period", () => {
    clean(healthFindings(real));
    const probe = planted(real, (draft) => {
      draft.services[SERVER].healthcheck = { test: ["CMD", "true"], start_period: "5s" };
    });
    finds(healthFindings(probe), "does not probe /health");
    const period = planted(real, (draft) => {
      delete draft.services[SERVER].healthcheck?.start_period;
    });
    finds(healthFindings(period), "no start_period");
  });

  test("the seed is a one-shot that runs seed.sh, mounted read-only, once the server is healthy", () => {
    clean(seedFindings(real));
    const restarting = planted(real, (draft) => {
      draft.services[SEED].restart = "unless-stopped";
    });
    finds(seedFindings(restarting), "not a one-shot");
    const early = planted(real, (draft) => {
      draft.services[SEED].depends_on = { [SERVER]: { condition: "service_started" } };
    });
    finds(seedFindings(early), "does not wait for a healthy");
    const writable = planted(real, (draft) => {
      draft.services[SEED].volumes = ["./docker/databend:/fixtures"];
    });
    finds(seedFindings(writable), "read-only");
    const elsewhere = planted(real, (draft) => {
      draft.services[SEED].entrypoint = ["sh", "/fixtures/seed.sh", "http://databend:8000"];
    });
    finds(seedFindings(elsewhere), "does not run seed.sh");
    const gone = planted(real, (draft) => {
      delete draft.files["seed.sh"];
    });
    finds(seedFindings(gone), "seed.sh is missing");
  });

  test("docker/databend/README.md records the memory bound and start period the compose file sets", () => {
    clean(readmeBoundFindings(real));
    const moved = planted(real, (draft) => {
      const limits = draft.services[SERVER].deploy?.resources?.limits;
      if (limits) limits.memory = "7G";
    });
    finds(readmeBoundFindings(moved), "memory: 7G");
    const period = planted(real, (draft) => {
      const check = draft.services[SERVER].healthcheck;
      if (check) check.start_period = "999s";
    });
    finds(readmeBoundFindings(period), "start_period: 999s");
  });

  test("docker/databend holds the seed, the fixture and the README only", () => {
    clean(fileSetFindings(real));
    const extra = planted(real, (draft) => {
      draft.files["license.key"] = "";
    });
    finds(fileSetFindings(extra), "docker/databend/license.key");
    const missing = planted(real, (draft) => {
      delete draft.files["README.md"];
    });
    finds(fileSetFindings(missing), "README.md is missing");
  });
});

describe("docker/databend/fixture.jsonl", () => {
  test('every line is one statement as {"sql": ...}', () => {
    clean(fixtureStatements(real.files).findings);
    const twoKeys = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += '{"sql": "SELECT 1", "x": 1}\n';
    });
    finds(fixtureStatements(twoKeys.files).findings, 'is not {"sql"');
    const broken = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += "{sql\n";
    });
    finds(fixtureStatements(broken.files).findings, "is not JSON");
    const two = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += `${JSON.stringify({ sql: "SELECT ';'; SELECT 2" })}\n`;
    });
    finds(fixtureStatements(two.files).findings, "holds two statements");
    const quoted = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += `${JSON.stringify({ sql: "SELECT ';'" })}\n`;
    });
    clean(fixtureStatements(quoted.files).findings);
  });

  test("it writes only libredb_demo and studio_demo", () => {
    clean(fixtureScopeFindings(real));
    const other = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += `${JSON.stringify({ sql: "CREATE TABLE default.t (a INT)" })}\n`;
    });
    finds(fixtureScopeFindings(other), "writes to default");
    const database = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += `${JSON.stringify({ sql: "CREATE DATABASE IF NOT EXISTS other" })}\n`;
    });
    finds(fixtureScopeFindings(database), "creates the database other");
    const value = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += `${JSON.stringify({ sql: "INSERT INTO studio_demo.notes VALUES (1, 'a.b')" })}\n`;
    });
    clean(fixtureScopeFindings(value));
  });

  test("it creates both databases, a view, a materialized view and the 60-column table", () => {
    clean(fixtureContentFindings(real));
    const noView = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace("CREATE MATERIALIZED VIEW", "CREATE TABLE");
    });
    finds(fixtureContentFindings(noView), "no materialized view");
    const narrow = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace("c60 INT", "c60 INT, c61 INT");
    });
    finds(fixtureContentFindings(narrow), "declares 61 columns");
    const noDemo = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace(
        "CREATE DATABASE IF NOT EXISTS studio_demo",
        "SELECT 1",
      );
    });
    finds(fixtureContentFindings(noDemo), "does not create studio_demo");
    const plainView = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace(/CREATE OR REPLACE VIEW/g, "SELECT");
    });
    finds(fixtureContentFindings(plainView), "creates no view");
  });

  test("libredb_demo.every_type declares a column of every type design section 4 decodes", () => {
    clean(everyTypeFindings(real));
    const narrowed = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace("u32 INT UNSIGNED", "u32 BIGINT");
    });
    finds(everyTypeFindings(narrowed), "declares no INT UNSIGNED column");
  });

  test("studio_reader holds only studio_ro, which reads libredb_demo and nothing else", () => {
    clean(leastPrivilegeFindings(real));
    const wider = planted(real, (draft) => {
      draft.files["fixture.jsonl"] += `${JSON.stringify({ sql: "GRANT ALL ON *.* TO studio_reader" })}\n`;
    });
    finds(leastPrivilegeFindings(wider), "grants: GRANT ALL ON *.* TO studio_reader");
    const noRole = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace(
        "GRANT ROLE studio_ro TO studio_reader",
        "SELECT 1",
      );
    });
    finds(leastPrivilegeFindings(noRole), "does not run: GRANT ROLE studio_ro");
    const noUser = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace(/USER studio_reader/g, "USER someone");
    });
    finds(leastPrivilegeFindings(noUser), "creates no studio_reader");
    const shape = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace(/123pass!/g, "secret");
    });
    finds(leastPrivilegeFindings(shape), "not the fixture's shape");
    const noRoleCreated = planted(real, (draft) => {
      draft.files["fixture.jsonl"] = draft.files["fixture.jsonl"].replace(
        "CREATE ROLE IF NOT EXISTS studio_ro",
        "SELECT 1",
      );
    });
    finds(leastPrivilegeFindings(noRoleCreated), "creates no studio_ro");
  });
});

describe("the write surface of tests/live/databend-*.ts", () => {
  test("only databend-live-check.ts writes, and only to studio_demo and libredb_demo", () => {
    clean(writeSurfaceFindings(real));
    const harness = planted(real, (draft) => {
      draft.live["databend-evidence.ts"] += '\nconst sql = "DROP TABLE libredb_demo.every_type";\n';
    });
    finds(writeSurfaceFindings(harness), "tests/live/databend-evidence.ts names a write");
    const commented = planted(real, (draft) => {
      draft.live["databend-evidence.ts"] += "\n// DROP TABLE is never sent here\n";
    });
    clean(writeSurfaceFindings(commented));
    const inScope = planted(real, (draft) => {
      draft.live[LIVE_CHECK] =
        'const a = "INSERT INTO studio_demo.notes VALUES (1)";\nconst b = `CREATE OR REPLACE TABLE libredb_demo.replay_${1} (a INT)`;\nconst c = "SELECT 1";\n';
    });
    clean(writeSurfaceFindings(inScope));
    const elsewhere = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'const a = "INSERT INTO default.notes VALUES (1)";\n';
    });
    finds(writeSurfaceFindings(elsewhere), "writes outside studio_demo and libredb_demo", "default.notes");
    const unqualified = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'const a = "DELETE FROM notes";\n';
    });
    finds(writeSurfaceFindings(unqualified), "writes outside", "DELETE FROM notes");
    const unparsed = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'const a = "GRANT SELECT ON *.* TO x";\n';
    });
    finds(writeSurfaceFindings(unparsed), "writes outside", "GRANT");
  });

  test("databend-live-check.ts creates and drops only its own scratch user and that user's password policy", () => {
    const scratch = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = [
        'const a = "DROP USER IF EXISTS studio_scratch";',
        'const b = "DROP PASSWORD POLICY IF EXISTS studio_scratch_policy";',
        'const c = "CREATE PASSWORD POLICY studio_scratch_policy PASSWORD_MAX_RETRIES = 5";',
        "const d = `CREATE USER studio_scratch IDENTIFIED BY '${p}' WITH SET PASSWORD POLICY = 'studio_scratch_policy'`;",
      ].join("\n");
    });
    clean(writeSurfaceFindings(scratch));
    const fixtureUser = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'const a = "DROP USER studio_reader";\n';
    });
    finds(writeSurfaceFindings(fixtureUser), "writes outside", "DROP USER studio_reader");
    const defaultUser = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = "const a = `CREATE OR REPLACE USER libredb IDENTIFIED BY '${p}'`;\n";
    });
    finds(writeSurfaceFindings(defaultUser), "writes outside", "USER libredb");
    const otherPolicy = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'const a = "CREATE PASSWORD POLICY strict PASSWORD_MAX_RETRIES = 1";\n';
    });
    finds(writeSurfaceFindings(otherPolicy), "writes outside", "POLICY strict");
    const otherPolicyOnScratch = planted(real, (draft) => {
      draft.live[LIVE_CHECK] =
        "const a = `CREATE USER studio_scratch IDENTIFIED BY '${p}' WITH SET PASSWORD POLICY = 'strict'`;\n";
    });
    finds(writeSurfaceFindings(otherPolicyOnScratch), "writes outside", "studio_scratch");
    const grant = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'const a = "GRANT ROLE account_admin TO studio_scratch";\n';
    });
    finds(writeSurfaceFindings(grant), "writes outside", "GRANT ROLE");
    const harness = planted(real, (draft) => {
      draft.live["databend-evidence.ts"] += '\nconst sql = "DROP USER IF EXISTS studio_scratch";\n';
    });
    finds(writeSurfaceFindings(harness), "tests/live/databend-evidence.ts names a write");
  });

  test("every export replay of databend-live-check.ts writes into a studio_demo table named in a literal", () => {
    const qualified = planted(real, (draft) => {
      draft.live[LIVE_CHECK] =
        'await replay(admin, writer, "SELECT 1", "studio_demo.every_type_replay", "SELECT 1");\n';
    });
    clean(writeSurfaceFindings(qualified));
    const unqualified = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'await replay(admin, writer, "SELECT 1", "every_type_replay", "SELECT 1");\n';
    });
    finds(writeSurfaceFindings(unqualified), "replays an export into every_type_replay");
    const elsewhere = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = 'await replay(admin, writer, "SELECT 1", "libredb_demo.every_type", "SELECT 1");\n';
    });
    finds(writeSurfaceFindings(elsewhere), "replays an export into libredb_demo.every_type");
    const computed = planted(real, (draft) => {
      draft.live[LIVE_CHECK] = "await replay(admin, writer, sql, name, readBack);\n";
    });
    finds(writeSurfaceFindings(computed), "replays an export into name");
  });

  test("the evidence plan writes only temporary tables of its session and the insert scenario's notes rows", () => {
    clean(planWriteFindings(real));
    const persistent = planted(real, (draft) => {
      draft.scenarios[0].steps.push({ kind: "query", sql: "INSERT INTO libredb_demo.every_type VALUES (9)" });
    });
    finds(planWriteFindings(persistent), "writes: INSERT INTO libredb_demo.every_type");
    const sessionless = planted(real, (draft) => {
      draft.scenarios[0].clientSession = false;
      draft.scenarios[0].steps.push({ kind: "query", sql: "CREATE TEMP TABLE t9 (a INT)" });
    });
    finds(planWriteFindings(sessionless), "temporary table with no client session");
    const otherTable = planted(real, (draft) => {
      draft.scenarios[0].steps.push({ kind: "query", sql: "INSERT INTO t_unknown VALUES (1)" });
    });
    finds(planWriteFindings(otherTable), "writes: INSERT INTO t_unknown");
    const notesElsewhere = planted(real, (draft) => {
      draft.scenarios[0].steps.push({ kind: "query", sql: "INSERT INTO studio_demo.notes VALUES (9, 'nine')" });
    });
    finds(planWriteFindings(notesElsewhere), "version writes: INSERT INTO studio_demo.notes");
    const notesOnCloud = planted(real, (draft) => {
      draftScenario(draft, "insert").targets = ["local", "cloud"];
    });
    finds(planWriteFindings(notesOnCloud), "insert writes studio_demo.notes on a target seed.sh does not reset");
    const notesDeleted = planted(real, (draft) => {
      draftScenario(draft, "insert").steps.push({ kind: "query", sql: "DELETE FROM studio_demo.notes WHERE id = 1" });
    });
    finds(planWriteFindings(notesDeleted), "insert writes: DELETE FROM studio_demo.notes");
    const otherRows = planted(real, (draft) => {
      draftScenario(draft, "insert").steps.push({
        kind: "query",
        sql: "INSERT INTO studio_demo.other VALUES (1, 'a')",
      });
    });
    finds(planWriteFindings(otherRows), "insert writes: INSERT INTO studio_demo.other");
  });
});

describe("the Cloud target of the evidence plan (plan section 7)", () => {
  const cloud = scenariosFor("cloud");
  const local = scenariosFor("local");

  test("the local target runs every scenario that names no target, unchanged, plus the two that name it alone", () => {
    expect(local).toEqual(EVIDENCE_SCENARIOS.filter((scenario) => scenario.targets?.includes("local") ?? true));
    expect(local.filter((scenario) => scenario.targets !== undefined).map((scenario) => scenario.name)).toEqual([
      "insert",
      "final-kill",
    ]);
    expect(local.filter((scenario) => scenario.targets !== undefined).map((scenario) => scenario.targets)).toEqual([
      ["local"],
      ["local"],
    ]);
    expect(local.some((scenario) => scenario.warehouse !== undefined)).toBe(false);
  });

  test("on Cloud no statement and no session names libredb_demo, which the tenant does not have", () => {
    const named = cloud.filter((scenario) => JSON.stringify(scenario.steps).includes("libredb_demo"));
    expect(named.map((scenario) => scenario.name)).toEqual([]);
    const echo = cloud.find((scenario) => scenario.name === "session-echo");
    const first = echo?.steps[0];
    expect(first?.kind === "query" ? first.session?.database : undefined).toBe(CLOUD_DEMO_DATABASE);
  });

  test("on Cloud a scenario expects the gateway's envelope where it has one, and its own expectation otherwise", () => {
    const auth = cloud.find((scenario) => scenario.name === "auth-401");
    expect(auth?.expect).toEqual({ status: 401, kind: "AuthorizationFailed", message: "5100" });
    const version = cloud.find((scenario) => scenario.name === "version");
    expect(version?.expect).toEqual(EVIDENCE_SCENARIOS[0].expect);
  });

  test("the warehouse refusals and the forbidden statement run on Cloud only", () => {
    const only = cloud.filter((scenario) => scenario.targets !== undefined).map((scenario) => scenario.name);
    expect(only).toEqual(["no-warehouse", "unknown-warehouse", "forbidden"]);
    expect(cloud.filter((scenario) => scenario.warehouse !== undefined).map((scenario) => scenario.warehouse)).toEqual([
      "omit",
      "unknown",
    ]);
  });
});

// -- the run arguments and the expectation check of tests/live/databend-evidence.ts --------------------------------

/** A captured exchange as the harness checks a live one: the plan step, the status, and the answer as parsed. */
function asExchange(exchange: DatabendCapture["exchanges"][number]): Exchange {
  const { status, headers, body } = exchange.response;
  return {
    step: exchange.step as Exchange["step"],
    raw: { request: exchange.request, response: { status, headers, body: JSON.stringify(body) } },
    answer: body as Exchange["answer"],
  };
}

describe("the run arguments and the expectation check of tests/live/databend-evidence.ts", () => {
  const names = (argv: readonly string[]) => runArguments(argv).scenarios.map((scenario) => scenario.name);

  test("a query carries the newest session an answer held, as BendSQL's handle_session keeps it", () => {
    const opened = { database: "default", txn_state: "Active" };
    const echoed = { database: "default", txn_state: "AutoCommit" };
    expect(carriedSession(undefined, "query", {})).toBeUndefined();
    expect(carriedSession(undefined, "query", { session: opened })).toEqual(opened);
    expect(carriedSession(opened, "query", { session: echoed })).toEqual(echoed);
    // The last page of a statement answers `session: null`, which keeps the session before it.
    expect(carriedSession(opened, "pages", JSON.parse('{"state":"Succeeded","session":null}'))).toEqual(opened);
    expect(carriedSession(opened, "kill", {})).toEqual(opened);
    // A logout ends the client: what the plan sends after it starts with no session.
    expect(carriedSession(opened, "logout", {})).toBeUndefined();
  });

  test("a run asks every scenario of its target, as that target runs them", () => {
    expect(runArguments(["--target", "local"])).toEqual({ target: "local", scenarios: scenariosFor("local") });
    expect(runArguments(["--target", "cloud"])).toEqual({ target: "cloud", scenarios: scenariosFor("cloud") });
    expect(() => runArguments(["--target", "staging"])).toThrow("usage: bun tests/live/databend-evidence.ts");
    expect(() => runArguments([])).toThrow("usage: bun tests/live/databend-evidence.ts");
  });

  test("--only runs just the scenarios it names, in plan order", () => {
    expect(names(["--target", "local", "--only", "insert,final-kill"])).toEqual(["insert", "final-kill"]);
    expect(names(["--only", "final-kill,version", "--target", "local"])).toEqual(["version", "final-kill"]);
    expect(runArguments(["--target", "cloud", "--only", "session-echo"]).scenarios).toEqual(
      scenariosFor("cloud").filter((scenario) => scenario.name === "session-echo"),
    );
  });

  test("--only refuses a name its target does not run, and a missing list", () => {
    expect(() => runArguments(["--target", "local", "--only", "insert,nope"])).toThrow(
      '--only names "nope", which the local target does not run',
    );
    expect(() => runArguments(["--target", "local", "--only", "no-warehouse"])).toThrow(
      '--only names "no-warehouse", which the local target does not run',
    );
    expect(() => runArguments(["--target", "cloud", "--only", "insert,final-kill"])).toThrow(
      '--only names "insert", "final-kill", which the cloud target does not run',
    );
    expect(() => runArguments(["--target", "local", "--only", ""])).toThrow('--only names ""');
    expect(() => runArguments(["--target", "local", "--only"])).toThrow("usage: bun tests/live/databend-evidence.ts");
  });

  test("statuses holds the status of every exchange in order, wherever a refusal falls", () => {
    const finalKill = loadDatabendCapture("final-kill").exchanges.map(asExchange);
    expect(problems({ statuses: [200, 200, 400, 200] }, finalKill)).toEqual([]);
    expect(problems({ statuses: [200, 200, 200, 200] }, finalKill)).toEqual([
      'statuses "200,200,400,200", expected "200,200,200,200"',
    ]);
    expect(problems({ statuses: [200, 200, 400] }, finalKill)).toEqual([
      'statuses "200,200,400,200", expected "200,200,400"',
    ]);
  });
});

// -- the captures --------------------------------------------------------------------------------------------------

/** What a scenario sends: its principal, the client-session header of its requests, and its steps in order. */
interface Sent {
  readonly principal: string;
  readonly caps: readonly string[];
  readonly steps: readonly Readonly<Record<string, unknown>>[];
}

/**
 * What a capture sent, each run of `pages` exchanges read as the one step that followed those links. The first
 * statement carries the plan's own `session`; a later one carries the newest an answer held (checked below), so only
 * the first is compared here.
 */
function sentBy(capture: DatabendCapture): Sent {
  const steps: Record<string, unknown>[] = [];
  for (const { step, request } of capture.exchanges) {
    if (step === "pages" && steps.at(-1)?.kind === "pages") continue;
    if (step !== "query") steps.push({ kind: step });
    else {
      const first = !steps.some((sent) => sent.kind === "query");
      const body: Readonly<Record<string, unknown>> = request.body ?? {};
      steps.push({
        kind: step,
        sql: body.sql,
        pagination: body.pagination,
        ...(first ? { session: body.session } : {}),
      });
    }
  }
  const caps = [
    ...new Set(capture.exchanges.map(({ request }) => request.headers["x-databend-client-caps"] ?? "none")),
  ];
  return { principal: capture.principal, caps, steps };
}

/** What a scenario sends, in the shape of {@link sentBy}. */
function plannedBy(scenario: EvidenceScenario): Sent {
  const firstQuery = scenario.steps.findIndex((step) => step.kind === "query");
  const steps = scenario.steps.map((step, index) =>
    step.kind === "query"
      ? {
          kind: step.kind,
          sql: step.sql,
          pagination: step.pagination,
          ...(index === firstQuery ? { session: step.session } : {}),
        }
      : { kind: step.kind },
  );
  return { principal: scenario.principal, caps: [scenario.clientSession ? "session_header" : "none"], steps };
}

/**
 * Each capture the replay reads is a scenario the local target runs (the scenarios that name no target or name local,
 * as `scenariosFor("local")` picks them), sent as that scenario sends it, and showing what that scenario expects.
 */
function captureFindings({ scenarios, captures }: DatabendFixtures): string[] {
  const findings: string[] = [];
  const local = scenarios.filter((scenario) => scenario.targets?.includes("local") ?? true);
  for (const capture of captures) {
    const name = capture.scenario;
    const scenario = local.find((entry) => entry.name === name);
    if (scenario === undefined) {
      findings.push(`${name} is the capture of no scenario the local target runs`);
      continue;
    }
    const sent = sentBy(capture);
    const planned = plannedBy(scenario);
    for (const key of ["principal", "caps"] as const)
      if (!Bun.deepEquals(sent[key], planned[key]))
        findings.push(`${name} was sent with ${key} ${JSON.stringify(sent[key])}, not ${JSON.stringify(planned[key])}`);
    for (let index = 0; index < Math.max(sent.steps.length, planned.steps.length); index += 1) {
      const [was, plan] = [sent.steps[index], planned.steps[index]];
      if (!Bun.deepEquals(was, plan))
        findings.push(`${name} step ${index + 1} was sent as ${JSON.stringify(was)}, not ${JSON.stringify(plan)}`);
    }
    for (const problem of problems(scenario.expect, capture.exchanges.map(asExchange)))
      findings.push(`${name}: ${problem}`);
  }
  return findings;
}

/**
 * The secrets tests/live/databend-evidence.ts hands its scrub for the local target, read where its `readCredentials`
 * reads them: the compose file's default user, `studio_reader` from fixture.jsonl, and the default user with the
 * harness's wrong password, in that order.
 */
function localSecrets({ services, files, live }: DatabendFixtures): EvidenceSecrets {
  const environment = services[SERVER]?.environment ?? {};
  const user = environment.QUERY_DEFAULT_USER;
  const password = environment.QUERY_DEFAULT_PASSWORD;
  const reader = /USER studio_reader IDENTIFIED BY '([^']+)'/.exec(files["fixture.jsonl"] ?? "")?.[1];
  const wrong = /^const WRONG_PASSWORD = "([^"]+)";$/m.exec(live["databend-evidence.ts"] ?? "")?.[1];
  if (user === undefined || password === undefined || reader === undefined || wrong === undefined)
    throw new Error("the local secrets are not where tests/live/databend-evidence.ts reads them");
  return {
    users: [
      { user, password },
      { user: "studio_reader", password: reader },
      { user, password: wrong },
    ],
  };
}

/**
 * Every local capture run, rendered again through today's scrub with the fixture's secrets (C23): a file the scrub
 * refuses, or one its render does not write back byte for byte, is a finding, so a scrub made stricter than a committed
 * capture fails here and not first on the next capture run.
 */
function scrubFindings(fixtures: DatabendFixtures): string[] {
  const findings: string[] = [];
  const secrets = localSecrets(fixtures);
  const local = Object.entries(fixtures.runs).filter(
    ([, texts]) => JSON.parse(texts["manifest.json"]).target === "local",
  );
  if (local.length === 0) findings.push("no local capture run is committed");
  for (const [run, texts] of local) {
    const files = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, JSON.parse(text)]));
    try {
      const rendered = new EvidenceScrubber(secrets).render(files);
      for (const [name, text] of Object.entries(texts))
        if (rendered[name] !== text) findings.push(`${run}/${name} is not what the scrub writes`);
    } catch (error) {
      if (!(error instanceof EvidenceLeakError)) throw error;
      findings.push(...error.findings.map((finding) => `${run}: ${finding}`));
    }
  }
  return findings;
}

describe("the captures under tests/fixtures/databend", () => {
  test("every local capture renders again through today's scrub with the fixture's secrets, refused nowhere and unchanged", () => {
    clean(scrubFindings(real));
    const [run] = DATABEND_CAPTURE_RUNS;
    const { password } = localSecrets(real).users[1];
    // The scrub reads a key as it reads a value.
    const keyed = planted(real, (draft) => {
      draft.runs[run]["planted.json"] = `${JSON.stringify({ [password]: true }, null, 2)}\n`;
    });
    finds(scrubFindings(keyed), `${run}: planted.json holds the password`);
    const unwritten = planted(real, (draft) => {
      draft.runs[run]["version.json"] = draft.runs[run]["version.json"].trimEnd();
    });
    finds(scrubFindings(unwritten), `${run}/version.json is not what the scrub writes`);
    const none = planted(real, (draft) => {
      for (const [name, texts] of Object.entries(draft.runs))
        if (JSON.parse(texts["manifest.json"]).target === "local") delete draft.runs[name];
    });
    finds(scrubFindings(none), "no local capture run is committed");
  });

  test("each manifest names the Studio commit and the harness files that commit did not hold", () => {
    const captures = path.join(ROOT, "tests/fixtures/databend");
    const manifests = readdirSync(captures, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => JSON.parse(readFileSync(path.join(captures, entry.name, "manifest.json"), "utf8")));
    expect(manifests.length).toBeGreaterThan(0);
    for (const manifest of manifests) {
      expect(manifest.studioCommit).toMatch(/^[0-9a-f]{40}$/);
      expect(Array.isArray(manifest.uncommitted)).toBe(true);
      for (const file of manifest.uncommitted) expect(HARNESS_PATHS.some((root) => file.startsWith(root))).toBe(true);
    }
  });

  test("every query after a scenario's first carries the newest session an answer held since the last logout", () => {
    const root = path.join(ROOT, "tests/fixtures/databend");
    const findings: string[] = [];
    for (const run of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      for (const file of readdirSync(path.join(root, run.name)).filter((name) => name !== "manifest.json")) {
        const capture = JSON.parse(readFileSync(path.join(root, run.name, file), "utf8")) as DatabendCapture;
        let newest: unknown;
        let queries = 0;
        capture.exchanges.forEach(({ step, request, response }, index) => {
          if (step === "query" && queries++ > 0 && !Bun.deepEquals(request.body?.session, newest))
            findings.push(`${run.name}/${file} exchange ${index} carries ${JSON.stringify(request.body?.session)}`);
          const answered = (response.body as { session?: unknown } | null)?.session;
          if (step === "logout") newest = undefined;
          else if (answered !== null && answered !== undefined) newest = answered;
        });
      }
    }
    expect(findings).toEqual([]);
  });

  test("each replayed capture is sent as its local scenario sends it and shows what that scenario expects", () => {
    expect(real.captures.length).toBeGreaterThan(0);
    clean(captureFindings(real));
    const statement = planted(real, (draft) => {
      const [step] = draftScenario(draft, "insert").steps;
      if (step.kind === "query") step.sql = "INSERT INTO studio_demo.notes VALUES (6, 'sixth')";
    });
    finds(captureFindings(statement), "insert step 1 was sent as", "(3, 'third')", "(6, 'sixth')");
    const paging = planted(real, (draft) => {
      const [step] = draftScenario(draft, "final-kill").steps;
      if (step.kind === "query") step.pagination = { wait_time_secs: 10 };
    });
    finds(captureFindings(paging), "final-kill step 1 was sent as", "max_rows_per_page");
    const stepless = planted(real, (draft) => {
      draftScenario(draft, "final-kill").steps.pop();
    });
    finds(captureFindings(stepless), 'final-kill step 4 was sent as {"kind":"kill"}');
    const sessionless = planted(real, (draft) => {
      draftScenario(draft, "insert").clientSession = false;
    });
    finds(captureFindings(sessionless), 'insert was sent with caps ["session_header"], not ["none"]');
    const principal = planted(real, (draft) => {
      draftScenario(draft, "reader").principal = "default";
    });
    finds(captureFindings(principal), 'reader was sent with principal "reader", not "default"');
    const expectation = planted(real, (draft) => {
      draftScenario(draft, "final-kill").expect.statuses = [200, 200, 200, 200];
    });
    finds(captureFindings(expectation), 'final-kill: statuses "200,200,400,200", expected "200,200,200,200"');
    const cloudOnly = planted(real, (draft) => {
      draftScenario(draft, "insert").targets = ["cloud"];
    });
    finds(captureFindings(cloudOnly), "insert is the capture of no scenario the local target runs");
  });
});
