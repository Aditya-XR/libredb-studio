import { describe, expect, test } from "bun:test";
import { AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";
import { composeEstimatingExplain } from "@/lib/agent/composed-sql";
import { languageClientPack } from "@/lib/agent/languages/client";
import { engineClientPack } from "@/lib/agent/languages/engines/client";
import { agentEnginePack } from "@/lib/agent/languages/engines/index";
import { engineServerDialect, engineServerOverlay } from "@/lib/agent/languages/engines/server";
import * as KUBECTL_CLIENT_OVERLAYS from "@/lib/agent/languages/kubectl/engines/client";
import * as KUBERNETES from "@/lib/agent/languages/kubectl/engines/kubernetes";
import { KUBECTL_PACK } from "@/lib/agent/languages/kubectl/index";
import * as MONGO_CLIENT_OVERLAYS from "@/lib/agent/languages/mongo/engines/client";
import * as MONGODB from "@/lib/agent/languages/mongo/engines/mongodb";
import { MONGO_PACK } from "@/lib/agent/languages/mongo/index";
import { defineOverlay } from "@/lib/agent/languages/overlay";
import type { AgentEngineServerDialect } from "@/lib/agent/languages/pack";
import { languageServerPack } from "@/lib/agent/languages/server";
import * as SQL_CLIENT_OVERLAYS from "@/lib/agent/languages/sql/engines/client";
import * as DUCKDB from "@/lib/agent/languages/sql/engines/duckdb";
import * as MSSQL from "@/lib/agent/languages/sql/engines/mssql";
import * as MYSQL from "@/lib/agent/languages/sql/engines/mysql";
import * as POSTGRES from "@/lib/agent/languages/sql/engines/postgres";
import * as SQLITE from "@/lib/agent/languages/sql/engines/sqlite";
import { SQL_PACK } from "@/lib/agent/languages/sql/index";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { getExplainStrategy } from "@/lib/explain";
import type { DatabaseType } from "@/lib/types";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

/**
 * The engine overlays (#1821): one engine's pack is its family's pack with the engine's dialect laid on, and nothing
 * else. Held member for member against the family pack, so a reader moved from `agentLanguagePack` onto
 * `agentEnginePack` reads what it read before.
 */

const ALL_TYPES = Object.keys(AGENT_STATEMENT_LANGUAGE) as DatabaseType[];
const ENGINES = ALL_TYPES.filter((type) => AGENT_STATEMENT_LANGUAGE[type] !== null);
const SQL_ENGINES = ENGINES.filter((type) => AGENT_STATEMENT_LANGUAGE[type] === "sql");

/** The merged view's members: every dialect-bound member of every family. */
const SERVER_DIALECT_MEMBERS: readonly (keyof AgentEngineServerDialect)[] = ["planEstimate", "profileComposition"];

const ENGINE_MODULES: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  "sql/engines/postgres": POSTGRES,
  "sql/engines/sqlite": SQLITE,
  "sql/engines/duckdb": DUCKDB,
  "sql/engines/mssql": MSSQL,
  "sql/engines/mysql": MYSQL,
  "sql/engines/client": SQL_CLIENT_OVERLAYS,
  "mongo/engines/mongodb": MONGODB,
  "mongo/engines/client": MONGO_CLIENT_OVERLAYS,
  "kubectl/engines/kubernetes": KUBERNETES,
  "kubectl/engines/client": KUBECTL_CLIENT_OVERLAYS,
};

const without = (facet: object, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(facet).filter(([name]) => name !== key));

describe("the engine registry", () => {
  test("holds the engines that speak a statement language, in registry order", () => {
    expect(ENGINES).toEqual(["postgres", "mysql", "sqlite", "duckdb", "mssql", "mongodb", "kubernetes"]);
    expect(SQL_ENGINES).toEqual(["postgres", "mysql", "sqlite", "duckdb", "mssql"]);
  });

  test.each(ALL_TYPES)("%s has a client pack exactly when it speaks a language, over that language's facet", (type) => {
    const language = AGENT_STATEMENT_LANGUAGE[type];
    if (language === null) {
      expect(() => engineClientPack(type)).toThrow(new Error(`no engine pack for ${type}`));
    } else {
      // Every client overlay is empty, so the engine's client facet is its family's own object.
      expect(engineClientPack(type)).toBe(languageClientPack(language));
    }
  });

  test("a name that is no engine has no pack, inherited names included", () => {
    expect(() => engineClientPack("toString" as DatabaseType)).toThrow(new Error("no engine pack for toString"));
    expect(() => agentEnginePack("toString" as DatabaseType)).toThrow(new Error("no engine pack for toString"));
    expect(() => agentEnginePack("oracle")).toThrow(new Error("no engine pack for oracle"));
  });

  test("every engine module exports overlays that hold a dialect and nothing else (ruling 2)", () => {
    const exported = Object.entries(ENGINE_MODULES).flatMap(([module, exports]) =>
      Object.entries(exports).map(([name, overlay]) => [`${module}#${name}`, overlay] as const),
    );
    expect(exported).toHaveLength(14);
    for (const [, overlay] of exported) {
      expect(Object.keys(overlay as object).filter((key) => key !== "dialect")).toEqual([]);
    }
  });
});

