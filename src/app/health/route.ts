import { livenessResponse } from "@/lib/api/liveness";

/**
 * GET /health — liveness, no dependencies (#909).
 *
 * The plainest path there is, for the platforms whose health-check field starts out
 * holding `/health`.
 */
export function GET() {
  return livenessResponse();
}
