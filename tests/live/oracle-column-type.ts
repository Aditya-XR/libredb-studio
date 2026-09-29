/**
 * Opt-in live guard for #1139: does the type this provider reports still build DDL the server
 * that reported it accepts, and does that DDL create the SAME column?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. `ALL_TAB_COLUMNS.DATA_TYPE` is the type
 * without its length, precision or scale: `VARCHAR2` for a `VARCHAR2(20)`, `NUMBER` for a
 * `NUMBER(12,2)`, `CHAR` for a `CHAR(2)`. The provider read that column alone,
 * `ColumnSchema.type` carried it, and the schema-diff migration generator interpolates that
 * field verbatim. A bare `VARCHAR2`, `NVARCHAR2` or `RAW` is ORA-00906, so the generated
 * `CREATE TABLE` was refused. A bare `CHAR` or `NUMBER` was worse: it was accepted, and it
 * created a different column (`CHAR(1)`, an unconstrained `NUMBER`) without an error.
 *
 * A mock cannot settle either half. "The server accepts this statement" and "the server creates
 * this column from it" are claims about the engine. So this script asks the engine:
 *
 *  1. It reads the fixture table through the provider, both reads.
 *  2. It replays the generated `CREATE TABLE` at the same server and requires an accept.
 *  3. It compares the new table's `ALL_TAB_COLUMNS` rows with the fixture's, which catches a
 *     declaration that is accepted but creates a different column.
 *  4. It replays the definition the OLD reading produced and requires ORA-00906. Without this
 *     half, a server that had started to accept a bare `VARCHAR2` would leave this script green
 *     while the reading it guards had stopped mattering.
 *
 * Step 2 runs under `NLS_LENGTH_SEMANTICS = CHAR`. Under that setting a bare `VARCHAR2(20)` is
 * created with character length semantics, so a reading that left out `BYTE` would fail step 3
 * on the byte columns.
 *
 * It reads `APP.COLUMN_TYPES`, which `docker/oracle-init/01-object-fixture.sql` creates with one
 * column per row of the rule in `docs/providers/oracle.md` §7. It is NOT in `bun run test`: the
 * runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 *
 *   LIBREDB_LIVE_ORACLE_URL=oracle://app:Password123!@127.0.0.1:1521/XEPDB1 \
 *     bun tests/live/oracle-column-type.ts
 *
 * Point it at a DISPOSABLE server. It CREATES and DROPS throwaway tables in the schema of the
 * user the URL names.
 */
import oracledb from "oracledb";
import { OracleProvider } from "../../src/lib/db/providers/sql/oracle";
import { diffSchemas } from "../../src/lib/schema-diff/diff-engine";
import { generateMigrationSQL } from "../../src/lib/schema-diff/migration-generator";
import type { StoredObject } from "../../src/lib/db/detailed-object";
import type { ColumnSchema, DatabaseConnection } from "../../src/lib/types";
import { splitStatements } from "../../src/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "../../src/lib/sql/grammar";

/** The fixture table this script reads, in the connecting user's schema. */
const PROBE_TABLE = "COLUMN_TYPES";

/** The dictionary columns that say what a column IS. Two tables that agree on these agree on the column. */
const SHAPE_SQL = `SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH, DATA_PRECISION, DATA_SCALE, CHAR_LENGTH, CHAR_USED
         FROM USER_TAB_COLUMNS
         WHERE TABLE_NAME = :1
         ORDER BY COLUMN_ID`;

function url(): URL {
  const raw = process.env.LIBREDB_LIVE_ORACLE_URL;
  if (!raw) {
    throw new Error(
      "Set LIBREDB_LIVE_ORACLE_URL to a disposable Oracle, for example " +
        "oracle://app:Password123!@127.0.0.1:1521/XEPDB1 against the database-compose.yml service.",
    );
  }
  return new URL(raw);
}

