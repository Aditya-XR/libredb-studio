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
import { escapeGlob } from "@/lib/query-generators";
import { isUnderPrefix, KEY_SEPARATOR, pathKey } from "./tree";

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
  /**
   * Each key's value type, by key name, as last answered by the server.
   *
   * A KEY ABSENT FROM THIS MAP IS ONE NO PAGE HAS DESCRIBED, and a row draws nothing for it rather
   * than guessing — see `KeyScanPage.types`. Types arrive WITH their page, so a row is never drawn
   * beside a type that is still on its way.
   */
  readonly types: ReadonlyMap<string, string>;
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
  /**
   * Where each PREFIX's own walk stands, by `pathKey`.
   *
   * Absent means that prefix has never been scoped, which is not the same as "no more": the whole
   * point of a scoped walk is that the global sample cannot answer the question. `"0"` means the
   * scoped walk reached the end of that prefix and there is provably nothing more under it.
   */
  readonly nodeCursors: ReadonlyMap<string, string>;
  /** Prefixes whose scoped page is in flight, so a row can say so instead of taking a second press. */
  readonly nodeLoading: ReadonlySet<string>;
}

export interface KeyScanControls {
  /** Take one more batch from wherever the walk stands. */
  readonly scanMore: () => Promise<void>;
  /** Page until the walk is spent, the cap is reached, someone presses Stop, or a page fails. */
  readonly scanAll: () => Promise<void>;
  /**
   * Take one more batch of the walk scoped to ONE PREFIX, for the row under an open folder.
   *
   * The keys it brings back join the tree and NOT the walk's own progress: `scanned` counts what the
   * GLOBAL walk has been handed, and a scoped page hands back keys the global walk may already have
   * counted. Adding them would push the progress line above its own denominator.
   */
  readonly loadMoreUnder: (path: readonly string[]) => Promise<void>;
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
  const [nodeCursors, setNodeCursors] = useState<ReadonlyMap<string, string>>(new Map());
  const [nodeLoading, setNodeLoading] = useState<ReadonlySet<string>>(new Set());
  const [types, setTypes] = useState<ReadonlyMap<string, string>>(new Map());

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
  /*
   * The keys the tree has already been handed.
   *
   * Two pages can name the same key — a `SCAN` may return it twice, and a scoped page certainly
   * overlaps the global walk — and a tree cannot draw one key twice. Deduplicating HERE rather than
   * leaving it to `buildKeyTree` is what keeps the accumulated list bounded: without it, every scoped
   * page would append its whole batch again, and a reader pressing Load more down a deep prefix would
   * grow the array until the search that feeds the tree was the slowest thing on screen.
   */
  const walked = useRef(new Set<string>());
  /*
   * Each prefix's own walk, keyed by `pathKey`. In a ref because the read has to see what the last
   * scoped page wrote, exactly as the global cursor does, and mirrored into state below because a row
   * has to RENDER the difference between "never asked" and "asked and there is no more".
   */
  const nodeCursor = useRef(new Map<string, string>());
  const nodeInFlight = useRef(new Set<string>());
  /*
   * The types the server has answered with, accumulated across pages. In a ref beside its mirror for
   * the same reason the cursors are: a page records what it learned before the next decision, and a
   * row has to render it.
   */
  const knownTypes = useRef(new Map<string, string>());

