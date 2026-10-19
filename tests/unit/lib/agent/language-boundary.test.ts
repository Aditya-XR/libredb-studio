/**
 * The language boundary of the agent core (issue #1821, PR 1): the core names no statement language a pack owns, and
 * the packs load in tiers that cannot form an import cycle.
 *
 * R1 and R2 hold every `.ts` and `.tsx` file under `src/lib/agent/` except `src/lib/agent/languages/**`. The pack ids
 * they look for are the keys of `AGENT_LANGUAGE_COPY` other than `sql`, whose rule is PR 3's, so a fourth pack is
 * covered the day it lands. Only AST nodes are visited, so a comment never counts.
 *
 * - R1a: a string literal, no-substitution template or literal type whose whole text is a pack id.
 * - R1b: a property named by a pack id: an assignment, a shorthand, a signature, a `.x` access or an `["x"]` access.
 * - R1c: any other identifier that contains a pack id, in any case, except an engine's own name (`mongodb` as a key of
 *   `AGENT_STATEMENT_LANGUAGE`): engine names are the `DatabaseType` rule's, which is PR 3's.
 * - R1d: a string or template part that names a MongoDB plan stage (`COLLSCAN`, `IXSCAN`).
 * - R1e: a string literal or literal type that starts with a pack id and a separator, or ends in `-<id>.<n>`: an
 *   operation id, a verifier id or a fingerprint prefix.
 * - R2: an import of a module under `languages/` other than the shared entries: `pack.ts`, `client.ts`, `server.ts`,
 *   `index.ts`, `verifiers.ts`, `refusals.ts` and `engines/{client,server,index}.ts`, matched by full path.
 * - R3: the tiers, each finding the first forbidden module a chain meets, not every module past it. The server modules never reach the execution tier; the client packs never reach a server module, an
 *   execution module or a `node:`/`bun:` builtin; the language verifiers and `goal-claims.ts` never reach
 *   `goal-verifier.ts`; `goal-verifier.ts`, `goal-claims.ts` and every verifier module never reach `tools.ts` or a
 *   server, adapter or definitions module; and no runtime cycle among the agent modules passes through `languages/` or
 *   a shared module. A dynamic `import("x")` or `require("x")` with a literal specifier counts as an import, for R2
 *   and R3 alike.
 * - R6: every `*_SERVER_OVERLAY` and `*_CLIENT_OVERLAY` an engine module under `languages/<family>/engines/` exports is
 *   declared `satisfies` its overlay type, `AgentEngineServerOverlay<...>`, `AgentEngineClientOverlay<...>` or
 *   `{ dialect: ClientDialectOf<...> }`, so the excess-property check holds every overlay to its family's dialect.
 * - R4: the allowlist is exact. A key found more often than it is listed fails, and so does a listed key found less
 *   often, so the list can only shrink.
 *
 * A finding is `${file}#${innermost named declaration}: ${rule} ${text}`, where the declaration is the innermost
 * function, method, class, variable, type alias or interface around the node, or `<module>` at the top level. Every
 * rule is proven both ways: the real sources pass, and a violation planted in a copy of a real file's text yields
 * exactly the findings it should.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { AGENT_LANGUAGE_COPY, AGENT_STATEMENT_LANGUAGE } from "@/lib/agent/agent-manifest";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const AGENT = "src/lib/agent";
const LANGUAGES = `${AGENT}/languages`;

const PACK_IDS = Object.keys(AGENT_LANGUAGE_COPY).filter((id) => id !== "sql");
const IDS = PACK_IDS.join("|");
const WHOLE_ID = new RegExp(`^(${IDS})$`);
const ANY_ID = new RegExp(IDS, "i");
/** The engine names, the keys of the one total `DatabaseType` map. */
const ENGINE_IDS = new Set(Object.keys(AGENT_STATEMENT_LANGUAGE));
const PLAN_STAGE = /COLLSCAN|IXSCAN/;
const COMPOUND_ID = [new RegExp(`^(${IDS})[.:-]`), new RegExp(`-(${IDS})\\.\\d+$`)];

/** The shared entries of `languages/` the core may import; every other module there belongs to one pack. */
const SHARED_ENTRIES = new Set(
  [
    "pack.ts",
    "client.ts",
    "server.ts",
    "index.ts",
    "verifiers.ts",
    "refusals.ts",
    "engines/client.ts",
    "engines/server.ts",
    "engines/index.ts",
  ].map((name) => `${LANGUAGES}/${name}`),
);

/**
 * The findings the core keeps on purpose, each an exact count. Every one is persisted or the spec's own map: the id
 * union `AGENT_STATEMENT_LANGUAGE` maps onto, that total map itself, and the operation and verifier ids the ledgers in
 * `tests/fixtures/agent/*.ndjson` hold.
 */
