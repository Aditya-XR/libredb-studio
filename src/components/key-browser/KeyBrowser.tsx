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
import { ChevronRight, Folder, KeyRound, LoaderCircle, TriangleAlert } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import type { DatabaseConnection } from "@/lib/types";
import type { KeyScanCapability } from "@/lib/db/types";
import { buildKeyTree, filterKeyTree, flattenKeyTree } from "./tree";
import { useKeyScan } from "./use-key-scan";

/** A row's identity: the whole path, because two siblings can share a segment under two parents. */
function pathKey(path: readonly string[]): string {
  return JSON.stringify(path);
}

export interface KeyBrowserProps {
  readonly connection: DatabaseConnection;
  /** What this provider declares a batch to be. Absent means no walk, and the shell draws nothing. */
  readonly capability: KeyScanCapability;
}

export function KeyBrowser({ connection, capability }: KeyBrowserProps) {
  const [pattern, setPattern] = useState("");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const { keys, scanned, total, busy, scanningAll, exhausted, stoppedBy, error, scanMore, scanAll, stop, reset } =
    useKeyScan({ connection, capability, pattern });

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
  const rows = useMemo(
    () => flattenKeyTree(visible, (path) => filtering || open.has(pathKey(path))),
    [visible, filtering, open],
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

      {error !== null && (
        <div className="flex flex-col items-center px-2 py-6 text-center" data-testid="key-browser-error">
          <TriangleAlert strokeWidth={1.5} className="h-5 w-5 text-warning" />
          <p className="mt-2 break-words text-xs leading-relaxed text-muted-foreground">{error}</p>
        </div>
      )}

      {error === null && stoppedBy !== null && (
        <p className="px-1 pb-2 text-[10px] leading-relaxed text-warning" data-testid="key-browser-stopped">
          {stoppedBy}
        </p>
      )}

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
            const key = pathKey(row.node.path);
            const isOpen = filtering || open.has(key);
            return (
              <div
                key={key}
                role="treeitem"
                aria-expanded={row.folder ? isOpen : undefined}
                tabIndex={0}
                title={row.node.path.join(":")}
                onClick={() => {
                  if (row.folder) openPath(row.node.path);
                }}
                onKeyDown={(event) => {
                  if (row.folder && (event.key === "Enter" || event.key === " ")) {
                    event.preventDefault();
                    openPath(row.node.path);
                  }
                }}
                // The project's own row recipe: `8 + depth * 12`, the same induction the object tree
                // uses, so a key two levels down lines up with a table two levels down.
                style={{ paddingLeft: 8 + row.depth * 12 }}
                className={cn(
                  "flex h-6 cursor-default select-none items-center gap-1 rounded pr-1 outline-none hover:bg-accent",
                  "focus-visible:ring-1 focus-visible:ring-brand",
                  row.folder && "cursor-pointer",
                )}
              >
                {row.folder ? (
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
                {row.folder ? (
                  <Folder strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-hue-yellow/70" />
                ) : (
                  <KeyRound strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate font-mono text-xs">
                  {row.node.segment}
                  {row.folder && ":*"}
                </span>
                <span className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground">
                  {row.node.count}
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
