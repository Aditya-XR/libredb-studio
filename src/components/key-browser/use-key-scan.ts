"use client";

/**
 * The sampled walk a keys panel is driven by.
 *
 * THE CURSOR LIVES HERE AND NOWHERE ELSE. `SCAN` is stateless on the server — a cursor is a
 * position in a hash table rather than a handle — so there is nothing to hold open and nothing to
 * release: the hook keeps the position between pages, hands it back on the next request, and a
 * reload simply starts again at `"0"`. That is why a page costs a round trip instead of owning a
 * session, and why `Stop` can be an ordinary flag rather than a cancellation protocol.
 *
 * THE SAMPLE IS THE POINT, NOT A SHORTCOMING OF THIS CODE. A walk stopped at a batch holds some of
 * the keys, and `scanned` counts what the walk has been HANDED rather than what it uniquely found:
 * a key returned twice while the table rehashes was still walked twice, and a progress indicator
 * that quietly deduplicated would drift below the denominator it is measured against. The tree, by
 * contrast, merges duplicates, because two rows for one key would be a lie about the keyspace.
 *
 * `Scan all` IS BOUNDED, and the bound is declared rather than discovered. Redis's `SCAN` is O(N)
 * over the whole keyspace, so an unbounded "all" against a key space of millions is a request that
 * never returns and a server that is busy while it does not. The cap is a number this client chose,
 * in keys, and the panel says so in its own words when a walk stops on it — a cap nobody can see is
 * the defect that sentence exists to prevent.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { KeyScanCapability, KeyScanOptions, KeyScanPage } from "@/lib/db/types";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { appFetch } from "@/lib/config/base-path";

/**
 * How many keys one `Scan all` may walk before it stops and says it did.
 *
 * Ten thousand is a client-side budget and not an engine limit: at the default batch of 500 it is
 * twenty round trips, which is a gesture a person will wait for and a load a server will answer. A
 * key space larger than this is one where the right answer is "narrow the pattern".
 */
export const SCAN_ALL_MAX_KEYS = 10_000;

/** The batch size to ask for, kept inside what the provider declared it will accept. */
function batchSize(capability: KeyScanCapability): number {
  return Math.min(capability.defaultCount, capability.maxCount);
}

export interface KeyScanResult {
  /** Distinct keys the walk has seen, in the order it saw them. */
  readonly keys: readonly string[];
  /** Keys the walk has been handed, repeats included. */
  readonly scanned: number;
  /** The server's own key count for the database, or null before the first page answers. */
  readonly total: number | null;
  /** True while one page is in flight. */
  readonly busy: boolean;
  /** True while a `Scan all` is running, so the panel can offer `Stop` rather than a second press. */
  readonly scanningAll: boolean;
  /** True once a walk reached cursor `"0"`, which is the only signal the server gives. */
  readonly exhausted: boolean;
  /** What ended a `Scan all` before the walk was spent, when something did. */
  readonly stoppedBy: string | null;
  /** The sentence a failed page answered with, in the route's own words where it gave one. */
  readonly error: string | null;
}

export interface KeyScanControls {
  /** Take one more batch from wherever the walk stands. */
  readonly scanMore: () => Promise<void>;
  /** Page until the walk is spent, the cap is reached, someone presses Stop, or a page fails. */
  readonly scanAll: () => Promise<void>;
  /** Ask a running `Scan all` to stop after the page in flight. */
  readonly stop: () => void;
  /** Throw the walk away and start again at cursor `"0"`. */
  readonly reset: () => void;
}

