"use client";

/**
 * A sampled walk of an engine's key space, drawn as the tree its names imply.
 *
 * THE KEYS ARE ALREADY HERE, so opening a row asks the server for nothing: the walk accumulates
 * batches and the tree is arranged from what has arrived. That is the whole reason this is a panel
 * rather than a reader — `SCAN` can only answer a cursor, so the only way to be fast on a keystroke
 * is to hold what the walk has seen and rearrange it locally.
 *
 * WHAT IS DRAWN IS A SAMPLE, and it says so. `Scanned n/m` is the walk's progress against the
 * server's own key count, a folder's number is how many keys the walk found under it, and a prefix
 * whose keys have not arrived yet does not appear at all. The alternative — presenting a sample as
 * a catalog — is the defect this panel exists to avoid.
 *
 * A FOLDER IS A NAME, NOT A THING. `app:*` is a row this client drew because two keys begin with
 * those bytes; nothing on the server can be asked about it. That is why a folder is not clickable
 * into a query the way a table is, and why the row says `shape` rather than claiming an object.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, Folder, KeyRound, LoaderCircle, PackageOpen, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { DatabaseConnection } from "@/lib/types";
import type { KeyScanCapability } from "@/lib/db/types";
import { buildKeyTree, filterKeyTree, flattenKeyTree, KEY_SEPARATOR, pathKey } from "./tree";
import { useKeyScan } from "./use-key-scan";

export interface KeyBrowserProps {
  readonly connection: DatabaseConnection;
  /** What this provider declares a batch to be. Absent means no walk, and the shell draws nothing. */
  readonly capability: KeyScanCapability;
}

