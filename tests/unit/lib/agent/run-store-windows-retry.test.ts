import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore, AgentRunStoreError, ledgerStreamName, type AgentLedgerWorld } from "@/lib/agent/run-store";
import { historyStreamName } from "@/lib/agent/history";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { logger } from "@/lib/logger";

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
const runId = "arun_windows_retry";
const streamName = ledgerStreamName(runId);
const chunkPath = `C:\\ledger\\streams\\chunks\\${streamName}-chnk_01ABC.bin`;
const event = { kind: "run-started", atMs: 1, mode: "agent" } as const;
const finish = {
  runId,
  sessionId: "ada",
  threadId: runId,
  objective: "Inspect one table",
  workflowType: "investigation",
  mode: "agent",
  connectionId: "seed:sqlite-sample",
  createdAtMs: 1,
  atMs: 2,
  status: "succeeded",
  answered: true,
} as const;
const dirs: string[] = [];

function probeError(overrides: Partial<NodeJS.ErrnoException> = {}): NodeJS.ErrnoException {
  return Object.assign(new Error("temporary filesystem lock"), {
    code: "EPERM",
    syscall: "access",
    path: chunkPath,
    ...overrides,
  });
}

function worldWithFault(error: unknown, failures = 1) {
  let calls = 0;
  const write = mock(async () => {
    if (calls++ < failures) throw error;
  });
  const world: AgentLedgerWorld = {
    writeToStream: write,
    closeStream: write,
    getStreamChunks: async () => ({ data: [], cursor: null, hasMore: false }),
    readFromStream: async () => new ReadableStream(),
  };
  return { store: new AgentRunStore({ world }), write };
}

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  spyOn(logger, "warn").mockImplementation(() => {});
  spyOn(logger, "info").mockImplementation(() => {});
});