describe("the engine packs", () => {
  test("an engine whose overlays are empty is its family's pack itself", () => {
    expect(agentEnginePack("mongodb")).toBe(MONGO_PACK);
    expect(agentEnginePack("kubernetes")).toBe(KUBECTL_PACK);
    expect(agentEnginePack("mongodb")).toEqual(MONGO_PACK);
    expect(agentEnginePack("kubernetes")).toEqual(KUBECTL_PACK);
  });

  test.each(SQL_ENGINES)("%s is the SQL pack member for member, with its own dialect on the server facet", (type) => {
    const pack = agentEnginePack(type);
    const server = languageServerPack("sql");
    expect(pack.id).toBe("sql");
    expect(pack.execution).toBe(SQL_PACK.execution);
    expect(Object.keys(without(pack.server, "dialect"))).toEqual(Object.keys(server));
    for (const [member, value] of Object.entries(without(pack.server, "dialect"))) {
      expect(value).toBe((server as unknown as Record<string, unknown>)[member]);
    }
    const client = languageClientPack(AGENT_STATEMENT_LANGUAGE[type] as "sql");
    expect(Object.keys(without(pack.client, "dialect"))).toEqual(Object.keys(client));
    for (const [member, value] of Object.entries(without(pack.client, "dialect"))) {
      expect(value).toBe((client as unknown as Record<string, unknown>)[member]);
    }
    expect(pack.server.dialect).toBe(engineServerDialect(type));
    expect(Object.isFrozen(pack)).toBe(true);
    expect(Object.isFrozen(pack.server)).toBe(true);
    expect(Object.isFrozen(pack.client)).toBe(true);
  });
});

describe("engineServerDialect", () => {
  test.each([...ALL_TYPES, "toString" as DatabaseType])("%s answers a frozen dialect with every member", (type) => {
    const dialect = engineServerDialect(type);
    expect(Object.isFrozen(dialect)).toBe(true);
    expect(Object.keys(dialect).sort()).toEqual([...SERVER_DIALECT_MEMBERS].sort());
    if (!SQL_ENGINES.includes(type)) {
      for (const member of SERVER_DIALECT_MEMBERS) expect(dialect[member]).toBe("unsupported");
    }
  });

  test("a type with no overlay holds an empty one, so its server facet is its family's own", () => {
    for (const type of ["oracle", "toString", "mongodb", "kubernetes"] as DatabaseType[]) {
      expect(Object.keys(engineServerOverlay(type))).toEqual([]);
    }
    expect(engineServerOverlay("postgres").dialect).toBe(engineServerDialect("postgres"));
  });

  test("profileComposition is supplied on exactly the four verified engines, and DuckDB declares it unsupported (B111)", () => {
    const supplied = SQL_ENGINES.filter((type) => engineServerDialect(type).profileComposition !== "unsupported");
    expect(supplied).toEqual(["postgres", "mysql", "sqlite", "mssql"]);
    expect(engineServerDialect("duckdb").profileComposition).toBe("unsupported");
    const counted = supplied.filter((type) => {
      const composition = engineServerDialect(type).profileComposition;
      return composition !== "unsupported" && composition.uncountableType !== undefined;
    });
    expect(counted).toEqual(["mssql"]);
    for (const type of supplied) {
      const composition = engineServerDialect(type).profileComposition;
      expect(Object.isFrozen(composition)).toBe(true);
      if (composition !== "unsupported") expect(Object.isFrozen(composition.shapeTests)).toBe(true);
    }
  });

  test("planEstimate is supplied on every SQL engine: a prefix on four, SQL Server's session mode", () => {
    expect(Object.fromEntries(SQL_ENGINES.map((type) => [type, engineServerDialect(type).planEstimate]))).toEqual({
      postgres: { kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" },
      mysql: { kind: "prefix", prefix: "EXPLAIN FORMAT=JSON" },
      sqlite: { kind: "prefix", prefix: "EXPLAIN QUERY PLAN" },
      duckdb: { kind: "prefix", prefix: "EXPLAIN (FORMAT JSON)" },
      mssql: { kind: "session-mode", mode: "estimate-plan" },
    });
    for (const type of SQL_ENGINES) expect(Object.isFrozen(engineServerDialect(type).planEstimate)).toBe(true);
  });
});

/**
 * The estimating EXPLAIN prefix is restated in the agent rather than read from the provider (#1821 ruling 4): MySQL
 * measures its format on the agent connection too, so the format is not known until connect. What is known before
 * connect is the format each provider declares, and the editor's strategy for that format must build the same
 * estimating statement the agent composes. SQL Server is the one exception: its plan is a session mode, and its
 * provider declares no EXPLAIN at all.
 */
describe("the estimating EXPLAIN agrees with the editor's strategy", () => {
  test.each(["postgres", "sqlite", "duckdb", "mysql"] as const)(
    "%s composes what the strategy of its declared format builds",
    async (type) => {
      const provider = await createDatabaseProvider(
        CENSUS_CONNECTION[type],
        {},
        executionContextFor("agent-read-only"),
      );
      const strategy = getExplainStrategy(provider.getCapabilities().explainFormat);
      expect(strategy).not.toBeNull();
      expect(composeEstimatingExplain(type, "SELECT 1").sql).toBe(strategy!.buildSql("SELECT 1", "estimate")!);
    },
  );

  test("mssql declares no EXPLAIN, and its estimating plan is the session mode", async () => {
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.mssql, {}, executionContextFor("agent-read-only"));
    expect(provider.getCapabilities().supportsExplain).toBe(false);
    expect(provider.getCapabilities().explainFormat).toBeUndefined();
    expect(composeEstimatingExplain("mssql", "SELECT 1")).toEqual({ sql: "SELECT 1", mode: "estimate-plan" });
  });
});

