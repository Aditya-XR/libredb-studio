import { describe, expect, test } from "bun:test";
import type { AgentStatementLanguageId } from "@/lib/agent/agent-manifest";
import { defineOverlay } from "@/lib/agent/languages/overlay";
import type {
  AgentEngineServerOverlay,
  AgentEngineServerOverlays,
  AgentFamilyDialect,
  AgentLanguageServerAdapter,
  MemberOverride,
} from "@/lib/agent/languages/pack";
import { SQL_SERVER_PACK } from "@/lib/agent/languages/sql/server";

/**
 * The engine overlay types (#1821), held by the compiler: `bun run typecheck` reads this file, and each
 * `@ts-expect-error` below fails it the day its line compiles, so every case is proven both ways. The runtime
 * assertions only keep the fixtures from being unused.
 */

describe("the engine overlay types", () => {
  test("refuse an overlay that leaves a member out, widens one, or reaches past its dialect", () => {
    const fixtures: readonly unknown[] = [
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `profileComposition` included.
        dialect: { catalogRead: "unsupported", planEstimate: "unsupported" },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `planEstimate` included.
        dialect: { catalogRead: "unsupported", profileComposition: "unsupported" },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        // @ts-expect-error: a SQL overlay must say every dialect-bound member, `catalogRead` included.
        dialect: { planEstimate: "unsupported", profileComposition: "unsupported" },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          catalogRead: "unsupported",
          planEstimate: "unsupported",
          // @ts-expect-error: `undefined` is neither a composition nor "unsupported".
          profileComposition: undefined,
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          catalogRead: "unsupported",
          // @ts-expect-error: a session mode is the estimating plan's own, never a prefix's.
          planEstimate: { kind: "prefix", mode: "estimate-plan" },
          profileComposition: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      {
        dialect: {
          // @ts-expect-error: a catalog read composes all four kinds, `statistics` included.
          catalogRead: { compose: { columns: () => "", relations: () => "", indexes: () => "" } },
          planEstimate: "unsupported",
          profileComposition: "unsupported",
        },
      } as const satisfies AgentEngineServerOverlay<"sql">,
      // @ts-expect-error: a family with no dialect-bound member takes no `dialect`.
      { dialect: { profileComposition: "unsupported" } } as const satisfies AgentEngineServerOverlay<"mongo">,
      {
        dialect: { catalogRead: "unsupported", planEstimate: "unsupported", profileComposition: "unsupported" },
        // @ts-expect-error: a Shared member is not overridable from an engine overlay (ruling 2).
        grounding: {},
      } as const satisfies AgentEngineServerOverlay<"sql">,
    ];
    expect(fixtures).toHaveLength(8);
  });

  test("refuse a registry that misses an engine", () => {
    const sql = {
      dialect: { catalogRead: "unsupported", planEstimate: "unsupported", profileComposition: "unsupported" },
    } as const;
    // @ts-expect-error: the registry is total over the engines that speak a statement language, mysql included.
    const missing: AgentEngineServerOverlays = {
      postgres: sql,
      sqlite: sql,
      duckdb: sql,
      mssql: sql,
      mongodb: {},
      kubernetes: {},
    };
    expect(Object.keys(missing)).not.toContain("mysql");
  });

  test("refuse a bare function where a function-valued member can only be derived", () => {
    // @ts-expect-error: a function in an overlay is a derivation from the base, so a bare canonicalize does not type.
    const bare: MemberOverride<AgentLanguageServerAdapter["canonicalize"]> = (raw: unknown) => String(raw);
    const derived: MemberOverride<AgentLanguageServerAdapter["canonicalize"]> = (base) => (raw) => base(raw);
    expect([typeof bare, typeof derived]).toEqual(["function", "function"]);
  });

  test("have one row per family and no default branch", () => {
    type Widened = AgentStatementLanguageId | "cypher";
    // @ts-expect-error: a fourth language has no row until one is written for it.
    type Fourth = AgentFamilyDialect["cypher" & Widened];
    const rows: readonly (keyof AgentFamilyDialect)[] = ["sql", "mongo", "kubectl"];
    const fourth: Fourth | undefined = undefined;
    expect([rows.length, fourth]).toEqual([3, undefined]);
  });

  test("accept 'unsupported' for every member, and a dialect laid over a family facet", () => {
    const unsupported = {
      dialect: { catalogRead: "unsupported", planEstimate: "unsupported", profileComposition: "unsupported" },
    } as const satisfies AgentEngineServerOverlay<"sql">;
    const overlaid = defineOverlay(SQL_SERVER_PACK, { dialect: unsupported.dialect });
    expect(overlaid.dialect).toBe(unsupported.dialect);
    expect(overlaid.adapter).toBe(SQL_SERVER_PACK.adapter);
  });
});
