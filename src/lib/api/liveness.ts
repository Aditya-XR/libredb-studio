import { NextResponse } from "next/server";

/**
 * The answer every liveness path gives.
 *
 * Three paths serve it — `/health`, `/api/health` and `GET /api/db/health` — because an
 * operator reaches for whichever one their platform's form defaults to, and until #909 the
 * first two did not exist. That was worse than a 404: an unknown path redirects to the
 * login screen, so a check that follows redirects read 200 from a login page and went green
 * whether or not the app worked. #909 carries the measurement.
 *
 * That `/api/db/health` was the only one is visible in this repository too: every deploy
 * surface that names a health path hard-codes it — `deploy/azure/README.md`,
 * `deploy/azure/src/install.sh` and the chart's probes — which is what a path nobody would
 * guess looks like once it has been written down enough times.
 *
 * It depends on nothing. A liveness check answers "is this process serving", and a check
 * that also touches a database reports a database outage as a dead application — which is
 * how an orchestrator ends up restarting a healthy container. The connection-scoped check
 * is `POST /api/db/health`, and it is a different question.
 */
export function livenessResponse() {
  return NextResponse.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    service: "libredb-studio",
  });
}
