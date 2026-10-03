/**
 * createNodeTransport over plaintext, against local listeners (vector-family spec 3.7).
 *
 * Each transport here is one connection: its own keep-alive Agent with at most `maxSockets` sockets, the connection's
 * headers plus `accept-encoding: identity` on every request, and nothing through the global agent. The listeners count
 * the connections they accept and record every request that reaches them, so "nothing was sent" is measured.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import http from "node:http";
import https from "node:https";
import { DatabaseConfigError } from "@/lib/db/errors";
import { endpointUrl, httpOrigin } from "@/lib/db/http/endpoint";
import {
  createNodeTransport,
  type NodeRequest,
  type NodeTransport,
  type NodeTransportOptions,
  TransportError,
} from "@/lib/db/http/node-transport";
import {
  closeAll,
  eventually,
  httpListener,
  jsonAnswer,
  type Listener,
} from "../../../helpers/node-transport-fixtures";

const SECRET = "node-transport-secret-key";
const MIB = 1024 * 1024;
const CLOSED = "The connection was closed, so the request did not complete";
const FOREIGN_URL = "Invalid host: the request URL would not address the configured host, so it was not sent";

const transports: NodeTransport[] = [];
afterEach(async () => {
  for (const transport of transports.splice(0)) transport.close();
  await closeAll();
});

function connect(listener: Listener, overrides: Partial<NodeTransportOptions> = {}) {
  const origin = httpOrigin("http", "127.0.0.1", listener.port);
  const transport = createNodeTransport({
    origin,
    tls: null,
    maxSockets: 4,
    headers: { "api-key": SECRET },
    ...overrides,
  });
  transports.push(transport);
  return { transport, url: (path: string, params?: URLSearchParams) => endpointUrl(origin, path, params) };
}

function get(url: string, extra: Partial<NodeRequest> = {}): NodeRequest {
  return { method: "GET", url, signal: AbortSignal.timeout(5000), maxResponseBytes: MIB, ...extra };
}

async function failure(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
}

/** An Agent with addRequest, the method every request through it calls, which @types/node leaves out. */
function withAddRequest(agent: http.Agent): http.Agent & { addRequest(...args: unknown[]): void } {
  return agent as http.Agent & { addRequest(...args: unknown[]): void };
}

function refusal(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to throw");
}

describe("a request and its answer", () => {
  test("a GET returns status, content type, Retry-After and text, with the connection's headers and accept-encoding identity", async () => {
    const listener = await httpListener(jsonAnswer(200, '{"result":{"collections":[]}}'));
    const { transport, url } = connect(listener);
    const answer = await transport.request(get(url("/collections", new URLSearchParams({ limit: "1" }))));
    expect(answer).toEqual({
      status: 200,
      contentType: "application/json",
      retryAfter: null,
      text: '{"result":{"collections":[]}}',
    });
    expect(listener.seen.map(({ method, url: path }) => ({ method, path }))).toEqual([
      { method: "GET", path: "/collections?limit=1" },
    ]);
    expect(listener.seen[0].headers["api-key"]).toBe(SECRET);
    expect(listener.seen[0].headers["accept-encoding"]).toBe("identity");
  });

  test("a POST sends its body as UTF-8 JSON with its byte length", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const body = '{"name":"çğış","limit":10}';
    await transport.request({ ...get(url("/collections/c/points/scroll")), method: "POST", body });
    const [seen] = listener.seen;
    expect(seen.body).toBe(body);
    expect(seen.headers["content-type"]).toBe("application/json");
    expect(seen.headers["content-length"]).toBe(String(Buffer.byteLength(body, "utf8")));
  });

  test("a caller's accept-encoding is replaced whatever its case, and the other headers arrive as set", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener, { headers: { "Accept-Encoding": "gzip, br", "API-Key": SECRET } });
    await transport.request(get(url("/")));
    expect(listener.seen[0].headers["accept-encoding"]).toBe("identity");
    expect(listener.seen[0].headers["api-key"]).toBe(SECRET);
  });

  test.each([
    ["10", "10"],
    ["Wed, 21 Oct 2026 07:28:00 GMT", "Wed, 21 Oct 2026 07:28:00 GMT"],
    ["9".repeat(200), "9".repeat(64)],
  ])("a 429 carrying Retry-After %p yields retryAfter %p", async (header, expected) => {
    const listener = await httpListener(
      jsonAnswer(429, '{"status":{"error":"rate limited"}}', { "retry-after": header }),
    );
    const { transport, url } = connect(listener);
    const answer = await transport.request(get(url("/collections")));
    expect(answer.status).toBe(429);
    expect(answer.retryAfter).toBe(expected);
  });

  test("a 429 with no Retry-After yields null", async () => {
    const listener = await httpListener(jsonAnswer(429, '{"status":{"error":"rate limited"}}'));
    const { transport, url } = connect(listener);
    expect((await transport.request(get(url("/collections")))).retryAfter).toBeNull();
  });
});

