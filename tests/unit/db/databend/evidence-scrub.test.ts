/**
 * The evidence scrub of the Databend harness (design 8, C23): what tests/live/databend-evidence.ts may write under
 * tests/fixtures/databend/. Only allow-listed fields and headers are kept; query, session and node ids, IP addresses,
 * user names and the tenant become stable placeholders; and no file is written while any of them holds a secret
 * form, the host, the tenant, the warehouse, the region, an email address or the egress IP.
 */
import { describe, expect, test } from "bun:test";
import {
  EVIDENCE_LEAK_SENTENCE,
  EvidenceLeakError,
  EvidenceScrubber,
  type EvidenceSecrets,
  type RawExchange,
  redactForTerminal,
} from "../../../helpers/databend-evidence-scrub";

const QUERY = "01a1187f71477350a2d078634d6b91c7";
const QUERY_2 = "01a118802a6c7b918b939cd32f1a013c";
const SESSION = "fe8bb136-5d18-4388-98c9-4343f600dbdc";
const NODE = "GCrXmmQJ9S9bmhAYmzOgd6";
const PASSWORD = "Probe123pass!";

const SECRETS: EvidenceSecrets = {
  users: [
    { user: "libredb", password: PASSWORD },
    { user: "studio_reader", password: "Reader123pass!" },
  ],
};

const CLOUD: EvidenceSecrets = {
  ...SECRETS,
  host: "tn3ftqihs--ingest.gw.aws-us-east-2.default.databend.com",
  tenant: "tn3ftqihs",
  warehouse: "ingest",
  region: "aws-us-east-2",
  egressIp: "203.0.113.7",
};

const sessionHeader = (id: string, extra: Record<string, string> = {}): string =>
  Buffer.from(JSON.stringify({ id, last_refresh_time: 1791412367, ...extra })).toString("base64url");

function answer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: QUERY,
    session_id: SESSION,
    node_id: NODE,
    state: "Succeeded",
    session: {
      catalog: "default",
      database: "default",
      role: "account_admin",
      settings: {},
      txn_state: "AutoCommit",
      need_sticky: true,
      need_keep_alive: true,
      internal: JSON.stringify({ has_temp_table: true, last_node_id: NODE, last_query_ids: [QUERY] }),
      future_field: "dropped",
    },
    error: null,
    warnings: [],
    has_result_set: false,
    schema: [],
    data: [],
    affect: null,
    result_timeout_secs: 60,
    settings: { timezone: "UTC", http_json_result_mode: "display" },
    stats: { running_time_ms: 9 },
    stats_uri: `/v1/query/${QUERY}`,
    final_uri: `/v1/query/${QUERY}/final`,
    next_uri: `/v1/query/${QUERY}/final`,
    kill_uri: `/v1/query/${QUERY}/kill`,
    unknown_top_level: 1,
    ...overrides,
  });
}

function exchange(body: string = answer(), extra: Partial<RawExchange> = {}): RawExchange {
  return {
    request: {
      method: "POST",
      path: "/v1/query",
      headers: {
        authorization: `Basic ${Buffer.from(`libredb:${PASSWORD}`).toString("base64")}`,
        "content-type": "application/json",
        "x-databend-client-caps": "session_header",
        "x-databend-session": sessionHeader(SESSION),
        "user-agent": "curl/8",
      },
      body: { sql: "SELECT 1", pagination: { wait_time_secs: 10 }, extra: "dropped" },
    },
    response: {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-databend-query-id": QUERY,
        "x-databend-query-state": "Succeeded",
        "x-databend-session-id": SESSION,
        "x-databend-session": sessionHeader(SESSION),
        "x-databend-version": "1.2.951-nightly",
        date: "Wed, 07 Oct 2026 22:32:47 GMT",
        "set-cookie": "x=1",
      },
      body,
    },
    ...extra,
  };
}

function leakOf(action: () => unknown): EvidenceLeakError {
  try {
    action();
  } catch (error) {
    if (error instanceof EvidenceLeakError) return error;
    throw error;
  }
  throw new Error("no leak was reported");
}

