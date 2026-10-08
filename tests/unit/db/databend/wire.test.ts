/**
 * The Databend HTTP transport on the real shared transport, against a local `node:http` server replaying the committed
 * captures (design section 8; C1): a statement end to end with the production deps, what reaches the wire and what
 * never does, a redirect that sends nothing to where it points, a compressed answer refused unread, and the hosts the
 * connection refuses before any socket.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { DatabaseConfigError } from "@/lib/db/errors";
import { createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import { type DatabendError, type DatabendTransport } from "@/lib/db/providers/sql/databend/transport";
import {
  capturedAnswer,
  statement,
  TEST_NODE,
  TEST_PASSWORD,
  TEST_USER,
  testOptions,
  wireIds,
} from "../../../helpers/databend-node-transport";
import { closeAll, gzipOfZeros, httpListener, type Listener } from "../../../helpers/node-transport-fixtures";

const transports: DatabendTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await closeAll();
});

function transportTo(listener: Listener): DatabendTransport {
  const transport = createDatabendHttpTransport(testOptions({ port: listener.port }), {
    latch: createAuthLatch({ now: Date.now }),
  });
  transports.push(transport);
  return transport;
}

function reply(response: ServerResponse, answer: { status: number; body: string; contentType?: string | null }) {
  response.writeHead(answer.status, { "content-type": answer.contentType ?? "application/json" });
  response.end(answer.body);
}

/** Replays the captured three-page SELECT for whatever ids the POST carried. */
function selectPages() {
  let values: Record<string, string> = {};
  return (request: IncomingMessage, response: ServerResponse) => {
    if (request.method === "POST") {
      const ids = wireIds(request.headers);
      values = {
        "<query-2>": ids.queryId,
        "<node-1>": TEST_NODE,
        '"session_id":""': `"session_id":"${ids.sessionId}"`,
      };
      reply(response, capturedAnswer("select-pages", 0, values));
      return;
    }
    const index = { "/page/1": 1, "/page/2": 2, "/final": 3 }[String(request.url).replace(/^\/v1\/query\/[^/]+/, "")];
    reply(response, capturedAnswer("select-pages", index ?? 3, values));
  };
}

describe("a statement end to end", () => {
  test("follows the captured pages over the wire with the production deps", async () => {
    const listener = await httpListener(selectPages());
    const outcome = await transportTo(listener).run(
      statement("SELECT number, to_string(number) AS text FROM numbers(25)"),
    );
    expect(outcome.rows).toHaveLength(25);
    expect(listener.seen.map((seen) => `${seen.method} ${seen.url.replace(/[0-9a-f]{32}/, "ID")}`)).toEqual([
      "POST /v1/query",
      "GET /v1/query/ID/page/1",
      "GET /v1/query/ID/page/2",
      "GET /v1/query/ID/final",
    ]);
  });

  test("sends Basic, the client caps, the client session and Studio's user-agent, and nothing it must not", async () => {
    const listener = await httpListener(selectPages());
    await transportTo(listener).run(statement("SELECT 1"));
    const [post, page] = listener.seen;
    expect(post.headers.authorization).toBe(`Basic ${Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`).toString("base64")}`);
    expect(post.headers["user-agent"]).toBe("libredb-studio/1.2.3");
    expect(post.headers["x-databend-client-caps"]).toBe("session_header");
    expect(post.headers["accept-encoding"]).toBe("identity");
    expect(post.headers["x-databend-query-id"]).toMatch(/^[0-9a-f]{32}$/);
    expect(post.headers["x-databend-route-hint"]).toMatch(/^rh:[0-9a-f-]{36}:\d{6}$/);
    expect(page.headers["x-databend-sticky-node"]).toBe(TEST_NODE);
    for (const seen of listener.seen) {
      for (const name of ["x-databend-tenant", "x-databend-node-id", "x-databend-auth-method", "cookie"]) {
        expect(seen.headers[name]).toBeUndefined();
      }
      expect(Object.keys(seen.headers).filter((name) => name.startsWith("x-forwarded"))).toEqual([]);
      expect(seen.headers["x-databend-deduplicate-label"]).toBeUndefined();
    }
  });
});

describe("C1", () => {
  test("a 302 elsewhere gets zero requests there, and the POST is not followed", async () => {
    const elsewhere = await httpListener((_request, response) => response.end("{}"));
    const listener = await httpListener((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${elsewhere.port}/v1/query` });
      response.end();
    });
    const error = (await transportTo(listener)
      .run(statement("SELECT 1"))
      .catch((caught: unknown) => caught)) as DatabendError;
    expect(error.category).toBe("redirect");
    expect(listener.seen).toHaveLength(1);
    expect(elsewhere.accepted()).toBe(0);
  });

  test("a gzip answer is refused unread", async () => {
    const zipped = await gzipOfZeros(1024);
    const listener = await httpListener((request, response) => {
      if (request.method === "POST" && request.url === "/v1/query") {
        response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
        response.end(zipped);
        return;
      }
      response.writeHead(200);
      response.end();
    });
    const error = (await transportTo(listener)
      .run(statement("SELECT 1"))
      .catch((caught: unknown) => caught)) as DatabendError;
    expect(error.category).toBe("encoding");
  });

  test.each(["a@b", "a/b", "127.1", "fe80::1%eth0"])("the host %s is refused with no socket", (host) => {
    expect(() => testOptions({ host })).toThrow(DatabaseConfigError);
  });
});