export function KeyBrowser({ connection, capability }: KeyBrowserProps) {
  const [pattern, setPattern] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const {
    keys,
    scanned,
    total,
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
  } = useKeyScan({ connection, capability, pattern });

  /*
   * The first page loads itself. A panel whose first gesture is "find the Scan button" reads as
   * broken until somebody finds it, and the walk is what the panel IS rather than something done to
   * it. `reset` and `scanMore` are the dependencies and not `pattern` alone: both are stable for a
   * given pattern, so a new pattern runs this once and a re-render of the same one does not run it
   * at all — a walk restarted on every render would request the first page forever.
   */
  useEffect(() => {
    reset();
    void scanMore();
  }, [reset, scanMore]);

  const openPath = useCallback(
    (path: readonly string[]) => {
      setOpen((previous) => {
        const next = new Set(previous);
        const key = pathKey(path);
        // One write for both directions: a twisty that only ever added would be a row that cannot be
        // closed, and the copy is what makes React see a new Set.
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    [setOpen],
  );

  const tree = useMemo(() => buildKeyTree(keys), [keys]);
  const filtering = term.trim() !== "";
  const visible = useMemo(() => filterKeyTree(tree, term), [tree, term]);
  // While a filter is on, every surviving folder is open: a match two levels down that stayed
  // collapsed would look like no match at all, which is the one answer a filter must never give.
  const canLoadMore = useCallback(
    (path: readonly string[]) => {
      /*
       * THREE REASONS NOT TO OFFER IT, and each is a fact rather than a preference.
       *
       * The walk is SPENT: a cursor of `"0"` at the database level means the sample IS the keyspace,
       * so every prefix in it is complete and a "there may be more" row would be a lie.
       *
       * The prefix is SPENT: its own scoped walk came back `"0"`, which is the one thing that proves
       * there is nothing more under it.
       *
       * A FILTER IS ON: the visible tree is a view of what is held, and a row that pulled more keys
       * into it would make what a reader sees depend on clicks the filter's term does not explain.
       * Clearing the box brings the rows back.
       */
      if (exhausted || filtering) return false;
      return nodeCursors.get(pathKey(path)) !== "0";
    },
    [exhausted, filtering, nodeCursors],
  );
  const rows = useMemo(
    () => flattenKeyTree(visible, (path) => filtering || open.has(pathKey(path)), canLoadMore),
    [visible, filtering, open, canLoadMore],
  );

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="key-browser">
      <div className="flex items-center gap-1 pb-2">
        <Input
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="Match pattern, e.g. app:cache:*"
          aria-label="Match pattern"
          className="h-7 flex-1 font-mono text-xs"
        />
      </div>

      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span className="text-[10px] tabular-nums text-muted-foreground" data-testid="key-browser-progress">
          Scanned {scanned}
          {total === null ? "" : `/${total}`}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void scanMore()}
            disabled={busy || scanningAll || exhausted}
            className="rounded px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            Scan more
          </button>
          <button
            type="button"
            onClick={() => (scanningAll ? stop() : void scanAll())}
            disabled={busy && !scanningAll}
            className="rounded px-2 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            {scanningAll ? "Stop" : "Scan all"}
          </button>
        </div>
      </div>

      {keys.length > 0 && (
        <div className="pb-2">
          <Input
            value={term}
            onChange={(event) => setTerm(event.target.value)}
            placeholder="Filter the keys found"
            aria-label="Filter the keys found"
            className="h-7 text-xs"
          />
        </div>
      )}

      {/*
        A FAILED PAGE IS A BANNER, NOT A REPLACEMENT. A page that failed did not invalidate the pages
        that did — the keys already in the tree are still answers the server really gave — so taking
        the tree away would hide correct data because a later request could not be made. It is now
        load-bearing rather than a preference: a scoped Load more can fail on its own, and blanking
        the panel for it would punish the reader for one prefix.
      */}
      {error !== null && (
        <div
          className="mb-2 flex items-start gap-2 rounded border border-warning/40 bg-warning/5 px-2 py-1.5"
          data-testid="key-browser-error"
        >
          <TriangleAlert strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="break-words text-[10px] leading-relaxed text-muted-foreground">{error}</p>
        </div>
      )}

      {stoppedBy !== null && (
        <p className="px-1 pb-2 text-[10px] leading-relaxed text-warning" data-testid="key-browser-stopped">
          {stoppedBy}
        </p>
      )}

      {/* Suppressed by an error because it is a claim about the DATABASE, and a read that failed is
          not evidence about what the database holds. */}
      {error === null && rows.length === 0 && (
        <div
          className="flex flex-col items-center px-2 py-6 text-center text-muted-foreground"
          data-testid="key-browser-empty"
        >
          {busy ? (
            <LoaderCircle strokeWidth={1.5} className="h-5 w-5 animate-spin text-brand/40" />
          ) : (
            <>
              <KeyRound strokeWidth={1.5} className="h-5 w-5" />
              <span className="mt-2 text-xs font-medium">
                {filtering ? "No key matches the filter" : "This database holds no keys the walk has seen"}
              </span>
            </>
          )}
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1">
        <div role="tree" aria-label="Keys">
          {rows.map((row) => {
            if (row.kind === "loadMore") {
              const key = pathKey(row.path);
              const loading = nodeLoading.has(key);
              return (
                <button
                  key={`more:${key}`}
                  type="button"
                  data-testid="key-browser-load-more"
                  disabled={loading}
                  onClick={() => void loadMoreUnder(row.path)}
                  // One level deeper than the folder it belongs to, so it reads as following the
                  // children above it rather than as one of them.
                  style={{ paddingLeft: 8 + row.depth * 12 }}
                  className="flex h-6 w-full items-center gap-1 rounded pr-1 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="h-3.5 w-3.5 shrink-0" />
                  {loading ? (
                    <LoaderCircle
                      strokeWidth={1.5}
                      className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground"
                    />
                  ) : (
                    <PackageOpen strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="truncate text-xs text-muted-foreground">
                    {loading ? "Loading..." : "Click to load more"}
                  </span>
                </button>
              );
            }

            const { node, depth, folder } = row;
            const key = pathKey(node.path);
            const isOpen = filtering || open.has(key);
            return (
              <div
                key={key}
                role="treeitem"
                aria-expanded={folder ? isOpen : undefined}
                tabIndex={0}
                // The FULL name, which is what a key is identified by. A folder's own row is its
                // prefix and says so with `:*`; a leaf's identity is the whole path, and the depth it
                // is drawn at only says where the tree put it.
                title={folder ? `${node.path.join(KEY_SEPARATOR)}:*` : node.path.join(KEY_SEPARATOR)}
                onClick={() => {
                  if (folder) openPath(node.path);
                }}
                onKeyDown={(event) => {
                  if (folder && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    openPath(node.path);
                  }
                }}
                // The project's own row recipe: `8 + depth * 12`, the same induction the object tree
                // uses, so a key two levels down lines up with a table two levels down.
                style={{ paddingLeft: 8 + depth * 12 }}
                className={cn(
                  "flex h-6 cursor-default select-none items-center gap-1 rounded pr-1 outline-none hover:bg-accent",
                  "focus-visible:ring-1 focus-visible:ring-brand",
                  folder && "cursor-pointer",
                )}
              >
                {folder ? (
                  <ChevronRight
                    strokeWidth={1.5}
                    className={cn(
                      "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                ) : (
                  // A leaf keeps the column so labels line up down a level, the way the object tree
                  // pads a row with no twisty.
                  <span className="h-3.5 w-3.5 shrink-0" />
                )}
                {folder ? (
                  <Folder strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-hue-yellow/70" />
                ) : (
                  <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono text-xs">
                  {folder ? `${node.segment}:*` : node.path.join(KEY_SEPARATOR)}
                </span>
                {/*
                  A FOLDER COUNTS ITS CHILDREN, and a leaf carries no number at all.
                  The badge on a folder is the number of rows it can be opened to show, which is what
                  a reader compares against that list. The number of KEYS under the prefix is a
                  different question — it is larger, it includes everything deeper, and reading it as
                  "children" is how a folder comes to look like it is missing rows. That number is on
                  the row's tooltip instead.
                */}
                {folder && (
                  <span
                    className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground"
                    title={`${node.count.toLocaleString("en-US")} scanned key${node.count === 1 ? "" : "s"} under this prefix`}
                  >
                    {node.children.length}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