export function useKeyScan(options: {
  readonly connection: DatabaseConnection;
  readonly capability: KeyScanCapability;
  /** A `MATCH` pattern, or `""` for every key. */
  readonly pattern: string;
}): KeyScanResult & KeyScanControls {
  const { connection, capability, pattern } = options;

  const [keys, setKeys] = useState<readonly string[]>([]);
  const [scanned, setScanned] = useState(0);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanningAll, setScanningAll] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [stoppedBy, setStoppedBy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /*
   * Refs, not state, and the reason is the loop rather than performance. `scanAll` takes several
   * pages inside ONE commit, so every value it reads to decide whether to keep going — the cursor,
   * the count, whether the walk is spent, whether a page failed — has to be one the page it just
   * took can update before the next decision. Read from state and the loop decides on the values
   * the last RENDER saw, which is the state before its own first request.
   */
  const cursor = useRef("0");
  const running = useRef(false);
  const stopped = useRef(false);
  const spent = useRef(false);
  const scannedKeys = useRef(0);
  const failure = useRef<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    // Set on the way IN as well as cleared on the way out: React runs an effect twice on one mount
    // in development, and a cleanup that only ever wrote `false` would leave the second mount
    // permanently ignoring its own answers.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const readPage = useCallback(async (): Promise<KeyScanPage> => {
    const payload = buildConnectionPayload(connection);
    const request: Omit<KeyScanOptions, "database"> = {
      cursor: cursor.current,
      count: batchSize(capability),
      ...(pattern === "" ? {} : { pattern }),
    };
    const response = await appFetch("/api/db/keys/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, ...request }),
    });

    // A route that answered with no body still answered something worth showing, so the status
    // stands in for the sentence rather than the read being reported as a parse error.
    const body = (await response.json().catch(() => ({}))) as Partial<KeyScanPage> & { error?: string };
    if (!response.ok) {
      throw new Error(body.error ?? `The key walk failed with HTTP ${response.status}`);
    }
    return { keys: body.keys ?? [], cursor: body.cursor ?? "0", total: body.total ?? 0 };
  }, [connection, capability, pattern]);

  const scanMore = useCallback(async (): Promise<void> => {
    // One page at a time. Two in flight would both read the same cursor and both advance from it,
    // so the second answer would overwrite the position the first one earned and the walk would
    // skip whatever lay between them. A spent walk is refused for the same reason it is spent.
    if (running.current || spent.current) return;
    running.current = true;
    setBusy(true);

    try {
      const page = await readPage();
      if (!alive.current) return;
      cursor.current = page.cursor;
      scannedKeys.current += page.keys.length;
      failure.current = null;
      setKeys((previous) => (page.keys.length === 0 ? previous : [...previous, ...page.keys]));
      setScanned(scannedKeys.current);
      setTotal(page.total);
      setError(null);
      // Cursor `"0"` is the only end-of-walk signal Redis publishes, so it is the only one this
      // can set: there is no total to compare against that a concurrent write would not move.
      if (page.cursor === "0") {
        spent.current = true;
        setExhausted(true);
      }
    } catch (thrown) {
      if (!alive.current) return;
      // The cursor is deliberately NOT advanced on a failure. The position already held is the
      // last one the server acknowledged, so retrying re-asks the batch that failed rather than
      // skipping it.
      const message = thrown instanceof Error ? thrown.message : String(thrown);
      failure.current = message;
      setError(message);
    } finally {
      running.current = false;
      if (alive.current) setBusy(false);
    }
  }, [readPage]);

  const scanAll = useCallback(async (): Promise<void> => {
    if (running.current) return;
    stopped.current = false;
    setScanningAll(true);
    setStoppedBy(null);

    /*
     * ONE EXIT, AND NO `try`/`finally` AROUND THE LOOP.
     *
     * The obvious shape is a `finally` that clears `scanningAll`, and it was written that way first.
     * It is not needed — `scanMore` catches its own failures, so nothing escapes the loop — and it
     * costs a false positive: `react/memo-dependencies` cannot see a reference inside a `try` that
     * has a `finally`, so it reported `scanMore` as an extra dependency of a callback that calls it
     * on the line above. A comment asking the linter to look again is the alternative, and this is
     * better: the reason the walk ended is computed as a value and applied once, which is also what
     * makes "stopped" and "hit the cap" ordered rather than racing in a `finally`.
     */
    let reason: string | null = null;
    while (!stopped.current && !spent.current && failure.current === null) {
      await scanMore();
      if (scannedKeys.current >= SCAN_ALL_MAX_KEYS && !spent.current) {
        const limit = SCAN_ALL_MAX_KEYS.toLocaleString("en-US");
        reason = `Stopped after ${limit} keys. Narrow the pattern to walk a smaller key space.`;
        break;
      }
    }

    if (!alive.current) return;
    setScanningAll(false);
    if (reason !== null) setStoppedBy(reason);
    // Applied after the cap's sentence rather than instead of it, so a Stop pressed in the same turn
    // is what a reader sees: the two are ordered, not merged.
    if (stopped.current) setStoppedBy("Stopped.");
  }, [scanMore]);

  const stop = useCallback((): void => {
    // Read by the loop between pages, so this stops a walk rather than a request: the page already
    // in flight lands, is counted, and is the last one.
    stopped.current = true;
  }, []);

  const reset = useCallback((): void => {
    stopped.current = true;
    cursor.current = "0";
    spent.current = false;
    scannedKeys.current = 0;
    failure.current = null;
    setKeys([]);
    setScanned(0);
    setTotal(null);
    setExhausted(false);
    setStoppedBy(null);
    setError(null);
  }, []);

  return { keys, scanned, total, busy, scanningAll, exhausted, stoppedBy, error, scanMore, scanAll, stop, reset };
}
