import { describe, expect, test } from "bun:test";
import {
  DatabendError,
  type DatabendErrorCategory,
  type DatabendTransport,
  type StatementOutcome,
  type StatementRequest,
} from "@/lib/db/providers/sql/databend/transport";

/** The nine categories of design 3.13 and the five transport kinds a provider statement surfaces. */
const CATEGORIES = [
  "auth",
  "config",
  "protocol",
  "unavailable",
  "outcome-unknown",
  "timeout",
  "cancelled",
  "statement",
  "server",
  "network",
  "tls",
  "redirect",
  "encoding",
  "too-large",
] as const satisfies readonly DatabendErrorCategory[];

describe("DatabendError", () => {
  test("the category union is closed: the list above names every member, which the typecheck holds", () => {
    // A member the list leaves out makes `Unlisted` that member, and this assignment a type error.
    type Unlisted = Exclude<DatabendErrorCategory, (typeof CATEGORIES)[number]>;
    const closed: [Unlisted] extends [never] ? true : false = true;
    expect(closed).toBe(true);
    expect(new Set(CATEGORIES).size).toBe(14);
  });

  test("carries exactly one category of its closed union, and the message it was given", () => {
    for (const category of CATEGORIES) {
      const error = new DatabendError(category, `sentence for ${category}`);
      expect(error).toBeInstanceOf(Error);
      expect(error).toBeInstanceOf(DatabendError);
      expect(error.category).toBe(category);
      expect(error.message).toBe(`sentence for ${category}`);
      expect(error.name).toBe("DatabendError");
      expect(error.code).toBeUndefined();
      expect(error.status).toBeUndefined();
      expect(error.position).toBeUndefined();
      expect(error.detail).toBeUndefined();
    }
  });

  test("keeps Databend's code, the HTTP status, the statement position, a detail and the cause it was given", () => {
    const cause = new Error("socket hang up");
    const error = new DatabendError("statement", "error: column x does not exist", {
      code: 1065,
      status: 200,
      position: 8,
      detail: "--> SQL:1:8",
      cause,
    });
    expect(error.code).toBe(1065);
    expect(error.status).toBe(200);
    expect(error.position).toBe(8);
    expect(error.detail).toBe("--> SQL:1:8");
    expect(error.cause).toBe(cause);
  });
});

describe("the seam types", () => {
  test("a transport takes one statement request and answers one outcome, schema, rows, bound, notices and affect", async () => {
    const outcome: StatementOutcome = {
      schema: [
        { name: "id", type: "Int32" },
        { name: "payload", type: "Nullable(Binary)" },
      ],
      rows: [
        ["1", "616263"],
        ["2", null],
      ],
      truncated: { bound: "rows", limit: 2 },
      notices: [
        { kind: "use-not-carried" },
        { kind: "close-failed", step: "final" },
        { kind: "server-warning", text: "unknown setting max_result_rows is ignored" },
      ],
      hasResultSet: true,
      affect: { type: "UseDB", name: "default" },
    };
    const requests: StatementRequest[] = [];
    const transport: DatabendTransport = {
      run: async (request) => {
        requests.push(request);
        return outcome;
      },
      close: async () => undefined,
    };
    const signal = new AbortController().signal;
    await expect(transport.run({ sql: "SELECT 1", origin: "user", rowCut: 2, signal })).resolves.toBe(outcome);
    expect(requests).toEqual([{ sql: "SELECT 1", origin: "user", rowCut: 2, signal }]);
    await expect(transport.close()).resolves.toBeUndefined();
  });
});