/** The URL as this repo's own connection record, so the PROVIDER does the reading. */
function connectionOf(parsed: URL): DatabaseConnection {
  return {
    id: "live-oracle",
    name: `live ${parsed.host}`,
    type: "oracle",
    host: parsed.hostname,
    port: Number(parsed.port || "1521"),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    createdAt: new Date(),
  };
}

type Row = Record<string, unknown>;

async function shape(conn: oracledb.Connection, table: string): Promise<Row[]> {
  const result = await conn.execute(SHAPE_SQL, [table], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return (result.rows ?? []) as Row[];
}

async function dropQuietly(conn: oracledb.Connection, table: string): Promise<void> {
  try {
    await conn.execute(`DROP TABLE "${table}" PURGE`);
  } catch {
    // Not there, which is the state this wanted.
  }
}

/**
 * The generated migration, replayed at the server that supplied the columns, and the new
 * table's dictionary rows compared with the fixture's.
 *
 * `diffSchemas` against an empty source is the CREATE TABLE path, and the table is renamed
 * first so the statement lands beside the fixture rather than on top of it.
 */
async function replayGenerated(
  conn: oracledb.Connection,
  columns: readonly ColumnSchema[],
  table: string,
  original: readonly Row[],
): Promise<string[]> {
  const target: StoredObject[] = [{ name: table, columns: [...columns], indexes: [] }];
  const sql = generateMigrationSQL(diffSchemas([], target), "oracle");
  const failures: string[] = [];
  let ran = 0;
  await conn.execute("ALTER SESSION SET NLS_LENGTH_SEMANTICS = CHAR");
  try {
    for (const statement of splitStatements(sql, resolveSqlGrammar("oracle"))) {
      // The generator puts a header of comments and blank lines in front of the statement,
      // and node-oracledb answers ORA-00911 for a trailing terminator, so both are removed.
      const text = statement.sql
        .replace(/;\s*$/, "")
        .replace(/^(?:[ \t]*(?:--[^\n]*)?\n)*/, "")
        .trim();
      if (!/^CREATE\s+TABLE/i.test(text)) continue;
      ran += 1;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one statement at a time is the point.
        await conn.execute(text);
        console.log(`the generated CREATE TABLE was accepted:\n${text}`);
      } catch (error) {
        failures.push(
          `the generated CREATE TABLE was refused by the server that supplied its columns: ` +
            `${error instanceof Error ? error.message : String(error)}\n${text}`,
        );
      }
    }
    if (ran > 0 && failures.length === 0) {
      const replayed = await shape(conn, table);
      if (replayed.length !== original.length) {
        failures.push(`the replayed table has ${replayed.length} columns, and the fixture has ${original.length}.`);
      }
      let same = 0;
      for (const [index, want] of original.entries()) {
        const got = replayed[index];
        if (JSON.stringify(got) === JSON.stringify(want)) {
          same += 1;
          continue;
        }
        failures.push(
          `${String(want.COLUMN_NAME)} was created as a different column. Fixture ${JSON.stringify(want)}, ` +
            `replayed ${JSON.stringify(got)}.`,
        );
      }
      console.log(`${same} of ${original.length} replayed columns have the fixture's ALL_TAB_COLUMNS row.`);
    }
  } finally {
    await conn.execute("ALTER SESSION SET NLS_LENGTH_SEMANTICS = BYTE");
    await dropQuietly(conn, table);
  }
  // A run that replayed NOTHING would pass every assertion above, so it is a failure: the
  // generator emitted no CREATE TABLE, and this half of the guard measured nothing.
  if (ran === 0) failures.push(`the migration generator produced no CREATE TABLE to replay:\n${sql}`);
  return failures;
}

