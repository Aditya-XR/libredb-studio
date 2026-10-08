import { describe, expect, test } from "bun:test";
import {
  endOpenPlan,
  globalSettingsChangedWarning,
  newQueryId,
  ROLE_NOT_CARRIED,
  rollbackBody,
  rollbackNotice,
  SETTINGS_NOT_CARRIED,
  sessionHeader,
  sessionNotices,
  statementIds,
  TEMP_TABLES_DROPPED,
  TRANSACTION_ENDED,
  TRANSACTION_MAY_STAY_OPEN,
  USE_NOT_CARRIED,
} from "@/lib/db/providers/sql/databend/session";
import { secretForms, serverText } from "@/lib/db/utils/server-text";
import { TEST_PASSWORD } from "../../../helpers/databend-node-transport";

/** A connection with no password, whose secret forms are none. */
const NO_FORMS: readonly string[] = [];

const UUIDS = [
  "6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b",
  "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
  "00112233-4455-4677-8899-aabbccddeeff",
];

/** An injected id source answering the fixed UUIDs in order. */
function ids(): () => string {
  let next = 0;
  return () => UUIDS[next++] as string;
}

/** Decodes padded URL-safe base64 the way Databend's `URL_SAFE` engine does. */
function decodeUrlSafe(value: string): string {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
}