describe("the allow-list", () => {
  test("keeps the named request and response headers and drops the rest, authorization first", () => {
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(exchange());
    expect(Object.keys(scrubbed.request.headers).sort()).toEqual([
      "content-type",
      "x-databend-client-caps",
      "x-databend-session",
    ]);
    expect(Object.keys(scrubbed.response.headers).sort()).toEqual([
      "content-type",
      "x-databend-query-id",
      "x-databend-query-state",
      "x-databend-session",
      "x-databend-session-id",
      "x-databend-version",
    ]);
  });

  test("keeps the warehouse header, the tenant's own warehouse as <warehouse> and any other name as sent", () => {
    const sent = (warehouse: string): RawExchange => {
      const raw = exchange();
      return {
        ...raw,
        request: { ...raw.request, headers: { ...raw.request.headers, "X-Databend-Warehouse": warehouse } },
      };
    };
    const scrubber = new EvidenceScrubber(CLOUD);
    expect(scrubber.exchange(sent("ingest")).request.headers["x-databend-warehouse"]).toBe("<warehouse>");
    expect(scrubber.exchange(sent("studio_no_such_wh")).request.headers["x-databend-warehouse"]).toBe(
      "studio_no_such_wh",
    );
    const stock = new EvidenceScrubber({ ...CLOUD, warehouse: "default" });
    expect(stock.exchange(sent("default")).request.headers["x-databend-warehouse"]).toBe("default");
    expect(scrubber.exchange(exchange()).request.headers).not.toHaveProperty("x-databend-warehouse");
  });

  test("keeps the named body fields, nested ones included, and lists the names it dropped", () => {
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(exchange());
    const body = scrubbed.response.body as Record<string, unknown>;
    expect(body.unknown_top_level).toBeUndefined();
    expect((body.session as Record<string, unknown>).future_field).toBeUndefined();
    expect((body.session as Record<string, unknown>).need_keep_alive).toBe(true);
    expect(scrubbed.response.dropped).toEqual(["session.future_field", "unknown_top_level"]);
    expect(scrubbed.request.body).toEqual({ sql: "SELECT 1", pagination: { wait_time_secs: 10 } });
    expect(scrubbed.request.dropped).toEqual(["extra"]);
  });

  test("keeps an error answer's code and message", () => {
    const body = JSON.stringify({ error: { code: 5100, message: "Authentication failed: incorrect password" } });
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(exchange(body));
    expect(scrubbed.response.body).toEqual({
      error: { code: 5100, message: "Authentication failed: incorrect password" },
    });
  });

  test("keeps the Databend Cloud gateway's kind, nested under error with its message (I19)", () => {
    const body = JSON.stringify({ error: { kind: "BadWarehouse", message: "bad warehouse", trace: "dropped" } });
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(exchange(body));
    expect(scrubbed.response.body).toEqual({ error: { kind: "BadWarehouse", message: "bad warehouse" } });
    expect(scrubbed.response.dropped).toEqual(["error.trace"]);
  });

  test("keeps a body that is not JSON as text, through the same placeholders", () => {
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(exchange(`gateway 10.0.0.12 says no`));
    expect(scrubbed.response.body).toEqual({ text: "gateway <ip-1> says no" });
    expect(scrubbed.response.dropped).toEqual([]);
  });

  test("keeps a request with no body without one", () => {
    const raw = exchange();
    const scrubbed = new EvidenceScrubber(SECRETS).exchange({
      ...raw,
      request: { method: "GET", path: `/v1/query/${QUERY}/kill`, headers: {} },
    });
    expect(scrubbed.request).toEqual({ method: "GET", path: "/v1/query/<query-1>/kill", headers: {}, dropped: [] });
  });
});

