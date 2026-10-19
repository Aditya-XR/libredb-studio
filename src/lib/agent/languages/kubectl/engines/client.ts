/**
 * Kubernetes's client overlay (#1821). The kubectl family declares no dialect-bound member, so the overlay is empty and the
 * engine's client facet is the family's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const KUBERNETES_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"kubectl">;
