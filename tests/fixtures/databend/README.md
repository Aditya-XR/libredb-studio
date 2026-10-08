# Databend captures

What Databend's HTTP query API answered over `node:http` before any provider code ran, one scenario per file.
The Databend transport tests and the replay read these files; no test here reaches a live server.

## Where they come from

`tests/live/databend-evidence.ts --target local` runs the scenarios of `tests/live/databend-evidence-plan.ts` that the local target runs, every one but the three that run on Cloud only, against the `databend-http` fixture of `docker/databend/README.md` and writes `<target>-<date>-v<version>/<scenario>.json` for each, plus `manifest.json`.
`--target cloud` runs the same list against a Databend Cloud tenant set up as plan section 7 says, over HTTPS on 443 with the system trust store, through `scenariosFor("cloud")`: every name of `libredb_demo` reads `studio_demo`, three scenarios run on Cloud only and two locally only, and a gateway refusal is checked as the gateway wraps it.
Its inputs come from the environment only, never from a file of this repository: `DATABEND_CLOUD_HOST`, `DATABEND_CLOUD_PORT` and `DATABEND_CLOUD_WAREHOUSE`, and the user and password pairs `DATABEND_CLOUD_STUDIO_*`, `DATABEND_CLOUD_RO_*` and `DATABEND_CLOUD_SCRATCH_*`, plus `DATABEND_CLOUD_USER` and `DATABEND_CLOUD_PASSWORD` when set, which only the scrub reads.
`--only <name>[,<name>...]` runs only the named scenarios of the target, in plan order, and writes them and a manifest that lists only them into the same `<target>-<date>-v<version>/` directory.
A name the target does not run is refused before anything is sent, and a directory that already holds a file the run does not write is refused before anything is written.
A run that leaves out `version` still asks it first, for the manifest's server version, and writes nothing of it.
The date is the UTC day of the run and the version is the server's `x-databend-version` header.
`manifest.json` names the target, the Studio commit the harness ran from, the harness files (`database-compose.yml`, `docker/databend/`, the plan, the scrub and the harness) that differ from that commit or are not in it, the image as `tag@digest` (on Cloud, `Databend Cloud`, with a `region` field that is always the placeholder `<region>`), the answer of `SELECT version()`, the date, and each scenario's result, time in milliseconds and number of exchanges.
A capture whose `uncommitted` list is not empty is not reproducible from its commit alone; capture again from the commit that holds those files.
A scenario whose answers do not show what the plan expects stops the run, and nothing is written.

The replay reads `local-2026-10-08-v1.2.951-nightly/`, every scenario the local target runs, which `DATABEND_CAPTURE_RUNS` in `tests/helpers/databend-fixtures.ts` names.
No test replays `cloud-2026-10-08-v1.2.951-nightly/`, which is kept as the record of the Cloud acceptance of plan section 7.

Each scenario file holds its exchanges in order, each with the plan step that sent it (`query`, `pages`, `next`, `final`, `kill` or `logout`), the request (method, path, allow-listed headers, body) and the answer (status, allow-listed headers, body).
A body that is not JSON, such as the empty answer to a kill, is kept as `{"text": ...}`.

## The scrub

Every exchange passes through `tests/helpers/databend-evidence-scrub.ts` before it is written (C23).
Only the named request headers (`content-type`, `x-databend-client-caps`, `x-databend-session`, `x-databend-query-id`, `x-databend-warehouse`), the named answer headers (`content-type` and the `x-databend-query-*`, `x-databend-session*` and `x-databend-version` headers) and the named fields of the request and of the answer are kept; `dropped` lists the field names that were not.
`authorization`, cookies and dates never reach a file.
Query, session and node ids become `<query-N>`, `<session-N>` and `<node-N>`, the same placeholder for the same id across every file of a run, inside links, `session.internal` and the base64 `x-databend-session` header too, which is encoded again with its `=` padding so a replay can send it.
IP addresses become `<ip-N>`, user names `<user-N>` and a Cloud tenant `<tenant>`.
Locally `<user-1>` is the default user `libredb` and `<user-2>` is `studio_reader`; on Cloud `<user-1>` is `studio`, `<user-2>` is `studio_reader` and `<user-3>` is `studio_scratch`, the user the wrong password is sent for.
The `x-databend-warehouse` request header shows what each Cloud request named: the tenant's own warehouse becomes `<warehouse>`, while the stock name `default` and the plan's unknown `studio_no_such_wh` are kept as sent, and `no-warehouse` sends none.
The harness writes nothing at all while any file holds a password or a `user:password`, raw, percent-encoded in either case, form-encoded, in standard or URL-safe base64 with or without padding, or escaped inside a JSON text, the host, the tenant, the warehouse, the region, an email address or the egress IP.
Keys are read as well as values, and a string that reads as base64, or one of up to 64 KiB that is a JSON text, is read decoded too, up to four layers deep.
`tests/unit/db/databend/live-environment.test.ts` renders every local capture again through the scrub with the fixture's secrets, so a scrub that a committed capture would fail, or would write differently, fails the suite.
A warehouse named `default`, Databend Cloud's stock name, is not looked for, since every catalog a capture shows is named so; the host still carries the tenant and the region, and they are.
An error the harness stops on is printed with the same names replaced, so a DNS or TLS failure does not show the host on the terminal either.

