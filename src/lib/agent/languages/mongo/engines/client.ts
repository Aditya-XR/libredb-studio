/**
 * MongoDB's client overlay (#1821). The mongo family declares no dialect-bound member, so the overlay is empty and the
 * engine's client facet is the family's own.
 */
import type { AgentEngineClientOverlay } from "../../pack";

export const MONGODB_CLIENT_OVERLAY = {} as const satisfies AgentEngineClientOverlay<"mongo">;
