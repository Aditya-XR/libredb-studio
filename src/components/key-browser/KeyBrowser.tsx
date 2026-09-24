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
 *
 * THE ROOT OF THE TREE IS A DATABASE, WHICH IS THE ONE THING ABOVE A KEY THAT REALLY EXISTS. A key
 * space belongs to a numbered database, the walk takes that number, and the reader picks it from the
 * engine's own container list — so the tree is drawn under that row rather than floating free, and
 * everything below it is the arrangement described above.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  Database,
  Folder,
  KeyRound,
  LoaderCircle,
  PackageOpen,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import type { DatabaseConnection } from "@/lib/types";
import type { ContainerLevelSpec, KeyScanCapability } from "@/lib/db/types";
import { buildKeyTree, filterKeyTree, flattenKeyTree, KEY_SEPARATOR, pathKey, type KeyTreeNode } from "./tree";
import { useKeyDatabases } from "./use-key-databases";
import { useKeyScan } from "./use-key-scan";

export interface KeyBrowserProps {
  readonly connection: DatabaseConnection;
  /** What this provider declares a batch to be. Absent means no walk, and the shell draws nothing. */
  readonly capability: KeyScanCapability;
  /**
   * The container level a walk is pointed at, when the engine declares one to choose from.
   *
   * Absent means the engine has no level above a key that this panel can name — the walk then goes
   * wherever the engine puts the session, which is what it did before there was anything to choose.
   * The spec is passed rather than the capabilities so the panel cannot invent a label or a depth for
   * a level the engine did not declare: the engine's own WORD for it ("Database") is what the
   * dropdown is labelled with.
   */
  readonly databaseLevel?: ContainerLevelSpec;
  /**
   * A pattern the shell asked to see, from a key-prefix row's own menu.
   *
   * Applied ONCE per request and then owned by the panel, so a reader can edit or clear it afterwards.
   */
  readonly request?: KeyPatternRequest;
  /**
   * A key the reader activated, with the type this panel already knows about it.
   *
   * THE TYPE COMES FROM THE PAGE, so activating a key costs no request of its own: the server sends
   * each key's type with the batch it arrived in. `null` is a key no page described, and the shell
   * decides what to do with that — refusing is as reasonable as opening the editor on a command that
   * finds out.
   *
   * THE DATABASE COMES WITH IT for the same reason and one more: this panel WALKS one numbered
   * database, a key lives in exactly one of them, and Redis has no database-qualified key syntax — so
   * a generated `GET <key>` cannot name the database it belongs to. The number is what lets the shell
   * run the read where the key actually is; `null` is the engine's own session database, which is
   * nothing to override and the call the shell has always taken.
   *
   * Absent means nobody is listening, and the rows are then not clickable: a row that looks
   * actionable and does nothing is worse than one that plainly is not.
   */
  readonly onOpenKey?: (key: string, type: string | null, database: number | null) => void;
}

/**
 * A pattern somebody asked this panel to show — a key-prefix row's own name, handed over from the
 * object tree's row menu.
 *
 * AN OBJECT AND NOT A STRING, because this is a REQUEST rather than a value: the same pattern asked
 * for twice is a second request, and a string would be indistinguishable from the one already here —
 * so a caller could never ask again, and the panel could never tell an ask from its own state.
 */
export interface KeyPatternRequest {
  /** The `MATCH` pattern the row named, ready to send. */
  readonly pattern: string;
  /**
   * The container the row lives in, when the row names one.
   *
   * A KEY PATTERN ROW BELONGS TO A DATABASE, and the row menu's item is offered on the rows of every
   * database the object tree lists - so a request that carried the pattern alone would walk whichever
   * database the panel happened to be in, and answer about a key space the reader never pointed at.
   * The NAME rather than a number because that is what the engine listed and what this panel's own
   * choice is made of; an engine whose containers are not numbers cannot be walked by number at all.
   */
  readonly database?: string;
}

/**
 * The picker's stand-in for "the database the session is already in".
 *
 * A SENTINEL BECAUSE THE VALUE CANNOT BE EMPTY: Radix refuses an empty `SelectItem` value, and the
 * fact this one carries is not an absence — it is the engine's own answer, which is exactly what an
 * absent `database` on the wire means.
 */
const SESSION_DATABASE = "__session__";