describe("per-statement ids", () => {
  test("the query id is the first id as 32 hex, the session id the second, the route hint carries the third", () => {
    expect(statementIds(ids(), 0.5)).toEqual({
      queryId: "6f1c2a3b4d5e4f608a7b9c0d1e2f3a4b",
      sessionId: "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
      routeHint: "rh:00112233-4455-4677-8899-aabbccddeeff:500000",
    });
  });

  test.each([
    [0, "000000"],
    [0.000001, "000001"],
    [1 - Number.EPSILON, "999999"],
  ])("the route hint nonce at random %p is the six digits %s", (random, nonce) => {
    expect(statementIds(ids(), random).routeHint).toBe(`rh:${UUIDS[2]}:${nonce}`);
  });

  test("with the production id source the query id is 32 hex and the route hint has bendsql's shape", () => {
    const generated = statementIds(() => crypto.randomUUID(), Math.random());
    expect(generated.queryId).toMatch(/^[0-9a-f]{32}$/);
    expect(generated.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(generated.routeHint).toMatch(/^rh:[0-9a-f-]{36}:\d{6,}$/);
  });

  test("a new query id, as the ROLLBACK POST takes, is 32 hex", () => {
    expect(newQueryId(ids())).toBe("6f1c2a3b4d5e4f608a7b9c0d1e2f3a4b");
  });
});

describe("the x-databend-session value", () => {
  test("is the exact JSON of the session id and the refresh time in unix seconds, in padded URL-safe base64", () => {
    const value = sessionHeader(UUIDS[1] as string, 1_759_900_000_999);
    expect(decodeUrlSafe(value)).toBe(`{"id":"${UUIDS[1]}","last_refresh_time":1759900000}`);
    expect(value).toMatch(/^[A-Za-z0-9_-]+={0,2}$/);
    expect(value.length % 4).toBe(0);
  });

  test("keeps the padding where the JSON length is not a multiple of three", () => {
    const value = sessionHeader("abc", 1000);
    expect(decodeUrlSafe(value)).toBe('{"id":"abc","last_refresh_time":1}');
    expect(value.endsWith("=")).toBe(true);
  });

  test("uses the URL-safe alphabet where standard base64 would give + and /", () => {
    const value = sessionHeader("ûÿ¿", 0);
    expect(value).not.toMatch(/[+/]/);
    expect(value).toMatch(/[-_]/);
    expect(decodeUrlSafe(value)).toBe('{"id":"ûÿ¿","last_refresh_time":0}');
  });
});

describe("the warnings of design 3.7", () => {
  test("none for a null affect and an unchanged role", () => {
    expect(sessionNotices(null, "account_admin", "account_admin", NO_FORMS)).toEqual([]);
  });

  test.each(["UseDB", "UseCatalog"] as const)("%s: USE does not carry over", (type) => {
    expect(sessionNotices({ type, name: "other" }, null, null, NO_FORMS)).toEqual([{ kind: "use-not-carried" }]);
  });

  test("a session-level SET or UNSET does not carry over (UNSET GLOBAL reports false)", () => {
    const affect = {
      type: "ChangeSettings",
      keys: ["max_threads", "timezone"],
      values: ["4", "UTC"],
      isGlobals: [false, false],
    } as const;
    expect(sessionNotices(affect, null, null, NO_FORMS)).toEqual([{ kind: "settings-not-carried" }]);
  });

  test("a true in is_globals names the keys SET GLOBAL changed for every session", () => {
    const affect = {
      type: "ChangeSettings",
      keys: ["max_threads", "timezone"],
      values: ["4", "UTC"],
      isGlobals: [true, true],
    } as const;
    expect(sessionNotices(affect, null, null, NO_FORMS)).toEqual([
      { kind: "global-settings-changed", keys: ["max_threads", "timezone"] },
    ]);
  });

  test("a mix gives both, the global one naming only the global keys", () => {
    const affect = {
      type: "ChangeSettings",
      keys: ["max_threads", "timezone"],
      values: ["4", "UTC"],
      isGlobals: [false, true],
    } as const;
    expect(sessionNotices(affect, null, null, NO_FORMS)).toEqual([
      { kind: "settings-not-carried" },
      { kind: "global-settings-changed", keys: ["timezone"] },
    ]);
  });

  test("each key SET GLOBAL changed passes serverText with the connection's forms and the refusal's cut (HASIM-D-5)", () => {
    const password = TEST_PASSWORD;
    const forms = secretForms([password, `reader:${password}`]);
    const affect = {
      type: "ChangeSettings",
      keys: [password, "k".repeat(400), "max_threads"],
      values: ["1", "2", "4"],
      isGlobals: [true, true, true],
    } as const;
    expect(sessionNotices(affect, null, null, forms)).toEqual([
      { kind: "global-settings-changed", keys: [serverText(password, forms), `${"k".repeat(300)}...`, "max_threads"] },
    ]);
  });

  test("a role unlike the connect probe's does not carry over", () => {
    expect(sessionNotices(null, "analyst", "account_admin", NO_FORMS)).toEqual([{ kind: "role-not-carried" }]);
  });

  test.each([
    [null, "account_admin"],
    ["analyst", null],
  ])("no role warning when the echoed role is %p and the probe's is %p", (role, probeRole) => {
    expect(sessionNotices(null, role, probeRole, NO_FORMS)).toEqual([]);
  });

  test("the affect and the role warnings together", () => {
    expect(sessionNotices({ type: "UseDB", name: "other" }, "analyst", "public", NO_FORMS)).toEqual([
      { kind: "use-not-carried" },
      { kind: "role-not-carried" },
    ]);
  });

  test("the sentences", () => {
    expect(USE_NOT_CARRIED).toBe(
      "USE succeeded, but each statement runs in its own session, so it does not carry over. Set Database on the connection, or qualify names.",
    );
    expect(SETTINGS_NOT_CARRIED).toBe(
      "Each statement runs in its own session, so a session-level SET or UNSET does not carry over. SET GLOBAL and UNSET GLOBAL change the setting for every session.",
    );
    expect(globalSettingsChangedWarning(["max_threads", "timezone"])).toBe(
      "SET GLOBAL changed max_threads, timezone for every session, and the change persists.",
    );
    expect(ROLE_NOT_CARRIED).toBe("SET ROLE does not carry over to the next statement.");
    expect(TRANSACTION_MAY_STAY_OPEN).toBe("The transaction may stay open until Databend's idle timeout (4 hours).");
    expect(TRANSACTION_ENDED).toBe(
      "The statement left a transaction open, and each statement runs in its own session, so Studio rolled it back.",
    );
    expect(TEMP_TABLES_DROPPED).toBe(
      "Each statement runs in its own session, so Studio ended it, which dropped the temporary tables it created.",
    );
  });
});

describe("the end-open plan of design 3.4", () => {
  test("an Active transaction is rolled back", () => {
    expect(endOpenPlan({ txnState: "Active", needKeepAlive: false })).toEqual(["rollback"]);
  });

  test("a Fail transaction needs nothing: only an Active one is kept", () => {
    expect(endOpenPlan({ txnState: "Fail", needKeepAlive: false })).toEqual([]);
  });

  test("an AutoCommit session with no temp table, or no session echoed, needs nothing", () => {
    expect(endOpenPlan({ txnState: "AutoCommit", needKeepAlive: false })).toEqual([]);
    expect(endOpenPlan({ txnState: null, needKeepAlive: false })).toEqual([]);
  });

  test("a temp table only: one logout", () => {
    expect(endOpenPlan({ txnState: "AutoCommit", needKeepAlive: true })).toEqual(["logout"]);
  });

  test("both: the rollback, then the logout", () => {
    expect(endOpenPlan({ txnState: "Active", needKeepAlive: true })).toEqual(["rollback", "logout"]);
  });

  test("a POST with no answer: a kill, then one logout [X13]", () => {
    expect(endOpenPlan(null)).toEqual(["kill", "logout"]);
  });
});

describe("the ROLLBACK", () => {
  test("carries the echoed session verbatim and a long poll of 2 s, inside the 5 s budget [X13]", () => {
    const session = {
      database: "default",
      role: "account_admin",
      txn_state: "Active",
      settings: { http_json_result_mode: "display" },
      internal: '{"opaque":true}',
      need_sticky: true,
    };
    expect(JSON.parse(rollbackBody(session))).toEqual({
      sql: "ROLLBACK",
      session,
      pagination: { wait_time_secs: 2 },
    });
  });

  const ROLLBACK_ID = "ffeeddccbbaa99887766554433221100";

  test("ended the transaction only when its own answer says AutoCommit", () => {
    expect(rollbackNotice(ROLLBACK_ID, { id: ROLLBACK_ID, txnState: "AutoCommit" })).toEqual({
      kind: "transaction-ended",
    });
  });

  test.each([
    ["another id", { id: "0123456789abcdef0123456789abcdef", txnState: "AutoCommit" }],
    ["a transaction still Active", { id: ROLLBACK_ID, txnState: "Active" }],
    ["a Fail state", { id: ROLLBACK_ID, txnState: "Fail" }],
    ["no session echoed", { id: ROLLBACK_ID, txnState: null }],
    ["no answer", null],
  ])("with %s the transaction may stay open", (_name, answer) => {
    expect(rollbackNotice(ROLLBACK_ID, answer)).toEqual({ kind: "transaction-may-stay-open" });
  });
});