const ALLOWLIST: Readonly<Record<string, number>> = Object.freeze({
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "kubectl"`]: 1,
  [`${AGENT}/agent-manifest.ts#AgentStatementLanguageId: R1a "mongo"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "mongo"`]: 1,
  [`${AGENT}/agent-manifest.ts#AGENT_STATEMENT_LANGUAGE: R1a "kubectl"`]: 1,
  [`${AGENT}/tools.ts#AgentOperationId: R1e "kubectl.query.read"`]: 1,
  [`${AGENT}/tools.ts#AgentOperationId: R1e "mongo.query.read"`]: 1,
  [`${AGENT}/tools.ts#AgentOperationId: R1e "mongo.schema.read"`]: 1,
  [`${AGENT}/tools.ts#AgentOperationId: R1e "mongo.plan.estimate"`]: 1,
  [`${AGENT}/tools.ts#AgentOperationId: R1e "mongo.table.profile"`]: 1,
  [`${AGENT}/goal-verifier.ts#AgentGoalVerifierId: R1e "agent-query-optimization-kubectl.1"`]: 1,
  [`${AGENT}/goal-verifier.ts#AgentGoalVerifierId: R1e "agent-database-assessment-kubectl.1"`]: 1,
  [`${AGENT}/goal-verifier.ts#AgentGoalVerifierId: R1e "agent-query-optimization-mongo.1"`]: 1,
});

/** Declarations too wide to key an allowlist entry on: one entry would excuse a whole run loop or file. */
const TOO_WIDE = new Set(["runInvestigation", "<module>"]);

const canonical = (path: string): string => realpathSync.native(path).split("\\").join("/");
const ROOT_PATH = canonical(ROOT);

let compilerOptions: ts.CompilerOptions | undefined;

/** A repository file a specifier names, as TypeScript resolves it, or `package:<name>` for anything else. */
function resolve(specifier: string, file: string): string {
  if (compilerOptions === undefined) {
    const config = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
    compilerOptions = ts.parseJsonConfigFileContent(config, ts.sys, ROOT).options;
  }
  const resolution = ts.resolveModuleName(specifier, join(ROOT, file), compilerOptions, ts.sys).resolvedModule;
  if (resolution !== undefined && resolution.isExternalLibraryImport !== true) {
    return canonical(resolution.resolvedFileName).slice(ROOT_PATH.length + 1);
  }
  return `package:${specifier}`;
}

const parse = (file: string, text: string): ts.SourceFile =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : undefined);

