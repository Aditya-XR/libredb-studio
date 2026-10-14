import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { DuplicateRunError, LimiterFullError } from "@/lib/db/utils/bounded-limiter";
import { SNOWFLAKE_ERROR_SENTENCES, SnowflakeError } from "@/lib/db/providers/sql/snowflake/errors";
import { SNOWFLAKE_QUERY_TAGS, type SnowflakeResult } from "@/lib/db/providers/sql/snowflake/statements";
import { logger } from "@/lib/logger";
import { failureAnswer, handleAnswer, TEST_HANDLE } from "../../../helpers/snowflake-answers";
import { deferredAnswer, type ScriptedAnswer } from "../../../helpers/snowflake-node-transport";
import {
  CANCEL,
  type Harness,
  caught,
  cancels,
  closeOpened,
  one,
  STATUS,
  SUBMIT,
  setup,
  submits,
  tick,
} from "../../../helpers/snowflake-statements";

let warn: ReturnType<typeof spyOn>;
beforeAll(() => {
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterAll(() => warn.mockRestore());
afterEach(async () => {
  await closeOpened();
  warn.mockClear();
});

const HANG: ScriptedAnswer = { hang: true };
const CONFIRMED: ScriptedAnswer = { status: 200, json: { code: "000604", message: "SQL execution canceled" } };
/** Snowflake's 408 body on the trial, a statement ended at the warehouse's 600 s under a 700 s timeout. */
const TIMEOUT_MESSAGE = "Statement reached its statement or warehouse timeout of 600 second(s) and was canceled.";
const SURFACE = SNOWFLAKE_QUERY_TAGS.tree;

let handles = 0;
/** A handle of its own for each run, as Snowflake gives one per statement. */
const nextHandle = (): string => `019c06a4-0000-df4f-0000-${String((handles += 1)).padStart(12, "0")}`;

/** Runs whose submit answers a handle of their own and whose poll hangs until its signal fires. */
function hanging(harness: Harness, count = 1): void {
  harness.transports.answer(SUBMIT, ...Array.from({ length: count }, () => handleAnswer(nextHandle())));
  harness.transports.answer(STATUS, ...Array.from({ length: count }, () => HANG));
}

/**
 * Starts a run and waits until `requests` requests were sent; its outcome (the result or the error) is wrapped, since
 * an async function would otherwise wait for the run itself.
 */
async function started(
  harness: Harness,
  run: Promise<SnowflakeResult>,
  requests: number,
): Promise<{ readonly outcome: Promise<unknown> }> {
  const outcome = run.then(
    (value) => value,
    (error: unknown) => error,
  );
  await harness.transports.received(requests);
  await tick();
  return { outcome };
}

const userRun = (harness: Harness, queryId: string | undefined) => harness.statements.runUser("SHOW TABLES", queryId);
const surfaceRun = (harness: Harness) => harness.statements.runSurface("SHOW TABLES", SURFACE);

/** The first run's own deadline: its permit wait's bound is requested first, the statement's once it is sent. */
const STATEMENT_DEADLINE = 1;

const isCancelled = (error: unknown): boolean => error instanceof SnowflakeError && error.category === "cancelled";

describe("runs in flight drop to 0 on every exit", () => {
  for (const withId of [true, false]) {
    const label = withId ? "with a queryId" : "without one";
    const start = (harness: Harness) => (withId ? userRun(harness, "q-1") : surfaceRun(harness));

    test(`success, ${label}`, async () => {
      const harness = setup();
      const status = deferredAnswer();
      harness.transports.answer(SUBMIT, handleAnswer());
      harness.transports.answer(STATUS, status.answer);
      const { outcome } = await started(harness, start(harness), 2);
      expect(harness.statements.runsInFlight()).toBe(1);
      status.resolve(one());
      expect(await outcome).toMatchObject({ rows: [{ N: 1 }] });
      expect(harness.statements.runsInFlight()).toBe(0);
    });

    test(`a failed statement, ${label}`, async () => {
      const harness = setup();
      const status = deferredAnswer();
      harness.transports.answer(SUBMIT, handleAnswer());
      harness.transports.answer(STATUS, status.answer);
      const { outcome } = await started(harness, start(harness), 2);
      expect(harness.statements.runsInFlight()).toBe(1);
      status.resolve(failureAnswer(422, "000904", "invalid identifier"));
      expect(await outcome).toBeInstanceOf(SnowflakeError);
      expect(harness.statements.runsInFlight()).toBe(0);
    });

    test(`the deadline, ${label}`, async () => {
      const harness = setup();
      hanging(harness);
      harness.transports.answer(CANCEL, CONFIRMED);
      const { outcome } = await started(harness, start(harness), 2);
      expect(harness.statements.runsInFlight()).toBe(1);
      harness.deps.deadlines.fire(STATEMENT_DEADLINE);
      const error = await outcome;
      expect((error as SnowflakeError).category).toBe("query");
      expect((error as SnowflakeError).message).toBe(
        withId ? SNOWFLAKE_ERROR_SENTENCES.deadline(60) : SNOWFLAKE_ERROR_SENTENCES.surfaceDeadline(30),
      );
      expect(cancels(harness)).toHaveLength(1);
      expect(harness.statements.runsInFlight()).toBe(0);
    });

    test(`close() during the poll, ${label}`, async () => {
      const harness = setup();
      hanging(harness);
      harness.transports.answer(CANCEL, CONFIRMED);
      const { outcome } = await started(harness, start(harness), 2);
      expect(harness.statements.runsInFlight()).toBe(1);
      await harness.statements.close();
      expect(isCancelled(await outcome)).toBe(true);
      expect(cancels(harness)).toHaveLength(1);
      expect(harness.statements.runsInFlight()).toBe(0);
    });
  }

  test("a user cancel", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    expect(harness.statements.runsInFlight()).toBe(1);
    expect(await harness.statements.cancel("q-1")).toBe(true);
    expect(isCancelled(await outcome)).toBe(true);
    expect(harness.statements.runsInFlight()).toBe(0);
  });

  test("an abort during the submit, with a queryId: the cancel follows the submit's answer", async () => {
    const harness = setup();
    const submit = deferredAnswer();
    harness.transports.answer(SUBMIT, submit.answer);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 1);
    const cancelling = harness.statements.cancel("q-1");
    await tick();
    expect(harness.statements.runsInFlight()).toBe(1);
    expect(cancels(harness)).toHaveLength(0);
    submit.resolve(handleAnswer());
    expect(await cancelling).toBe(true);
    expect(isCancelled(await outcome)).toBe(true);
    expect(cancels(harness)).toHaveLength(1);
    expect(new URL(cancels(harness)[0].url).pathname).toBe(`/api/v2/statements/${TEST_HANDLE}/cancel`);
    expect(harness.statements.runsInFlight()).toBe(0);
  });

  test("an abort during the submit, without one: close() while the submit is held", async () => {
    const harness = setup();
    const submit = deferredAnswer();
    harness.transports.answer(SUBMIT, submit.answer);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, surfaceRun(harness), 1);
    const closing = harness.statements.close();
    await tick();
    expect(harness.statements.runsInFlight()).toBe(1);
    submit.resolve(handleAnswer());
    await closing;
    expect(isCancelled(await outcome)).toBe(true);
    expect(cancels(harness)).toHaveLength(1);
    expect(harness.statements.runsInFlight()).toBe(0);
  });
});