describe("one keep-alive Agent per connection", () => {
  test("at most maxSockets sockets, reused across requests", async () => {
    const listener = await httpListener((request, response, body) => {
      setTimeout(() => jsonAnswer(200, "{}")(request, response, body), 30);
    });
    const { transport, url } = connect(listener, { maxSockets: 2 });
    await Promise.all([1, 2, 3].map(() => transport.request(get(url("/")))));
    for (let i = 0; i < 5; i += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each reuses an idle socket.
      await transport.request(get(url("/")));
    }
    expect(listener.seen).toHaveLength(8);
    expect(listener.accepted()).toBe(2);
  });

  test("two connections are two Agents and share no socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const first = connect(listener);
    const second = connect(listener);
    await first.transport.request(get(first.url("/")));
    await second.transport.request(get(second.url("/")));
    await first.transport.request(get(first.url("/")));
    expect(listener.accepted()).toBe(2);
  });

  test("never the global agent: the spies on http.globalAgent and https.globalAgent see nothing, and do see a request that takes it", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const httpSpy = spyOn(withAddRequest(http.globalAgent), "addRequest");
    const httpsSpy = spyOn(withAddRequest(https.globalAgent), "addRequest");
    try {
      const { transport, url } = connect(listener);
      await transport.request(get(url("/")));
      expect(httpSpy).toHaveBeenCalledTimes(0);
      expect(httpsSpy).toHaveBeenCalledTimes(0);
      // The control: a request with no agent takes the global one, and the spy sees it.
      await new Promise<void>((resolve, reject) => {
        http
          .get({ hostname: "127.0.0.1", port: listener.port, path: "/control" }, (answer) => {
            answer.resume();
            answer.on("end", () => resolve());
          })
          .on("error", reject);
      });
      expect(httpSpy).toHaveBeenCalledTimes(1);
    } finally {
      httpSpy.mockRestore();
      httpsSpy.mockRestore();
    }
  });

  test("close() destroys the Agent: its idle socket closes, and a later request is refused with no socket", async () => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    await transport.request(get(url("/")));
    transport.close();
    await eventually(() => listener.open() === 0, "the idle socket to close");
    const error = await failure(() => transport.request(get(url("/"))));
    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).kind).toBe("aborted");
    expect(error.message).toBe(CLOSED);
    expect(listener.accepted()).toBe(1);
  });
});

describe("refused before any socket", () => {
  test.each([
    ["another port on the same host", (port: number) => `http://127.0.0.1:${port + 1}/`],
    ["another scheme", (port: number) => `https://127.0.0.1:${port}/`],
    [
      "userinfo, which would become an Authorization header",
      (port: number) => `http://user:${SECRET}@127.0.0.1:${port}/`,
    ],
    ["a text that is not a URL", () => `not a url ${SECRET}`],
  ])("a URL with %s", async (_label, build) => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport } = connect(listener);
    const error = await failure(() => transport.request(get(build(listener.port))));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(FOREIGN_URL);
    expect(listener.accepted()).toBe(0);
  });

  test.each([0, -1, 1.5, Number.NaN])("a maxResponseBytes of %p", async (maxResponseBytes) => {
    const listener = await httpListener(jsonAnswer(200, "{}"));
    const { transport, url } = connect(listener);
    const error = await failure(() => transport.request(get(url("/"), { maxResponseBytes })));
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid maxResponseBytes: expected a positive integer");
    expect(listener.accepted()).toBe(0);
  });

  test.each([0, -1, 2.5, Number.POSITIVE_INFINITY])("a maxSockets of %p", (maxSockets) => {
    const error = refusal(() =>
      createNodeTransport({ origin: httpOrigin("http", "127.0.0.1", 6333), tls: null, maxSockets, headers: {} }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe("Invalid maxSockets: expected a positive integer");
  });

  test.each([
    ["an https origin with no TLS material", "https" as const, null],
    ["an http origin with TLS material", "http" as const, { rejectUnauthorized: true, identity: "127.0.0.1" }],
  ])("%s", (_label, scheme, tls) => {
    const error = refusal(() =>
      createNodeTransport({ origin: httpOrigin(scheme, "127.0.0.1", 6333), tls, maxSockets: 1, headers: {} }),
    );
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(
      "Invalid TLS settings: an https origin needs TLS material, and an http origin takes none",
    );
  });
});