/** Every `import("x")` and `require("x")` with a literal specifier, anywhere in the file, as written. */
function dynamicSpecifiers(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Every static `import` and `export ... from` specifier, type-only ones included, and every dynamic one, as written. */
function importSpecifiers(source: ts.SourceFile): string[] {
  const found = dynamicSpecifiers(source);
  for (const statement of source.statements) {
    if (
      (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

/** The specifiers a file loads at run time: value imports, value re-exports, side-effect imports and dynamic loads. */
function runtimeSpecifiers(source: ts.SourceFile): string[] {
  const found = dynamicSpecifiers(source);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.length > 0 &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (!onlyTypes) found.push(statement.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(statement) &&
      !statement.isTypeOnly &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      found.push(statement.moduleSpecifier.text);
    }
  }
  return found;
}

function sourcesUnder(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    const path = `${directory}/${entry}`;
    if (statSync(join(ROOT, path)).isDirectory()) files.push(...sourcesUnder(path));
    else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) files.push(path);
  }
  return files.sort();
}

type Planted = Readonly<Record<string, string>>;
const read = (file: string): string => readFileSync(join(ROOT, file), "utf8");
const textOf = (file: string, planted: Planted): string => planted[file] ?? read(file);

/** The name of the innermost function, method, class, variable, type alias or interface around `node`. */
function declarationOf(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (
      (ts.isFunctionDeclaration(at) ||
        ts.isMethodDeclaration(at) ||
        ts.isClassDeclaration(at) ||
        ts.isVariableDeclaration(at) ||
        ts.isTypeAliasDeclaration(at) ||
        ts.isInterfaceDeclaration(at)) &&
      at.name !== undefined &&
      (ts.isIdentifier(at.name) || ts.isStringLiteral(at.name))
    ) {
      return at.name.text;
    }
  }
  return "<module>";
}

/** True when `node` is the name of a property: an assignment, a shorthand, a signature, or a `.x` / `["x"]` access. */
function isPropertyName(node: ts.Node): boolean {
  const parent = node.parent;
  return (
    ((ts.isPropertyAssignment(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isMethodDeclaration(parent)) &&
      parent.name === node) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isElementAccessExpression(parent) && parent.argumentExpression === node)
  );
}

/** R1 and R2 over one core file: every finding, once per occurrence. */
function coreFileFindings(file: string, text: string): string[] {
  const source = parse(file, text);
  const findings: string[] = [];
  const add = (node: ts.Node, rule: string, detail: string): void => {
    findings.push(`${file}#${declarationOf(node)}: ${rule} ${detail}`);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const literal = JSON.stringify(node.text);
      const isSpecifier = ts.isImportDeclaration(node.parent) || ts.isExportDeclaration(node.parent);
      if (!isSpecifier && WHOLE_ID.test(node.text)) add(node, isPropertyName(node) ? "R1b" : "R1a", literal);
      if (!isSpecifier && COMPOUND_ID.some((pattern) => pattern.test(node.text))) add(node, "R1e", literal);
    }
    if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) {
      if (PLAN_STAGE.test(node.text)) add(node, "R1d", JSON.stringify(node.text));
    }
    if (ts.isIdentifier(node)) {
      if (WHOLE_ID.test(node.text) && isPropertyName(node)) add(node, "R1b", node.text);
      else if (ANY_ID.test(node.text) && !ENGINE_IDS.has(node.text)) add(node, "R1c", node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  for (const specifier of importSpecifiers(source)) {
    const target = resolve(specifier, file);
    if (target.startsWith(`${LANGUAGES}/`) && !SHARED_ENTRIES.has(target)) {
      findings.push(`${file}#<module>: R2 ${target}`);
    }
  }
  return findings;
}

/** The core files: every agent module outside `languages/`. */
const coreFiles = (): string[] => sourcesUnder(AGENT).filter((file) => !file.startsWith(`${LANGUAGES}/`));

/** R1 and R2 checked against the allowlist (R4): every finding it does not excuse, and every stale entry. */
function boundaryFindings(planted: Planted = {}): string[] {
  const counts = new Map<string, number>();
  for (const file of coreFiles()) {
    for (const finding of coreFileFindings(file, textOf(file, planted))) {
      counts.set(finding, (counts.get(finding) ?? 0) + 1);
    }
  }
  const findings: string[] = [];
  for (const [finding, found] of counts) {
    const allowed = ALLOWLIST[finding] ?? 0;
    if (allowed === 0) for (let n = 0; n < found; n++) findings.push(finding);
    else if (found > allowed) findings.push(`R4 surplus: ${finding} (found ${found}, allowed ${allowed})`);
  }
  for (const [finding, allowed] of Object.entries(ALLOWLIST)) {
    const found = counts.get(finding) ?? 0;
    if (found < allowed) findings.push(`R4 stale: ${finding} (found ${found}, allowed ${allowed})`);
  }
  return findings.sort();
}

/** One file's runtime imports, resolved. */
function edges(file: string, planted: Planted): string[] {
  return runtimeSpecifiers(parse(file, textOf(file, planted))).map((specifier) => resolve(specifier, file));
}

/** What `start` reaches through runtime imports anywhere in the repository, each with the chain that reaches it. */
function reach(start: string, planted: Planted): Map<string, string[]> {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (file.startsWith("package:") || !/\.tsx?$/.test(file) || file.endsWith(".d.ts")) continue;
    for (const target of edges(file, planted)) {
      if (chains.has(target)) continue;
      chains.set(target, [...(chains.get(file) as string[]), target]);
      queue.push(target);
    }
  }
  return chains;
}

/** An engine's server overlay: every module under a family's `engines/` but its client overlays. */
const isEngineServerModule = (file: string): boolean =>
  new RegExp(`^${LANGUAGES}/[^/]+/engines/(?!client\\.ts$)[^/]+\\.ts$`).test(file);
const SERVER_SIDE = [
  `${AGENT}/tools.ts`,
  `${AGENT}/goal-verifier.ts`,
  `${AGENT}/tool-contracts.ts`,
  `${AGENT}/goal-claims.ts`,
  `${AGENT}/composed-sql.ts`,
  `${AGENT}/table-profile.ts`,
  `${AGENT}/schema-stats.ts`,
  `${AGENT}/context-snapshot.ts`,
  `${LANGUAGES}/server.ts`,
  `${LANGUAGES}/verifiers.ts`,
  `${LANGUAGES}/engines/server.ts`,
];
const isExecution = (file: string): boolean =>
  file === `${LANGUAGES}/index.ts` || new RegExp(`^${LANGUAGES}/[^/]+/(index|tools)\\.ts$`).test(file);
/** What the verifiers never load: the server facet and the tool runtime, so verifying a goal loads no adapter. */
const isServerFacet = (file: string): boolean =>
  file === `${AGENT}/tools.ts` ||
  file === `${LANGUAGES}/server.ts` ||
  file === `${LANGUAGES}/engines/server.ts` ||
  isEngineServerModule(file) ||
  new RegExp(`^${LANGUAGES}/[^/]+/(adapter|server|definitions)\\.ts$`).test(file);
const CLIENT_FORBIDDEN = new Set([
  `${AGENT}/tools.ts`,
  `${AGENT}/investigation.ts`,
  `${AGENT}/goal-verifier.ts`,
  `${AGENT}/composed-sql.ts`,
  `${AGENT}/composed-sql-primitives.ts`,
  `${AGENT}/table-profile.ts`,
  `${AGENT}/schema-stats.ts`,
  `${AGENT}/context-snapshot.ts`,
  `${AGENT}/catalog-rows.ts`,
  `${LANGUAGES}/server.ts`,
  `${LANGUAGES}/index.ts`,
  `${LANGUAGES}/engines/server.ts`,
  `${LANGUAGES}/engines/index.ts`,
]);
const isClientForbidden = (file: string): boolean =>
  CLIENT_FORBIDDEN.has(file) ||
  isEngineServerModule(file) ||
  file.startsWith("package:node:") ||
  file.startsWith("package:bun:");
const SHARED_MODULES = new Set(
  [
    "tool-contracts.ts",
    "goal-claims.ts",
    "workflow-tool-sets.ts",
    "disjoint-merge.ts",
    "composed-sql-primitives.ts",
    "catalog-rows.ts",
  ].map((name) => `${AGENT}/${name}`),
);

/** The runtime import graph among the agent modules, `languages/**` included. */
function agentGraph(planted: Planted): Map<string, string[]> {
  const files = sourcesUnder(AGENT);
  const inside = new Set(files);
  return new Map(
    files.map((file) => [file, [...new Set(edges(file, planted))].filter((target) => inside.has(target))]),
  );
}

/** The shortest runtime cycle through `start`, or undefined. */
function shortestCycle(graph: Map<string, string[]>, start: string): string[] | undefined {
  const chains = new Map<string, string[]>([[start, [start]]]);
  const queue = [start];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    for (const target of graph.get(file) ?? []) {
      if (target === start) return chains.get(file) as string[];
      if (chains.has(target)) continue;
      chains.set(target, [...(chains.get(file) as string[]), target]);
      queue.push(target);
    }
  }
  return undefined;
}

