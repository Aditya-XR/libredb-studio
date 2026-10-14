import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getExplainStrategy, resolveExplainPlan } from "@/lib/explain";
import {
  SNOWFLAKE_EXPLAIN_DECLINE,
  SNOWFLAKE_EXPLAIN_GATED_DECLINE,
  snowflakeJsonStrategy,
} from "@/lib/explain/snowflake-json";

const MODES = ["estimate", "analyze"] as const;

/**
 * A plan in the shape of `EXPLAIN USING JSON`: `GlobalStats` and `Operations`, an array of steps, each an array of
 * operations linked by `parentOperators`.
 * Its root names no parent, the documented form; the trial's roots name parent -1 (M26, and the cases below).
 */
const PLAN = {
  GlobalStats: { partitionsTotal: 12, partitionsAssigned: 3, bytesAssigned: 4096 },
  Operations: [
    [
      { id: 0, operation: "Result", expressions: ["T.A", "T.B"] },
      { id: 1, parentOperators: [0], operation: "Filter", expressions: ["T.A > 1"] },
      {
        id: 2,
        parentOperators: [1],
        operation: "TableScan",
        objects: ["DB.PUBLIC.T"],
        expressions: ["A", "B"],
        partitionsAssigned: 3,
        partitionsTotal: 12,
        bytesAssigned: 4096,
      },
    ],
  ],
};

describe("the snowflake-json strategy", () => {
  test("is the registry's entry for its format", () => {
    expect(getExplainStrategy("snowflake-json")).toBe(snowflakeJsonStrategy);
    expect(snowflakeJsonStrategy.format).toBe("snowflake-json");
  });

  // On the trial (Snowflake 10.37.100, 2026-10-12) EXPLAIN USING JSON left a suspended warehouse suspended.
  test("builds the background estimate as the same EXPLAIN USING JSON the Explain button sends", () => {
    expect(snowflakeJsonStrategy.buildSql("SELECT 1", "estimate")).toBe("EXPLAIN USING JSON SELECT 1");
    expect(snowflakeJsonStrategy.buildSql("WITH a AS (SELECT 1) SELECT * FROM a", "estimate")).toBe(
      snowflakeJsonStrategy.buildSql("WITH a AS (SELECT 1) SELECT * FROM a", "analyze"),
    );
    expect(snowflakeJsonStrategy.declineReason?.("SELECT 1", "estimate")).toBeNull();
  });

  test("builds EXPLAIN USING JSON for the Explain button, never an executing form", () => {
    expect(snowflakeJsonStrategy.buildSql("SELECT 1", "analyze")).toBe("EXPLAIN USING JSON SELECT 1");
    expect(snowflakeJsonStrategy.buildSql("WITH a AS (SELECT 1) SELECT * FROM a", "analyze")).toBe(
      "EXPLAIN USING JSON WITH a AS (SELECT 1) SELECT * FROM a",
    );
    expect(snowflakeJsonStrategy.declineReason?.("SELECT 1", "analyze")).toBeNull();
  });

  test("reads a // comment as Snowflake does, so a //-led SELECT builds", () => {
    expect(snowflakeJsonStrategy.buildSql("// c\nSELECT 1", "analyze")).toBe("EXPLAIN USING JSON // c\nSELECT 1");
  });

  test.each([
    ["CALL p()"],
    ["EXECUTE IMMEDIATE 'x'"],
    ["BEGIN SELECT 1; END"],
    ["DECLARE x INT; BEGIN RETURN 1; END"],
    ["WITH p AS PROCEDURE () RETURNS INT LANGUAGE SQL AS $$ BEGIN RETURN 1; END $$ CALL p()"],
    ["-- x\ncall p()"],
  ])("declines %s in both modes with the decline sentence", (sql) => {
    for (const mode of MODES) {
      expect(snowflakeJsonStrategy.buildSql(sql, mode)).toBeNull();
      expect(snowflakeJsonStrategy.declineReason?.(sql, mode)).toBe(SNOWFLAKE_EXPLAIN_DECLINE);
    }
  });

  // SF-001: Snowflake's compiler evaluates a SYSTEM$ function while it explains the statement. Measured on the trial
  // (Snowflake 10.37.100): `EXPLAIN USING JSON SELECT SYSTEM$WAIT(5)` took 6.5 s, and the Explain button's
  // `EXPLAIN USING JSON SELECT SYSTEM$CANCEL_QUERY('<id>')` really cancelled the other statement. RUN asks first for any
  // statement naming one, so neither the button nor the background estimate may send it.
  test.each([
    ["SELECT SYSTEM$CANCEL_QUERY('01b2') AS E_EXPLBTN_1"],
    ["select system$cancel_query('01b2')"],
    ["SELECT SYSTEM$WAIT(5)"],
    ['SELECT "SYSTEM$WAIT"(5)'],
    ["WITH a AS (SELECT SYSTEM$WAIT(1) AS w) SELECT * FROM a"],
    ["SELECT a FROM t WHERE b = SYSTEM$TYPEOF(a)"],
  ])("declines %s in both modes, because Snowflake evaluates it while explaining", (sql) => {
    for (const mode of MODES) {
      expect(snowflakeJsonStrategy.buildSql(sql, mode)).toBeNull();
      expect(snowflakeJsonStrategy.declineReason?.(sql, mode)).toBe(SNOWFLAKE_EXPLAIN_GATED_DECLINE);
    }
  });

  test.each([
    ["SELECT 'SYSTEM$WAIT(5)' AS s"],
    ["SELECT 1 -- SYSTEM$WAIT(5)"],
    ["SELECT 1 // SYSTEM$WAIT(5)"],
    ['SELECT "system$wait"(5)'],
    ["SELECT MY_SYSTEM$X FROM t"],
  ])("still explains %s, which names no SYSTEM$ function in its code", (sql) => {
    for (const mode of MODES) {
      expect(snowflakeJsonStrategy.buildSql(sql, mode)).toBe(`EXPLAIN USING JSON ${sql}`);
      expect(snowflakeJsonStrategy.declineReason?.(sql, mode)).toBeNull();
    }
  });

  test("the SYSTEM$ decline sentence", () => {
    expect(SNOWFLAKE_EXPLAIN_GATED_DECLINE).toBe(
      "Snowflake runs a SYSTEM$ function while it explains a statement, so Studio does not explain one. Run it instead; the confirmation gate asks first.",
    );
  });

  test("the decline sentence", () => {
    expect(SNOWFLAKE_EXPLAIN_DECLINE).toBe(
      "Snowflake explains a query only; this statement calls a procedure, runs dynamic SQL or opens a Scripting block.",
    );
  });

  test("a statement that is not a query declines without a sentence of its own", () => {
    for (const mode of MODES) {
      expect(snowflakeJsonStrategy.buildSql("INSERT INTO t VALUES (1)", mode)).toBeNull();
      expect(snowflakeJsonStrategy.declineReason?.("INSERT INTO t VALUES (1)", mode)).toBeNull();
    }
  });
});