describe("the placeholders", () => {
  test("replace query, session and node ids everywhere, stable across exchanges", () => {
    const scrubber = new EvidenceScrubber(SECRETS);
    const first = JSON.stringify(scrubber.exchange(exchange()));
    const second = scrubber.exchange(
      exchange(answer({ id: QUERY_2, next_uri: `/v1/query/${QUERY_2}/page/1?node_id=${NODE}` })),
    );
    for (const id of [QUERY, QUERY_2, SESSION, NODE]) expect(JSON.stringify(second)).not.toContain(id);
    expect(first).not.toContain(QUERY);
    expect(first).toContain('"id":"<query-1>"');
    expect(first).toContain('"session_id":"<session-1>"');
    expect(first).toContain('"node_id":"<node-1>"');
    expect(first).toContain("/v1/query/<query-1>/kill");
    const body = second.response.body as { id: string; next_uri: string; session: { internal: string } };
    expect(body.id).toBe("<query-2>");
    expect(body.next_uri).toBe("/v1/query/<query-2>/page/1?node_id=<node-1>");
    expect(JSON.parse(body.session.internal)).toEqual({
      has_temp_table: true,
      last_node_id: "<node-1>",
      last_query_ids: ["<query-1>"],
    });
  });

  test("decode the session header, replace its id and encode it again, padded as Databend requires", () => {
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(exchange());
    for (const header of [scrubbed.request.headers, scrubbed.response.headers]) {
      expect(header["x-databend-session"]).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
      expect(header["x-databend-session"].length % 4).toBe(0);
      const decoded = JSON.parse(Buffer.from(header["x-databend-session"], "base64url").toString("utf8"));
      expect(decoded).toEqual({ id: "<session-1>", last_refresh_time: 1791412367 });
    }
  });

  test("replace a session header that is not base64 JSON whole", () => {
    const raw = exchange();
    const scrubbed = new EvidenceScrubber(SECRETS).exchange({
      ...raw,
      request: { ...raw.request, headers: { "x-databend-session": "not-json" } },
    });
    expect(scrubbed.request.headers["x-databend-session"]).toBe("<session-header>");
  });

  test("replace IPv4 and IPv6 addresses, and leave timestamps, versions and a cast alone", () => {
    const text = "from 10.1.2.3 and 2001:db8::7 and fe80:0:0:0:0:0:0:1 at 12:34:56.789 on v1.2.951 'NaN'::DOUBLE";
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(
      exchange(answer({ error: { code: 1, message: text }, state: "Failed" })),
    );
    expect((scrubbed.response.body as { error: { message: string } }).error.message).toBe(
      "from <ip-1> and <ip-2> and <ip-3> at 12:34:56.789 on v1.2.951 'NaN'::DOUBLE",
    );
  });

  test("replace each user name as a whole word, so a database named after it is kept", () => {
    const message = "Permission denied: user 'studio_reader'@'%' on libredb_demo, as libredb";
    const scrubbed = new EvidenceScrubber(SECRETS).exchange(
      exchange(answer({ error: { code: 1063, message }, state: "Failed" })),
    );
    expect((scrubbed.response.body as { error: { message: string } }).error.message).toBe(
      "Permission denied: user '<user-2>'@'%' on libredb_demo, as <user-1>",
    );
  });

  test("replace the tenant", () => {
    const scrubber = new EvidenceScrubber({ ...SECRETS, tenant: "tn3ftqihs" });
    const scrubbed = scrubber.exchange(exchange(answer({ error: { code: 1, message: "tenant tn3ftqihs" } })));
    expect((scrubbed.response.body as { error: { message: string } }).error.message).toBe("tenant <tenant>");
  });
});

