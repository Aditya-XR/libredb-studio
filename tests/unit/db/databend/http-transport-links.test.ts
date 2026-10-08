/**
 * Untrusted links and the poll bound (design 3.4, 3.9; C4; X25): `next_uri` is followed only as page N or final of our
 * own query id, rebuilt from the id Studio sent; any other link sends only the start and the kill and names neither
 * the link nor an id; a long-poll repeat of the current page is followed; more polls than the bound is protocol.
 */
import { describe, expect, test } from "bun:test";
import { DATABEND_ERROR_SENTENCES as S, DATABEND_PROTOCOL_FAULTS as F } from "@/lib/db/providers/sql/databend/errors";
import { NEXT_URI_REFUSED } from "@/lib/db/providers/sql/databend/routes";
import { DatabendError } from "@/lib/db/providers/sql/databend/transport";
import {
  idsOf,
  ok,
  pathsOf,
  type ScriptedStep,
  statement,
  testOptions,
  transportHarness,
} from "../../../helpers/databend-node-transport";

const FIRST = idsOf(1);
const P = pathsOf(FIRST.queryId);

async function failure(promise: Promise<unknown>): Promise<DatabendError> {
  const error = await promise.then(
    () => {
      throw new Error("expected the run to fail");
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DatabendError);
  return error as DatabendError;
}

describe("a refused link (C4)", () => {
  test.each([
    ["an absolute same-origin URL", `http://127.0.0.1:8000${P.page(1)}`],
    ["the state link", `/v1/query/${FIRST.queryId}`],
    ["another id", "/v1/query/0123456789abcdef0123456789abcdef/page/1"],
    ["a dot segment", `/v1/query/${FIRST.queryId}/page/../final`],
    ["a percent escape", `/v1/query/${FIRST.queryId}/page/%31`],
    ["a query string", `${P.page(1)}?x=1`],
    ["a protocol-relative URL", `//evil.test${P.page(1)}`],
    ["a page with a leading zero", P.page(1).replace("/1", "/01")],
  ])("%s sends only the start and the kill, and names neither the link nor the id", async (_label, link) => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: link }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    const error = await failure(transport.run(statement("SELECT 1")));
    script.expectDone();
    expect(error.category).toBe("protocol");
    expect(error.message).toBe(S.protocol(NEXT_URI_REFUSED));
    expect(error.message).not.toContain(FIRST.queryId);
    expect(error.message).not.toContain("/v1/");
  });

  test("a refused link after an Active session still ends the transaction", async () => {
    const session = { txn_state: "Active", settings: { http_json_result_mode: "display" } };
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { session, next_uri: "/elsewhere" }) },
      { method: "GET", path: P.kill, reply: { status: 200 } },
      { method: "POST", path: "/v1/query", reply: { status: 503 } },
    ]);
    await failure(transport.run(statement("BEGIN")));
    script.expectDone();
    expect(JSON.parse(script.requests[2].body as string).sql).toBe("ROLLBACK");
  });
});

describe("an accepted link", () => {
  test("a long-poll repeat of the current page is followed, then the next", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      {
        method: "GET",
        path: P.page(0),
        reply: ok(FIRST, { schema: [{ name: "a", type: "Int32" }], data: [["1"]], next_uri: P.page(1) }),
      },
      { method: "GET", path: P.page(1), reply: ok(FIRST, { next_uri: P.final }) },
      { method: "GET", path: P.final, reply: ok(FIRST) },
    ]);
    expect((await transport.run(statement("SELECT 1"))).rows).toEqual([["1"]]);
    script.expectDone();
  });

  test("a page answered with a body that does not parse is protocol, killed", async () => {
    const { script, transport } = transportHarness([
      { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
      { method: "GET", path: P.page(0), reply: { status: 200, body: "{" } },
      { method: "GET", path: P.kill, reply: { status: 200 } },
    ]);
    expect((await failure(transport.run(statement("SELECT 1")))).message).toBe(S.protocol(F.notJson));
    script.expectDone();
  });
});

describe("the poll bound (design 3.4) [13 #19]", () => {
  test("100 polls plus one per second of the deadline are followed; one more is protocol, killed", async () => {
    // A 1 s deadline: 101 polls.
    const repeat: ScriptedStep = {
      method: "GET",
      path: P.page(0),
      reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }),
    };
    const { script, transport } = transportHarness(
      [
        { method: "POST", path: "/v1/query", reply: ok(FIRST, { state: "Running", next_uri: P.page(0) }) },
        ...Array.from({ length: 101 }, () => repeat),
        { method: "GET", path: P.kill, reply: { status: 200 } },
      ],
      { options: testOptions({}, { queryTimeout: 1000 }) },
    );
    const error = await failure(transport.run(statement("SELECT sleep(100)")));
    script.expectDone();
    expect(error.message).toBe(S.protocol(F.pollBound));
    expect(script.requests).toHaveLength(103);
  });
});
