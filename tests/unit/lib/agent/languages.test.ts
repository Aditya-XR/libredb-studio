import { describe, expect, test } from "bun:test";
import { mergeDisjoint } from "@/lib/agent/disjoint-merge";
import { READING_REFUSAL_TEXT, UNAVAILABLE_TEXT } from "@/lib/agent/tool-contracts";
import type { AgentToolUnavailableCode } from "@/lib/agent/tools";
import type { AgentReadingDenyCode } from "@/lib/agent/types";

/**
 * The language packs (#1821): the shared tables the core and the packs build together.
 *
 * A table keyed by a global name is a union of the core's rows and the packs' rows, and `mergeDisjoint` is what keeps
 * one name from being said twice.
 */

describe("mergeDisjoint", () => {
  test("returns one frozen record holding every key, in the order given", () => {
    const merged = mergeDisjoint([{ a: 1, b: 2 }, { c: 3 }], "a table");
    expect(merged).toEqual({ a: 1, b: 2, c: 3 });
    expect(Object.keys(merged)).toEqual(["a", "b", "c"]);
    expect(Object.isFrozen(merged)).toBe(true);
  });

  test("throws a named error when two records register one key", () => {
    expect(() => mergeDisjoint([{ a: 1 }, { b: 2, a: 3 }], "a table")).toThrow(
      new Error("a table: a is registered twice"),
    );
  });
});

/*
  Total records over the two code unions, so the compiler fails here when a code is added and the test below fails when
  a sentence goes missing from either side of the merge.
*/
const UNAVAILABLE_CODES: Readonly<Record<AgentToolUnavailableCode, true>> = {
  MODE_HAS_NO_TOOLS: true,
  INVALID_TOOL_INPUT: true,
  UNVERIFIABLE_EVIDENCE: true,
  UNVERIFIABLE_PLAN: true,
  TABLE_QUALIFIER_UNKNOWN: true,
  TABLE_NOT_INVENTORIED: true,
  TABLE_SPELLING_AMBIGUOUS: true,
  OBJECT_NOT_PROFILABLE: true,
  KIND_REFUSED: true,
  CATALOG_MATCHED_NOTHING: true,
  CATALOG_OBJECT_EMPTY: true,
  CATALOG_INVENTORY_EMPTY: true,
  PROFILE_UNREADABLE: true,
  NO_COLUMNS_AT_OFFSET: true,
  IDENTICAL_PLANS: true,
  RECOMMENDATION_SHAPE_MISMATCH: true,
  INDEX_ALREADY_EXISTS: true,
  PLAN_RESULT_RELEASED: true,
  ANSWER_ALREADY_RECORDED: true,
  ANSWER_ARTIFACT_UNKNOWN: true,
  ANSWER_NOT_A_DATA_READ: true,
  ANSWER_STATEMENT_UNKNOWN: true,
  ANSWER_RESULT_RELEASED: true,
  CHART_COLUMN_NOT_IN_RESULT: true,
  CHART_COLUMN_NOT_NUMERIC: true,
  CHART_TOO_FEW_ROWS: true,
  CHART_SHAPE_MISMATCH: true,
  STATEMENT_NOT_ADMITTED: true,
  RUN_DEADLINE_EXCEEDED: true,
  INSUFFICIENT_TIME_REMAINING: true,
  STATEMENT_ALREADY_FAILED: true,
  REPAIR_BUDGET_EXHAUSTED: true,
};

const READING_CODES: Readonly<Record<AgentReadingDenyCode, true>> = {
  KIND_UNSUPPORTED_BY_PROVIDER: true,
  READING_OVER_BUDGET: true,
  METRICS_UNAVAILABLE: true,
};

describe("the refusal tables", () => {
  test.each([
    ["UNAVAILABLE_TEXT", UNAVAILABLE_TEXT, UNAVAILABLE_CODES],
    ["READING_REFUSAL_TEXT", READING_REFUSAL_TEXT, READING_CODES],
  ] as const)("%s holds one sentence for every code and is frozen", (_name, table, codes) => {
    expect(Object.keys(table).sort()).toEqual(Object.keys(codes).sort());
    for (const sentence of Object.values(table)) expect(sentence.length).toBeGreaterThan(0);
    expect(Object.isFrozen(table)).toBe(true);
  });
});