afterEach(() => {
  mock.restore();
  Object.defineProperty(process, "platform", platformDescriptor);
  for (const dir of dirs.splice(0)) {
    if (
      path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) ||
      !path.basename(dir).startsWith("agent-run-retry-")
    ) {
      throw new Error("Refusing to remove a directory outside this test's fixtures");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("AgentRunStore — transient Windows existence probes (#900)", () => {
  test.each(["EPERM", "EBUSY", "EACCES"])(
    "retries %s before appending, preserving the serialized entry",
    async (code) => {
      const { store, write } = worldWithFault(probeError({ code }));

      await store.appendEvent(runId, event);

      expect(write).toHaveBeenCalledTimes(2);
      expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
      expect(logger.warn).toHaveBeenCalledTimes(1);
    },
  );

  test("retries the history index's existence probe", async () => {
    const name = historyStreamName(finish.sessionId);
    const { store, write } = worldWithFault(
      probeError({ path: `C:\\ledger\\streams\\chunks\\${name}-chnk_01ABC.bin` }),
    );

    await store.recordHistoryFinish(finish);

    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[0]).toEqual(write.mock.calls[1]);
  });

  test("does not retry a fault for a different stream during close", async () => {
    const fault = probeError();
    const { store, write } = worldWithFault(fault);
    await expect(store.close("arun_retry_close")).rejects.toBe(fault);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test("retries a matching stream's EOF existence probe", async () => {
    const closingId = "arun_retry_eof";
    const { store, write } = worldWithFault(
      probeError({ path: `C:\\ledger\\streams\\chunks\\${ledgerStreamName(closingId)}-chnk_01ABC.bin` }),
    );
    await store.close(closingId);
    expect(write).toHaveBeenCalledTimes(2);
  });

  test("gives up after five retries with the file, cause and attempt count", async () => {
    const fault = probeError();
    const { store, write } = worldWithFault(fault, 100);
    const caught = await store.appendEvent(runId, event).catch((error: unknown) => error);

    expect(write).toHaveBeenCalledTimes(6);
    expect(caught).toBeInstanceOf(AgentRunStoreError);
    const error = caught as AgentRunStoreError;
    expect(error.reasonCode).toBe("LEDGER_WRITE_FAILED");
    expect(error.message).toContain(chunkPath);
    expect(error.message).toContain("EPERM");
    expect(error.message).toContain("6 attempts");
    expect(error.cause).toBe(fault);
    expect(logger.warn).toHaveBeenCalledTimes(5);
  });

  test("does not retry on non-Windows platforms", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const fault = probeError();
    const { store, write } = worldWithFault(fault);
    await expect(store.appendEvent(runId, event)).rejects.toBe(fault);
    expect(write).toHaveBeenCalledTimes(1);
  });

  test.each(["rename", "write", "open"])(
    "does not replay a failed %s, whose commit status is uncertain",
    async (syscall) => {
      const fault = probeError({ syscall });
      const { store, write } = worldWithFault(fault);
      await expect(store.appendEvent(runId, event)).rejects.toBe(fault);
      expect(write).toHaveBeenCalledTimes(1);
    },
  );

  test.each([
    null,
    "EPERM",
    new Error("backend failure"),
    probeError({ code: "ENOSPC" }),
    probeError({ path: undefined }),
    probeError({ path: `C:\\ledger\\streams\\runs\\${runId}.json` }),
    probeError({ path: `C:\\ledger\\other\\chunks\\${streamName}-chnk_01ABC.bin` }),
    probeError({ path: `C:\\ledger\\streams\\chunks\\other-chnk_01ABC.bin` }),
    probeError({ path: `C:\\ledger\\streams\\chunks\\${streamName}-chnk_01ABC.bin.tmp` }),
  ])("preserves unrelated failures without retrying (%#)", async (fault) => {
    const { store, write } = worldWithFault(fault);
    await expect(store.appendEvent(runId, event)).rejects.toBe(fault);
    expect(write).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test("a real sequential run recovers without duplicate tool effects or ledger entries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-retry-"));
    dirs.push(dir);
    const world = createLocalWorld({ dataDir: dir, recoverActiveRuns: false });
    const store = new AgentRunStore({ world });
    const service = new AgentRunService({
      store,
      resources: {
        tracker: new ExecutionBudgetTracker(),
        artifacts: new ExecutionArtifactStore({ ttlMs: 60_000, maxArtifacts: 20 }),
      },
    });
    const actualAccess = fs.promises.access;
    let faults = 0;
    spyOn(fs.promises, "access").mockImplementation(async (file, ...args) => {
      if (
        typeof file === "string" &&
        path.dirname(file) === path.join(dir, "streams", "chunks") &&
        faults++ % 2 === 0
      ) {
        throw probeError({ path: file });
      }
      return actualAccess(file, ...args);
    });

    const run = await service.start({
      mode: "agent",
      actor: { sessionId: "ada", role: "admin" },
      connectionId: "seed:sqlite-sample",
      objective: "Inspect one table",
    });
    await service.markRunning(run.runId);
    const execute = mock(async () => ({ kind: "not-attempted" }) as const);
    await service.runStep(run.runId, { stepId: "step_1", tool: "inspect_schema" }, execute);
    await service.finish(run.runId, "succeeded");

    expect(logger.warn).toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
    const restarted = new AgentRunStore({ world: createLocalWorld({ dataDir: dir, recoverActiveRuns: false }) });
    const view = await restarted.read(run.runId);
    expect(view?.record.status).toBe("succeeded");
    expect(view?.record.events.map((entry) => entry.kind)).toEqual(["run-started", "tool-invoked", "run-finished"]);
    expect((await restarted.listConversations("ada")).conversations).toHaveLength(1);
    const chunks = await fs.promises.readdir(path.join(dir, "streams", "chunks"));
    expect(chunks.filter((file) => file.endsWith(".bin"))).toHaveLength(6);
    expect(chunks.some((file) => file.includes(".tmp."))).toBe(false);
  });

  test("a retry does not let a later append overtake the first entry", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-retry-"));
    dirs.push(dir);
    const world = createLocalWorld({ dataDir: dir, recoverActiveRuns: false });
    const store = new AgentRunStore({ world });
    const run = await store.openRun({
      mode: "agent",
      actor: { sessionId: "ada", role: "admin" },
      connectionId: "seed:sqlite-sample",
      objective: "Inspect one table",
    });
    const actualAccess = fs.promises.access;
    let failed = false;
    spyOn(fs.promises, "access").mockImplementation(async (file, ...args) => {
      if (!failed && typeof file === "string" && path.dirname(file) === path.join(dir, "streams", "chunks")) {
        failed = true;
        throw probeError({ path: file });
      }
      return actualAccess(file, ...args);
    });

    await Promise.all([
      store.appendEvent(run.runId, { kind: "tool-invoked", stepId: "first", tool: "inspect_schema", atMs: 2 }),
      store.appendEvent(run.runId, { kind: "tool-invoked", stepId: "second", tool: "inspect_schema", atMs: 3 }),
    ]);
    expect(logger.warn).toHaveBeenCalled();
    expect((await store.read(run.runId))?.unsettledStepIds).toEqual(["first", "second"]);
  });

  test("a failed append reports to its caller without poisoning a queued append", async () => {
    const fault = probeError({ syscall: "rename" });
    const { store, write } = worldWithFault(fault);

    const results = await Promise.allSettled([store.appendEvent(runId, event), store.appendEvent(runId, event)]);

    expect(results[0]).toEqual({ status: "rejected", reason: fault });
    expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(write).toHaveBeenCalledTimes(2);
  });

  test("closing waits for a retried append before publishing EOF", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-run-retry-"));
    dirs.push(dir);
    const world = createLocalWorld({ dataDir: dir, recoverActiveRuns: false });
    const store = new AgentRunStore({ world });
    const run = await store.openRun({
      mode: "agent",
      actor: { sessionId: "ada", role: "admin" },
      connectionId: "seed:sqlite-sample",
      objective: "Inspect one table",
    });
    const actualAccess = fs.promises.access;
    let failed = false;
    spyOn(fs.promises, "access").mockImplementation(async (file, ...args) => {
      if (!failed && typeof file === "string" && path.dirname(file) === path.join(dir, "streams", "chunks")) {
        failed = true;
        throw probeError({ path: file });
      }
      return actualAccess(file, ...args);
    });

    await Promise.all([store.appendEvent(run.runId, event), store.close(run.runId)]);

    expect(logger.warn).toHaveBeenCalled();
    expect((await store.read(run.runId))?.record.events).toEqual([event]);
  });
});
