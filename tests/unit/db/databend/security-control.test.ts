/**
 * docs/SECURITY.md names the Databend provider's HTTP controls (design 8 C21, plan D15): row 0.6 gains the route
 * table, the transport and the connection options, with the tests that drive them, and note 0.6 says how a
 * `next_uri` link is followed. The egress row is the Databend entry of
 * `tests/unit/db/http/egress-policy-providers.test.ts`, which row 0.6 already links, so the address policy is proven
 * on this provider's own connect path. This test holds that every file and test the row cites is linked by its full
 * repository path and exists; scripts/security-check.mjs, run by tests/unit/security-check.test.ts, then proves every
 * linked test runs.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const SECURITY = readFileSync(path.join(ROOT, "docs/SECURITY.md"), "utf8");
const DIRECTORY = "src/lib/db/providers/sql/databend";
const TESTS = "tests/unit/db/databend";
const EGRESS_TEST = "tests/unit/db/http/egress-policy-providers.test.ts";

function controlRow(id: string): { status: string; control: string; enforcedIn: string; verifiedBy: string } {
  const row = SECURITY.split("\n").find((line) => line.startsWith(`| ${id} |`)) ?? "";
  const [, control = "", status = "", enforcedIn = "", verifiedBy = ""] = row.split(" | ");
  return { status, control, enforcedIn, verifiedBy };
}

function link(file: string): string {
  return `[\`${file}\`](../${file})`;
}

const ENFORCED_IN = [`${DIRECTORY}/routes.ts`, `${DIRECTORY}/http-transport.ts`, `${DIRECTORY}/connection-options.ts`];

const VERIFIED_BY = [
  `${TESTS}/routes.test.ts`,
  `${TESTS}/connection-options.test.ts`,
  `${TESTS}/http-transport-request.test.ts`,
  `${TESTS}/http-transport-links.test.ts`,
  `${TESTS}/wire.test.ts`,
  `${TESTS}/wire-tls.test.ts`,
  `${TESTS}/seam-guard.test.ts`,
  EGRESS_TEST,
];

describe("row 0.6 names the Databend transport", () => {
  const row = controlRow("0.6");

  test("is an implemented control", () => {
    expect(row.status).toBe("Implemented");
  });

  test.each(ENFORCED_IN)("is enforced in %s, which exists", (file) => {
    expect(row.enforcedIn).toContain(link(file));
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });

  test.each(VERIFIED_BY)("is verified by %s, which exists", (file) => {
    expect(row.verifiedBy).toContain(link(file));
    expect(existsSync(path.join(ROOT, file))).toBe(true);
  });
});

describe("the egress row", () => {
  test("the address policy census builds the Databend provider", () => {
    const source = readFileSync(path.join(ROOT, EGRESS_TEST), "utf8");
    expect(source).toContain('["Databend", "databend", DatabendProvider]');
  });
});

describe("note 0.6 states what the code does", () => {
  test("names the two next_uri shapes Databend's links are held to", () => {
    expect(SECURITY).toContain(
      "Databend's `next_uri` is followed only when it is exactly the page or final path of the statement Studio sent, rebuilt from Studio's own query id, so an absolute URL, even one on the same origin, is refused.",
    );
  });
});
