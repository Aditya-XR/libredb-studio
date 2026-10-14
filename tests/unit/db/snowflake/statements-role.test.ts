/**
 * The role check `connect()` sends after its connect statement: what it sends, how it reads the role Snowflake runs
 * as and the secondary roles, and that no user statement sends it. M100 measured it to answer with the warehouse
 * suspended, leaving it suspended, and under a role holding no warehouse at all.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { AuthenticationError } from "@/lib/db/errors";
import { SNOWFLAKE_ERROR_SENTENCES, SnowflakeError, toDatabaseError } from "@/lib/db/providers/sql/snowflake/errors";
import {
  SNOWFLAKE_QUERY_TAGS,
  SNOWFLAKE_ROLE_CHECK_SQL,
  SNOWFLAKE_STATEMENT_SENTENCES,
  SNOWFLAKE_UNRESOLVED_CODES,
} from "@/lib/db/providers/sql/snowflake/statements";
import { logger } from "@/lib/logger";
import { failureAnswer } from "../../../helpers/snowflake-answers";
import {
  bodyOf,
  CONTEXT,
  caught,
  closeOpened,
  one,
  roleAnswer,
  SUBMIT,
  setup,
  submits,
} from "../../../helpers/snowflake-statements";

let warn: ReturnType<typeof spyOn>;
beforeAll(() => {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterAll(() => warn.mockRestore());
afterEach(closeOpened);

type Harness = ReturnType<typeof setup>;
const statementsSent = (harness: Harness): string[] => submits(harness).map((r) => bodyOf(r).statement as string);
const CAUTION = (roles: string) => ({ message: SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles(roles, CONTEXT.role) });

describe("what the check sends", () => {
  test("the check alone, tagged role-check, under the surface timeout, with the connection's context", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO"));
    expect(await harness.statements.checkRole()).toEqual([]);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL]);
    expect(bodyOf(submits(harness)[0])).toMatchObject({
      timeout: 30,
      role: "STUDIO_RO",
      warehouse: "STUDIO_WH",
      database: "SALES",
      schema: "PUBLIC",
      parameters: { query_tag: SNOWFLAKE_QUERY_TAGS.roleCheck },
    });
    // The permit wait's bound, then the statement's own deadline once it is sent.
    expect(harness.deps.deadlines.requested).toEqual([35_000, 35_000]);
  });

  test("with no Warehouse, the check carries no warehouse field", async () => {
    const harness = setup({ context: { ...CONTEXT, warehouse: undefined } });
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO"));
    await harness.statements.checkRole();
    expect(bodyOf(submits(harness)[0])).not.toHaveProperty("warehouse");
  });

  test("nothing is latched: each call sends the check again", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO"), roleAnswer("STUDIO_RO"));
    await harness.statements.checkRole();
    await harness.statements.checkRole();
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL, SNOWFLAKE_ROLE_CHECK_SQL]);
  });

  for (const sql of ["SELECT 1", "DESCRIBE TABLE t", "INSERT INTO t VALUES (1)", "CALL p()", "SHOW TABLES"]) {
    test(`${JSON.stringify(sql)} is sent alone, with no check before it`, async () => {
      const harness = setup();
      harness.transports.answer(SUBMIT, one());
      await harness.statements.runUser(sql, undefined);
      expect(statementsSent(harness)).toEqual([sql]);
    });
  }

  test("a failed check surfaces its own failure", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, failureAnswer(422, "002003", "Object does not exist."));
    const error = await caught(harness.statements.checkRole());
    expect(error).toBeInstanceOf(SnowflakeError);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL]);
  });
});

describe("the effective role", () => {
  test("another role is an auth failure naming both roles", async () => {
    const harness = setup({ context: { ...CONTEXT, role: "studio_ro" } });
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RW"));
    const error = await caught(harness.statements.checkRole());
    expect(error).toBeInstanceOf(SnowflakeError);
    expect((error as SnowflakeError).category).toBe("auth");
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("STUDIO_RW", "studio_ro"));
    expect(toDatabaseError(error)).toBeInstanceOf(AuthenticationError);
  });

  for (const [configured, answered] of [
    ['"Mixed Role"', "Mixed Role"],
    ["studio_ro", "STUDIO_RO"],
    ['"has ""quote"""', 'has "quote"'],
  ] as const) {
    test(`${configured} configured and ${answered} answered is no mismatch`, async () => {
      const harness = setup({ context: { ...CONTEXT, role: configured } });
      harness.transports.answer(SUBMIT, roleAnswer(answered));
      expect(await harness.statements.checkRole()).toEqual([]);
      // The body carries the role as Snowflake resolves it, the same fold the check compares with.
      expect(bodyOf(submits(harness)[0]).role).toBe(answered);
    });
  }

  test("a mismatch sentence never echoes a secret the answer holds", async () => {
    const harness = setup({ secrets: ["pat-secret"] });
    harness.transports.answer(SUBMIT, roleAnswer("pat-secret"));
    const error = await caught(harness.statements.checkRole());
    expect((error as SnowflakeError).message).not.toContain("pat-secret");
  });

  test("an answer with no rows is a mismatch", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, {
      status: 200,
      json: {
        statementHandle: "019c06a4-0000-df4f-0000-00100006589e",
        resultSetMetaData: { rowType: [], partitionInfo: [{}] },
        data: [],
      },
    });
    const error = await caught(harness.statements.checkRole());
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("", CONTEXT.role));
  });
});

describe("the signed-in user under token sign-in (SF-005)", () => {
  test("a token of another user is an auth failure naming both users, before any caution", async () => {
    const harness = setup({ failure: { authMethod: "pat", user: "SOMEONE_ELSE" } });
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", '{"roles":"STUDIO_RW","value":""}', "STUDIO_PAT"));
    const error = await caught(harness.statements.checkRole());
    expect(error).toBeInstanceOf(SnowflakeError);
    expect((error as SnowflakeError).category).toBe("auth");
    expect((error as SnowflakeError).message).toBe(
      SNOWFLAKE_ERROR_SENTENCES.tokenUserMismatch("STUDIO_PAT", "SOMEONE_ELSE"),
    );
    expect(toDatabaseError(error)).toBeInstanceOf(AuthenticationError);
  });

  test("the user rides in the role check: one statement, no request of its own", async () => {
    const harness = setup({ failure: { authMethod: "pat", user: "studio_pat" } });
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", undefined, "STUDIO_PAT"));
    expect(await harness.statements.checkRole()).toEqual([]);
    expect(statementsSent(harness)).toEqual([SNOWFLAKE_ROLE_CHECK_SQL]);
    expect(SNOWFLAKE_ROLE_CHECK_SQL).toContain("CURRENT_USER()");
  });

  for (const [typed, answered, same] of [
    ["studio_pat", "STUDIO_PAT", true],
    [" Studio_Pat ", "STUDIO_PAT", true],
    ["john.doe@example.com", "JOHN.DOE@EXAMPLE.COM", true],
    ['"Mixed User"', "Mixed User", true],
    ['"Mixed User"', "MIXED USER", false],
    ["studio_svc", "STUDIO_PAT", false],
  ] as const) {
    test(`User ${JSON.stringify(typed)} and ${answered} answered ${same ? "match" : "do not match"}`, async () => {
      const harness = setup({ failure: { authMethod: "pat", user: typed } });
      harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", undefined, answered));
      const outcome = harness.statements.checkRole();
      if (same) expect(await outcome).toEqual([]);
      else expect(((await caught(outcome)) as SnowflakeError).category).toBe("auth");
    });
  }

  test("a key pair signs in as the user it names, so the user cell is not compared", async () => {
    const harness = setup({ failure: { authMethod: "keypair", user: "STUDIO_SVC" } });
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", undefined, "SOMEONE_ELSE"));
    expect(await harness.statements.checkRole()).toEqual([]);
  });

  test("the user mismatch sentence never echoes a secret the answer holds", async () => {
    const harness = setup({ failure: { authMethod: "pat", user: "STUDIO" }, secrets: ["pat-secret"] });
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", undefined, "pat-secret"));
    const error = await caught(harness.statements.checkRole());
    expect((error as SnowflakeError).message).not.toContain("pat-secret");
  });
});

describe("a configured name Snowflake does not resolve (SF-019, D344)", () => {
  const S = SNOWFLAKE_STATEMENT_SENTENCES;
  const code = SNOWFLAKE_UNRESOLVED_CODES;

  test("each configured name answered NULL is cautioned, in field order, after the secondary roles", async () => {
    const harness = setup();
    harness.transports.answer(
      SUBMIT,
      roleAnswer("STUDIO_RO", '{"roles":"ANALYST","value":""}', undefined, { database: null, warehouse: null }),
    );
    expect(await harness.statements.checkRole()).toEqual([
      CAUTION("ANALYST"),
      { code: code.database, message: S.unresolvedDatabase("SALES", "STUDIO_RO") },
      { code: code.warehouse, message: S.unresolvedWarehouse("STUDIO_WH", "STUDIO_RO") },
    ]);
  });

  test("a schema answered NULL under a database that resolved is cautioned", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", undefined, undefined, { schema: null }));
    expect(await harness.statements.checkRole()).toEqual([
      { code: code.schema, message: S.unresolvedSchema("PUBLIC", "STUDIO_RO") },
    ]);
  });

  test("a field the connection leaves empty is not cautioned, whatever the check answers for it", async () => {
    const harness = setup({ context: { role: "STUDIO_RO", database: "", schema: undefined } });
    harness.transports.answer(
      SUBMIT,
      roleAnswer("STUDIO_RO", undefined, undefined, { database: null, schema: null, warehouse: null }),
    );
    expect(await harness.statements.checkRole()).toEqual([]);
  });

  test("names that resolved give no caution", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO"));
    expect(await harness.statements.checkRole()).toEqual([]);
  });
});

describe("secondary roles", () => {
  test("a non-empty value answers the caution", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", '{"roles":"ANALYST,LOADER","value":""}'));
    expect(await harness.statements.checkRole()).toEqual([CAUTION("ANALYST,LOADER")]);
  });

  for (const [label, value, expected] of [
    ["an empty roles string", '{"roles":"","value":""}', null],
    ["an object without roles", '{"value":"ALL"}', null],
    ["a null value", null, null],
    ["blank text", "   ", null],
    ["plain text", " ANALYST ", "ANALYST"],
    ["a JSON value that is not an object", '"ALL"', '"ALL"'],
  ] as const) {
    test(`${label} gives ${expected === null ? "no caution" : "the caution with the text"}`, async () => {
      const harness = setup();
      harness.transports.answer(SUBMIT, roleAnswer("STUDIO_RO", value));
      expect(await harness.statements.checkRole()).toEqual(expected === null ? [] : [CAUTION(expected)]);
    });
  }
});
