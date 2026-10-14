/**
 * The texts the connection dialog's Paste URL box reads, one entry per branch of `parseConnectionString` in
 * src/lib/connection-string-parser.ts, in the words both the box's hint and its refusal use (SF-024): two copies of
 * this list drifted once, and the refusal named no Snowflake form while the hint did.
 *
 * Elasticsearch, OpenSearch and Trino are absent on purpose: all three are addressed by host and port like Druid, and
 * `http(s)://` already resolves to ClickHouse there, so listing them would promise a paste the form cannot honour.
 * Trino's own `jdbc:trino://…` is a JDBC URL the parser does not read. DuckDB, SQLite and the embedded store are absent
 * because they are file-based and the Paste URL control is never drawn for them. A Snowflake account identifier with
 * no `.snowflakecomputing.com` suffix is not read either: it is a single word, which would claim any text pasted.
 */
const PASTE_FORMATS: readonly string[] = [
  "postgres://",
  "mysql://",
  "mongodb://",
  "couchbase://",
  "clickhouse://",
  "libsql://",
  "http(s)://",
  "redis://",
  "oracle://",
  "mssql://",
  "db2://",
  "databend://",
  "sc://",
  "Server=… (ADO.NET)",
  "jdbc:snowflake://",
  "snowflake://",
  "a Snowflake account URL or host",
];

/** The list as one phrase, for the hint and the refusal alike. */
export const PASTE_FORMATS_TEXT = PASTE_FORMATS.join(", ");
