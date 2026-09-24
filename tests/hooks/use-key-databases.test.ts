import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, afterEach } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../helpers/mock-fetch";

import { useKeyDatabases } from "@/components/key-browser/use-key-databases";
import type { ContainerLevelSpec } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The container list a walk can be pointed at.
 *
 * THE COUNT IS NEVER ASSUMED, which is the whole reason this is a read: the same Redis image answers
 * 16 databases on a plain server and 1 in cluster mode, so anything this hook answered without asking
 * would be a number nobody measured. Every assertion below is therefore about the REQUEST and about
 * which answer is allowed to land.
 */

const CONNECTION: DatabaseConnection = {
  id: "redis-1",
  name: "Local Redis",
  type: "redis",
  host: "127.0.0.1",
  port: 6380,
  createdAt: new Date(0),
};

const OTHER: DatabaseConnection = { ...CONNECTION, id: "redis-2" };

/** The engine's own word for the level, which is what the panel labels the choice with. */
const LEVEL: ContainerLevelSpec = { id: "schema", label: "Database", labelPlural: "Databases" };

/**
 * The connection as it crosses the wire.
 *
 * `createdAt` is a `Date` in memory and a string once `JSON.stringify` has been through it, so an
 * expectation built from the live object can never equal the body that was actually sent.
 */
const WIRE_CONNECTION = JSON.parse(JSON.stringify(CONNECTION)) as Record<string, unknown>;

/** The numbered databases a stock server reports: every one of them, empty ones included. */
const DATABASES = [
  { path: ["0"], name: "0", level: 0, isSessionDefault: true },
  { path: ["1"], name: "1", level: 0, isSessionDefault: false },
  { path: ["2"], name: "2", level: 0, isSessionDefault: false },
];

/** Every request body the hook sent, as the route would have received it. */
function bodiesOf(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  );
}

function hook(connection: DatabaseConnection = CONNECTION, level: ContainerLevelSpec | undefined = LEVEL) {
  return renderHook(() => useKeyDatabases(connection, level));
}

describe("useKeyDatabases", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("reads the engine's own container list, and nothing before it answers", async () => {
    mockGlobalFetch({ "/api/db/objects/containers": { json: DATABASES } });

    const { result } = hook();

    // Nothing read yet is nothing read FOR THIS CONNECTION: the walk it belongs to does not wait for
    // it, so these are empty rather than a promise in a different shape.
    expect(result.current.names).toEqual([]);
    expect(result.current.sessionDefault).toBeNull();
    expect(result.current.error).toBeNull();

    await waitFor(() => {
      expect(result.current.names).toEqual(["0", "1", "2"]);
    });
  });

  test("asks the container route for this connection, and answers with its names", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/objects/containers": { json: DATABASES } });

    const { result } = hook();

    await waitFor(() => {
      expect(result.current.names).toEqual(["0", "1", "2"]);
    });
    // The engine's own container level is the same read the object tree's top level comes from, and
    // one body is the connection and nothing else: no parent, so the whole level is asked for.
    expect(bodiesOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION }]);
    // The database the session is already in, which is what the panel shows before anybody chooses.
    expect(result.current.sessionDefault).toBe("0");
  });

  test("reads nothing at all when the engine declares no level to choose from", () => {
    const fetchMock = mockGlobalFetch({ "/api/db/objects/containers": { json: DATABASES } });

    // Inline rather than through the helper above: an explicit `undefined` reaches a DEFAULT
    // parameter as the default, so the level would be filled back in and the case never reached.
    const { result } = renderHook(() => useKeyDatabases(CONNECTION, undefined));

    // An engine with no container level is walked as a whole, so there is no question to ask and no
    // request to make for it.
    expect(fetchMock.mock.calls.length).toBe(0);
    expect(result.current.names).toEqual([]);
  });

  test("keeps the route's own sentence when the read is refused", async () => {
    mockGlobalFetch({
      "/api/db/objects/containers": { status: 403, json: { error: "NOPERM this user has no permissions" } },
    });

    const { result } = hook();

    await waitFor(() => {
      expect(result.current.error).toBe("NOPERM this user has no permissions");
    });
    // A refusal is not an empty level: the names stay empty because none were read, and the panel
    // draws the sentence rather than claiming the server has no databases.
    expect(result.current.names).toEqual([]);
  });

  test("names the HTTP status when a refusal carries no sentence", async () => {
    mockGlobalFetch({ "/api/db/objects/containers": { status: 502, text: "" } });

    const { result } = hook();

    await waitFor(() => {
      expect(result.current.error).toBe("The database list failed with HTTP 502");
    });
  });

  test("refuses a body it cannot render rather than drawing names out of it", async () => {
    // A response is not a type guarantee: this is a route's body, and a row is built from what is in
    // it, so the shape is checked before anything is dereferenced.
    mockGlobalFetch({ "/api/db/objects/containers": { json: { databases: ["0", "1"] } } });

    const { result } = hook();

    await waitFor(() => {
      expect(result.current.error).toBe("The database list answered with a body this panel cannot render");
    });
    expect(result.current.names).toEqual([]);
  });

  test("drops an answer that lands after the panel moved to another connection", async () => {
    let connection = CONNECTION;
    // A no-op default rather than `| null`: the executor below replaces it before anything waits, and
    // a nullable declaration narrows to `null` at the call site, where `release?.()` then has type
    // `never`.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGlobalFetch({
      "/api/db/objects/containers": async (req: Request) => {
        const body = (await req.json()) as { connection?: { id?: string } };
        // The first connection's read is held; the second one's answers at once, which is what makes
        // the order of the two landings the thing under test.
        if (body.connection?.id === CONNECTION.id) {
          await gate;
          return { json: DATABASES };
        }
        return { json: [{ path: ["7"], name: "7", level: 0, isSessionDefault: true }] };
      },
    });

    const { result, rerender } = renderHook(() => useKeyDatabases(connection, LEVEL));
    connection = OTHER;
    rerender();

    await waitFor(() => {
      expect(result.current.names).toEqual(["7"]);
    });

    // The answer the first connection's read was holding names databases the second server never
    // listed: landing it would point the walk at a number that does not exist there.
    release();
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.names).toEqual(["7"]);
    expect(result.current.sessionDefault).toBe("7");
  });
});
