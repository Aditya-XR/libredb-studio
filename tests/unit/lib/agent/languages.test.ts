import { describe, expect, test } from "bun:test";
import { AGENT_WORKFLOW_VARIANTS, type AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { mergeDisjoint } from "@/lib/agent/disjoint-merge";
import { verifyRunGoal } from "@/lib/agent/goal-verifier";
import { AGENT_EVIDENCE_TOOLS, LANGUAGE_TOOL_ARMS, agentLanguagePack } from "@/lib/agent/languages/index";
import {
  LANGUAGE_BASE_DEFINITIONS,
  LANGUAGE_SHORTFALL_NOTICES,
  LANGUAGE_USAGE_BAR_NOTICE,
  WORKFLOW_TOOL_RULES,
  languageServer,
  languageServerPack,
} from "@/lib/agent/languages/server";
import { OPERATIONS_TOOL_RULE } from "@/lib/agent/languages/shared";
import { LANGUAGE_GOAL_RULES } from "@/lib/agent/languages/verifiers";
import { READING_REFUSAL_TEXT, UNAVAILABLE_TEXT } from "@/lib/agent/tool-contracts";
import { AGENT_TOOL_DEFINITIONS, type AgentToolUnavailableCode, agentToolDefinition } from "@/lib/agent/tools";
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

/* Total over the language ids, so the compiler fails here when a language is added without a row. */
const LANGUAGE_IDS: Readonly<Record<AgentStatementLanguageId, true>> = { sql: true, kubectl: true, mongo: true };

describe("the server packs", () => {
  test.each(Object.keys(LANGUAGE_IDS) as AgentStatementLanguageId[])(
    "%s resolves to a frozen pack whose adapter is the one languageServer returns",
    (id) => {
      const pack = languageServerPack(id);
      expect(Object.isFrozen(pack)).toBe(true);
      expect(Object.isFrozen(pack.adapter)).toBe(true);
      expect(languageServer(id)).toBe(pack.adapter);
      expect(Object.isFrozen(pack.toolOverrides)).toBe(true);
      expect(Object.isFrozen(pack.baseDefinitions)).toBe(true);
      expect(pack.answerNotADataRead.length).toBeGreaterThan(0);
    },
  );

  test.each(["cypher", "toString"])("an id no pack holds (%s) is the same named error from both accessors", (id) => {
    const unknown = id as AgentStatementLanguageId;
    expect(() => languageServerPack(unknown)).toThrow(new Error(`no server adapter for ${id}`));
    expect(() => languageServer(unknown)).toThrow(new Error(`no server adapter for ${id}`));
  });
});

describe("the definitions the packs register", () => {
  test("the base definitions are kubectl's two readings, spread into the core record where they always stood", () => {
    expect(Object.keys(LANGUAGE_BASE_DEFINITIONS)).toEqual(["inspect_usage", "profile_workloads"]);
    expect(Object.isFrozen(LANGUAGE_BASE_DEFINITIONS)).toBe(true);
    expect(Object.keys(AGENT_TOOL_DEFINITIONS)).toEqual([
      "inspect_schema",
      "run_read_query",
      "inspect_plan",
      "profile_table",
      "compare_plans",
      "recommend_change",
      "inspect_operations",
      "inspect_usage",
      "profile_workloads",
      "present_answer",
      "compose_report",
    ]);
    expect(AGENT_TOOL_DEFINITIONS.inspect_usage).toBe(LANGUAGE_BASE_DEFINITIONS.inspect_usage);
    expect(AGENT_TOOL_DEFINITIONS.profile_workloads).toBe(LANGUAGE_BASE_DEFINITIONS.profile_workloads);
  });

  test("a workflow's offer is its pack's override where one exists, and the core definition otherwise", () => {
    const mongoRead = languageServerPack("mongo").toolOverrides.investigation?.run_read_query;
    expect(mongoRead).toBeDefined();
    expect(agentToolDefinition("mongo", "investigation", "run_read_query")).toBe(
      mongoRead as NonNullable<typeof mongoRead>,
    );
    expect(agentToolDefinition("kubectl", "operations", "inspect_operations")).toBe(
      AGENT_TOOL_DEFINITIONS.inspect_operations,
    );
    expect(agentToolDefinition(undefined, "investigation", "run_read_query")).toBe(
      AGENT_TOOL_DEFINITIONS.run_read_query,
    );
  });

  test("an offer on an id no pack holds is the named error, not a fall back to SQL", () => {
    expect(() => agentToolDefinition("cypher" as AgentStatementLanguageId, "investigation", "run_read_query")).toThrow(
      new Error("no server adapter for cypher"),
    );
  });

  test("SQL and kubectl refuse a plan as the answer in the shared words, MongoDB in its own", () => {
    expect(languageServerPack("sql").answerNotADataRead).toBe(UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ);
    expect(languageServerPack("kubectl").answerNotADataRead).toBe(UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ);
    expect(languageServerPack("mongo").answerNotADataRead).not.toBe(UNAVAILABLE_TEXT.ANSWER_NOT_A_DATA_READ);
  });

  test("only SQL advises on a foreign catalog, and only when the message names one", () => {
    const advice = languageServerPack("sql").catalogAdvice;
    expect(advice?.("no such table: information_schema.tables", "sqlite")).toBe(
      "That catalog belongs to another engine \u2014 this connection is sqlite. Call inspect_schema for this database's tables and columns rather than querying a catalog directly.",
    );
    expect(advice?.("no such table: main.orders", "sqlite")).toStartWith("That catalog belongs to another engine");
    expect(advice?.('relation "orders" does not exist', "postgres")).toBeUndefined();
    expect(languageServerPack("kubectl").catalogAdvice).toBeUndefined();
    expect(languageServerPack("mongo").catalogAdvice).toBeUndefined();
  });

  test("a language's recommendation card is the schema its recommend_change offer parses with", () => {
    expect(languageServerPack("sql").recommendationCard).toBeUndefined();
    const resources = languageServerPack("kubectl").recommendationCard;
    expect(Object.isFrozen(resources)).toBe(true);
    expect(resources?.inputSchema as unknown).toBe(
      agentToolDefinition("kubectl", "query-optimization", "recommend_change").inputSchema,
    );
    const documentIndex = languageServerPack("mongo").recommendationCard;
    expect(Object.isFrozen(documentIndex)).toBe(true);
    expect(documentIndex?.inputSchema as unknown).toBe(
      agentToolDefinition("mongo", "query-optimization", "recommend_change").inputSchema,
    );
    // A kubectl workflow that proposes no resources change is offered the statement card, which no pack holds.
    expect(agentToolDefinition("kubectl", "investigation", "recommend_change").inputSchema).not.toBe(
      resources?.inputSchema,
    );
  });
});

describe("the language packs", () => {
  test.each(Object.keys(LANGUAGE_IDS) as AgentStatementLanguageId[])(
    "%s resolves to one frozen pack whose facets are the ones the tier accessors return",
    (id) => {
      const pack = agentLanguagePack(id);
      expect(pack.id).toBe(id);
      expect(Object.isFrozen(pack)).toBe(true);
      expect(Object.isFrozen(pack.execution)).toBe(true);
      expect(Object.isFrozen(pack.execution.arms)).toBe(true);
      expect(Object.isFrozen(pack.execution.evidenceTools)).toBe(true);
      expect(pack.server).toBe(languageServerPack(id));
      expect(LANGUAGE_TOOL_ARMS[id]).toBe(pack.execution.arms);
    },
  );

  test("the arms projection holds every language, in the order the packs are declared", () => {
    expect(Object.keys(LANGUAGE_TOOL_ARMS)).toEqual(["sql", "kubectl", "mongo"]);
    expect(Object.isFrozen(LANGUAGE_TOOL_ARMS)).toBe(true);
  });

  test.each(["cypher", "toString"])("an id no pack holds (%s) is a named error", (id) => {
    expect(() => agentLanguagePack(id as AgentStatementLanguageId)).toThrow(new Error(`no language pack for ${id}`));
  });

  test("the evidence tools are kubectl's two readings, each with the event its verdict reads", () => {
    expect(Object.keys(AGENT_EVIDENCE_TOOLS)).toEqual(["inspect_usage", "profile_workloads"]);
    expect(Object.isFrozen(AGENT_EVIDENCE_TOOLS)).toBe(true);
    expect(AGENT_EVIDENCE_TOOLS.inspect_usage).toBe(
      agentLanguagePack("kubectl").execution.evidenceTools.inspect_usage as NonNullable<
        typeof AGENT_EVIDENCE_TOOLS.inspect_usage
      >,
    );
    expect(AGENT_EVIDENCE_TOOLS.inspect_usage.event).toBe("usage-read");
    expect(AGENT_EVIDENCE_TOOLS.profile_workloads.event).toBe("workloads-profiled");
  });
});

describe("the prompt tables the packs hold", () => {
  const ids = Object.keys(LANGUAGE_IDS) as AgentStatementLanguageId[];

  test("exactly one pack supplies the usage bar, and it is kubectl's", () => {
    expect(ids.filter((id) => languageServerPack(id).usageBarNotice !== undefined)).toEqual(["kubectl"]);
    expect(LANGUAGE_USAGE_BAR_NOTICE).toBe(languageServerPack("kubectl").usageBarNotice as string);
  });

  test("the workflow rules projection holds each pack's own frozen record, in the order the packs are declared", () => {
    expect(Object.keys(WORKFLOW_TOOL_RULES)).toEqual(["sql", "kubectl", "mongo"]);
    expect(Object.isFrozen(WORKFLOW_TOOL_RULES)).toBe(true);
    for (const id of ids) {
      expect(WORKFLOW_TOOL_RULES[id]).toBe(languageServerPack(id).workflowToolRules);
      expect(Object.isFrozen(WORKFLOW_TOOL_RULES[id])).toBe(true);
      // `operations` sends no statement in any language, so every pack holds the one shared rule.
      expect(WORKFLOW_TOOL_RULES[id].operations).toBe(OPERATIONS_TOOL_RULE);
    }
  });

  test("the language shortfall notices are kubectl's three and MongoDB's one, and SQL adds none", () => {
    expect(Object.keys(languageServerPack("sql").shortfallNotices)).toEqual([]);
    expect(Object.keys(LANGUAGE_SHORTFALL_NOTICES)).toEqual([
      "no-usage-reading",
      "no-usage-evidence",
      "no-workload-profile",
      "no-plan-cited",
    ]);
    expect(Object.isFrozen(LANGUAGE_SHORTFALL_NOTICES)).toBe(true);
  });

  test("each pack grounds a run in its own tools' words, and only MongoDB adds planning rules", () => {
    for (const id of ids) expect(Object.isFrozen(languageServerPack(id).grounding)).toBe(true);
    expect(languageServerPack("sql").grounding.relations).toBe(true);
    expect(languageServerPack("kubectl").grounding.relations).toBe(false);
    expect(languageServerPack("mongo").grounding.relations).toBe(false);
    expect(languageServerPack("sql").grounding.planningRules).toBeUndefined();
    expect(languageServerPack("kubectl").grounding.planningRules).toBeUndefined();
    const [collectionRule] = languageServerPack("mongo").grounding.planningRules ?? [];
    expect(WORKFLOW_TOOL_RULES.mongo.investigation).toContain(collectionRule as string);
  });
});

describe("the goal rules the packs register", () => {
  const ids = Object.keys(LANGUAGE_IDS) as AgentStatementLanguageId[];

  test("the language rules are kubectl's two and MongoDB's one, and no SQL variant names any of them", () => {
    expect(Object.keys(LANGUAGE_GOAL_RULES)).toEqual([
      "agent-query-optimization-kubectl.1",
      "agent-database-assessment-kubectl.1",
      "agent-query-optimization-mongo.1",
    ]);
    expect(Object.isFrozen(LANGUAGE_GOAL_RULES)).toBe(true);
    for (const variant of Object.values(AGENT_WORKFLOW_VARIANTS.sql)) {
      expect(Object.hasOwn(LANGUAGE_GOAL_RULES, variant.verifier)).toBe(false);
    }
  });

  test("every variant's verifier has a rule, and a verdict names the id it was measured against", () => {
    for (const id of ids) {
      for (const [workflowType, variant] of Object.entries(AGENT_WORKFLOW_VARIANTS[id])) {
        const verdict = verifyRunGoal({
          mode: "agent",
          workflowType: workflowType as keyof typeof AGENT_WORKFLOW_VARIANTS.sql,
          status: "succeeded",
          events: [],
          statementLanguage: id,
          verifier: variant.verifier,
        });
        expect(verdict.verifier).toBe(variant.verifier);
      }
    }
  });

  test("goal-verifier.ts loads alone in a fresh process", () => {
    const run = Bun.spawnSync(
      [process.execPath, "-e", `await import(${JSON.stringify(`${process.cwd()}/src/lib/agent/goal-verifier.ts`)})`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});
