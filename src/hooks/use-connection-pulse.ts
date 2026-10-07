"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { ProviderMetadata } from "./use-provider-metadata";
import { buildConnectionPayload, connectionResolutionKey } from "./use-connection-payload";

/**
 * What the header says about the active connection. `not-checked` is the answer for a connection
 * whose provider declares `resumesBilledCompute`: Studio sends it no background health check,
 * because each one would wake billed compute, so there is nothing to report but that.
 */
export type ConnectionPulse = "healthy" | "degraded" | "error" | "not-checked";

/**
 * The pulse indicator's tooltip, the same on the desktop and mobile headers. Not checked is the one
 * state whose reason is not obvious from its name, so it says why nothing was asked.
 */
export function connectionPulseTitle(pulse: ConnectionPulse): string {
  return pulse === "not-checked"
    ? "Connection: Not checked. Studio sends this connection no background health checks."
    : `Connection: ${pulse}`;
}

/** The target an answer belongs to: the connection and every field that decides where it resolves. */
function answerKey(connection: DatabaseConnection): string {
  return `${connection.id}:${connectionResolutionKey(connection)}`;
}

/** How often the pulse asks `POST /api/db/health` about the active connection. */
export const CONNECTION_PULSE_INTERVAL_MS = 60_000;

/**
 * The connection pulse: one health check when a connection becomes active, then one every
 * {@link CONNECTION_PULSE_INTERVAL_MS}.
 *
 * It waits for the provider's declaration, because the declaration decides whether a check may be
 * sent at all: before `metadata` answers it sends nothing and starts no timer, and with
 * `resumesBilledCompute` it never does, answering `not-checked` instead. That keeps a suspended
 * warehouse suspended and keeps `skipObjectScan`'s promise of zero reads on connect.
 *
 * Null with no active connection, before the declaration, and before the first answer for this
 * connection: an answer is kept with the id and resolution key it was for, so neither the previous
 * connection's status nor the previous target of an edited one is shown under the current target.
 */
export function useConnectionPulse(
  connection: DatabaseConnection | null,
  metadata: ProviderMetadata | null,
): ConnectionPulse | null {
  const [answer, setAnswer] = useState<{ key: string; pulse: ConnectionPulse } | null>(null);
  const ready = metadata !== null;
  const silent = metadata?.capabilities.resumesBilledCompute === true;

  useEffect(() => {
    if (connection === null || !ready || silent) return;
    let current = true;
    const key = answerKey(connection);
    const checkHealth = async () => {
      try {
        const res = await appFetch("/api/db/health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildConnectionPayload(connection)),
        });
        if (current) setAnswer({ key, pulse: res.ok ? "healthy" : "degraded" });
      } catch {
        if (current) setAnswer({ key, pulse: "error" });
      }
    };
    void checkHealth();
    const interval = setInterval(checkHealth, CONNECTION_PULSE_INTERVAL_MS);
    return () => {
      current = false;
      clearInterval(interval);
    };
  }, [connection, ready, silent]);

  if (connection === null || !ready) return null;
  if (silent) return "not-checked";
  return answer?.key === answerKey(connection) ? answer.pulse : null;
}
