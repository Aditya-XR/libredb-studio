#!/bin/sh
# The seed of the Databend fixture (docker/databend/README.md), whose other writers are tests/live/databend-live-check.ts
# and the evidence harness's `insert` scenario. Studio never runs it, and the evidence harness never imports or runs it.
#
#   seed.sh <base url>   each line of fixture.jsonl, in order, on the server at <base url>
#
# Each line is one statement as {"sql": "..."}, posted to /v1/query with Basic; the seed follows next_uri until the
# statement is done, and stops on a status other than 200, an in-body error or a Failed state, printing the answer.
# The fixture replaces what it creates, so a second run leaves the same fixture. Run on the host it talks to the
# published port; in the one-shot the compose file points it at the service name. The credentials are the fixed test
# values of database-compose.yml. POSIX sh, because the Databend image carries sh and curl and no bash.
set -eu
export LC_ALL=C

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${1:-http://127.0.0.1:8000}"
USER_NAME="${DATABEND_USER:-libredb}"
PASSWORD="${DATABEND_PASSWORD:-Probe123pass!}"

fail() {
  echo "seed.sh: $*" >&2
  exit 1
}

# request <what> <curl arguments...>: prints the body; a status other than 200 stops the seed with the body.
request() {
  what="$1"
  shift
  body="$(mktemp)"
  status="$(curl -sS -u "$USER_NAME:$PASSWORD" -o "$body" -w '%{http_code}' "$@")" || {
    rm -f "$body"
    fail "$what: the request failed"
  }
  if [ "$status" != "200" ]; then
    cat "$body" >&2
    echo >&2
    rm -f "$body"
    fail "$what: HTTP $status, expected 200"
  fi
  cat "$body"
  rm -f "$body"
}

# The value of a top-level string field of an answer, or nothing when it is null or absent.
field() {
  sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"
}

count=0
while IFS= read -r line || [ -n "$line" ]; do
  [ -n "$line" ] || continue
  count=$((count + 1))
  what="fixture.jsonl line $count"
  # The line without its closing brace, plus a long poll, so most statements end in their first answer.
  answer="$(request "$what" -H 'content-type: application/json' \
    -d "${line%\}},\"pagination\":{\"wait_time_secs\":30}}" "$BASE/v1/query")"
  while :; do
    case "$answer" in
      *'"state":"Failed"'* | *'"error":{'*) printf '%s\n' "$answer" >&2 && fail "$what: the statement failed" ;;
    esac
    next="$(printf '%s' "$answer" | field next_uri)"
    state="$(printf '%s' "$answer" | field state)"
    # A finished statement's next_uri is its final link, which releases it on the server.
    [ -n "$next" ] || break
    answer="$(request "$what" "$BASE$next")"
    [ "$state" != "Succeeded" ] || break
  done
done <"$HERE/fixture.jsonl"

echo "seed.sh: $count statements"
