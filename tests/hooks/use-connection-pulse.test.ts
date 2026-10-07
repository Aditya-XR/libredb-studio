import "../setup-dom";

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { renderHook, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";

import { CONNECTION_PULSE_INTERVAL_MS, useConnectionPulse } from "@/hooks/use-connection-pulse";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { DatabaseConnection } from "@/lib/types";

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: "conn-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
  user: "admin",
  password: "secret",
  createdAt: new Date("2026-01-01"),
  ...overrides,
});

/** Only the capability the pulse reads; the rest of the declaration plays no part here. */
const metadata = (resumesBilledCompute?: true): ProviderMetadata =>
  ({
    capabilities: { queryLanguage: "sql", ...(resumesBilledCompute ? { resumesBilledCompute } : {}) },
  }) as unknown as ProviderMetadata;

type Props = { connection: DatabaseConnection | null; metadata: ProviderMetadata | null };

const renderPulse = (initialProps: Props) =>
  renderHook(({ connection, metadata }: Props) => useConnectionPulse(connection, metadata), { initialProps });

const healthPosts = (fetchMock: ReturnType<typeof mockGlobalFetch>) =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes("/api/db/health"));

/**
 * The repository's `setInterval` swap (tests/isolated/factory.test.ts): every pulse timer is
 * captured with its handler, and handed a real far-future timer so `clearInterval` behaves as it
 * would. Only timers at the pulse interval are the pulse's, and any other one runs for real:
 * Testing Library's `waitFor` polls with an interval of its own.
 */
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let pulseTimers: { handler: () => void; handle: ReturnType<typeof setInterval> }[] = [];
let cleared: ReturnType<typeof setInterval>[] = [];

beforeEach(() => {
  pulseTimers = [];
  cleared = [];
  globalThis.setInterval = ((handler: () => void, ms?: number) => {
    if (ms !== CONNECTION_PULSE_INTERVAL_MS) return originalSetInterval(handler, ms);
    const handle = originalSetInterval(() => {}, 2_147_000_000);
    pulseTimers.push({ handler, handle });
    return handle;
  }) as typeof globalThis.setInterval;
  globalThis.clearInterval = ((handle: ReturnType<typeof setInterval>) => {
    cleared.push(handle);
    originalClearInterval(handle);
  }) as typeof globalThis.clearInterval;
});

afterEach(() => {
  globalThis.setInterval = originalSetInterval;
  globalThis.clearInterval = originalClearInterval;
  restoreGlobalFetch();
});