describe("reading the plan", () => {
  test("extractPlan parses the first row's first column", () => {
    const rows = [{ content: JSON.stringify(PLAN) }];
    expect(snowflakeJsonStrategy.extractPlan({ rows })).toEqual(PLAN);
  });

  test("an unreadable plan is null", () => {
    expect(snowflakeJsonStrategy.extractPlan({ rows: [{ content: "not json" }] })).toBeNull();
    expect(snowflakeJsonStrategy.extractPlan({ rows: [{ content: 1 }] })).toBeNull();
    expect(snowflakeJsonStrategy.extractPlan({ rows: [] })).toBeNull();
    expect(snowflakeJsonStrategy.extractPlan({})).toBeNull();
  });

  test("renders the root with the three stats and the operations tree (a root naming no parent)", () => {
    const model = snowflakeJsonStrategy.toRenderModel(PLAN);
    expect(model).toEqual({
      kind: "tree",
      raw: PLAN,
      root: {
        label: "Snowflake plan",
        detail: "3 of 12 partitions assigned, 4,096 bytes assigned",
        children: [
          {
            label: "Result",
            detail: "T.A | T.B",
            children: [
              {
                label: "Filter",
                detail: "T.A > 1",
                children: [
                  {
                    label: "TableScan DB.PUBLIC.T",
                    detail: "A | B | 3 of 12 partitions, 4,096 bytes",
                    children: [],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  test("resolves through the registry from the stored value", () => {
    expect(resolveExplainPlan({ format: "snowflake-json", raw: PLAN })).toEqual(
      snowflakeJsonStrategy.toRenderModel(PLAN),
    );
  });

  test("a root that names parent -1, as a live plan does, is drawn with the operations under it", () => {
    // The shape Snowflake 10.37 answered for a two-table join on the sample data, 2026-10-12.
    const raw = {
      GlobalStats: { partitionsTotal: 4, partitionsAssigned: 4, bytesAssigned: 10752000 },
      Operations: [
        [
          { id: 0, operation: "Sort", expressions: ["COUNT(*) DESC NULLS FIRST"], parentOperators: [-1] },
          {
            id: 1,
            operation: "Aggregate",
            expressions: ["aggExprs: [COUNT(*)]", "groupKeys: [N.N_NAME]"],
            parentOperators: [0],
          },
          {
            id: 2,
            operation: "InnerJoin",
            expressions: ["joinKey: (N.N_NATIONKEY = C.C_NATIONKEY)"],
            parentOperators: [1],
          },
          {
            id: 3,
            operation: "TableScan",
            objects: ["SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.NATION"],
            expressions: ["N_NATIONKEY", "N_NAME"],
            alias: "N",
            partitionsAssigned: 1,
            partitionsTotal: 1,
            bytesAssigned: 4096,
            parentOperators: [2],
          },
          {
            id: 4,
            operation: "JoinFilter",
            expressions: ["joinKey: (N.N_NATIONKEY = C.C_NATIONKEY)"],
            parentOperators: [2],
          },
          {
            id: 5,
            operation: "TableScan",
            objects: ["SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.CUSTOMER"],
            expressions: ["C_NATIONKEY"],
            alias: "C",
            partitionsAssigned: 3,
            partitionsTotal: 3,
            bytesAssigned: 10747904,
            parentOperators: [4],
          },
        ],
      ],
    };
    const model = snowflakeJsonStrategy.toRenderModel(raw);
    expect(model?.kind).toBe("tree");
    const root = model?.kind === "tree" ? model.root : null;
    expect(root?.children.map((node) => node.label)).toEqual(["Sort"]);
    const join = root?.children[0].children[0].children[0];
    expect(join?.label).toBe("InnerJoin");
    expect(join?.children.map((node) => node.label)).toEqual([
      "TableScan SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.NATION",
      "JoinFilter",
    ]);
    expect(join?.children[1].children[0].label).toBe("TableScan SNOWFLAKE_SAMPLE_DATA.TPCH_SF1.CUSTOMER");
  });

  test("the plan the trial captured for M26 is drawn whole", () => {
    // EXPLAIN USING JSON SELECT * FROM every_type, Snowflake 10.37.100, 2026-10-12: one row, the plan as its text.
    const item = JSON.parse(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "fixtures", "snowflake", "trial-2026-10-12-v10.37.100", "M26.json"),
        "utf8",
      ),
    ) as { exchanges: { response: { rows?: { firstRow: string[] } } }[] };
    const content = item.exchanges[1].response.rows?.firstRow[0];
    const plan = snowflakeJsonStrategy.extractPlan({ rows: [{ content }] });
    const model = snowflakeJsonStrategy.toRenderModel(plan);
    const root = model?.kind === "tree" ? model.root : null;
    expect(root?.detail).toBe("1 of 1 partitions assigned, 6,656 bytes assigned");
    expect(root?.children.map((node) => [node.label, node.detail])).toEqual([["Limit", "rowCount: 100001"]]);
    const scan = root?.children[0].children[0];
    expect(scan?.label).toBe("TableScan STUDIO_DEMO.PROBE.EVERY_TYPE");
    expect(scan?.detail).toEndWith("FL | 1 of 1 partitions, 6,656 bytes");
    expect(scan?.children).toEqual([]);
  });

  test("several steps are each named under the root", () => {
    const plan = {
      GlobalStats: { partitionsTotal: 1, partitionsAssigned: 1, bytesAssigned: 10 },
      Operations: [[{ id: 0, operation: "Result" }], [{ id: 0, operation: "Insert" }]],
    };
    const model = snowflakeJsonStrategy.toRenderModel(plan);
    expect(model?.kind === "tree" ? model.root.children.map((child) => child.label) : null).toEqual([
      "Step 1",
      "Step 2",
    ]);
  });

  test("a cycle in parentOperators is drawn once and never loops", () => {
    const plan = {
      Operations: [
        [
          { id: 0, operation: "Result" },
          { id: 1, parentOperators: [0, 2], operation: "A" },
          { id: 2, parentOperators: [1], operation: "B" },
        ],
      ],
    };
    const model = snowflakeJsonStrategy.toRenderModel(plan);
    expect(model?.kind).toBe("tree");
    expect(JSON.stringify(model).match(/"label":"B"/g)?.length).toBe(1);
  });

  test("a foreign shape renders nothing", () => {
    expect(snowflakeJsonStrategy.toRenderModel(null)).toBeNull();
    expect(snowflakeJsonStrategy.toRenderModel({})).toBeNull();
    expect(snowflakeJsonStrategy.toRenderModel({ Operations: "x" })).toBeNull();
    expect(snowflakeJsonStrategy.toRenderModel({ Operations: [[{ id: 0 }]] })).toBeNull();
  });

  test("stats missing from GlobalStats are left out of the root", () => {
    const model = snowflakeJsonStrategy.toRenderModel({ Operations: [[{ id: 0, operation: "Result" }]] });
    expect(model?.kind === "tree" ? model.root.detail : "x").toBeUndefined();
  });
});