describe("cancel", () => {
  test("sends one cancel under its own bound and answers true once the run ended cancelled", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    const before = harness.deps.deadlines.requested.length;
    expect(await harness.statements.cancel("q-1")).toBe(true);
    expect(isCancelled(await outcome)).toBe(true);
    expect(((await outcome) as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.cancelled);
    expect(cancels(harness)).toHaveLength(1);
    expect(harness.deps.deadlines.requested.slice(before).sort()).toEqual([10_000, 5_000].sort());
    expect(warn).not.toHaveBeenCalled();
  });

  test("422 000709 is a confirmed cancel", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, failureAnswer(422, "000709", `Statement ${TEST_HANDLE} not found`));
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    expect(await harness.statements.cancel("q-1")).toBe(true);
    await outcome;
    expect(warn).not.toHaveBeenCalled();
  });

  test("another 422 still ends the run cancelled, and logs one line with its status alone", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, failureAnswer(422, "000605", `Statement ${TEST_HANDLE} secret text`));
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    expect(await harness.statements.cancel("q-1")).toBe(true);
    expect(isCancelled(await outcome)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toEqual(["A Snowflake statement cancel was not confirmed", { status: 422 }]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TEST_HANDLE);
  });

  test("a cancel that gets no answer is logged without a status", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, HANG);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    const cancelling = harness.statements.cancel("q-1");
    await harness.transports.received(3);
    const cancelDeadline = harness.deps.deadlines.requested.lastIndexOf(5_000);
    harness.deps.deadlines.fire(cancelDeadline);
    expect(await cancelling).toBe(true);
    expect(isCancelled(await outcome)).toBe(true);
    expect(warn.mock.calls[0]).toEqual(["A Snowflake statement cancel was not confirmed", { status: null }]);
  });

  test("two cancels of one id both answer true, and one cancel request is sent", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    const [first, second] = await Promise.all([harness.statements.cancel("q-1"), harness.statements.cancel("q-1")]);
    expect([first, second]).toEqual([true, true]);
    await outcome;
    expect(cancels(harness)).toHaveLength(1);
  });

  test("an unknown id answers false and sends nothing", async () => {
    const harness = setup();
    expect(await harness.statements.cancel("q-unknown")).toBe(false);
    expect(harness.transports.requests).toHaveLength(0);
  });

  test("a cancel of a run that does not end in time answers false", async () => {
    const harness = setup();
    const submit = deferredAnswer();
    harness.transports.answer(SUBMIT, submit.answer);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 1);
    const cancelling = harness.statements.cancel("q-1");
    harness.deps.deadlines.fire(harness.deps.deadlines.requested.lastIndexOf(10_000));
    expect(await cancelling).toBe(false);
    harness.transports.answer(CANCEL, CONFIRMED);
    submit.resolve(handleAnswer());
    expect(isCancelled(await outcome)).toBe(true);
  });

  test("a run that already ended answers false and sends nothing", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, one());
    await userRun(harness, "q-1");
    expect(await harness.statements.cancel("q-1")).toBe(false);
    expect(harness.transports.requests).toHaveLength(1);
  });

  test("a queryId already running is refused, and a finished id may run again", async () => {
    const harness = setup();
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    expect(await caught(userRun(harness, "q-1"))).toBeInstanceOf(DuplicateRunError);
    await harness.statements.cancel("q-1");
    await outcome;
    harness.transports.answer(SUBMIT, one());
    expect(await userRun(harness, "q-1")).toMatchObject({ rows: [{ N: 1 }] });
  });
});