## The scenarios

| Scenario | What it shows |
|---|---|
| `version` | `SELECT version()`, the source of the manifest's server version |
| `select-pages` | 25 rows over three pages with `max_rows_per_page: 10`, the `next_uri` chain to the final link |
| `every-type` | Every row of `libredb_demo.every_type` in the `display` result mode: unsafe `Int64`, `UInt64` at its maximum, `NaN` and both infinities, nested NULLs, upper-case hex `Binary`, `UInt16` and `UInt32` at their maximum, `Interval`, `Geometry` and `Geography` as GeoJSON, `Vector(2)`, `Timestamp_Tz` with its offset, `Variant`, `Array`, `Map`, `Tuple` and the `Bitmap` placeholder |
| `show-create-every-type` | The DDL the replay re-creates the every-type table from |
| `show-create-materialized-view` | `SHOW CREATE MATERIALIZED VIEW` of `libredb_demo.every_type_mv`, backticked DDL |
| `ddl` | A `CREATE TEMP TABLE` answer: `has_result_set: false` and `need_keep_alive: true`, then the logout |
| `dml` | An `INSERT` answer, one row in the column `number of rows inserted` |
| `temp-table-logout` | A temporary table that `need_keep_alive` keeps, its logout, and the 1025 Unknown table that follows in the same session |
| `begin` | `BEGIN` answering `txn_state: Active`, then `ROLLBACK` answering `AutoCommit` |
| `session-echo` | Pinned session settings echoed back, the unknown `no_such_setting` dropped from the echo |
| `error-position` | An in-body 1005 over HTTP 200 whose message carries `--> SQL:1:10` |
| `auth-401` | A wrong password: HTTP 401 with 5100; on Cloud the gateway's `AuthorizationFailed` envelope, with the 5100 in its message |
| `kill` | A running query, its kill (an empty 200), and the 400 its next page answers afterwards |
| `final` | A query closed by its final link after the first of three pages, and the 400 its next page answers afterwards |
| `reader` | `studio_reader` reading `libredb_demo` as `studio_ro` |
| `insert` | Local only: an `INSERT` into `studio_demo.notes`, a table that outlives the client session, answering one row in `number of rows inserted` with `need_keep_alive: false`, so no logout follows |
| `final-kill` | Local only: the `final` flow, `Running` with 10 of 25 rows, its final, and the 400 its next page answers, then the kill of the closed query, an empty 200 |
| `no-warehouse` | Cloud only: no `x-databend-warehouse` header, refused by the gateway with HTTP 400 and `error.kind` `WarehouseHeaderRequired` |
| `unknown-warehouse` | Cloud only: `x-databend-warehouse: studio_no_such_wh`, refused with HTTP 400 and `error.kind` `BadWarehouse`, the name in the message |
| `forbidden` | Cloud only: `SHOW WAREHOUSES` as `studio`, refused with HTTP 403 and `error.kind` `ForbiddenAccessUser` |

The answer's `error` keeps `code`, `kind`, `message` and `detail`: the Cloud gateway's own refusals carry a `kind` and no `code` (I19).

The harness writes nothing but temporary tables it created, which end with their client session, plus the `insert` scenario's rows in `studio_demo.notes` of the local fixture, which `docker/databend/seed.sh` resets.
