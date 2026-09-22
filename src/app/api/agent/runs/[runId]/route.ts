import { NextResponse } from "next/server";
import { accessAgentRun } from "@/lib/api/agent-run-access";
import { createErrorResponse } from "@/lib/api/errors";
import { AgentRunServiceError } from "@/lib/agent/run-service";
import { driveAgentRun } from "@/lib/agent/runtime";
import { logger } from "@/lib/logger";

/**
 * One run: what it is doing, and asking it to stop (#329 T9).
 *
 * Both verbs answer from the durable ledger rather than from anything this process
 * remembers, so a run started by a process that has since died reports the same
 * thing here as it does to the loop that resumes it.
 */

type RunParams = { params: Promise<{ runId: string }> };

export async function GET(req: Request, { params }: RunParams) {
  const { runId } = await params;
  const access = await accessAgentRun({ route: "GET /api/agent/runs/[runId]", request: req, runId });
  if ("response" in access) return access.response;

  return NextResponse.json(access.report);
}

/**
 * Asks the run to stop. What this does NOT do is stop it here: cancellation is
 * enforced by the run's own loop at its next checkpoint, which is the only place a
 * run's budget and artifacts can be released with nothing in flight. A queued run
 * that no loop has picked up ends immediately, because it has no checkpoint to
 * reach.
 */
export async function DELETE(req: Request, { params }: RunParams) {
  const { runId } = await params;
  const access = await accessAgentRun({ route: "DELETE /api/agent/runs/[runId]", request: req, runId });
  if ("response" in access) return access.response;

  try {
    const actor = access.report.record.actor;
    return NextResponse.json(await access.service.cancel(runId, actor));
  } catch (error) {
    return createErrorResponse(error, { route: "api/agent/runs/[runId]" });
  }
}

/**
 * Pauses or resumes the run. Pause lands only on a
 * RUNNING run; resume only on a PAUSED one — the service refuses anything else,
 * so the rail renders whichever control the ledger says the service can honour.
 *
 * Resume also drives the run again in this process: the run is being watched, so
 * continuing it must not wait for the orphan-reaper's staleness window (B9's
 * sweep was built for runs a dead process left, not for a user pressing Resume).
 */
export async function PATCH(req: Request, { params }: RunParams) {
  const { runId } = await params;
  const access = await accessAgentRun({ route: "PATCH /api/agent/runs/[runId]", request: req, runId });
  if ("response" in access) return access.response;

  let action: unknown;
  try {
    action = ((await req.json()) as Record<string, unknown>).action;
  } catch {
    return NextResponse.json({ error: "A JSON body with an action is required" }, { status: 400 });
  }

  try {
    if (action === "pause") return NextResponse.json(await access.service.pause(runId));
    if (action === "resume") {
      const record = await access.service.unpause(runId);
      // Driven in this process, the way the start route drives a fresh run — but only
      // when unpause actually answered `running`. A lost race to the run's end answers
      // a terminal record, and driving an ended run would resolve a connection, build a
      // provider and leave entries in the process's resource maps for a run that is
      // already over: that terminal answer is a normal outcome, not a drive to start.
      // The run's durability does not depend on the drive surviving either: everything
      // it does is written to the ledger first, and a drive that dies leaves a run the
      // sweep can still pick up.
      if (record.status === "running") {
        void driveAgentRun(runId).catch((error: unknown) => {
          logger.error("Agent run unpause drive ended in failure", error, {
            route: "PATCH /api/agent/runs/[runId]",
            runId,
          });
        });
      }
      return NextResponse.json(record);
    }
    return NextResponse.json({ error: `Unknown action: ${String(action)}` }, { status: 400 });
  } catch (error) {
    // A pause/unpause refusal is a 409, never a 500: the ledger moved between the
    // render and the click, or the action cannot be honoured — nothing broke.
    if (error instanceof AgentRunServiceError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return createErrorResponse(error, { route: "api/agent/runs/[runId]" });
  }
}