describe("nothing is written on a leak", () => {
  const forms: readonly [string, string][] = [
    ["password", PASSWORD],
    ["password", "Probe123pass%21"],
    ["password", "Reader123pass!"],
    ["password", `secret=${Buffer.from(PASSWORD).toString("base64")}`],
    ["credential", Buffer.from(`studio_reader:Reader123pass!`).toString("base64")],
    ["credential", `token ${Buffer.from(`studio_reader:Reader123pass!`).toString("base64url")} end`],
    ["credential", `libredb:${PASSWORD}`],
    ["host", CLOUD.host as string],
    ["host", (CLOUD.host as string).toUpperCase()],
    ["tenant", "TN3FTQIHS"],
    ["warehouse", "ingest"],
    ["region", "AWS-US-EAST-2"],
    ["email", "someone@example.com"],
    ["egress IP", "203-0-113-7"],
  ];

  for (const [label, value] of forms) {
    test(`a ${label} form stops every file, and the error never repeats it (${label})`, () => {
      const scrubber = new EvidenceScrubber(CLOUD);
      const clean = scrubber.exchange(exchange());
      const dirty = { message: `seen ${value} here` };
      const error = leakOf(() => scrubber.render({ "a.json": clean, "b.json": dirty }));
      expect(error.message).toBe(EVIDENCE_LEAK_SENTENCE);
      expect(error.findings).toContain(`b.json holds the ${label}`);
      expect(error.findings.every((finding) => finding.startsWith("b.json "))).toBe(true);
      expect(JSON.stringify(error.findings)).not.toContain(value);
    });
  }

  test("the egress IP in dotted form is replaced before the scan, and found when it survives in another form", () => {
    const scrubber = new EvidenceScrubber(CLOUD);
    const rendered = scrubber.render({ "a.json": { from: "203.0.113.7" } });
    expect(rendered["a.json"]).toContain("<ip-1>");
  });

  test("a secret inside the session header's base64 is found", () => {
    const scrubber = new EvidenceScrubber(SECRETS);
    const raw = exchange();
    const scrubbed = scrubber.exchange({
      ...raw,
      request: { ...raw.request, headers: { "x-databend-session": sessionHeader(SESSION, { note: `x ${PASSWORD}` }) } },
    });
    expect(leakOf(() => scrubber.render({ "a.json": scrubbed })).findings).toContain("a.json holds the password");
  });

  test("a password used as a key, which the allow-list keeps inside a whole field, is found", () => {
    const scrubber = new EvidenceScrubber(SECRETS);
    const session = { catalog: "default", settings: { [PASSWORD]: "1" } };
    const scrubbed = scrubber.exchange(exchange(answer({ session })));
    expect(JSON.stringify(scrubbed)).toContain(PASSWORD);
    const error = leakOf(() => scrubber.render({ "a.json": scrubbed }));
    expect(error.findings).toEqual(["a.json holds the password"]);
  });

  // A quote and a backslash are escaped inside a JSON text, so the password is there only in its escaped spelling.
  const ESCAPED: EvidenceSecrets = { users: [{ user: "libredb", password: 'Pro"be\\12' }] };

  test.each([
    ["a JSON-encoded message", (inner: string) => inner],
    ["a message wrapping one as the Cloud gateway does", (inner: string) => `status: 401, message: ${inner}: denied`],
  ])("a password holding a quote and a backslash in %s is found", (_case, wrap) => {
    const scrubber = new EvidenceScrubber(ESCAPED);
    const inner = JSON.stringify({ error: { code: 1063, message: `bad password 'Pro"be\\12'` } });
    const scrubbed = scrubber.exchange(
      exchange(answer({ error: { code: 401, message: wrap(inner) }, state: "Failed" })),
    );
    const error = leakOf(() => scrubber.render({ "a.json": scrubbed }));
    expect(error.findings).toEqual(["a.json holds the password"]);
  });

  test("a password used as a key inside a JSON-encoded string is found", () => {
    const scrubber = new EvidenceScrubber(ESCAPED);
    const dirty = { note: JSON.stringify({ settings: { 'Pro"be\\12': "1" } }) };
    expect(leakOf(() => scrubber.render({ "b.json": dirty })).findings).toEqual(["b.json holds the password"]);
  });

  test("a JSON text is read decoded, so a password in any escaped spelling of it is found, base64 inside included", () => {
    const scrubber = new EvidenceScrubber(ESCAPED);
    // The quote and the backslash are JSON unicode escapes here, so only parsing the text gives the password back.
    const unicode = '{"m": "Pro\\u0022be\\u005c12"}';
    expect(unicode).not.toContain('Pro"be');
    expect(leakOf(() => scrubber.render({ "c.json": { note: unicode } })).findings).toEqual([
      "c.json holds the password",
    ]);
    const layered = Buffer.from(JSON.stringify({ note: unicode })).toString("base64");
    expect(leakOf(() => scrubber.render({ "d.json": { header: layered } })).findings).toEqual([
      "d.json holds the password",
    ]);
  });

  test("a clean set renders every file as indented JSON with a final newline", () => {
    const scrubber = new EvidenceScrubber(SECRETS);
    const rendered = scrubber.render({ "a.json": scrubber.exchange(exchange()), "manifest.json": { ok: true } });
    expect(Object.keys(rendered)).toEqual(["a.json", "manifest.json"]);
    expect(rendered["manifest.json"]).toBe('{\n  "ok": true\n}\n');
  });

  test("a warehouse named default, Databend Cloud's stock name, is not looked for, since every catalog is named so", () => {
    const scrubber = new EvidenceScrubber({ ...CLOUD, warehouse: "default" });
    const rendered = scrubber.render({ "a.json": { catalog: "default", database: "DEFAULT" } });
    expect(rendered["a.json"]).toContain('"catalog": "default"');
    expect(leakOf(() => scrubber.render({ "b.json": { seen: CLOUD.host } })).findings).toContain(
      "b.json holds the host",
    );
  });

  test("a local run without cloud names checks only the credentials and email addresses", () => {
    const scrubber = new EvidenceScrubber(SECRETS);
    expect(scrubber.render({ "a.json": { word: "ingest" } })["a.json"]).toContain("ingest");
  });
});

