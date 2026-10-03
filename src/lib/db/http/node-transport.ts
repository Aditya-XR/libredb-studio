/**
 * The shared REST transport for driver-free providers (vector-family design 3.7; docs/BACKLOG.md D37)
 *
 * A provider hands it a validated origin, the TLS material of its SSL / TLS panel, its in-flight bound and the headers
 * its connection sends, and gets back `request` and `close`. Nothing here knows about an engine, and no provider is
 * imported. Server-only: it imports Node built-ins, so nothing browser-side may import it.
 *
 * - One `node:http` or `node:https` Agent per connection, `keepAlive: true`, at most `maxSockets` sockets, destroyed by
 *   close(). Never the global agent, which routes through a proxy variable (HTTP_PROXY under NODE_USE_ENV_PROXY=1 on
 *   Node, and under Bun), and never `globalThis.fetch`, so no proxy variable can carry a request or its credential.
 * - With DB_HTTP_BLOCK_PRIVATE_HOSTS on, the guard's literal check runs when the transport is built, before any socket,
 *   because an IP literal never reaches a lookup, and the guard's lookup goes on this connection's own Agent in place of
 *   the `agent: false` of guardedNodeOptions. The Agent never carries an unguarded request, so every socket it pools was
 *   opened through the guarded lookup, and a pooled socket costs one lookup rather than one per request.
 * - No redirect is followed: every 3xx goes to the shared rejectRedirect, and its body is released unread.
 * - Every request asks for `accept-encoding: identity`, and nothing is decompressed: an answer with any other
 *   content-encoding is refused before its body is read, so the byte cap always counts the bytes that are parsed.
 * - The body is counted as it streams, and the socket is destroyed the moment it passes `maxResponseBytes`.
 * - A deadline or a cancel destroys the socket; the signal's reason tells the two apart.
 * - Nothing is retried: an answer that never arrived is reported as lost, and the request is never sent again.
 * - No message carries a header, the key, a URL query string or a body: a failure names its kind, a runtime code, an
 *   origin or a number.
 *
 * `nodeTlsMaterial` is the TLS mapping D37 counts, shared here so that a new REST provider takes it instead of
 * writing another copy.
 *
 * A measured limit, not worked around: the first request on a new keep-alive TLS socket costs about 40 ms more than on
 * a socket that is closed after one request, with no cause found.
 */
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import type { SSLConfig, SSLMode } from "@/lib/types";

/** The SSL / TLS panel as node:https takes it. */
export interface NodeTlsMaterial {
  readonly rejectUnauthorized: boolean;
  readonly ca?: Buffer;
  readonly cert?: Buffer;
  readonly key?: Buffer;
  /** The connection's host, or TUNNEL_FAR_END's host through an SSH tunnel; an IPv6 literal without its brackets. */
  readonly identity: string;
}

/** A request that did not complete. Its message never carries a header, the key, a URL query string or a body. */
export class TransportError extends ConnectionError {
  constructor(
    readonly kind: "timeout" | "aborted" | "too-large" | "redirect" | "encoding" | "tls" | "network",
    message: string,
  ) {
    super(message);
    this.name = "TransportError";
    Object.setPrototypeOf(this, TransportError.prototype);
  }
}

/**
 * The default `rejectUnauthorized` of each SSL mode, null for plaintext: the repository's one rule,
 * rejectUnauthorized = ssl.rejectUnauthorized ?? ssl.mode !== "require". `require` encrypts without checking, because a
 * self-hosted server ordinarily presents a self-signed certificate; `verify-ca` and `verify-full` come out the same,
 * because Node checks the identity whenever it verifies (SSLMode in src/lib/types.ts says the same).
 */
const VERIFY_BY_MODE: Readonly<Record<SSLMode, boolean | null>> = Object.freeze({
  disable: null,
  require: false,
  "verify-system": true,
  "verify-ca": true,
  "verify-full": true,
});

const INVALID_SSL_MODE = "Invalid ssl.mode: expected disable, require, verify-system, verify-ca or verify-full";
const INVALID_REJECT_UNAUTHORIZED = "Invalid ssl.rejectUnauthorized: expected true or false";
const CLIENT_PAIR = "Invalid ssl.clientCert and ssl.clientKey: give both or neither";

/** A PEM field as bytes; an empty or absent field is left out, because a cleared form field is not a certificate. */
function pem(value: unknown, field: string): Buffer | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new DatabaseConfigError(`Invalid ${field}: expected PEM text`);
  return Buffer.from(value, "utf8");
}

/** A host without the brackets an IPv6 literal is written in; any other host unchanged. */
function unbracketed(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * The connection's SSL / TLS panel as node:https takes it, or null for plaintext: an absent or null panel, or the mode
 * `disable`. A panel with no mode verifies, as every provider with this rule reads it, since a seed file's panel may
 * omit the mode (src/lib/seed/types.ts). The panel arrives as the caller wrote it, so a field of the wrong kind is
 * refused by name, never read as plaintext or as "do not verify", and never repeated.
 *
 * `identity` is the connection's host, or the tunnel's far end when an SSH tunnel carries the connection, so the
 * certificate is checked against the server Studio means and never against the local forward.
 */
export function nodeTlsMaterial(ssl: SSLConfig | null | undefined, identity: string): NodeTlsMaterial | null {
  if (ssl === null || ssl === undefined) return null;
  const panel = ssl as { readonly [field in keyof SSLConfig]?: unknown };
  const mode = panel.mode ?? "verify-full";
  if (typeof mode !== "string" || !Object.hasOwn(VERIFY_BY_MODE, mode)) throw new DatabaseConfigError(INVALID_SSL_MODE);
  const verify = VERIFY_BY_MODE[mode as SSLMode];
  if (verify === null) return null;
  const rejectUnauthorized = panel.rejectUnauthorized ?? verify;
  if (typeof rejectUnauthorized !== "boolean") throw new DatabaseConfigError(INVALID_REJECT_UNAUTHORIZED);
  const ca = pem(panel.caCert, "ssl.caCert");
  const cert = pem(panel.clientCert, "ssl.clientCert");
  const key = pem(panel.clientKey, "ssl.clientKey");
  if ((cert === undefined) !== (key === undefined)) throw new DatabaseConfigError(CLIENT_PAIR);
  return {
    rejectUnauthorized,
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
    identity: unbracketed(identity),
  };
}
