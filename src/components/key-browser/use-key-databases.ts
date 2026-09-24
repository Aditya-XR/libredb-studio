"use client";

/**
 * The containers a walk can be pointed at, read so a reader can choose one.
 *
 * A WALK NAMES ONE DATABASE AND NOT THE ENGINE'S WHOLE KEY SPACE. Redis holds a fixed number of
 * NUMBERED databases, `SELECT` decides which one a connection talks to, and the walk takes the
 * number as an argument — so a panel that never read the list could only ever walk whichever
 * database the session happened to be in, and a reader would have no way to reach the other fifteen.
 *
 * THE COUNT IS READ AND NEVER ASSUMED. `CONFIG GET databases` answers 16 on a stock server and 1 on
 * the same image started in cluster mode (measured 2026-09-11, see `docs/providers/redis.md`), and
 * an engine is not obliged to number its containers at all. So this reads the engine's own container
 * list — the same `POST /api/db/objects/containers` the object tree's top level comes from, because
 * a database on this engine IS that tree's container level — rather than inventing a range.
 *
 * IT IS NOT A FAILURE THAT COSTS THE PANEL. The list is a convenience: the walk works without it,
 * because an absent database means the session's own. A refused read is kept as a sentence and shown
 * beside a panel that still walks, rather than blanking the one thing the reader asked for.
 */
import { useEffect, useMemo, useState } from "react";
import type { ContainerLevelSpec } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { buildConnectionPayload } from "@/hooks/use-connection-payload";
import { appFetch } from "@/lib/config/base-path";

export interface KeyDatabaseList {
  /** The containers the engine listed, in its own order. Empty until the read answers. */
  readonly names: readonly string[];
  /**
   * Whether the read has answered at all.
   *
   * NOT THE SAME QUESTION AS "ARE THERE ANY", and the caller that needs the difference is the one
   * holding a database somebody asked for: until this is true, a walk cannot be pointed at it, and
   * starting one anyway would take a page of the session's database and throw it away.
   */
  readonly answered: boolean;
  /** The container the session is already in, when the engine publishes that. */
  readonly sessionDefault: string | null;
  /** Why the read failed, in the route's own words where it gave one, or null. */
  readonly error: string | null;
}

interface DatabasesRead {
  readonly connectionId: string;
  readonly names: readonly string[];
  readonly sessionDefault: string | null;
  readonly error: string | null;
  readonly answered: boolean;
}

/** Nothing read yet for this connection: not an answer, and drawn as one. */
function unread(connectionId: string): DatabasesRead {
  return { connectionId, names: [], sessionDefault: null, error: null, answered: false };
}

/** One entry of the container list, as far as this panel is about to dereference it. */
interface ListedContainer {
  readonly name: string;
  readonly isSessionDefault?: boolean;
}

function isListedContainer(value: unknown): value is ListedContainer {
  return typeof value === "object" && value !== null && typeof (value as { name?: unknown }).name === "string";
}

/**
 * The sentence a refusal carries, which is the route's own where it wrote one.
 *
 * The body is `unknown` on purpose: it arrives over the wire, and a response is not a type
 * guarantee — so the shape is checked rather than asserted into the render (the same rule
 * `useTreeNodes` applies to every answer it accepts).
 */
function sentenceOf(body: unknown, status: number): string {
  if (typeof body === "object" && body !== null) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
  }
  return `The database list failed with HTTP ${status}`;
}

export function useKeyDatabases(
  connection: DatabaseConnection,
  level: ContainerLevelSpec | undefined,
): KeyDatabaseList {
  const [stored, setStored] = useState<DatabasesRead>(() => unread(connection.id));

  // An answer about another connection is not an answer about this one, so it is not shown while this
  // connection's read is in flight — the derivation `useTreeNodes` uses, for the same reason.
  const fresh = useMemo(() => unread(connection.id), [connection.id]);
  const read = stored.connectionId === connection.id ? stored : fresh;

  useEffect(() => {
    // No level to choose from means no question to ask: an engine with no container level is walked
    // as a whole, and its own answer for "which database" is the only one there is.
    if (level === undefined) return;

    let live = true;
    void (async () => {
      try {
        const payload = buildConnectionPayload(connection);
        const response = await appFetch("/api/db/objects/containers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const body: unknown = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(sentenceOf(body, response.status));
        if (!Array.isArray(body) || !body.every(isListedContainer)) {
          throw new Error("The database list answered with a body this panel cannot render");
        }

        if (!live) return;
        const session = body.find((entry) => entry.isSessionDefault === true);
        setStored({
          connectionId: connection.id,
          names: body.map((entry) => entry.name),
          sessionDefault: session?.name ?? null,
          error: null,
          answered: true,
        });
      } catch (thrown) {
        if (!live) return;
        setStored({
          connectionId: connection.id,
          names: [],
          sessionDefault: null,
          error: thrown instanceof Error ? thrown.message : String(thrown),
          // A refusal IS an answer about the list, and the caller waiting for one must stop waiting:
          // the walk then goes to the session's database, which is what the panel says it is doing.
          answered: true,
        });
      }
    })();

    // A read that settles after the panel has moved on must not land on the connection that replaced
    // it, and must not write to an unmounted panel.
    return () => {
      live = false;
    };
  }, [connection, level]);

  return { names: read.names, answered: read.answered, sessionDefault: read.sessionDefault, error: read.error };
}