describe("the deadline", () => {
  test("a statement that never finishes sees one cancel, and the deadline names the clamped seconds", async () => {
    const harness = setup({ queryTimeoutMs: 1_500 });
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, userRun(harness, "q-1"), 2);
    expect(harness.deps.deadlines.requested.slice(0, 2)).toEqual([7_000, 7_000]);
    harness.deps.deadlines.fire(STATEMENT_DEADLINE);
    const error = await outcome;
    expect(error).toBeInstanceOf(SnowflakeError);
    expect((error as SnowflakeError).category).toBe("query");
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.deadline(2));
    expect(cancels(harness)).toHaveLength(1);
  });

  test("a deadline during the submit throws the deadline sentence with nothing more sent", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, HANG);
    const { outcome } = await started(harness, surfaceRun(harness), 1);
    harness.deps.deadlines.fire(STATEMENT_DEADLINE);
    expect(((await outcome) as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.surfaceDeadline(30));
    expect(harness.transports.requests).toHaveLength(1);
  });

  test("Snowflake's own 408 on a Studio read says Snowflake ended it, at Studio's bound or a lower one", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, handleAnswer());
    harness.transports.answer(STATUS, failureAnswer(408, "000630", TIMEOUT_MESSAGE, "57014"));
    const error = await caught(surfaceRun(harness));
    expect((error as SnowflakeError).category).toBe("query");
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.surfaceStatementTimeout(30));
    expect(cancels(harness)).toHaveLength(0);
  });

  test("a Studio read past its 30 s bound names that bound, not the longer query timeout", async () => {
    const harness = setup({ queryTimeoutMs: 120_000 });
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, surfaceRun(harness), 2);
    harness.deps.deadlines.fire(STATEMENT_DEADLINE);
    const message = ((await outcome) as SnowflakeError).message;
    expect(message).toBe(SNOWFLAKE_ERROR_SENTENCES.surfaceDeadline(30));
    expect(message).not.toContain("Raise Query Timeout");
  });

  test("a Studio read under a query timeout shorter than 30 s names the query timeout", async () => {
    const harness = setup({ queryTimeoutMs: 2_000 });
    hanging(harness);
    harness.transports.answer(CANCEL, CONFIRMED);
    const { outcome } = await started(harness, surfaceRun(harness), 2);
    harness.deps.deadlines.fire(STATEMENT_DEADLINE);
    expect(((await outcome) as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.deadline(2));
  });

  test("Snowflake's own 408 on a user statement names the query timeout and the lower timeouts, never Studio's cancel", async () => {
    const harness = setup({ queryTimeoutMs: 700_000 });
    harness.transports.answer(SUBMIT, handleAnswer());
    harness.transports.answer(STATUS, failureAnswer(408, "000630", TIMEOUT_MESSAGE, "57014"));
    const error = await caught(userRun(harness, "q-1"));
    const message = (error as SnowflakeError).message;
    expect(message).toBe(SNOWFLAKE_ERROR_SENTENCES.statementTimeout(700));
    expect(message).not.toContain("so Studio cancelled it");
    expect(cancels(harness)).toHaveLength(0);
  });
});