async function probe(): Promise<string[]> {
  const failures: string[] = [];
  const parsed = url();
  const connection = connectionOf(parsed);
  const owner = connection.user!.toUpperCase();
  const provider = new OracleProvider(connection);
  const pool = await oracledb.createPool({
    user: connection.user,
    password: connection.password,
    connectString: `${connection.host}:${connection.port}/${connection.database}`,
    poolMin: 0,
    poolMax: 1,
  });
  const conn = await pool.getConnection();
  try {
    const version = await conn.execute("SELECT BANNER_FULL FROM V$VERSION", [], {
      outFormat: oracledb.OUT_FORMAT_OBJECT,
    });
    const banner = ((version.rows ?? []) as Row[])[0]?.BANNER_FULL;
    console.log(`\n=== ${String(banner ?? "unknown").split("\n")[0]} ===`);

    const original = await shape(conn, PROBE_TABLE);
    if (original.length === 0) {
      failures.push(
        `${owner}.${PROBE_TABLE} has no columns. Recreate the container: the init script only runs on a fresh data directory.`,
      );
      return failures;
    }

    await provider.connect();
    const single = await provider.describeObject([owner, PROBE_TABLE], "table");
    const batch = await provider.describeObjects([owner], "table");
    const bulk = batch.details.find((detail) => detail.path[1] === PROBE_TABLE);
    if (bulk === undefined) {
      failures.push(`describeObjects() did not describe ${PROBE_TABLE}.`);
      return failures;
    }

    // 1: both reads agree, and `baseType` is DATA_TYPE exactly where `type` differs from it.
    const dataType = new Map(original.map((row) => [String(row.COLUMN_NAME), String(row.DATA_TYPE)]));
    if (JSON.stringify(single.columns) !== JSON.stringify(bulk.columns)) {
      failures.push(
        `describeObject() and describeObjects() disagree:\n${JSON.stringify(single.columns)}\n${JSON.stringify(bulk.columns)}`,
      );
    }
    for (const column of single.columns) {
      const family = dataType.get(column.name);
      console.log(`${column.name}: DATA_TYPE=${family} type=${column.type} baseType=${column.baseType}`);
      const wantBase = column.type === family ? undefined : family;
      if (column.baseType !== wantBase) {
        failures.push(
          `${column.name} has baseType ${JSON.stringify(column.baseType)}, expected ${JSON.stringify(wantBase)}. ` +
            `baseType is DATA_TYPE, and it is absent exactly where the declaration IS DATA_TYPE.`,
        );
      }
    }

    // 2 and 3: the generated CREATE TABLE is accepted, and it creates the same columns.
    failures.push(...(await replayGenerated(conn, single.columns, `LIBREDB_TYPE_REPLAY_${process.pid}`, original)));

    // 4: the OLD reading is refused, so a green run means the reading still matters.
    const familyOnly = original.map((row) => `"${String(row.COLUMN_NAME)}" ${String(row.DATA_TYPE)}`).join(", ");
    const refusedTable = `LIBREDB_TYPE_FAMILY_${process.pid}`;
    try {
      await conn.execute(`CREATE TABLE "${refusedTable}" (${familyOnly})`);
      failures.push(
        `the OLD reading built a CREATE TABLE this server ACCEPTED (${familyOnly}). This guard proves #1139 by ` +
          `the engine's refusal of a bare DATA_TYPE, and the engine no longer refuses it, so the guard has stopped ` +
          `measuring anything and must be rewritten.`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("ORA-00906"))
        failures.push(`the OLD reading was refused, but not with ORA-00906: ${message}`);
      else console.log(`the DATA_TYPE-only definition was refused, as it must be: ${message}`);
    } finally {
      await dropQuietly(conn, refusedTable);
    }
  } finally {
    await provider.disconnect();
    await conn.close();
    await pool.close(0);
  }
  return failures;
}

const failures = await probe();

console.log("");
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  console.error(`\n${failures.length} column type reading(s) did not hold.`);
  process.exit(1);
}
console.log(
  "Both column reads report the declaration with DATA_TYPE beside it, the generated CREATE TABLE was accepted " +
    "by the server that supplied its columns and created the same columns, and the DATA_TYPE-only definition it " +
    "replaces was refused with ORA-00906.",
);