/** A cycle written from its smallest module, so the same cycle found from any of its modules reads the same. */
function cycleText(cycle: readonly string[]): string {
  const first = cycle.indexOf([...cycle].sort()[0] as string);
  const rotated = [...cycle.slice(first), ...cycle.slice(0, first)];
  return [...rotated, rotated[0]].join(" -> ");
}

/** R3 over the agent modules. */
function layeringFindings(planted: Planted = {}): string[] {
  const findings = new Set<string>();
  const forbid = (from: string, forbidden: (file: string) => boolean, bullet: string): void => {
    for (const [target, chain] of reach(from, planted)) {
      if (forbidden(target) && !chain.slice(0, -1).some(forbidden))
        findings.add(`R3 ${bullet}: ${from} reaches ${target} through ${chain.join(" -> ")}`);
    }
  };
  const files = sourcesUnder(AGENT);
  for (const file of [...SERVER_SIDE, ...files.filter(isEngineServerModule)]) forbid(file, isExecution, "server");
  for (const file of files.filter((path) => new RegExp(`^${LANGUAGES}/(.+/)?client\\.ts$`).test(path))) {
    forbid(file, isClientForbidden, "client");
  }
  for (const file of [
    ...files.filter((path) => new RegExp(`^${LANGUAGES}/[^/]+/verifiers\\.ts$`).test(path)),
    `${AGENT}/goal-claims.ts`,
  ]) {
    forbid(file, (target) => target === `${AGENT}/goal-verifier.ts`, "verifier");
  }
  for (const file of [
    `${AGENT}/goal-verifier.ts`,
    `${AGENT}/goal-claims.ts`,
    ...files.filter((path) => new RegExp(`^${LANGUAGES}/([^/]+/)?verifiers\\.ts$`).test(path)),
  ]) {
    forbid(file, isServerFacet, "verifier");
  }
  const graph = agentGraph(planted);
  for (const file of files.filter((path) => path.startsWith(`${LANGUAGES}/`) || SHARED_MODULES.has(path))) {
    const cycle = shortestCycle(graph, file);
    if (cycle !== undefined) findings.add(`R3 cycle: ${cycleText(cycle)}`);
  }
  return [...findings].sort();
}

/** `text` with `code` inserted at the top of the body of the function `name`. */
function plantInFunction(file: string, name: string, code: string): Planted {
  const text = read(file);
  let at: number | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body !== undefined) {
      at = node.body.getStart() + 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  if (at === undefined) throw new Error(`no function ${name} in ${file}`);
  return { [file]: `${text.slice(0, at)}\n${code}\n${text.slice(at)}` };
}

/** `text` with `member` added to the union of the type alias `name`. */
function plantInTypeAlias(file: string, name: string, member: string): Planted {
  const text = read(file);
  const alias = parse(file, text).statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
  if (alias === undefined) throw new Error(`no type ${name} in ${file}`);
  return { [file]: `${text.slice(0, alias.type.end)} | ${member}${text.slice(alias.type.end)}` };
}