/**
 * A container name a walk can be POINTED AT, or null.
 *
 * `KeyScanOptions.database` is a number, so a container the engine named something else — a schema, a
 * bucket, a keyspace whose names are words — is one this panel cannot address: nothing is sent for it
 * and the engine answers with the session's, which is a real answer rather than a guess.
 */
function addressable(name: string | null): string | null {
  return name !== null && /^\d+$/.test(name) ? name : null;
}

/**
 * What the last press of a prefix's Load more did, in the row's own words.
 *
 * ABSENT IS NOT ZERO. A prefix nobody has asked about has no outcome to report and says nothing, while
 * a page that came back holding only keys already in the tree is a real answer that has to be shown —
 * otherwise the press looks like a button that does nothing, which is exactly what it is not.
 */
function outcomeOf(added: number | undefined): string {
  if (added === undefined) return "";
  return added === 0 ? " · nothing new in that page" : ` · +${added} new`;
}

export function KeyBrowser({ connection, capability, databaseLevel, request, onOpenKey }: KeyBrowserProps) {
  const [pattern, setPattern] = useState(request?.pattern ?? "");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // A request's database is the panel's INITIAL choice, exactly as its pattern is the initial
  // pattern: on mount the sync below has nothing to compare against, so a row's own database would
  // otherwise be dropped on the very first handover - the case the item exists for.
  const [chosen, setChosen] = useState<string | null>(request?.database ?? null);
  const [databaseOpen, setDatabaseOpen] = useState(true);
  const [answered, setAnswered] = useState<KeyPatternRequest | undefined>(request);

  /*
   * A REQUEST IS APPLIED ON THE RENDER IT ARRIVES, which is React's own escape hatch for state derived
   * from a prop and the shape `useProviderMetadata` uses for its reset. An effect would commit one
   * render showing the OLD pattern — and that render already walks, because the walk follows the
   * pattern — so the panel would take a page of the previous question and then throw it away.
   *
   * IDENTITY IS THE QUESTION AND NOT THE TEXT: a request for the pattern already on screen changes
   * nothing, because the sample in the tree IS the answer to it.
   */
  if (answered !== request) {
    setAnswered(request);
    if (request !== undefined) {
      setPattern(request.pattern);
      // The row's own database travels with it: a request that changed the pattern but not the
      // database would answer about the key space the panel was already in.
      if (request.database !== undefined) setChosen(request.database);
      // The filter belongs to the keys that were on screen, and those are about to be replaced: left
      // on, it would hide the answer to the request that was just made.
      setTerm("");
    }
  }

  const {
    names,
    answered: databasesAnswered,
    sessionDefault,
    error: databasesError,
  } = useKeyDatabases(connection, databaseLevel);

  /*
   * THE DATABASE THE WALK READS, which is a name until the last moment because that is what the
   * engine listed.
   *
   * ONLY A CHOICE IS SENT, and that is not an optimisation. The engine answers "which database is
   * this session in?" itself, so a first page that carried the session's own number would be asking
   * for what it was already getting — and the walk would then be RESTARTED the moment the container
   * list arrived, because the request's question changed under it. Nothing is sent until somebody
   * chooses, and an absent `database` is the engine's own default.
   *
   * `chosen` is only honoured while this engine still lists it: a reader who picked database 3 and
   * then switched to a server with two of them gets the session's own rather than a number that
   * server never offered.
   */
  const listed = chosen !== null && names.includes(chosen) && addressable(chosen) !== null ? chosen : null;
  /**
   * Whether the panel is waiting for the container list before it can walk the database it was asked
   * for.
   *
   * A REQUEST THAT NAMES A DATABASE IS NOT AN ANSWER ABOUT ONE. The panel cannot point the walk at a
   * container it has not been told exists, so starting one anyway would take a page of the session's
   * database and replace it a moment later - the visible flash of one database's keys under another
   * database's name, for no answer. The wait ends when the list answers, whatever it answers: a
   * refused list is a real answer about the list, and the walk then goes where the panel says it does.
   */
  const waitingForChosenDatabase = chosen !== null && !databasesAnswered && databasesError === null;
  /** What the panel says the walk is reading: the choice, or the engine's own session database. */
  const walked = listed ?? sessionDefault;
  const database = listed === null ? undefined : Number(listed);
  /**
   * The database row the tree hangs under, or null when there is no database to draw.
   *
   * It names the database the walk is actually reading — the choice, or the engine's own session
   * database — because that is the fact a reader looking at a key needs.
   */
  const databaseRow =
    databaseLevel !== undefined && walked !== null ? { name: walked, label: databaseLevel.label } : null;

  const {
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
    nodeAdded,
    scanMore,
    scanAll,
    loadMoreUnder,
    stop,
    reset,
  } = useKeyScan({ connection, capability, pattern, database });

  /*
   * Start the walk again from cursor `"0"`.
   *
   * `reset` and then one page, in that order and in one place, because two callers want exactly this:
   * the effect below, when the question the walk answers has changed, and the panel's own refresh
   * button, when the reader wants the same question asked again. The generation `reset` bumps is what
   * makes it safe while a page is still in the air — that answer is dropped rather than mixed in.
   */
  const restart = useCallback(() => {
    reset();
    void scanMore();
  }, [reset, scanMore]);

  /*
   * The first page loads itself, and it is re-taken when the walk's question changes.
   *
   * A panel whose first gesture is "find the Scan button" reads as broken until somebody finds it,
   * and the walk is what the panel IS rather than something done to it. `restart` is the dependency
   * and not `pattern` alone: it changes exactly when the connection, the pattern or the database
   * changes — a different question, so a different walk — and it is stable for a given question, so a
   * re-render of the same one does not restart anything. A walk restarted on every render would
   * request its first page for ever.
   *
   * `waitingForChosenDatabase` is the one case where the walk does NOT start yet, and it is read here
   * rather than left to the restart above: the database a row asked for is only usable once the
   * engine has confirmed it exists, and a page taken before that is a page thrown away.
   */
  useEffect(() => {
    if (waitingForChosenDatabase) return;
    restart();
  }, [restart, waitingForChosenDatabase]);

  /**
   * Hand a leaf to the shell, with the type this panel already has for it.
   *
   * A FOLDER IS NOT HANDED OVER: it has no value, so there is nothing to read and the shell has no
   * command to open. Activating one opens it, which is what a reader means by clicking a folder.
   */
  const openKey = useCallback(
    (node: KeyTreeNode) => {
      const name = node.path.join(KEY_SEPARATOR);
      // `database` is the walked database as a number, or undefined while nothing was chosen — which
      // the shell reads as "the engine's own", exactly as an absent `database` does on the wire.
      onOpenKey?.(name, types.get(name) ?? null, database ?? null);
    },
    [database, onOpenKey, types],
  );

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
  /**
   * A row's indentation, in pixels.
   *
   * THE DATABASE ROW PUSHES EVERYTHING UNDER IT DOWN ONE LEVEL, so the tree's own `8 + depth * 12`
   * induction still lines a key up with a row of the same depth elsewhere in the product rather than
   * with the database's children.
   */
  const indent = (depth: number): number => 8 + (depth + (databaseRow === null ? 0 : 1)) * 12;

  /*
   * WHAT THE TWO NUMBERS OF THE PROGRESS LINE ARE, because they are not the same kind of number and
   * the obvious wording says they are.
   *
   * The denominator is the server's own `DBSIZE`: EVERY key the database holds, whatever pattern is
   * in hand. The numerator is what the walk has been HANDED, and a `MATCH` narrows that to the keys
   * that passed it — so with a pattern on, the fraction is not a walk position at all. Redis walks
   * the whole table and filters; a walk that has finished with `user:*` reports `137` because 137 keys
   * match, and "Scanned 137/1531" invites a reader to wait for a walk that is already over.
   *
   * So the word follows the question: a plain walk is Scanned, a pattern is Matched. The tooltip says
   * what both numbers are, since neither word explains the pair on its own.
   */
  const progressPrefix = pattern === "" ? "Scanned" : "Matched";
  const progressSuffix = total === null ? "" : pattern === "" ? `/${total}` : ` of ${total}`;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="key-browser">
      <div className="flex items-center gap-1 pb-2">
        <Input
          value={pattern}
          onChange={(event) => setPattern(event.target.value)}
          placeholder="Match pattern, e.g. app:cache:*"
          aria-label="Match pattern"
          className="h-7 min-w-0 flex-1 font-mono text-xs"
        />
        {/*
          WHICH DATABASE THE WALK IS IN, from the engine's own list. Drawn only where the engine
          declared a level to choose from, and left empty while that read is in flight or refused:
          the walk itself does not wait for it, because an absent database means the session's own.

          THE PROJECT'S OWN SELECT AND NOT A NATIVE ONE, which is a colour and not a taste: a native
          `<option>` list is painted by the browser, and this application declares no `color-scheme`,
          so the popup came out light with the dark theme's text on it — a menu a reader has to guess
          at. `SelectContent` is the themed surface every other picker in the product opens.
        */}
        {databaseLevel !== undefined && (
          <Select
            value={walked ?? SESSION_DATABASE}
            onValueChange={(value) => setChosen(value === SESSION_DATABASE ? null : value)}
            disabled={names.length === 0}
          >
            <SelectTrigger
              size="sm"
              aria-label={databaseLevel.label}
              title={`${databaseLevel.label} to walk`}
              // The component's `sm` trigger is 32px and this panel's rows are 28, so the SAME variant
              // is asked for the height rather than an `!` override: `tailwind-merge` sees one group
              // and keeps the later value, which is the one written here.
              className="h-7 data-[size=sm]:h-7 w-[4.5rem] shrink-0 px-1.5 py-0 font-mono text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* A real item rather than a `placeholder`, because it is a real ANSWER: it means "the
                  database the session is already in", which is what the engine walks when nothing was
                  chosen. Radix refuses an empty item value, so the sentinel stands for it. */}
              <SelectItem value={SESSION_DATABASE} className="text-xs">
                session
              </SelectItem>
              {names.map((name) => (
                <SelectItem key={name} value={name} className="font-mono text-xs">
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {/*
          ASK AGAIN. The walk is a sample of a key space that changes under it, so re-reading it is a
          normal thing to want rather than a recovery from a failure — and it is the only way to see a
          key somebody else wrote without leaving the panel.
        */}
        <button
          type="button"
          data-testid="key-browser-refresh"
          onClick={restart}
          aria-label="Scan this database again"
          title="Scan this database again"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-brand"
        >
          <RefreshCw strokeWidth={1.5} className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 px-1 pb-2">
        <span
          className="text-[10px] tabular-nums text-muted-foreground"
          data-testid="key-browser-progress"
          title="Keys the walk has been handed, out of every key this database holds"
        >
          {progressPrefix} {scanned}
          {progressSuffix}
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
            /*
              WHAT IT MATCHES, on the row itself, because the box takes two kinds of answer and the
              reader cannot tell which one it wants: a word names a SEGMENT (`cache`), and the rest of
              a path names a KEY (`queue:jobs:failed:2026:09:23`). Both are answered — see
              `filterKeyTree` — and the tooltip is where that is stated rather than guessed at.
            */
            title="Narrows the keys already loaded, without asking the server. Matches any part of a key's full name, or one of its `:`-separated segments."
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

      {/*
        THE DATABASE LIST IS ITS OWN REPORT, because it is its own read. A refusal there is not a
        refusal of the walk — the panel still walks the session's database — so the two sentences are
        drawn separately rather than ranked into one slot, and the reader can tell which read failed.
      */}
      {databasesError !== null && (
        <div
          className="mb-2 flex items-start gap-2 rounded border border-warning/40 bg-warning/5 px-2 py-1.5"
          data-testid="key-browser-databases-error"
        >
          <TriangleAlert strokeWidth={1.5} className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
          <p className="break-words text-[10px] leading-relaxed text-muted-foreground">
            {`Reading the databases failed: ${databasesError}`}
          </p>
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
          {/*
            THE DATABASE THE KEYS ARE IN, drawn as the tree's root because that is what it is: a key
            space belongs to one numbered database, and a tree that began at `app:*` would leave the
            reader to guess which one they were looking at.

            It carries the SERVER'S OWN count (`DBSIZE`, which travels with every page) rather than the
            sample's, and it stands down to nothing until a page has answered — the one slot both kinds
            of row use, so one edge answers "how much is in this row" throughout.
          */}
          {databaseRow !== null && (
            <div
              role="treeitem"
              aria-expanded={databaseOpen}
              tabIndex={0}
              data-testid="key-browser-database"
              title={`${databaseRow.label} ${databaseRow.name}`}
              onClick={() => setDatabaseOpen((wasOpen) => !wasOpen)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                setDatabaseOpen((wasOpen) => !wasOpen);
              }}
              style={{ paddingLeft: 8 }}
              className="flex h-6 cursor-pointer select-none items-center gap-1 rounded pr-7 outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-brand"
            >
              <ChevronRight
                strokeWidth={1.5}
                className={cn(
                  "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
                  databaseOpen && "rotate-90",
                )}
              />
              <Database strokeWidth={1.5} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">{databaseRow.name}</span>
              <span
                data-testid="key-browser-database-total"
                title="Keys in this database, as the server counts them"
                className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground"
              >
                {total === null ? "" : total.toLocaleString("en-US")}
              </span>
            </div>
          )}

          {(databaseRow === null || databaseOpen) &&
            rows.map((row) => {
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
                    /*
                     * THE ROW SAYS WHAT A PRESS IS WORTH BEFORE IT IS PRESSED. `MATCH` is applied per
                     * batch and is not indexed, and the keys that come back are then deduplicated, so
                     * one press can legitimately add nothing at all — a fact that has to be on the row
                     * rather than discovered by pressing it repeatedly.
                     */
                    title={`Ask the server for one more page under this prefix. It answers a batch of buckets rather than a listing, so a page can hold only keys already loaded.`}
                    // One level deeper than the folder it belongs to, so it reads as following the
                    // children above it rather than as one of them.
                    style={{ paddingLeft: indent(row.depth) }}
                    // `pr-7` and not a token gutter: the object tree reserves the same 28px on every
                    // row so that a right-hand number is never under the scrollbar, which is a
                    // measured defect this project has already fixed once (`TreeRow`).
                    className="flex h-6 w-full items-center gap-1 rounded pr-7 text-left outline-none hover:bg-accent focus-visible:ring-1 focus-visible:ring-brand disabled:pointer-events-none disabled:opacity-50"
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
                      {loading ? "Asking for one more page..." : `Click to load more${outcomeOf(nodeAdded.get(key))}`}
                    </span>
                    {/*
                      THE COUNT THIS PRESS IS MEASURED AGAINST, in the same right-hand column every
                      other row keeps its number in. Without it a page of duplicates looks like a dead
                      button; with it the reader can see the number the press is trying to move.
                    */}
                    <span
                      data-testid="key-browser-load-more-count"
                      className="ml-auto shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground"
                    >
                      {`${row.count.toLocaleString("en-US")} key${row.count === 1 ? "" : "s"}`}
                    </span>
                  </button>
                );
              }

              const { node, depth, folder } = row;
              const key = pathKey(node.path);
              const isOpen = filtering || open.has(key);
              const name = node.path.join(KEY_SEPARATOR);
              /*
               * A NODE CAN BE TWO THINGS AT ONCE, and this is the row where that shows: `user:42` is
               * a key AND a prefix of `user:42:profile`, so it has a value to read and children to
               * open. The row is the KEY and the twisty is the FOLDER, which is the split the object
               * tree already makes between activating a table and expanding its columns - and it is
               * what makes a row that was drawn only as a folder reachable as a key.
               *
               * A node that is only a folder keeps the whole row as its toggle, because there is
               * nothing else for a click to mean there.
               */
              const readable = node.isKey && onOpenKey !== undefined;
              const activate = (): void => {
                if (readable) openKey(node);
                else if (folder) openPath(node.path);
              };
              return (
                <div
                  key={key}
                  role="treeitem"
                  aria-expanded={folder ? isOpen : undefined}
                  tabIndex={0}
                  // The FULL name, which is what a key is identified by, and the `:*` form beside it
                  // when the row is a prefix too - because a reader needs to know both, and the label
                  // can only say one.
                  title={
                    folder && node.isKey
                      ? `${name} is a key of this database and a prefix: ${name}:*`
                      : folder
                        ? `${name}:*`
                        : name
                  }
                  onClick={activate}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    activate();
                  }}
                  // The project's own row recipe, plus the database row above this one, so a key two
                  // levels down lines up with a table two levels down in the object tree.
                  style={{ paddingLeft: indent(depth) }}
                  className={cn(
                    "flex h-6 cursor-default select-none items-center gap-1 rounded pr-7 outline-none hover:bg-accent",
                    "focus-visible:ring-1 focus-visible:ring-brand",
                    // A leaf is actionable only when somebody will act on it, so the pointer follows the
                    // wiring rather than the row's kind.
                    (readable || folder) && "cursor-pointer",
                  )}
                >
                  {folder ? (
                    /*
                     * THE TWISTY IS ITS OWN CONTROL, and it has to be now that a row can be a key as
                     * well as a folder: one press cannot mean both "read this value" and "open these
                     * children". `stopPropagation` keeps the press off the row, and `tabIndex={-1}` is
                     * the object tree's own choice - arrow keys are what a tree gives a keyboard for
                     * this, so a second tab stop per row would be noise rather than access.
                     *
                     * `-m-1.5 p-1.5` grows the target to 26 by 26 around the 14px glyph without moving
                     * anything, which is the measurement `TreeRow` records for its own twisty.
                     */
                    <button
                      type="button"
                      data-testid="key-browser-twisty"
                      aria-label={`${isOpen ? "Collapse" : "Expand"} ${name}`}
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        openPath(node.path);
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                      className="-m-1.5 flex h-3.5 w-3.5 box-content shrink-0 items-center justify-center rounded-sm p-1.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-brand"
                    >
                      <ChevronRight
                        strokeWidth={1.5}
                        className={cn("h-3.5 w-3.5 transition-transform", isOpen && "rotate-90")}
                      />
                    </button>
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
                  {/* A row that is a key says the KEY's name, because that is what activating it
                      addresses; a row that is only a prefix says the prefix it stands for. */}
                  <span className="truncate font-mono text-xs">
                    {folder && !node.isKey ? `${node.segment}:*` : name}
                  </span>
                  {/*
                    A FOLDER COUNTS THE KEYS THE WALK HOLDS UNDER IT, and a leaf carries no number.

                    THE BADGE IS THE NUMBER THAT MOVES. A prefix's contents grow as pages arrive — the
                    global walk's, and one press of this prefix's own Load more — and the reader's
                    question in front of a folder is "how much is in here". The number of ROWS it opens
                    to is the other half of the same fact, and it is on the tooltip: it is smaller, it
                    is what the child count used to show, and reading it as the amount of data under a
                    prefix is how a folder of 670 keys came to wear a `2`. The `+` in the count's
                    tooltip is the sample's own admission: keys a page has not reached are not counted,
                    and a count that pretended otherwise would be a total nobody read.
                  */}
                  {/*
                    A ROW THAT IS BOTH carries BOTH numbers, which is the whole reason this column is
                    two cells rather than one: the type says what the row itself is worth reading as,
                    and the count says how much sits under it. A row that is only one of the two shows
                    only its own, and the type leads so that the count keeps the outer edge every
                    folder's number has.
                  */}
                  {folder && node.isKey && (
                    <span
                      data-testid="key-browser-type"
                      className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-muted-foreground"
                    >
                      {types.get(name) ?? ""}
                    </span>
                  )}
                  {folder ? (
                    <span
                      data-testid="key-browser-folder-count"
                      className={cn(
                        "shrink-0 pl-2 text-[10px] tabular-nums text-muted-foreground",
                        !node.isKey && "ml-auto",
                      )}
                      title={`${node.count.toLocaleString("en-US")} key${node.count === 1 ? "" : "s"} loaded under this prefix so far, in ${node.children.length} row${node.children.length === 1 ? "" : "s"}`}
                    >
                      {node.count.toLocaleString("en-US")}
                    </span>
                  ) : (
                    /*
                    A LEAF'S TYPE, in the same right-hand column the folders use for their count, so
                    one edge carries "what this row is" for every row.
                    
                    NOTHING IS DRAWN WHEN THE SERVER HAS NOT SAID. The type travels with the page the
                    key arrived in, so this is empty only where a page could not describe its keys —
                    and an empty cell is the honest drawing, since a guess here would be a claim about
                    the value that nobody made.
                  */
                    <span
                      data-testid="key-browser-type"
                      className="ml-auto shrink-0 pl-2 font-mono text-[10px] text-muted-foreground"
                    >
                      {types.get(name) ?? ""}
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