describe("useConnectionPulse", () => {
  test("checks every 60 s", () => {
    expect(CONNECTION_PULSE_INTERVAL_MS).toBe(60_000);
  });

  test("sends nothing and starts no timer before metadata answers", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/health": { json: { status: "healthy" } } });

    const { result } = renderPulse({ connection: makeConnection(), metadata: null });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(result.current).toBeNull();
    expect(healthPosts(fetchMock)).toHaveLength(0);
    expect(pulseTimers).toHaveLength(0);
  });

  test("with no active connection it sends nothing and reports nothing", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/health": { json: { status: "healthy" } } });

    const { result } = renderPulse({ connection: null, metadata: metadata() });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(result.current).toBeNull();
    expect(healthPosts(fetchMock)).toHaveLength(0);
    expect(pulseTimers).toHaveLength(0);
  });

  test("checks once and every 60 s without the capability", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/health": { json: { status: "healthy" } } });
    const connection = makeConnection();

    const { result } = renderPulse({ connection, metadata: metadata() });

    await waitFor(() => {
      expect(result.current).toBe("healthy");
    });
    expect(healthPosts(fetchMock)).toHaveLength(1);
    const [, init] = healthPosts(fetchMock)[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(String(init.body)).toContain('"id":"conn-1"');
    expect(pulseTimers).toHaveLength(1);

    pulseTimers[0].handler();
    await waitFor(() => {
      expect(healthPosts(fetchMock)).toHaveLength(2);
    });
  });

  test("a refused answer reads degraded", async () => {
    mockGlobalFetch({ "/api/db/health": { status: 503, json: { error: "Service Unavailable" } } });

    const { result } = renderPulse({ connection: makeConnection(), metadata: metadata() });

    await waitFor(() => {
      expect(result.current).toBe("degraded");
    });
  });

  test("a request that throws reads error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("Network error");
    }) as unknown as typeof fetch;

    try {
      const { result } = renderPulse({ connection: makeConnection(), metadata: metadata() });
      await waitFor(() => {
        expect(result.current).toBe("error");
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("with resumesBilledCompute sends zero /api/db/health posts across two activations, starts no timer and sets not-checked", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/health": { json: { status: "healthy" } } });
    const first = makeConnection({ id: "cloud-1" });
    const second = makeConnection({ id: "cloud-2" });

    const { result, rerender } = renderPulse({ connection: first, metadata: metadata(true) });
    expect(result.current).toBe("not-checked");

    rerender({ connection: second, metadata: null });
    rerender({ connection: second, metadata: metadata(true) });
    expect(result.current).toBe("not-checked");

    rerender({ connection: first, metadata: null });
    rerender({ connection: first, metadata: metadata(true) });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(result.current).toBe("not-checked");
    expect(healthPosts(fetchMock)).toHaveLength(0);
    expect(pulseTimers).toHaveLength(0);
  });

  test("switching connections clears the previous timer and does not report the previous answer", async () => {
    let answer: { status?: number; json: unknown } = { json: { status: "healthy" } };
    const fetchMock = mockGlobalFetch({ "/api/db/health": () => answer });
    const first = makeConnection({ id: "conn-1" });
    const second = makeConnection({ id: "conn-2" });

    const { result, rerender } = renderPulse({ connection: first, metadata: metadata() });
    await waitFor(() => {
      expect(result.current).toBe("healthy");
    });
    expect(pulseTimers).toHaveLength(1);

    answer = { status: 503, json: { error: "down" } };
    rerender({ connection: second, metadata: null });
    expect(cleared).toContain(pulseTimers[0].handle);
    expect(result.current).toBeNull();

    rerender({ connection: second, metadata: metadata() });
    expect(result.current).toBeNull();
    await waitFor(() => {
      expect(result.current).toBe("degraded");
    });
    expect(pulseTimers).toHaveLength(2);
    expect(String((healthPosts(fetchMock)[1][1] as RequestInit).body)).toContain('"id":"conn-2"');
  });

  test("an edit of the same connection that gains resumesBilledCompute clears the timer and sends nothing more", async () => {
    const fetchMock = mockGlobalFetch({ "/api/db/health": { json: { status: "healthy" } } });
    const before = makeConnection({ id: "conn-1" });
    const edited = makeConnection({ id: "conn-1", database: "billed" });

    const { result, rerender } = renderPulse({ connection: before, metadata: metadata() });
    await waitFor(() => {
      expect(result.current).toBe("healthy");
    });
    expect(healthPosts(fetchMock)).toHaveLength(1);

    rerender({ connection: edited, metadata: null });
    expect(cleared).toContain(pulseTimers[0].handle);
    rerender({ connection: edited, metadata: metadata(true) });
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(result.current).toBe("not-checked");
    expect(healthPosts(fetchMock)).toHaveLength(1);
    expect(pulseTimers).toHaveLength(1);
  });

  test("an edit of the same connection to a new host reports nothing until the new target answers", async () => {
    let releaseEdited: (() => void) | undefined;
    const fetchMock = mockGlobalFetch({
      "/api/db/health": (req) =>
        req.text().then((body) =>
          body.includes('"host":"new-host"')
            ? new Promise((resolve) => {
                releaseEdited = () => resolve({ status: 503, json: { error: "down" } });
              })
            : { json: { status: "healthy" } },
        ),
    });
    const before = makeConnection({ id: "conn-1" });
    const edited = makeConnection({ id: "conn-1", host: "new-host" });

    const { result, rerender } = renderPulse({ connection: before, metadata: metadata() });
    await waitFor(() => {
      expect(result.current).toBe("healthy");
    });

    rerender({ connection: edited, metadata: metadata() });
    await waitFor(() => {
      expect(releaseEdited).toBeDefined();
    });
    expect(result.current).toBeNull();

    releaseEdited?.();
    await waitFor(() => {
      expect(result.current).toBe("degraded");
    });
    expect(healthPosts(fetchMock)).toHaveLength(2);
  });

  test("an answer that settles after the connection changed does not replace the new one's", async () => {
    let releaseFirst: (() => void) | undefined;
    const fetchMock = mockGlobalFetch({
      "/api/db/health": (req) =>
        req.text().then((body) =>
          body.includes('"id":"conn-1"')
            ? new Promise((resolve) => {
                releaseFirst = () => resolve({ status: 503, json: { error: "late" } });
              })
            : { json: { status: "healthy" } },
        ),
    });

    const { result, rerender } = renderPulse({ connection: makeConnection(), metadata: metadata() });
    await waitFor(() => {
      expect(releaseFirst).toBeDefined();
    });

    rerender({ connection: makeConnection({ id: "conn-2" }), metadata: metadata() });
    await waitFor(() => {
      expect(result.current).toBe("healthy");
    });
    releaseFirst?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(healthPosts(fetchMock)).toHaveLength(2);
    expect(result.current).toBe("healthy");
  });

  test("a check that throws after the connection changed does not replace the new one's answer", async () => {
    let failFirst: (() => void) | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      String(init?.body).includes('"id":"conn-1"')
        ? new Promise((_, fail) => {
            failFirst = () => fail(new Error("Network error"));
          })
        : Promise.resolve(new Response("{}", { status: 200 }))) as unknown as typeof fetch;

    try {
      const { result, rerender } = renderPulse({ connection: makeConnection(), metadata: metadata() });
      await waitFor(() => {
        expect(failFirst).toBeDefined();
      });

      rerender({ connection: makeConnection({ id: "conn-2" }), metadata: metadata() });
      await waitFor(() => {
        expect(result.current).toBe("healthy");
      });
      failFirst?.();
      await new Promise((resolve) => setTimeout(resolve, 5));

      expect(result.current).toBe("healthy");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("unmount clears the timer", async () => {
    mockGlobalFetch({ "/api/db/health": { json: { status: "healthy" } } });

    const { result, unmount } = renderPulse({ connection: makeConnection(), metadata: metadata() });
    await waitFor(() => {
      expect(result.current).toBe("healthy");
    });

    unmount();
    expect(cleared).toContain(pulseTimers[0].handle);
  });
});