const prepend = (file: string, code: string): Planted => ({ [file]: `${code}\n${read(file)}` });

/** The overlay types an engine overlay may be declared `satisfies`, as written. */
const OVERLAY_TYPE = /^(AgentEngine(Server|Client)Overlay<[\s\S]+>|\{\s*dialect: ClientDialectOf<[\s\S]+>;?\s*\})$/;

/** R6 over every engine module: each exported overlay that is not declared `satisfies` its overlay type. */
function overlayShapeFindings(planted: Planted = {}): string[] {
  const findings: string[] = [];
  const modules = sourcesUnder(LANGUAGES).filter((file) => new RegExp(`^${LANGUAGES}/[^/]+/engines/`).test(file));
  for (const file of modules) {
    const source = parse(file, textOf(file, planted));
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(source);
        if (!/_(SERVER|CLIENT)_OVERLAY$/.test(name)) continue;
        const initializer = declaration.initializer;
        const shaped =
          initializer !== undefined &&
          ts.isSatisfiesExpression(initializer) &&
          OVERLAY_TYPE.test(initializer.type.getText(source));
        if (!shaped) findings.push(`${file}#${name}: R6`);
      }
    }
  }
  return findings.sort();
}

describe("the agent core names no language a pack owns", () => {
  test("the pack ids come from the manifest", () => {
    expect(PACK_IDS).toEqual(["kubectl", "mongo"]);
  });

  test("the real core sources yield exactly the allowlisted findings", () => {
    expect(boundaryFindings()).toEqual([]);
  });

  test("the scan reads real code: the core holds every allowlisted finding, and the packs hold many more", () => {
    const core = coreFiles().flatMap((file) => coreFileFindings(file, read(file)));
    expect(core.sort()).toEqual(Object.keys(ALLOWLIST).sort());
    const packs = sourcesUnder(LANGUAGES).flatMap((file) => coreFileFindings(file, read(file)));
    expect(packs.length).toBeGreaterThan(100);
  });

  test("no allowlist entry is keyed on a declaration too wide to excuse one finding", () => {
    const wide = Object.keys(ALLOWLIST).filter((key) =>
      TOO_WIDE.has(key.slice(key.indexOf("#") + 1, key.indexOf(":"))),
    );
    expect(wide).toEqual([]);
  });
});

// A test that walks the import graph of the whole repository (these two and the tier plants below) takes
// about a second alone under coverage and exceeded the default 5 s in a loaded coverage run, so each gets the
// seam guard's 60 s budget.
describe("the language modules load in tiers", () => {
  test("the real sources hold every tier, and no cycle passes through a pack or a shared module", () => {
    expect(layeringFindings()).toEqual([]);
  }, 60_000);

  test("the walk reads real code: the graph holds pack modules, and the execution tier reaches the core", () => {
    const graph = agentGraph({});
    expect([...graph.keys()].some((file) => new RegExp(`^${LANGUAGES}/[^/]+/`).test(file))).toBe(true);
    expect(reach(`${LANGUAGES}/index.ts`, {}).has(`${AGENT}/tools.ts`)).toBe(true);
    expect(reach(`${AGENT}/agent-manifest.ts`, {}).has(`${LANGUAGES}/kubectl/client.ts`)).toBe(true);
    // The pre-existing `tools.ts` <-> `context-snapshot.ts` cycle passes through no pack, so R3 does not report it.
    expect(cycleText(shortestCycle(graph, `${AGENT}/tools.ts`) as string[])).toBe(
      `${AGENT}/context-snapshot.ts -> ${AGENT}/tools.ts -> ${AGENT}/context-snapshot.ts`,
    );
  }, 60_000);
});

describe("every engine overlay is declared satisfies its overlay type", () => {
  test("the real engine modules hold R6, and the scan reads every overlay they export", () => {
    expect(overlayShapeFindings()).toEqual([]);
    const exported = sourcesUnder(LANGUAGES)
      .filter((file) => new RegExp(`^${LANGUAGES}/[^/]+/engines/`).test(file))
      .flatMap((file) => Array.from(read(file).matchAll(/^export const (\w+_(SERVER|CLIENT)_OVERLAY)\b/gm)));
    expect(exported).toHaveLength(14);
  });

  test("an overlay that drops its satisfies fails R6", () => {
    const duckdb = `${LANGUAGES}/sql/engines/duckdb.ts`;
    const text = read(duckdb);
    const planted = { [duckdb]: text.replace(' as const satisfies AgentEngineServerOverlay<"sql">', "") };
    expect(planted[duckdb]).not.toBe(text);
    expect(overlayShapeFindings(planted)).toEqual([`${duckdb}#DUCKDB_SERVER_OVERLAY: R6`]);
  });

  test("an overlay declared satisfies another type fails R6", () => {
    const client = `${LANGUAGES}/mongo/engines/client.ts`;
    const text = read(client);
    const planted = { [client]: text.replace('satisfies AgentEngineClientOverlay<"mongo">', "satisfies object") };
    expect(overlayShapeFindings(planted)).toEqual([`${client}#MONGODB_CLIENT_OVERLAY: R6`]);
  });
});

