/**
 * Opt-in live guard for #795: does a real server still report column defaults the way the
 * provider's `CATALOG_DEFAULT_READING` says it does?
 *
 * It checks BOTH readings the provider publishes, because a column carries both. The value,
 * against `EXPECTED` below. And the SQL TEXT, by replaying each reported `COLUMN_DEFAULT`
 * back at the SAME server after the word `DEFAULT`: that is the reading the schema-diff
 * migration generator pastes, and `literal: "as-written"` is exactly the claim that it can
 * be pasted. Without the replay a server that stopped reporting pasteable SQL would leave
 * this script green.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The provider's reading rule is a claim
 * about what two ENGINES emit, and a mock answers whatever its author already thought of.
 * The first repair of this defect handled the doubled quote and not the escaping backslash,
 * and every mock in the suite agreed with it, because the same author wrote both.
 *
 * It reads `app.column_defaults`, which `docker/mysql-init/01-object-fixture.sql` and
 * `docker/mariadb-init/01-object-fixture.sql` create with one column per measured case. It
 * is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`).
 *
 *   LIBREDB_LIVE_MYSQL_URLS=mysql://root:pw@127.0.0.1:3306/app,mysql://root:pw@127.0.0.1:3307/app \
 *     bun tests/live/mysql-column-defaults.ts
 *
 * Point it at DISPOSABLE servers, and include one of each family: the whole point is that
 * they disagree.
 */
import mysql from "mysql2/promise";
import { unquoteLiteral } from "../../src/lib/sql/values";

/** What each column must resolve to, whichever server reports it. */
const EXPECTED: Readonly<Record<string, string | undefined>> = {
  def_absent: undefined,
  def_not_null: undefined,
  def_null_string: "NULL",
  def_text: "abc",
  def_empty: "",
  def_quote: "it's",
  def_backslash: "a\\b",
  def_newline: "a\nb",
  def_number: "42",
  def_generated: undefined,
};

/**
 * The provider's rule, spelled here because `catalogDefault` is private to the provider
 * module and this script must not become a second implementation of the DECODING. The
 * literal decoding, which is the part that was wrong, comes from the shipped function.
 */
function readDefault(raw: string | null, extra: string | null, flavour: "mysql" | "mariadb"): string | undefined {
  if (raw === null) return undefined;
  if (extra !== null && ["STORED GENERATED", "VIRTUAL GENERATED"].includes(extra.trim().toUpperCase()))
    return undefined;
  if (flavour === "mysql") return raw;
  if (raw === "NULL") return undefined;
  return unquoteLiteral(raw, "mysql") ?? raw;
}

function urls(): string[] {
  const raw = process.env.LIBREDB_LIVE_MYSQL_URLS;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_MYSQL_URLS to a comma-separated list of disposable MySQL-wire URLs. " +
        "Include a MySQL and a MariaDB: they do not report a column default the same way.",
    );
  }
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
}

/**
 * Replay every reported `COLUMN_DEFAULT` at the server that reported it.
 *
 * `CATALOG_DEFAULT_READING` claims `literal: "as-written"` for this flavour, which is the
 * claim that the catalog text is valid SQL HERE, and `ColumnSchema.defaultExpression`
 * carries it to the migration generator on that basis. The only honest test of "valid SQL
 * for this engine" is the engine: create a throwaway table whose one column takes the
 * reported text as its default, and let the server rule.
 *
 * The column type comes from `COLUMN_TYPE` and not `DATA_TYPE`: `DATA_TYPE` drops the
 * length, so `varchar` alone would fail the CREATE for a reason that has nothing to do with
 * the default.
 */
