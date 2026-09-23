/**
 * Search HTTP transport endpoints (Elasticsearch and OpenSearch)
 *
 * The rest of this transport is exercised through the two provider suites under
 * tests/integration/db. This file pins only how its URLs are built: the host and
 * port are validated when the transport is constructed, and a redirect is refused
 * rather than followed.
 *
 * globalThis.fetch is replaced per test and restored in afterEach; mock.module()
 * is deliberately not used, since it is process-wide in bun.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string) => Response;

const VERSION_BODY = JSON.stringify({ version: { number: "9.1.0" } });

function makeConnection(type: DatabaseType, overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: "search-1", name: "Search", type, host: "127.0.0.1", port: 9200, createdAt: new Date(), ...overrides };
}

beforeEach(() => {
  calls = [];
  handler = () => new Response(VERSION_BODY, { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.each(["elasticsearch", "opensearch"] as const)("SearchHttpTransport (%s) endpoint", (dialect) => {
  function makeTransport(overrides: Partial<DatabaseConnection> = {}): SearchHttpTransport {
    return new SearchHttpTransport(dialect, makeConnection(dialect, overrides));
  }

  test("builds the origin from host and port", async () => {
    await makeTransport().version();

    expect(calls[0]?.url).toBe("http://127.0.0.1:9200/");
  });

  test("brackets an IPv6 host", async () => {
    await makeTransport({ host: "::1" }).version();

    expect(calls[0]?.url).toBe("http://[::1]:9200/");
  });

  test("keeps the index listing's query parameters in the query", async () => {
    handler = () => new Response("[]", { headers: { "content-type": "application/json" } });
    await makeTransport().indices();

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/_cat/indices");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("bytes")).toBe("b");
  });

  // A host is spliced into nothing: one that would rewrite the URL around it is
  // refused before the transport exists, so no request can carry the credential.
  test.each(["evil.example/steal?", "user@evil.example", "db#x", "db\\evil", "db%2f", "db evil"])(
    "refuses the host %p before any request is sent",
    (host) => {
      expect(() => makeTransport({ host })).toThrow(DatabaseConfigError);
      expect(calls).toHaveLength(0);
    },
  );

  test.each([0, 65536, 1.5, "9200abc"])("refuses the port %p before any request is sent", (port) => {
    expect(() => makeTransport({ port: port as number })).toThrow(DatabaseConfigError);
    expect(calls).toHaveLength(0);
  });

  test("refuses an index name that would climb out of its path", async () => {
    const error = await makeTransport()
      .mapping("..")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe.each(["elasticsearch", "opensearch"] as const)("SearchHttpTransport (%s) redirects", (dialect) => {
  function makeTransport(): SearchHttpTransport {
    return new SearchHttpTransport(dialect, makeConnection(dialect));
  }

  test("asks fetch not to follow a redirect", async () => {
    await makeTransport().version();

    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  test("refuses a 3xx response with a ConnectionError naming only the target origin", async () => {
    handler = () =>
      new Response("", { status: 301, headers: { location: "https://evil.example:9443/steal?token=SECRET" } });

    const error = await makeTransport()
      .version()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain("HTTP 301");
    expect((error as Error).message).toContain("https://evil.example:9443");
    expect((error as Error).message).not.toContain("SECRET");
    expect(calls).toHaveLength(1);
  });

  // A 404 with an absence rule is answered as "nothing here"; a redirect must not
  // be mistaken for that, or for anything else but a refusal.
  test("refuses a 3xx response on a listing that tolerates absence", async () => {
    handler = () => new Response("", { status: 302, headers: { location: "/login" } });

    const error = await makeTransport()
      .pipelines()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionError);
  });
});