describe("the engine limiter", () => {
  test("five runs on one connection send four submits; the fifth goes out when one ends", async () => {
    const harness = setup();
    hanging(harness, 5);
    harness.transports.answer(CANCEL, CONFIRMED);
    const outcomes = await Promise.all([1, 2, 3, 4].map((n) => started(harness, userRun(harness, `q-${n}`), n * 2)));
    const fifth = userRun(harness, "q-5").then(
      (value) => value,
      (error: unknown) => error,
    );
    await tick();
    expect(submits(harness)).toHaveLength(4);
    expect(harness.statements.runsInFlight()).toBe(5);
    expect(await harness.statements.cancel("q-1")).toBe(true);
    await outcomes[0].outcome;
    await harness.transports.received(11);
    expect(submits(harness)).toHaveLength(5);
    await harness.statements.close();
    expect(isCancelled(await fifth)).toBe(true);
  });

  test("a full queue refuses with LimiterFullError and sends nothing; a cancel still goes out", async () => {
    const harness = setup();
    hanging(harness, 4);
    harness.transports.answer(CANCEL, CONFIRMED);
    for (let n = 1; n <= 4; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each run's poll is in flight before the next starts.
      await started(harness, userRun(harness, `q-${n}`), n * 2);
    }
    const waiting = Array.from({ length: 64 }, (_, n) =>
      userRun(harness, `w-${n}`).then(
        (value) => value,
        (error: unknown) => error,
      ),
    );
    await tick();
    const sent = harness.transports.requests.length;
    const refused = await caught(userRun(harness, "q-69"));
    expect(refused).toBeInstanceOf(LimiterFullError);
    expect(harness.transports.requests).toHaveLength(sent);
    expect(harness.statements.runsInFlight()).toBe(68);

    hanging(harness);
    expect(await harness.statements.cancel("q-1")).toBe(true);
    expect(cancels(harness)).toHaveLength(1);
    await harness.statements.close();
    for (const outcome of await Promise.all(waiting)) expect(isCancelled(outcome)).toBe(true);
    expect(harness.statements.runsInFlight()).toBe(0);
  });

  test("a cancel while waiting leaves the queue and sends nothing", async () => {
    const harness = setup();
    hanging(harness, 4);
    for (let n = 1; n <= 4; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each run's poll is in flight before the next starts.
      await started(harness, userRun(harness, `q-${n}`), n * 2);
    }
    const waiting = userRun(harness, "q-5").then(
      (value) => value,
      (error: unknown) => error,
    );
    await tick();
    const sent = harness.transports.requests.length;
    expect(await harness.statements.cancel("q-5")).toBe(true);
    expect(isCancelled(await waiting)).toBe(true);
    expect(harness.transports.requests).toHaveLength(sent);
    expect(harness.statements.runsInFlight()).toBe(4);
  });

  test("a permit wait the deadline ends throws the slots sentence as unavailable, with nothing sent", async () => {
    const harness = setup();
    hanging(harness, 4);
    for (let n = 1; n <= 4; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each run's poll is in flight before the next starts.
      await started(harness, userRun(harness, `q-${n}`), n * 2);
    }
    const index = harness.deps.deadlines.requested.length;
    const waiting = surfaceRun(harness).then(
      (value) => value,
      (error: unknown) => error,
    );
    await tick();
    const sent = harness.transports.requests.length;
    harness.deps.deadlines.fire(index);
    const error = await waiting;
    expect((error as SnowflakeError).category).toBe("unavailable");
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_ERROR_SENTENCES.slotsBusy(35));
    expect(harness.transports.requests).toHaveLength(sent);
  });

  test("a run that waited for a permit gets its whole timeout from the moment it is sent (SF-007)", async () => {
    const harness = setup({ queryTimeoutMs: 10_000 });
    hanging(harness, 4);
    harness.transports.answer(CANCEL, CONFIRMED);
    const outcomes = await Promise.all([1, 2, 3, 4].map((n) => started(harness, userRun(harness, `q-${n}`), n * 2)));
    const queueBound = harness.deps.deadlines.requested.length;
    const status = deferredAnswer();
    harness.transports.answer(SUBMIT, handleAnswer(nextHandle()));
    harness.transports.answer(STATUS, status.answer);
    const fifth = userRun(harness, "q-5").then(
      (value) => value,
      (error: unknown) => error,
    );
    await tick();
    // Waiting: only the wait's own bound is running.
    expect(harness.deps.deadlines.requested.slice(queueBound)).toEqual([15_000]);
    expect(await harness.statements.cancel("q-1")).toBe(true);
    await outcomes[0].outcome;
    await harness.transports.received(11);
    await tick();
    // Admitted: the statement's own deadline starts now, with the full timeout plus the grace.
    const statementBound = harness.deps.deadlines.requested.lastIndexOf(15_000);
    expect(statementBound).toBeGreaterThan(queueBound);
    // The wait's bound passing after admission no longer ends the statement.
    harness.deps.deadlines.fire(queueBound);
    await tick();
    status.resolve(one());
    expect(await fifth).toMatchObject({ rows: [{ N: 1 }] });
    expect(cancels(harness)).toHaveLength(1);
  });

  test("a run after close() is cancelled before it is sent", async () => {
    const harness = setup();
    await harness.statements.close();
    expect(isCancelled(await caught(surfaceRun(harness)))).toBe(true);
    expect(harness.transports.requests).toHaveLength(0);
  });
});

