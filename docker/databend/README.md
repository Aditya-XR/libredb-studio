# Databend fixture

The live Databend server of `database-compose.yml` that the databend provider talks to over Databend's own HTTP API, and the fixture that seeds it.
The provider's captures (`tests/fixtures/databend/`), the evidence harness and the live check run against this server.
The compat `databend` service of the same file is the mysql provider's MySQL-wire probe; it is a different service and is left alone.

## The server

| Service | Profile | From the host | Authentication |
|---|---|---|---|
| `databend-http` | none | HTTP `127.0.0.1:8000` | Basic, user `libredb`, password `Probe123pass!` |
| `databend-http-seed` | none | nothing | One-shot, the same user |

The server runs `datafuselabs/databend:v1.2.951-nightly`, pinned by the digest `sha256:f63585cae3e096d62580ad51d92abd2f64b57b196af3b51cb01ecae381ec874b`; `SELECT version()` answers `v1.2.951-nightly-9b7eeff9a8`.
The password is the compat service's spelling, a fixed test value.
The port is bound to the loopback address only.
Tables live on the container's file system (`QUERY_STORAGE_TYPE: fs`) and there is no data volume: removing the container resets the server.
Databend writes its query log to `/var/log/databend/databend-query-default.*` inside the container, not to `docker logs`, which carries only the startup banner; a check of what the server logged reads that file.

## Bounds, as measured

Measured on 2026-10-08 on this image, with the fixture seeded:

- Start: the container answered `/health` 2.2 s after it started (the first probe at 1.1 s failed to connect, the second passed), so `start_period: 30s` leaves more than ten times that.
- Resident size: 110.8 MiB idle after the seed (`docker stats --no-stream libredb-databend-http`), and a cgroup peak (`memory.peak`) of 160 MiB after a sort over 20 million generated rows and one page of a million rows.
- The bound is `memory: 1G` and 2 CPUs, about six times the measured peak, with no swap past it.
- The seed one-shot is bounded at 128 MiB and half a CPU; it runs only `sh` and `curl`.

## Bringing it up

Name the services: an unnamed `up` starts every engine of the file.

```sh
docker compose -f database-compose.yml up -d databend-http databend-http-seed
curl -fsS http://127.0.0.1:8000/health
DATABEND_PASSWORD='Probe123pass!'
curl -sS -u "libredb:$DATABEND_PASSWORD" -H 'content-type: application/json' -d '{"sql":"SELECT version()"}' http://127.0.0.1:8000/v1/query
docker compose -f database-compose.yml ps -a databend-http-seed
```

The seed waits for a healthy server, prints `seed.sh: <n> statements` and exits 0; any status other than 200, an in-body error or a `Failed` state stops it non-zero with the server's answer.
It may run again (`docker compose -f database-compose.yml up -d databend-http-seed`): every table and view is replaced, the role is created only when missing and the user is replaced, so a second run leaves the same fixture.
Remove the two containers by name, never with `down`:

```sh
docker compose -f database-compose.yml rm -sf databend-http databend-http-seed
```

## The fixture

`fixture.jsonl` holds one statement per line as `{"sql": "..."}`; `seed.sh` posts each in order to `/v1/query` and follows `next_uri` until the statement ends.

| Object | What it is for |
|---|---|
| `libredb_demo.every_type` | One column of every type of design section 4: the signed integers, `UInt8` to `UInt64` with `UInt16`, `UInt32` and `UInt64` at their maximum, `Int64` past 2^53 and at both ends, `Float32` and `Float64` with `NaN` and both infinities, `Decimal(38, 10)`, `Boolean`, `String` with a quote, a backslash and a double quote, `Binary` whose hex has letters, `Date`, `Timestamp`, `Timestamp_Tz` with three offsets, `Interval`, `Geometry`, `Geography`, `Variant`, `Array`, `Map` and `Tuple` holding nested NULLs, `Vector(2)` and `Bitmap`; row 4 is NULL in every nullable column |
| `libredb_demo.every_type_view` | A view over three of its columns |
| `libredb_demo.every_type_mv` | A materialized view over two of its columns; the pinned image creates one without a license |
| `libredb_demo.wide_60` | A table of 60 `INT` columns and one row |
| `studio_demo.notes` | The table S15 of the live check counts around `studio_reader`'s refused write and S16 describes; the evidence plan's `insert` scenario adds three rows to it each time it runs |
| role `studio_ro` | `SELECT` on `libredb_demo.*`, nothing else |
| user `studio_reader` | Password `Reader123pass!`, a fixed test value; holds `studio_ro` as its default role and no other grant (the `public` role every Databend user has aside), the least-privilege user agent plan mode needs, since it refuses a superuser |

The only writers of this server are `seed.sh`, `tests/live/databend-live-check.ts` and the evidence harness `tests/live/databend-evidence.ts`.
The live check writes only to `studio_demo` and `libredb_demo`, plus the user `studio_scratch` and its password policy `studio_scratch_policy`, which S7 creates and drops.
The evidence harness writes nothing but temporary tables it created, which end with their client session, plus the `insert` scenario's rows in `studio_demo.notes` of the local fixture, which `seed.sh` resets.
No check counts that table's rows against a fixed number: S15 compares the count before and after its refused write.
`tests/unit/db/databend/live-environment.test.ts` holds each of these rules.

## The live check

`tests/live/databend-live-check.ts` runs scenarios S1 to S16 and S3b of the delivery plan through a real `DatabendProvider`, reads every pinned session setting back from the server's echo, and replays the every-type table through Studio's SQL INSERT export.
Run it from the repository root with the fixture up and seeded:

```sh
bun tests/live/databend-live-check.ts --target local
```

Besides the tables and views it creates and drops in `studio_demo`, it creates the user `studio_scratch` under the password policy `studio_scratch_policy` for its one wrong password, and drops both before S7 ends, so no lockout can reach `libredb` or `studio_reader`.

The floor build runs the same check on another port, by digest, and is removed by name afterwards:

```sh
DATABEND_PASSWORD='Probe123pass!'
docker run -d --name databend-881 --memory 2g -p 127.0.0.1:18009:8000 \
  -e QUERY_DEFAULT_USER=libredb -e QUERY_DEFAULT_PASSWORD="$DATABEND_PASSWORD" -e QUERY_STORAGE_TYPE=fs \
  datafuselabs/databend:v1.2.881@sha256:847b20b0cfbadaa8dd87fc5c023db1d07042e9be6231dfc8303e75feefd94bf8
P="$(mktemp -d)"
cp docker/databend/seed.sh "$P/"
grep -v 'MATERIALIZED VIEW' docker/databend/fixture.jsonl >"$P/fixture.jsonl"
sh "$P/seed.sh" http://127.0.0.1:18009
bun tests/live/databend-live-check.ts --target v1.2.881
docker rm -f databend-881
```

v1.2.881 has no materialized views: `seed.sh` stops at the `DROP MATERIALIZED VIEW` line with 1005, so that build is seeded from a copy of `fixture.jsonl` without its two materialized-view lines, as above.
The check skips the materialized-view scenario there.
