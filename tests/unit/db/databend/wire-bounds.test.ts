/**
 * The bounds of design 3.12 on the real shared transport (C7), against a local `node:http` server: an answer past the
 * 16 MiB cap is cut, `too-large`, and killed; the poll bound stops a statement that never ends; and the row, cell and
 * text budgets cut the result and close it with one final.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createAuthLatch } from "@/lib/db/providers/sql/databend/auth-latch";
import { DATABEND_ERROR_SENTENCES as S, DATABEND_PROTOCOL_FAULTS as F } from "@/lib/db/providers/sql/databend/errors";
import { createDatabendHttpTransport } from "@/lib/db/providers/sql/databend/http-transport";
import type { DatabendError, DatabendTransport } from "@/lib/db/providers/sql/databend/transport";
import { answerBody, statement, TEST_NODE, testOptions, wireIds } from "../../../helpers/databend-node-transport";
import { closeAll, httpListener, type Listener, streamingAnswer } from "../../../helpers/node-transport-fixtures";

const transports: DatabendTransport[] = [];

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.close()));
  await closeAll();
});

function transportTo(listener: Listener, queryTimeout = 60_000): DatabendTransport {
  const transport = createDatabendHttpTransport(testOptions({ port: listener.port }, { queryTimeout }), {
    latch: createAuthLatch({ now: Date.now }),
  });
  transports.push(transport);
  return transport;
}

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * A server for one statement: the POST is answered by `pages[0]`, each page N by `pages[N + 1]`, the last one ending
 * the statement with the final link; final and kill answer 200.
 */
function statementServer(
  pages: readonly Record<string, unknown>[],
  onPage?: (n: number, response: ServerResponse) => boolean,
) {
  let ids = { queryId: "", sessionId: "" };
  const fields = (index: number) => ({
    id: ids.queryId,
    session_id: ids.sessionId,
    node_id: TEST_NODE,
    ...pages[index],
    next_uri: index + 1 < pages.length ? `/v1/query/${ids.queryId}/page/${index}` : `/v1/query/${ids.queryId}/final`,
  });
  return (request: IncomingMessage, response: ServerResponse): void => {
    if (request.method === "POST") {
      ids = wireIds(request.headers);
      json(response, answerBody(fields(0)));
      return;
    }
    const page = /\/page\/(\d+)$/.exec(String(request.url));
    if (page === null) {
      response.writeHead(200);
      response.end();
      return;
    }
    const n = Number(page[1]);
    if (onPage?.(n, response)) return;
    json(response, answerBody(fields(n + 1)));
  };
}

const kinds = (listener: Listener) =>
  listener.seen.map((seen) => /(query|page|final|kill)(\/\d+)?$/.exec(seen.url)?.[1]);

describe("C7", () => {
  test("an answer of 17 MiB is cut at 16 MiB, too-large, and the statement is killed", async () => {
    const listener = await httpListener(
      statementServer([{ state: "Running" }, {}], (_n, response) => {
        streamingAnswer(17 * 1024 * 1024)({} as IncomingMessage, response, "");
        return true;
      }),
    );
    const error = (await transportTo(listener)
      .run(statement("SELECT 1"))
      .catch((caught: unknown) => caught)) as DatabendError;
    expect(error.category).toBe("too-large");
    expect(kinds(listener)).toEqual(["query", "page", "kill"]);
  });

  test("past the poll bound the statement is protocol and killed", async () => {
    // A 5 s deadline: 105 polls, each answered with the same page again.
    let ids = { queryId: "", sessionId: "" };
    const listener = await httpListener((request, response) => {
      if (request.method === "POST") ids = wireIds(request.headers);
      if (String(request.url).endsWith("/kill")) {
        response.writeHead(200);
        response.end();
        return;
      }
      json(
        response,
        answerBody({
          id: ids.queryId,
          session_id: ids.sessionId,
          state: "Running",
          next_uri: `/v1/query/${ids.queryId}/page/0`,
        }),
      );
    });
    const error = (await transportTo(listener, 5000)
      .run(statement("SELECT 1"))
      .catch((caught: unknown) => caught)) as DatabendError;
    expect(error.message).toBe(S.protocol(F.pollBound));
    expect(listener.seen).toHaveLength(1 + 105 + 1);
    expect(kinds(listener).at(-1)).toBe("kill");
  });

  test("past the row cut the result is truncated and closed with one final", async () => {
    const schema = [{ name: "n", type: "UInt64" }];
    const rows = Array.from({ length: 11 }, (_, n) => [String(n)]);
    const listener = await httpListener(
      statementServer([
        { schema, data: rows },
        { schema, data: rows },
      ]),
    );
    const outcome = await transportTo(listener).run(statement("SELECT n FROM t", { rowCut: 10 }));
    expect(outcome.truncated).toEqual({ bound: "rows", limit: 10 });
    expect(kinds(listener)).toEqual(["query", "final"]);
  });

  test("past 250,000 cells the result is truncated and closed with one final", async () => {
    const schema = Array.from({ length: 100 }, (_, n) => ({ name: `c${n}`, type: "UInt8" }));
    const rows = Array.from({ length: 1500 }, () => Array.from({ length: 100 }, () => "1"));
    const listener = await httpListener(
      statementServer([
        { schema, data: rows },
        { schema, data: rows },
        { schema, data: rows },
      ]),
    );
    const outcome = await transportTo(listener).run(statement("SELECT * FROM wide", { rowCut: 100_000 }));
    expect(outcome.truncated).toEqual({ bound: "cells", limit: 250_000 });
    expect(outcome.rows).toHaveLength(2500);
    expect(kinds(listener)).toEqual(["query", "page", "final"]);
  });

  test("past 16 MiB of answer text the result is truncated and closed with one final", async () => {
    const schema = [{ name: "t", type: "String" }];
    // Two pages of 9 MiB: the second crosses the statement's 16 MiB and is dropped.
    const rows = Array.from({ length: 9 }, () => ["x".repeat(1024 * 1024 - 16)]);
    const listener = await httpListener(
      statementServer([
        { schema, data: rows },
        { schema, data: rows },
        { schema, data: rows },
      ]),
    );
    const outcome = await transportTo(listener).run(statement("SELECT t FROM big", { rowCut: 100_000 }));
    expect(outcome.truncated).toEqual({ bound: "bytes", limit: 16 * 1024 * 1024 });
    expect(outcome.rows).toHaveLength(9);
    expect(kinds(listener)).toEqual(["query", "page", "final"]);
  });
});
