/**
 * Kubernetes's server overlay (#1821). The kubectl family declares no dialect-bound member, so the overlay is empty and the
 * engine's server facet is the family's own.
 */
import type { AgentEngineServerOverlay } from "../../pack";

export const KUBERNETES_SERVER_OVERLAY = {} as const satisfies AgentEngineServerOverlay<"kubectl">;