describe("close", () => {
  test("two runs in flight get two cancels sent in parallel, each under its own 5 s", async () => {
    const harness = setup();
    hanging(harness, 2);
    const cancelAnswers = [deferredAnswer(), deferredAnswer()];
    harness.transports.answer(CANCEL, ...cancelAnswers.map((d) => d.answer));
    const outcomes = [
      await started(harness, userRun(harness, "q-1"), 2),
      await started(harness, surfaceRun(harness), 4),
    ];
    const before = harness.deps.deadlines.requested.length;
    const closing = harness.statements.close();
    await harness.transports.received(6);
    expect(cancels(harness)).toHaveLength(2);
    expect(harness.deps.deadlines.requested.slice(before)).toEqual([5_000, 5_000]);
    for (const answer of cancelAnswers) answer.resolve(CONFIRMED);
    await closing;
    // oxlint-disable-next-line no-await-in-loop -- both runs have already ended; each outcome is read in turn.
    for (const { outcome } of outcomes) expect(isCancelled(await outcome)).toBe(true);
    expect(harness.transports.closedLanes.length).toBeGreaterThan(0);
    expect(harness.transports.byteCloses()).toBe(1);
  });

  test("hanging cancels end close() once their deadlines fire", async () => {
    const harness = setup();
    hanging(harness, 4);
    harness.transports.answer(CANCEL, HANG, HANG, HANG, HANG);
    for (let n = 1; n <= 4; n += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each run's poll is in flight before the next starts.
      await started(harness, userRun(harness, `q-${n}`), n * 2);
    }
    const before = harness.deps.deadlines.requested.length;
    let closed = false;
    const closing = harness.statements.close().then(() => {
      closed = true;
    });
    await harness.transports.received(12);
    await tick();
    expect(closed).toBe(false);
    for (let index = before; index < harness.deps.deadlines.requested.length; index += 1) {
      harness.deps.deadlines.fire(index);
    }
    await closing;
    expect(cancels(harness)).toHaveLength(4);
    expect(harness.statements.runsInFlight()).toBe(0);
  });

  test("close() waits at most its bound for a run still in its submit, then closes the transport", async () => {
    const harness = setup();
    harness.transports.answer(SUBMIT, HANG);
    const { outcome } = await started(harness, surfaceRun(harness), 1);
    const before = harness.deps.deadlines.requested.length;
    const closing = harness.statements.close();
    await tick();
    expect(harness.deps.deadlines.requested.slice(before)).toEqual([5_000]);
    harness.deps.deadlines.fire(before);
    await closing;
    expect(isCancelled(await outcome)).toBe(true);
    expect(harness.statements.runsInFlight()).toBe(0);
    expect(cancels(harness)).toHaveLength(0);
  });
});
