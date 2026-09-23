import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, afterEach } from "bun:test";
import { act, renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from "../helpers/mock-fetch";

import { useKeyScan, SCAN_ALL_MAX_KEYS } from "@/components/key-browser/use-key-scan";
import { pathKey } from "@/components/key-browser/tree";
import type { DatabaseConnection } from "@/lib/types";

/**
 * The walk a keys panel drives.
 *
 * EVERY ASSERTION BELOW IS ABOUT THE CURSOR, because the cursor is the contract. A hook that ignored
 * the position it was given and restarted from `"0"` would answer a plausible first page, accumulate
 * a plausible set of keys, and pass any suite that read only `keys` — so the request bodies are
 * asserted, and the failure case checks the position is RETAINED rather than advanced.
 */

const CONNECTION: DatabaseConnection = {
  id: "redis-1",
  name: "Local Redis",
  type: "redis",
  host: "127.0.0.1",
  port: 6380,
  createdAt: new Date(0),
};

const CAPABILITY = { defaultCount: 500, maxCount: 1000 };

/**
 * The connection as it crosses the wire.
 *
 * `createdAt` is a `Date` in memory and a string once `JSON.stringify` has been through it, so an
 * expectation built from the live object can never equal the body that was actually sent.
 */
const WIRE_CONNECTION = JSON.parse(JSON.stringify(CONNECTION)) as Record<string, unknown>;

function hook() {
  return renderHook(() => useKeyScan({ connection: CONNECTION, capability: CAPABILITY, pattern: "" }));
}

/** The cursor the request carried. The helper hands a real `Request`, so the body is read once. */
async function cursorOf(req: Request): Promise<string> {
  const body = (await req.json().catch(() => ({}))) as { cursor?: string };
  return body.cursor ?? "0";
}

/** Every request body the hook sent, as the route would have received it. */
function bodiesOf(fetchMock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return fetchMock.mock.calls.map(
    (call) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>,
  );
}

/** A page, in the shape the route answers with. */
function page(keys: string[], cursor: string, total = 31): MockFetchResponse {
  return { json: { keys, cursor, total } };
}

describe("useKeyScan", () => {
  afterEach(() => {
    restoreGlobalFetch();
  });

  test("starts with nothing walked and no total", () => {
    mockGlobalFetch({});

    const { result } = hook();

    expect(result.current.keys).toEqual([]);
    expect(result.current.scanned).toBe(0);
    // Null rather than 0: the denominator is the SERVER's count and nothing local can stand in for
    // it, so "not asked yet" and "the database holds nothing" must not render identically.
    expect(result.current.total).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(result.current.exhausted).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.stoppedBy).toBeNull();
  });

  test("takes one page, records the total, and asks with the declared batch size", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env", "app:cache:ttl"], "9") });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.keys).toEqual(["app:env", "app:cache:ttl"]);
    expect(result.current.scanned).toBe(2);
    expect(result.current.total).toBe(31);

    // No `pattern` key at all rather than an empty one: `MATCH ""` is a pattern no key satisfies, so
    // forwarding an absent pattern as an empty string would turn "every key" into "no key".
    expect(bodiesOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION, cursor: "0", count: 500 }]);
  });

  test("forwards a pattern when there is one", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:env"], "0") });
    const { result } = renderHook(() =>
      useKeyScan({ connection: CONNECTION, capability: CAPABILITY, pattern: "app:*" }),
    );

    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock)).toEqual([{ connection: WIRE_CONNECTION, cursor: "0", pattern: "app:*", count: 500 }]);
  });

  test("counts a repeat the walk was handed but hands the tree one of it", async () => {
    // `SCAN` may return a key twice while the table rehashes, and the two answers are for two
    // readers. `scanned` is what the walk has been through — the number the progress line is measured
    // against, so a repeat counts — while `keys` is the tree's input, and a tree cannot draw one key
    // twice. Deduplicating at the source is also what keeps that list bounded: with a scoped Load
    // more appending whole batches, an undeduped list grows until the search feeding the tree is the
    // slowest thing on screen.
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["a", "b"], "1") : page(["b", "c"], "0");
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.keys).toEqual(["a", "b", "c"]);
    expect(result.current.scanned).toBe(4);
  });

  test("advances the cursor between pages", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => ((await cursorOf(req)) === "0" ? page(["a"], "7") : page(["b"], "0")),
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock)).toMatchObject([{ cursor: "0" }, { cursor: "7" }]);
  });

  test("refuses a second page while one is in flight", async () => {
    /*
     * The gate is built FIRST and its opener assigned inside the executor, rather than the handler
     * creating the promise it waits on. An assignment made inside a callback is one TypeScript
     * cannot see, so `release` would narrow to `null` and `release?.()` would stop compiling — the
     * shape `tests/hooks/use-provider-metadata.test.ts` already uses for the same reason.
     */
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await gate;
        return page(["a"], "0");
      },
    });
    const { result } = hook();

    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.scanMore();
    });
    // The second press reads the SAME cursor the first one is still holding, so letting it through
    // would advance from a position neither answer has earned.
    await act(async () => {
      await result.current.scanMore();
    });
    expect(fetchMock.mock.calls.length).toBe(1);

    release();
    await act(async () => {
      await first;
    });
  });

  test("stops at the spent cursor and refuses to walk past it", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["only"], "0") });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.exhausted).toBe(true);

    // Cursor "0" means the walk saw everything there was, so asking again would re-walk it.
    await act(async () => {
      await result.current.scanMore();
    });
    expect(fetchMock.mock.calls.length).toBe(1);
  });

  test("absorbs an empty page without disturbing the keys already held", async () => {
    let call = 0;
    mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        // `SCAN MATCH` can answer an empty batch and a non-zero cursor at once, which is a real
        // reply and not an end-of-walk signal.
        return call === 1 ? page(["a"], "4") : page([], "0");
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.keys).toEqual(["a"]);
    expect(result.current.scanned).toBe(1);
    expect(result.current.exhausted).toBe(true);
  });

  test("reports the route's own sentence on a failure and keeps the last acknowledged cursor", async () => {
    let fail = true;
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": () => (fail ? { status: 500, json: { error: "NOPERM no scan for you" } } : page(["a"], "5")),
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    expect(result.current.error).toBe("NOPERM no scan for you");

    // Retrying re-asks the batch that failed rather than skipping it: the cursor is still where the
    // server last acknowledged it, because an error is not progress.
    fail = false;
    await act(async () => {
      await result.current.scanMore();
    });

    expect(bodiesOf(fetchMock)).toMatchObject([{ cursor: "0" }, { cursor: "0" }]);
    expect(result.current.error).toBeNull();
    expect(result.current.keys).toEqual(["a"]);
  });

  test("names the HTTP status when a failure carries no sentence", async () => {
    mockGlobalFetch({ "/api/db/keys/scan": { status: 502, text: "bad gateway" } });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });

    expect(result.current.error).toBe("The key walk failed with HTTP 502");
  });

  test("Scan all pages until the walk is spent", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        const cursor = await cursorOf(req);
        if (cursor === "0") return page(["a", "b"], "1");
        if (cursor === "1") return page(["c"], "2");
        return page(["d"], "0");
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanAll();
    });

    expect(fetchMock.mock.calls.length).toBe(3);
    expect(result.current.keys).toEqual(["a", "b", "c", "d"]);
    expect(result.current.exhausted).toBe(true);
    expect(result.current.scanningAll).toBe(false);
    // A walk that reached the end was not "stopped": there is nothing it failed to reach.
    expect(result.current.stoppedBy).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test("Scan all stops at the cap and says so in its own words", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        // Full pages that never spend the cursor, so only the client's own cap can end this walk.
        const index = Number(await cursorOf(req)) / CAPABILITY.defaultCount;
        const keys = Array.from({ length: CAPABILITY.defaultCount }, (_, offset) => `bulk:${index * 500 + offset}`);
        return page(keys, String((index + 1) * CAPABILITY.defaultCount));
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanAll();
    });

    expect(result.current.scanned).toBe(SCAN_ALL_MAX_KEYS);
    expect(result.current.exhausted).toBe(false);
    // A cap nobody can see is the defect this sentence exists to prevent: without it, a walk that
    // gave up reads as a database holding exactly that many keys.
    expect(result.current.stoppedBy).toBe("Stopped after 10,000 keys. Narrow the pattern to walk a smaller key space.");
    expect(fetchMock.mock.calls.length).toBe(SCAN_ALL_MAX_KEYS / CAPABILITY.defaultCount);
  });

  test("Stop ends a running Scan all after the page in flight", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": async (req) => {
        if ((await cursorOf(req)) !== "0") return page(["b"], "2");
        await gate;
        return page(["a"], "1");
      },
    });
    const { result } = hook();

    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = result.current.scanAll();
    });
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBe(1);
    });

    act(() => {
      result.current.stop();
    });
    release();
    await act(async () => {
      await running;
    });

    // The page already in flight lands and is counted — it is not a request that can be recalled —
    // and it is the last one, which is what "stop" can honestly mean here.
    expect(fetchMock.mock.calls.length).toBe(1);
    expect(result.current.keys).toEqual(["a"]);
    expect(result.current.stoppedBy).toBe("Stopped.");
    expect(result.current.scanningAll).toBe(false);
  });

  test("Scan all ends a failed walk rather than re-asking the same page forever", async () => {
    let call = 0;
    const fetchMock = mockGlobalFetch({
      "/api/db/keys/scan": () => {
        call += 1;
        return call === 1 ? page(["a"], "1") : { status: 500, json: { error: "boom" } };
      },
    });
    const { result } = hook();

    await act(async () => {
      await result.current.scanAll();
    });

    expect(fetchMock.mock.calls.length).toBe(2);
    expect(result.current.error).toBe("boom");
    expect(result.current.scanningAll).toBe(false);
    // Not "stopped": the walk did not choose to end, it failed, and the panel shows the sentence.
    expect(result.current.stoppedBy).toBeNull();
  });

  test("Scan all refuses a second press while one is running", async () => {
    // A no-op default rather than `| null`: the executor below replaces it before anything waits,
    // and a nullable declaration narrows to `null` at the call site, where `release?.()` then has
    // type `never`. `release` is reassigned inside the promise's executor, which TypeScript cannot
    // see, so the declared type is what the call site has to be callable from.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await gate;
        return page(["a"], "0");
      },
    });
    const { result } = hook();

    let running: Promise<void> = Promise.resolve();
    act(() => {
      running = result.current.scanAll();
    });
    await act(async () => {
      await result.current.scanAll();
    });

    release();
    await act(async () => {
      await running;
    });

    expect(result.current.keys).toEqual(["a"]);
  });

  test("reset throws the walk away and starts again at cursor zero", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["a"], "3") });
    const { result } = hook();

    await act(async () => {
      await result.current.scanMore();
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.keys).toEqual([]);
    expect(result.current.scanned).toBe(0);
    expect(result.current.total).toBeNull();
    expect(result.current.exhausted).toBe(false);

    await act(async () => {
      await result.current.scanMore();
    });
    expect(bodiesOf(fetchMock)).toMatchObject([{ cursor: "0" }, { cursor: "0" }]);
  });

  test("ignores a page that lands after unmount", async () => {
    /*
     * There is no session to close, because a cursor is a position rather than a handle — but a
     * response still arrives, and setting state on an unmounted hook is the one thing the cleanup
     * has to prevent. Both arms are exercised: a late ANSWER and a late FAILURE, which are two
     * different `return`s in the hook.
     */
    const releases: Array<() => void> = [];
    let mode: "ok" | "fail" = "ok";
    mockGlobalFetch({
      "/api/db/keys/scan": async () => {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
        if (mode === "fail") throw new Error("late failure");
        return page(["late"], "0");
      },
    });

    const first = hook();
    let ok: Promise<void> = Promise.resolve();
    act(() => {
      ok = first.result.current.scanMore();
    });
    await waitFor(() => {
      expect(releases.length).toBe(1);
    });
    first.unmount();
    releases[0]();
    await act(async () => {
      await ok;
    });
    expect(first.result.current.keys).toEqual([]);

    mode = "fail";
    const second = hook();
    let bad: Promise<void> = Promise.resolve();
    act(() => {
      bad = second.result.current.scanMore();
    });
    await waitFor(() => {
      expect(releases.length).toBe(2);
    });
    second.unmount();
    releases[1]();
    await act(async () => {
      await bad;
    });
    expect(second.result.current.error).toBeNull();
  });

  /**
   * The walk scoped to ONE PREFIX, which is the only thing that can answer "is there more under
   * here" about a prefix the global sample happened to miss.
   *
   * The assertions are on the REQUEST as much as on the answer, because the two things that make
   * this different from the global walk are exactly the two fields it sends: a pattern built from the
   * prefix, and a cursor that belongs to that prefix rather than to the walk.
   */
  describe("loadMoreUnder()", () => {
    const APP = ["app", "cache"];
    const APP_PATTERN = "app:cache:*";

    /** The body of the nth request, as the route would have received it. */
    const bodyAt = (fetchMock: { mock: { calls: unknown[][] } }, index: number) =>
      JSON.parse(String((fetchMock.mock.calls[index][1] as RequestInit).body)) as Record<string, unknown>;

    test("asks about the prefix itself, starting where that prefix's walk starts", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": (req) => {
          void req;
          return page(["app:cache:ttl"], "17");
        },
      });
      const { result } = hook();

      // The global walk is not started here on purpose: a scoped load must work without it, since the
      // panel's first page may have failed while a folder is still worth asking about.
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(bodyAt(fetchMock, 0)).toMatchObject({ cursor: "0", pattern: APP_PATTERN, count: 500 });
      expect(result.current.keys).toEqual(["app:cache:ttl"]);
      expect(result.current.nodeCursors.get(pathKey(APP))).toBe("17");
    });

    test("continues that prefix's own walk on the next press", async () => {
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": () => page(["app:cache:a"], "17"),
      });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      // The SECOND request carries this prefix's cursor, not the global walk's and not `"0"` again: a
      // row that restarted the prefix every press would re-read the same first page forever.
      expect(bodyAt(fetchMock, 0)).toMatchObject({ cursor: "0" });
      expect(bodyAt(fetchMock, 1)).toMatchObject({ cursor: "17" });
    });

    test("records a spent prefix so the row can stop offering itself", async () => {
      mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl"], "0") });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(result.current.nodeCursors.get(pathKey(APP))).toBe("0");
    });

    test("drops names the server returned that are not under the prefix", async () => {
      // `MATCH` is an unescaped glob and a real key segment can contain `*`, so a scoped answer can
      // carry keys from outside the prefix. They are the server's answer to a question that was not
      // asked, and letting them in would put a key under a folder it does not belong to.
      mockGlobalFetch({
        "/api/db/keys/scan": page(["app:cache:ttl", "app:cached:other", "app:envelope", "elsewhere:x"], "0"),
      });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(result.current.keys).toEqual(["app:cache:ttl"]);
    });

    test("escapes the prefix half of the pattern, and ONLY that half", async () => {
      // `[` opens a character class in a Redis glob, so an unescaped prefix would ask the server for
      // a different set of keys entirely. The escaping is the repository's shared `escapeGlob` rule
      // (#427) rather than a copy of it, so this walk and the object surface's own prefix listing
      // cannot drift apart.
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": page(["weird[1:inner", "weirder[x:other"], "0"),
      });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(["weird[1"]);
      });

      expect(bodyAt(fetchMock, 0)).toMatchObject({ pattern: "weird\\[1:*" });
      // And the ANSWER is compared against the real name, unescaped: escaping the keys would drop a
      // literal key that genuinely contains `*`.
      expect(result.current.keys).toEqual(["weird[1:inner"]);
    });

    test("leaves the global walk's progress and cursor alone", async () => {
      let call = 0;
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          // First the global walk's page, then the scoped one, then the global walk's again.
          if (call === 1) return page(["top:one"], "7", 31);
          if (call === 2) return page(["app:cache:ttl"], "3");
          return page(["top:two"], "0", 31);
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      expect(result.current.scanned).toBe(1);

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      // The scoped page handed back a key the global walk had not counted, and it still does not
      // count: `scanned` is measured against `total`, which is the DATABASE's key count, so adding a
      // scoped batch would push the progress line past its own denominator.
      expect(result.current.scanned).toBe(1);
      expect(result.current.total).toBe(31);

      await act(async () => {
        await result.current.scanMore();
      });
      // And the global cursor is where the global walk left it, not where the scoped page did.
      expect(bodyAt(fetchMock, 2)).toMatchObject({ cursor: "7" });
      expect(result.current.keys).toEqual(["top:one", "app:cache:ttl", "top:two"]);
    });

    test("shares the tree's one copy of a key with the global walk", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          return call === 1 ? page(["app:cache:ttl"], "9") : page(["app:cache:ttl"], "0");
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      expect(result.current.keys).toEqual(["app:cache:ttl"]);
    });

    test("refuses a second page for one prefix while the first is in flight", async () => {
      // A callable default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where the call then has type
      // `never`. The opener is assigned inside a promise's executor, which TypeScript cannot see.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchMock = mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          await gate;
          return page(["app:cache:ttl"], "0");
        },
      });
      const { result } = hook();

      let first: Promise<void> = Promise.resolve();
      act(() => {
        first = result.current.loadMoreUnder(APP);
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });

      // Both presses would read the same scoped cursor and both advance from it, so the second would
      // overwrite the position the first earned — the same rule the global walk keeps.
      expect(fetchMock.mock.calls.length).toBe(1);
      release();
      await act(async () => {
        await first;
      });
      expect(result.current.nodeLoading.size).toBe(0);
    });

    test("marks the prefix while its page is in flight", async () => {
      // A callable default rather than `| null`: the executor below replaces it before anything waits,
      // and a nullable declaration narrows to `null` at the call site, where the call then has type
      // `never`. The opener is assigned inside a promise's executor, which TypeScript cannot see.
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          await gate;
          return page(["app:cache:ttl"], "0");
        },
      });
      const { result } = hook();

      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = result.current.loadMoreUnder(APP);
      });
      await waitFor(() => {
        expect(result.current.nodeLoading.has(pathKey(APP))).toBe(true);
      });

      release();
      await act(async () => {
        await pending;
      });
      expect(result.current.nodeLoading.has(pathKey(APP))).toBe(false);
    });

    test("reports a scoped failure without ending the walk somebody else started", async () => {
      let call = 0;
      mockGlobalFetch({
        "/api/db/keys/scan": () => {
          call += 1;
          if (call === 1) return page(["top:one"], "7", 31);
          if (call === 2) return { status: 500, json: { error: "NOPERM no scan for you" } };
          return page(["top:two"], "0", 31);
        },
      });
      const { result } = hook();

      await act(async () => {
        await result.current.scanMore();
      });
      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      expect(result.current.error).toBe("NOPERM no scan for you");
      // The prefix keeps no cursor, so its next press re-asks the batch that failed rather than
      // skipping it — the same rule the global walk keeps.
      expect(result.current.nodeCursors.get(pathKey(APP))).toBeUndefined();

      // AND THE WALK STILL RUNS. A prefix that refused is not a reason to end a walk started at the
      // database level, which is why this path does not set the loop's own failure flag.
      await act(async () => {
        await result.current.scanMore();
      });
      expect(result.current.keys).toEqual(["top:one", "top:two"]);
    });

    test("clears every prefix's walk on reset", async () => {
      const fetchMock = mockGlobalFetch({ "/api/db/keys/scan": page(["app:cache:ttl"], "17") });
      const { result } = hook();

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      act(() => {
        result.current.reset();
      });
      expect(result.current.nodeCursors.size).toBe(0);
      expect(result.current.nodeLoading.size).toBe(0);

      await act(async () => {
        await result.current.loadMoreUnder(APP);
      });
      // From the start, not from where the discarded walk stood: a cursor left standing would answer
      // the next walk's Load more with keys from the walk that was thrown away.
      expect(bodyAt(fetchMock, 1)).toMatchObject({ cursor: "0" });
    });

    test("ignores a scoped page that lands after unmount", async () => {
      const releases: Array<() => void> = [];
      let mode: "ok" | "fail" = "ok";
      mockGlobalFetch({
        "/api/db/keys/scan": async () => {
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          if (mode === "fail") throw new Error("late scoped failure");
          return page(["app:cache:ttl"], "0");
        },
      });

      const first = hook();
      let ok: Promise<void> = Promise.resolve();
      act(() => {
        ok = first.result.current.loadMoreUnder(APP);
      });
      await waitFor(() => {
        expect(releases.length).toBe(1);
      });
      first.unmount();
      releases[0]();
      await act(async () => {
        await ok;
      });
      expect(first.result.current.nodeCursors.size).toBe(0);

      mode = "fail";
      const second = hook();
      let bad: Promise<void> = Promise.resolve();
      act(() => {
        bad = second.result.current.loadMoreUnder(APP);
      });
      await waitFor(() => {
        expect(releases.length).toBe(2);
      });
      second.unmount();
      releases[1]();
      await act(async () => {
        await bad;
      });
      expect(second.result.current.error).toBeNull();
    });
  });
});
