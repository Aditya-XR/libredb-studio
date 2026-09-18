import { livenessResponse } from "@/lib/api/liveness";

/**
 * GET /api/health — liveness, no dependencies (#909).
 *
 * The same answer as `GET /api/db/health`, under the path an operator guesses first.
 */
export function GET() {
  return livenessResponse();
}