  useEffect(() => {
    // Set on the way IN as well as cleared on the way out: React runs an effect twice on one mount
    // in development, and a cleanup that only ever wrote `false` would leave the second mount
    // permanently ignoring its own answers.
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /**
   * One page, from a cursor and a pattern the CALLER names.
   *
   * Parameterised rather than reading this hook's own cursor and pattern, because there are two
   * walks now: the global one this hook drives, and one per prefix that a reader asks for by pressing
   * Load more. They differ in exactly these two arguments and in nothing else.
   */
  const readPageAt = useCallback(
    async (at: string, match: string): Promise<KeyScanPage> => {
      const payload = buildConnectionPayload(connection);
      const request: Omit<KeyScanOptions, "database"> = {
        cursor: at,
        count: batchSize(capability),
        ...(match === "" ? {} : { pattern: match }),
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
      return { keys: body.keys ?? [], cursor: body.cursor ?? "0", total: body.total ?? 0, types: body.types ?? {} };
    },
    [connection, capability],
  );

  /**
   * The names in a page the tree does not hold yet, and the record that it now does.
   *
   * One function because two callers need the same two steps in the same order, and a caller that
   * read `walked` before the other had written it would append a batch twice.
   */
  const absorb = useCallback((names: readonly string[]): string[] => {
    const fresh = names.filter((name) => !walked.current.has(name));
    for (const name of fresh) walked.current.add(name);
    return fresh;
  }, []);

  /**
   * Record what a page said about its keys' types.
   *
   * ONE WRITE PER PAGE, and the mirror is REPLACED rather than mutated, because React compares the
   * reference: a map mutated in place would render as unchanged and the type would never appear.
   */
  const absorbTypes = useCallback((page: KeyScanPage): void => {
    const entries = Object.entries(page.types);
    if (entries.length === 0) return;
    for (const [name, type] of entries) knownTypes.current.set(name, type);
    setTypes(new Map(knownTypes.current));
  }, []);

  const scanMore = useCallback(async (): Promise<void> => {
    // One page at a time. Two in flight would both read the same cursor and both advance from it,
    // so the second answer would overwrite the position the first one earned and the walk would
    // skip whatever lay between them. A spent walk is refused for the same reason it is spent.
    if (running.current || spent.current) return;
    running.current = true;
    setBusy(true);

    try {
      const page = await readPageAt(cursor.current, pattern);
      if (!alive.current) return;
      cursor.current = page.cursor;
      scannedKeys.current += page.keys.length;
      failure.current = null;
      const fresh = absorb(page.keys);
      absorbTypes(page);
      setKeys((previous) => (fresh.length === 0 ? previous : [...previous, ...fresh]));
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
  }, [absorb, absorbTypes, pattern, readPageAt]);

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

  /**
   * One page of a walk scoped to ONE PREFIX, for the Load more row under an open folder.
   *
   * WHY THIS EXISTS AT ALL. The global walk is a SAMPLE of the keyspace, so a prefix's contents in the
   * tree are whatever that sample happened to include — and a deep prefix can be entirely absent from
   * a thousand keys of a million. A scoped walk asks the server about that prefix directly, which is
   * the only way to answer "is there more under here" truthfully. It is also why the answer is not free:
   * `MATCH` is applied per batch server-side and is not indexed, so this costs the server a full pass
   * over the keyspace, exactly as the global walk's every page does.
   *
   * IT RUNS ONE WALK PER PREFIX AND KEEPS ITS CURSOR, so pressing Load more twice continues that
   * prefix rather than restarting it. `nodeCursor` is the authority and the state below is its mirror
   * for rendering, for the same reason the global cursor is a ref: the decision has to read what the
   * last page wrote.
   *
   * IT DOES NOT TOUCH THE WALK'S PROGRESS. `scanned` and `total` are the global walk's, and a scoped
   * page hands back keys the global walk may already have counted — adding them would push the
   * progress line past its own denominator. It also does not set the loop's failure flag: a prefix
   * that refuses is not a reason to end the walk somebody started at the database level.
   *
   * THE ANSWER IS FILTERED, because `MATCH` is a glob with no escape and a real key segment can
   * contain `*` or `[`. See `isUnderPrefix`.
   */
  const loadMoreUnder = useCallback(
    async (path: readonly string[]): Promise<void> => {
      const key = pathKey(path);

      // One page per prefix at a time, for the reason `scanMore` gives about the global walk: two in
      // flight would both read this prefix's cursor and both advance from it.
      if (nodeInFlight.current.has(key)) return;
      nodeInFlight.current.add(key);
      setNodeLoading((previous) => new Set(previous).add(key));

      try {
        /*
         * THE PREFIX HALF OF THE PATTERN IS ESCAPED, and the key half never is (#427).
         *
         * A real key segment can contain a glob metacharacter: `a[b:1` groups to a prefix holding
         * `[`, and an unescaped one opens a character class that matches a different set of keys
         * entirely. The escaping comes from `escapeGlob` rather than a local copy so that this walk
         * and the object surface's "list keys under this prefix" cannot drift — the same rule, in
         * one place. Note the asymmetry the other way: the `isUnderPrefix` filter below compares
         * REAL key names, so it must stay unescaped, and a caller that escaped those would corrupt
         * a literal key that genuinely contains `*`.
         */
        const page = await readPageAt(nodeCursor.current.get(key) ?? "0", `${escapeGlob(path.join(KEY_SEPARATOR))}:*`);
        if (!alive.current) return;
        nodeCursor.current.set(key, page.cursor);
        setNodeCursors(new Map(nodeCursor.current));

        const fresh = absorb(page.keys.filter((name) => isUnderPrefix(name, path)));
        absorbTypes(page);
        setKeys((previous) => (fresh.length === 0 ? previous : [...previous, ...fresh]));
        setError(null);
      } catch (thrown) {
        if (!alive.current) return;
        // NOT written to the loop's failure flag: see this callback's own note. The panel shows the
        // sentence and keeps the keys it already has, because a page that failed did not invalidate
        // the pages that did not.
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      } finally {
        nodeInFlight.current.delete(key);
        if (alive.current) {
          setNodeLoading((previous) => {
            const next = new Set(previous);
            next.delete(key);
            return next;
          });
        }
      }
    },
    [absorb, absorbTypes, readPageAt],
  );

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
    // Every prefix's walk goes with the global one: the keys they brought are about to leave the
    // tree, and a cursor left standing would answer the NEXT walk's Load more with keys from this one.
    nodeCursor.current.clear();
    nodeInFlight.current.clear();
    walked.current.clear();
    knownTypes.current.clear();
    setKeys([]);
    setScanned(0);
    setTotal(null);
    setExhausted(false);
    setStoppedBy(null);
    setError(null);
    setNodeCursors(new Map());
    setNodeLoading(new Set());
    setTypes(new Map());
  }, []);

  return {
    keys,
    scanned,
    total,
    types,
    busy,
    scanningAll,
    exhausted,
    stoppedBy,
    error,
    nodeCursors,
    nodeLoading,
    scanMore,
    scanAll,
    loadMoreUnder,
    stop,
    reset,
  };
}