async function replayDefaults(
  conn: mysql.Connection,
  version: string,
  rows: readonly mysql.RowDataPacket[],
): Promise<string[]> {
  const failures: string[] = [];
  let ordinal = 0;
  for (const row of rows) {
    if (row.raw === null) continue;
    const name = String(row.name);
    const raw = String(row.raw);
    const columnType = String(row.columnType);
    const table = `libredb_default_replay_${process.pid}_${ordinal++}`;
    try {
      await conn.query(`CREATE TABLE \`${table}\` (c ${columnType} DEFAULT ${raw})`);
      console.log(`${name}: replayed, the server accepted DEFAULT ${raw}`);
    } catch (error) {
      failures.push(
        `${version}: ${name} reported COLUMN_DEFAULT ${JSON.stringify(raw)}, and the SAME server refused it ` +
          `after the word DEFAULT on a ${columnType} column: ${error instanceof Error ? error.message : String(error)}. ` +
          `CATALOG_DEFAULT_READING in src/lib/db/providers/sql/mysql.ts claims literal: "as-written" for this ` +
          `flavour, and the schema-diff migration generator pastes that text, so one of the two must change.`,
      );
    } finally {
      // Always, including on the failure path: a rejected CREATE leaves nothing, but a later
      // failure in this loop must not leave the earlier tables behind.
      await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    }
  }
  return failures;
}

async function probeServer(url: string): Promise<string[]> {
  const failures: string[] = [];
  const conn = await mysql.createConnection(url);
  try {
    const [versionRows] = await conn.query<mysql.RowDataPacket[]>("SELECT VERSION() AS version");
    const version = String(versionRows[0]?.version ?? "unknown");
    const flavour = /mariadb/i.test(version) ? "mariadb" : "mysql";
    console.log(`\n=== ${version} (read as ${flavour}) ===`);

    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME AS name, COLUMN_DEFAULT AS raw, EXTRA AS extra, COLUMN_TYPE AS columnType " +
        "FROM information_schema.COLUMNS " +
        "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'column_defaults' ORDER BY ORDINAL_POSITION",
    );
    // An empty answer would pass every assertion below, so it is a failure and not a pass.
    if (rows.length === 0) {
      failures.push(
        `${version}: app.column_defaults has no columns. Recreate the container: the init script only runs on a fresh data directory.`,
      );
      return failures;
    }

    for (const row of rows) {
      const name = String(row.name);
      const raw = row.raw === null ? null : String(row.raw);
      const extra = row.extra === null ? null : String(row.extra);
      console.log(
        `${name}: raw=${raw === null ? "SQL NULL" : JSON.stringify(raw)} extra=${JSON.stringify(extra ?? "")}`,
      );
      if (!(name in EXPECTED)) continue;
      const want = EXPECTED[name];
      const got = readDefault(raw, extra, flavour);
      if (got !== want) {
        failures.push(
          `${version}: ${name} read as ${JSON.stringify(got)}, expected ${JSON.stringify(want)}. ` +
            `Raw COLUMN_DEFAULT was ${raw === null ? "SQL NULL" : JSON.stringify(raw)}, EXTRA ${JSON.stringify(extra ?? "")}. ` +
            `Either the engine changed what it emits or CATALOG_DEFAULT_READING in src/lib/db/providers/sql/mysql.ts is wrong.`,
        );
      }
    }

    if (flavour === "mariadb") {
      failures.push(...(await replayDefaults(conn, version, rows)));
    } else {
      console.log(
        "replay skipped on this flavour: MySQL reports the VALUE, so `DEFAULT abc` would be rejected " +
          "by the engine's own rules rather than by a regression here. That gap is issue #1031; the " +
          "provider sets no `defaultExpression` on MySQL for the same reason.",
      );
    }
  } finally {
    await conn.end();
  }
  return failures;
}

const failures: string[] = [];
for (const url of urls()) {
  failures.push(...(await probeServer(url)));
}

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(
    `\n${failures.length} column default reading(s) did not hold: a value read back wrong, or a catalog text this flavour reports as SQL was refused after DEFAULT.`,
  );
  process.exit(1);
}
console.log(
  "Every measured column default read back as its value, and every catalog text a flavour reports as SQL was accepted back after DEFAULT by the server that reported it.",
);