describe("a line for the operator's terminal", () => {
  test("names no password, credential, host, tenant, region, warehouse or egress IP, in any case", () => {
    const line = [
      `getaddrinfo ENOTFOUND ${CLOUD.host}`,
      "Hostname/IP does not match certificate's altnames: DNS:*.gw.AWS-US-EAST-2.default.databend.com",
      `tenant TN3FTQIHS, warehouse ingest, password ${PASSWORD}`,
      `Basic ${Buffer.from(`studio_reader:Reader123pass!`).toString("base64")}`,
      "from 203.0.113.7",
    ].join("\n");
    const redacted = redactForTerminal(line, CLOUD);
    for (const value of [
      CLOUD.host as string,
      "tn3ftqihs",
      "aws-us-east-2",
      "ingest",
      PASSWORD,
      "Reader123pass!",
      Buffer.from(`studio_reader:Reader123pass!`).toString("base64"),
      "203.0.113.7",
    ])
      expect(redacted.toLowerCase()).not.toContain(value.toLowerCase());
    expect(redacted).toContain("getaddrinfo ENOTFOUND <host>");
    expect(redacted).toContain("DNS:*.gw.<region>.default.databend.com");
    expect(redacted).toContain("tenant <tenant>, warehouse <warehouse>, password <password>");
  });

  test("names no password escaped inside a JSON text either, as a server's JSON error carries one", () => {
    const line = `Error: ${JSON.stringify({ message: `bad password 'Pro"be\\12'` })}`;
    expect(line).toContain('Pro\\"be\\\\12');
    const redacted = redactForTerminal(line, { users: [{ user: "libredb", password: 'Pro"be\\12' }] });
    expect(redacted).not.toContain("Pro");
    expect(redacted).toContain("bad password '<password>'");
  });

  test("leaves the stock warehouse name default and a local run's text alone", () => {
    expect(redactForTerminal("catalog default", { ...CLOUD, warehouse: "default" })).toBe("catalog default");
    expect(redactForTerminal("connect ECONNREFUSED 127.0.0.1:8000", SECRETS)).toBe(
      "connect ECONNREFUSED 127.0.0.1:8000",
    );
  });
});