describe("planted violations yield exactly their findings", () => {
  const TOOLS = `${AGENT}/tools.ts`;
  const INVESTIGATION = `${AGENT}/investigation.ts`;
  const GOAL_VERIFIER = `${AGENT}/goal-verifier.ts`;

  test("a pack id compared as a string fails R1a", () => {
    expect(boundaryFindings(plantInFunction(TOOLS, "agentToolDefinition", 'if (language === "mongo") {}'))).toEqual([
      `${TOOLS}#agentToolDefinition: R1a "mongo"`,
    ]);
  });

  test("a pack id as a property name fails R1b", () => {
    expect(boundaryFindings(plantInFunction(INVESTIGATION, "workflowToolRules", "const x = { kubectl: 1 };"))).toEqual([
      `${INVESTIGATION}#x: R1b kubectl`,
    ]);
  });

  test("a pack's tool imported by a named binding fails R1c and R2", () => {
    const planted = prepend(INVESTIGATION, 'import { mongoInspectPlanTool } from "./languages/mongo/tools";');
    expect(boundaryFindings(planted)).toEqual([
      `${INVESTIGATION}#<module>: R1c mongoInspectPlanTool`,
      `${INVESTIGATION}#<module>: R2 ${LANGUAGES}/mongo/tools.ts`,
    ]);
  });

  test("a pack's server module imported under a neutral name fails R2 alone", () => {
    const planted = prepend(INVESTIGATION, 'import * as pack from "./languages/mongo/server";');
    expect(boundaryFindings(planted)).toEqual([`${INVESTIGATION}#<module>: R2 ${LANGUAGES}/mongo/server.ts`]);
  });

  test("a pack module loaded by a dynamic import or a require fails R2", () => {
    const dynamic = plantInFunction(INVESTIGATION, "workflowToolRules", 'void import("./languages/mongo/tools");');
    expect(boundaryFindings(dynamic)).toEqual([`${INVESTIGATION}#<module>: R2 ${LANGUAGES}/mongo/tools.ts`]);
    const required = plantInFunction(
      INVESTIGATION,
      "workflowToolRules",
      'void require("./languages/kubectl/adapter");',
    );
    expect(boundaryFindings(required)).toEqual([`${INVESTIGATION}#<module>: R2 ${LANGUAGES}/kubectl/adapter.ts`]);
  });

  test("a MongoDB plan stage in a sentence fails R1d", () => {
    const planted = plantInFunction(GOAL_VERIFIER, "goalFor", 'void "the plan reads a COLLSCAN";');
    expect(boundaryFindings(planted)).toEqual([`${GOAL_VERIFIER}#goalFor: R1d "the plan reads a COLLSCAN"`]);
  });

  test("an operation id outside its union fails R1e", () => {
    const planted = plantInFunction(TOOLS, "runReadQueryTool", 'if (operation === "mongo.plan.estimate") {}');
    expect(boundaryFindings(planted)).toEqual([`${TOOLS}#runReadQueryTool: R1e "mongo.plan.estimate"`]);
  });

  test("an allowlisted id written twice fails R4 as a surplus, and one removed fails it as stale", () => {
    const id = '"agent-query-optimization-kubectl.1"';
    const key = `${GOAL_VERIFIER}#AgentGoalVerifierId: R1e ${id}`;
    expect(boundaryFindings(plantInTypeAlias(GOAL_VERIFIER, "AgentGoalVerifierId", id))).toEqual([
      `R4 surplus: ${key} (found 2, allowed 1)`,
    ]);
    const text = read(GOAL_VERIFIER);
    const removed = { [GOAL_VERIFIER]: text.replace(`| ${id}`, "").replace(id, '"agent-renamed.1"') };
    expect(boundaryFindings(removed)).toEqual([`R4 stale: ${key} (found 0, allowed 1)`]);
  });

  test("the execution tier imported by tools.ts fails the server tier and closes a cycle through every pack", () => {
    const planted = prepend(TOOLS, 'import { agentLanguagePack } from "./languages";');
    const index = `${LANGUAGES}/index.ts`;
    expect(layeringFindings(planted)).toEqual([
      `R3 cycle: ${index} -> ${LANGUAGES}/kubectl/index.ts -> ${LANGUAGES}/kubectl/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/mongo/index.ts -> ${LANGUAGES}/mongo/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/sql/index.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/context-snapshot.ts reaches ${index} through ${AGENT}/context-snapshot.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/schema-stats.ts reaches ${index} through ${AGENT}/schema-stats.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${TOOLS} reaches ${index} through ${TOOLS} -> ${index}`,
    ]);
  }, 60_000);

  test("the execution tier loaded by a dynamic import in tools.ts fails the server tier and closes the same cycles", () => {
    const planted = plantInFunction(TOOLS, "agentToolDefinition", 'void import("./languages/index");');
    const index = `${LANGUAGES}/index.ts`;
    expect(layeringFindings(planted)).toEqual([
      `R3 cycle: ${index} -> ${LANGUAGES}/kubectl/index.ts -> ${LANGUAGES}/kubectl/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/mongo/index.ts -> ${LANGUAGES}/mongo/tools.ts -> ${TOOLS} -> ${index}`,
      `R3 cycle: ${index} -> ${LANGUAGES}/sql/index.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/context-snapshot.ts reaches ${index} through ${AGENT}/context-snapshot.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${AGENT}/schema-stats.ts reaches ${index} through ${AGENT}/schema-stats.ts -> ${TOOLS} -> ${index}`,
      `R3 server: ${TOOLS} reaches ${index} through ${TOOLS} -> ${index}`,
    ]);
  }, 60_000);

  test("tools.ts imported by a client pack fails the client tier", () => {
    const client = `${LANGUAGES}/kubectl/client.ts`;
    const planted = prepend(client, 'import { executeAgentOperation } from "../../tools";');
    const clients = `${LANGUAGES}/client.ts`;
    const engines = `${LANGUAGES}/engines/client.ts`;
    const manifest = `${AGENT}/agent-manifest.ts`;
    const claims = `${AGENT}/goal-claims.ts`;
    const toTools = `${manifest} -> ${clients} -> ${client} -> ${TOOLS}`;
    // The manifest loads the client packs, and the verifiers load the manifest, so the verifier closure fails too.
    expect(layeringFindings(planted)).toEqual([
      `R3 client: ${clients} reaches ${TOOLS} through ${clients} -> ${client} -> ${TOOLS}`,
      `R3 client: ${engines} reaches ${TOOLS} through ${engines} -> ${clients} -> ${client} -> ${TOOLS}`,
      `R3 client: ${client} reaches ${TOOLS} through ${client} -> ${TOOLS}`,
      `R3 cycle: ${manifest} -> ${clients} -> ${client} -> ${TOOLS} -> ${manifest}`,
      `R3 verifier: ${claims} reaches ${TOOLS} through ${claims} -> ${toTools}`,
      `R3 verifier: ${GOAL_VERIFIER} reaches ${TOOLS} through ${GOAL_VERIFIER} -> ${toTools}`,
      `R3 verifier: ${LANGUAGES}/kubectl/verifiers.ts reaches ${TOOLS} through ${LANGUAGES}/kubectl/verifiers.ts -> ${claims} -> ${toTools}`,
      `R3 verifier: ${LANGUAGES}/mongo/verifiers.ts reaches ${TOOLS} through ${LANGUAGES}/mongo/verifiers.ts -> ${claims} -> ${toTools}`,
      `R3 verifier: ${LANGUAGES}/verifiers.ts reaches ${TOOLS} through ${LANGUAGES}/verifiers.ts -> ${LANGUAGES}/kubectl/verifiers.ts -> ${claims} -> ${toTools}`,
    ]);
  }, 60_000);

  test("a builtin imported by a client pack fails the client tier", () => {
    const client = `${LANGUAGES}/sql/client.ts`;
    const clients = `${LANGUAGES}/client.ts`;
    const engines = `${LANGUAGES}/engines/client.ts`;
    expect(layeringFindings(prepend(client, 'import "node:fs";'))).toEqual([
      `R3 client: ${clients} reaches package:node:fs through ${clients} -> ${client} -> package:node:fs`,
      `R3 client: ${engines} reaches package:node:fs through ${engines} -> ${clients} -> ${client} -> package:node:fs`,
      `R3 client: ${client} reaches package:node:fs through ${client} -> package:node:fs`,
    ]);
  }, 60_000);

  test("goal-verifier.ts imported at run time by a language verifier fails the verifier tier and closes a cycle", () => {
    const verifiers = `${LANGUAGES}/mongo/verifiers.ts`;
    const planted = prepend(verifiers, 'import "../../goal-verifier";');
    expect(layeringFindings(planted)).toEqual([
      `R3 cycle: ${GOAL_VERIFIER} -> ${LANGUAGES}/verifiers.ts -> ${verifiers} -> ${GOAL_VERIFIER}`,
      `R3 verifier: ${verifiers} reaches ${GOAL_VERIFIER} through ${verifiers} -> ${GOAL_VERIFIER}`,
    ]);
    // A type-only import loads nothing.
    expect(layeringFindings(prepend(verifiers, 'import type { AgentGoalRule } from "../pack";'))).toEqual([]);
  }, 60_000);

  test("tools.ts imported at run time by a language verifier fails the verifier closure", () => {
    const verifiers = `${LANGUAGES}/mongo/verifiers.ts`;
    const all = `${LANGUAGES}/verifiers.ts`;
    const planted = prepend(verifiers, 'import "../../tools";');
    expect(layeringFindings(planted)).toEqual([
      `R3 verifier: ${GOAL_VERIFIER} reaches ${TOOLS} through ${GOAL_VERIFIER} -> ${all} -> ${verifiers} -> ${TOOLS}`,
      `R3 verifier: ${verifiers} reaches ${TOOLS} through ${verifiers} -> ${TOOLS}`,
      `R3 verifier: ${all} reaches ${TOOLS} through ${all} -> ${verifiers} -> ${TOOLS}`,
    ]);
  }, 60_000);

  test("an engine module imported by the core fails R2", () => {
    const posture = `${AGENT}/posture.ts`;
    const planted = prepend(posture, 'import { POSTGRES_SERVER_OVERLAY } from "./languages/sql/engines/postgres";');
    expect(boundaryFindings(planted)).toEqual([`${posture}#<module>: R2 ${LANGUAGES}/sql/engines/postgres.ts`]);
  });

  test("the engine server resolver imported by a client overlay fails the client tier", () => {
    const client = `${LANGUAGES}/sql/engines/client.ts`;
    const engines = `${LANGUAGES}/engines/client.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    expect(layeringFindings(prepend(client, 'import "../../engines/server";'))).toEqual([
      `R3 client: ${engines} reaches ${server} through ${engines} -> ${client} -> ${server}`,
      `R3 client: ${client} reaches ${server} through ${client} -> ${server}`,
    ]);
  }, 60_000);

  test("the execution tier imported by an engine server overlay fails the server tier and closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const index = `${LANGUAGES}/sql/index.ts`;
    const profile = `${AGENT}/table-profile.ts`;
    const composed = `${AGENT}/composed-sql.ts`;
    const toIndex = `${server} -> ${postgres} -> ${index}`;
    expect(layeringFindings(prepend(postgres, 'import "../index";'))).toEqual([
      `R3 cycle: ${server} -> ${postgres} -> ${index} -> ${TOOLS} -> ${server}`,
      `R3 server: ${composed} reaches ${index} through ${composed} -> ${toIndex}`,
      `R3 server: ${AGENT}/context-snapshot.ts reaches ${index} through ${AGENT}/context-snapshot.ts -> ${TOOLS} -> ${toIndex}`,
      `R3 server: ${server} reaches ${index} through ${toIndex}`,
      `R3 server: ${postgres} reaches ${index} through ${postgres} -> ${index}`,
      `R3 server: ${AGENT}/schema-stats.ts reaches ${index} through ${AGENT}/schema-stats.ts -> ${composed} -> ${toIndex}`,
      `R3 server: ${profile} reaches ${index} through ${profile} -> ${toIndex}`,
      `R3 server: ${TOOLS} reaches ${index} through ${TOOLS} -> ${toIndex}`,
    ]);
  }, 60_000);

  test("a core reader of the resolver imported at run time by an engine overlay closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const profile = `${AGENT}/table-profile.ts`;
    expect(layeringFindings(prepend(postgres, 'import "../../../table-profile";'))).toEqual([
      `R3 cycle: ${server} -> ${postgres} -> ${profile} -> ${server}`,
    ]);
    // The overlays read the core through type-only imports, which load nothing.
    expect(read(postgres)).toContain('import type { AgentProfileComposition } from "../../../table-profile";');
  }, 60_000);

  test("the plan dispatcher imported at run time by an engine overlay closes a cycle", () => {
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    const server = `${LANGUAGES}/engines/server.ts`;
    const composed = `${AGENT}/composed-sql.ts`;
    expect(layeringFindings(prepend(postgres, 'import "../../../composed-sql";'))).toEqual([
      `R3 cycle: ${composed} -> ${server} -> ${postgres} -> ${composed}`,
    ]);
  }, 60_000);

  test("an engine server overlay imported by a language verifier fails the verifier closure", () => {
    const verifiers = `${LANGUAGES}/mongo/verifiers.ts`;
    const all = `${LANGUAGES}/verifiers.ts`;
    const postgres = `${LANGUAGES}/sql/engines/postgres.ts`;
    expect(layeringFindings(prepend(verifiers, 'import "../sql/engines/postgres";'))).toEqual([
      `R3 verifier: ${GOAL_VERIFIER} reaches ${postgres} through ${GOAL_VERIFIER} -> ${all} -> ${verifiers} -> ${postgres}`,
      `R3 verifier: ${verifiers} reaches ${postgres} through ${verifiers} -> ${postgres}`,
      `R3 verifier: ${all} reaches ${postgres} through ${all} -> ${verifiers} -> ${postgres}`,
    ]);
  }, 60_000);
});
