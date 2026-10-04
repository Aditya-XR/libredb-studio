/**
 * The TLS material and identity of one gRPC channel: what a provider's SSL / TLS panel mapping hands the channel
 * credentials of credentials.ts and the server-name override of channel.ts. Nothing here knows about an engine, and no
 * provider is imported; server-only.
 */

/** The panel's TLS material, before an identity is chosen. `disable`, an absent and a null panel are no TLS. */
export interface GrpcTlsMaterial {
  readonly mode: "require" | "verify-system" | "verify-ca" | "verify-full";
  /** PEM as configured; absent means the runtime's roots. */
  readonly ca?: string;
  readonly clientCertificate?: { readonly cert: string; readonly key: string };
  /** False only for `require`, or an explicit `rejectUnauthorized: false`. */
  readonly verify: boolean;
}

/** The material with the identity of one dialled host. */
export interface GrpcTlsOptions extends GrpcTlsMaterial {
  /** The TLS identity: the tunnel's far end when one carries the connection, else the host, bare (no IPv6 brackets). */
  readonly identity: string;
  readonly identityIsIp: boolean;
  /** Always set as `grpc.ssl_target_name_override`: the identity, or the caller's IP server name for an IP identity. */
  readonly serverNameOverride: string;
}
