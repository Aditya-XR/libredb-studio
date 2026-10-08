/**
 * Resubmission on the real shared transport (design 3.11; C10; X13), against a local `node:http` server: a POST whose
 * socket dies after its body, or that is answered 503, is sent once and is `outcome-unknown`, then killed and logged
 * out; a gateway `ProvisionWarehouseTimeout` is resent once with the same id and body, after the production backoff.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import type { DatabendError, DatabendTransport } from "@/lib/db/providers/sql/databend/transport";
import { answerBody, statement, testOptions, wireIds } from "../../../helpers/databend-node-transport";
import { closeAll, httpListener, type Listener } from "../../../helpers/node-transport-fixtures";

const transports: DatabendTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await closeAll();
});

function transportTo(listener: Listener, random?: () => number): DatabendTransport {
  const transport = createDatabendHttpTransport(testOptions({ port: listener.port }), {
    latch: createAuthLatch({ now: Date.now }),
    ...(random === undefined ? {} : { random }),
  });
  transports.push(transport);
  return transport;
}

/** Answers kill and logout 200, and hands every statement POST to `post`, counting it. */
function server(post: (request: IncomingMessage, response: ServerResponse, count: number) => void) {
  let count = 0;
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.url === "/v1/query") {
      count += 1;
      post(request, response, count);
      return;
    }
    response.writeHead(200);
    response.end();
  };
}

const paths = (listener: Listener) => listener.seen.map((seen) => seen.url.replace(/[0-9a-f]{32}/, "ID"));

async function failure(promise: Promise<unknown>): Promise<DatabendError> {
  return (await promise.catch((caught: unknown) => caught)) as DatabendError;
}

describe("C10", () => {
  test("a POST whose socket is destroyed after its body is sent once, outcome-unknown, then killed and logged out", async () => {
    const listener = await httpListener(server((request) => request.socket.destroy()));
    const error = await failure(transportTo(listener).run(statement("INSERT INTO t VALUES (1)")));
    expect(error.category).toBe("outcome-unknown");
    expect(paths(listener)).toEqual(["/v1/query", "/v1/query/ID/kill", "/v1/session/logout"]);
  });

  test("a POST answered 503 is sent once, outcome-unknown", async () => {
    const listener = await httpListener(
      server((_request, response) => {
        response.writeHead(503);
        response.end();
      }),
    );
    const error = await failure(transportTo(listener).run(statement("INSERT INTO t VALUES (1)")));
    expect(error.category).toBe("outcome-unknown");
    expect(paths(listener).filter((path) => path === "/v1/query")).toHaveLength(1);
  });

  test("ProvisionWarehouseTimeout then 200: two POSTs, one id, one body, after the production sleep", async () => {
    const listener = await httpListener(
      server((request, response, count) => {
        response.writeHead(200, { "content-type": "application/json" });
        if (count === 1) {
          response.end(JSON.stringify({ kind: "ProvisionWarehouseTimeout", message: "resuming" }));
          return;
        }
        const ids = wireIds(request.headers);
        response.end(JSON.stringify(answerBody({ id: ids.queryId, session_id: ids.sessionId })));
      }),
    );
    const started = Date.now();
    // Random 0 makes the first backoff 800 ms, the shortest the jitter allows.
    await transportTo(listener, () => 0).run(statement("SELECT 1"));
    expect(Date.now() - started).toBeGreaterThanOrEqual(750);
    const [one, two] = listener.seen;
    expect(listener.seen).toHaveLength(2);
    expect(two.headers["x-databend-query-id"]).toBe(one.headers["x-databend-query-id"]);
    expect(two.headers["x-databend-session"]).toBe(one.headers["x-databend-session"]);
    expect(two.body).toBe(one.body);
  });
});