describe("defineOverlay", () => {
  interface Fixture {
    readonly copy: string;
    readonly grounding: { readonly omissionAdvice: string; readonly relations?: boolean };
    readonly count: number;
  }
  const base: Fixture = Object.freeze({
    copy: "base copy",
    grounding: Object.freeze({ omissionAdvice: "base advice", relations: true }),
    count: 2,
  });

  test("a value replaces the member, and every member left alone keeps its reference", () => {
    const overlaid = defineOverlay(base, { copy: "engine copy" });
    expect(overlaid.copy).toBe("engine copy");
    expect(overlaid.grounding).toBe(base.grounding);
    expect(overlaid.count).toBe(2);
    expect(Object.isFrozen(overlaid)).toBe(true);
  });

  test("a function receives the base value and its result becomes the member", () => {
    const seen: number[] = [];
    const overlaid = defineOverlay(base, {
      count: (count: number) => {
        seen.push(count);
        return count + 1;
      },
    });
    expect(seen).toEqual([2]);
    expect(overlaid.count).toBe(3);
  });

  test("a record replaces the member whole: there is no deep merge", () => {
    const overlaid = defineOverlay(base, { grounding: { omissionAdvice: "x" } });
    expect(overlaid.grounding).toEqual({ omissionAdvice: "x" });
    expect("relations" in overlaid.grounding).toBe(false);
  });

  test("a member the base lacks appears on the result", () => {
    const dialect = Object.freeze({ profileComposition: "unsupported" as const });
    const overlaid = defineOverlay(base, { dialect });
    expect(overlaid.dialect).toBe(dialect);
    expect(Object.keys(overlaid)).toEqual(["copy", "grounding", "count", "dialect"]);
  });

  test("an empty or absent overlay returns the base itself", () => {
    expect(defineOverlay(base)).toBe(base);
    expect(defineOverlay(base, undefined)).toBe(base);
    expect(defineOverlay(base, {})).toBe(base);
  });
});

describe("the resolvers and their readers load alone", () => {
  // A module the overlays reach at load, through a runtime cycle, would read a binding in its temporal dead zone here.
  test.each([
    "src/lib/agent/languages/engines/client.ts",
    "src/lib/agent/languages/engines/server.ts",
    "src/lib/agent/languages/engines/index.ts",
    "src/lib/agent/table-profile.ts",
    "src/lib/agent/posture.ts",
  ])("%s loads alone in a fresh process", (module) => {
    const run = Bun.spawnSync(
      [process.execPath, "-e", `await import(${JSON.stringify(`${process.cwd()}/${module}`)})`],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});
