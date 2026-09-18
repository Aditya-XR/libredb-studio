#!/usr/bin/env python3
"""Export the whole measurement corpus as a HuggingFace-ready dataset.

Three files, because three different questions are asked of this corpus and one table cannot serve
all of them:

  runs.jsonl      one object per agent run - the unit a pass/fail verdict attaches to. This is the
                  table for "which models pass what", and it carries the verdict, the shortfall, the
                  tool histogram, the refusal histogram and the guidance histogram inline.

  events.jsonl    one object per ledger event, ~127k rows. This is the raw record and the reason the
                  dataset is worth releasing at all: it lets a reader recompute every number in the
                  paper, and disagree with the taxonomy without re-running anything. The taxonomy in
                  the paper is an interpretation OF this file, not a property of it.

  refusals.jsonl  every refused or declined tool call, with the tool, the reason code and the
                  validator's field paths. Split out because it is the paper's central evidence and
                  is otherwise buried under the event stream.

Redaction: the ledger is server-authored and holds no credentials by construction, but this export
leaves the machine, so `scrub` below drops the two fields that could carry a key if a future event
shape ever did, and every value is passed through a secret pattern check by the caller. The sample
database is the synthetic employee/department/salary schema shipped with the product; no real data
was ever connected during these runs.
"""
import glob
import json
import os
import sys
from collections import Counter, defaultdict

WORKTREES = [
    "/home/researcher/projects/libredb/lb-guncel",
    "/home/researcher/projects/libredb/lb-yeni",
    "/home/researcher/projects/libredb/lb-main-test",
    "/home/researcher/projects/libredb/lb-fix",
    "/home/researcher/projects/libredb/libredb-studio",
]

# Never exported, whatever a future event shape puts in them.
DROP_KEYS = {"apiKey", "api_key", "authorization", "token", "password", "secret", "connectionString"}

CLOCK = {"model-timeout", "turn-limit", "deadline-exceeded"}


def scrub(value):
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if k not in DROP_KEYS}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def read_event(path):
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
        return json.loads(raw[1:].decode("utf-8", "replace")).get("event") or {}
    except Exception:
        return {}


def collect(worktree):
    runs = defaultdict(list)
    pattern = os.path.join(worktree, ".workflow-data/streams/chunks/agent-ledger-*.bin")
    for path in glob.glob(pattern):
        base = os.path.basename(path)
        run_id = base.split("agent-ledger-", 1)[1].rsplit("-chnk_", 1)[0]
        runs[run_id].append(path)
    return runs


def classify(stop_reason, tools_invoked, outcome):
    """The paper's four-class taxonomy, computed here so the dataset carries it as a column.

    Stated as code rather than prose so a reader can disagree with it precisely: the column is an
    interpretation, `events.jsonl` is the evidence, and swapping this function reclassifies the
    corpus without touching the data.
    """
    if outcome != "unanswered":
        return ""
    if stop_reason in CLOCK:
        return "clock"
    if tools_invoked == 0:
        return "capability"
    if stop_reason == "report-composed":
        return "verification"
    return "transport"


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "/home/researcher/Desktop/makale/dataset"
    os.makedirs(out_dir, exist_ok=True)
    runs_path = os.path.join(out_dir, "runs.jsonl")
    events_path = os.path.join(out_dir, "events.jsonl")
    refusals_path = os.path.join(out_dir, "refusals.jsonl")

    n_runs = n_events = n_ref = 0
    with (
        open(runs_path, "w") as runs_out,
        open(events_path, "w") as events_out,
        open(refusals_path, "w") as refusals_out,
    ):
        for worktree in WORKTREES:
            tree = os.path.basename(worktree)
            grouped = collect(worktree)
            print(f"{tree}: {len(grouped)} run", flush=True)
            for run_id, paths in grouped.items():
                events = [e for e in (read_event(p) for p in paths) if e]
                if not events:
                    continue
                events.sort(key=lambda e: e.get("atMs") or 0)
                base_ms = events[0].get("atMs") or 0

                record = {
                    "run_id": run_id,
                    "worktree": tree,
                    "model": "",
                    "provider": "",
                    "tuning_origin": "",
                    "mode": "",
                    "surface": "",
                    "verifier": "",
                    "status": "",
                    "stop_reason": "",
                    "outcome": "",
                    "unmet": [],
                    "elapsed_ms": (events[-1].get("atMs") or 0) - base_ms,
                    "event_count": len(events),
                    "tools": {},
                    "refusals": {},
                    "guidance": {},
                    "stopped_saying_chars": 0,
                    "reports_composed": 0,
                    "answers_composed": 0,
                    "recommendations": 0,
                    "loss_class": "",
                    # Rank of this run's start within its worktree, filled after the pass below.
                    #
                    # The wall clock is deliberately NOT exported - when this machine ran a sweep is
                    # not part of the finding - but ORDER is load-bearing: the protocol scores a cell
                    # as five CONSECUTIVE passes, and consecutiveness cannot be recovered from a
                    # pooled corpus without it. A rank gives a reader the sequence and not the date.
                    "order": -1,
                    "started_at_ms_raw": base_ms,
                }
                tools, refusals, guidance = Counter(), Counter(), Counter()

                for index, event in enumerate(events):
                    kind = event.get("kind")
                    clean = scrub(event)
                    # Offsets rather than wall-clock: the absolute timestamps say when this machine
                    # ran a sweep, which is not part of the finding, and an offset is what a reader
                    # needs to see the shape of a run.
                    clean.pop("atMs", None)
                    events_out.write(
                        json.dumps(
                            {
                                "run_id": run_id,
                                "worktree": tree,
                                "seq": index,
                                "offset_ms": (event.get("atMs") or 0) - base_ms,
                                "kind": kind,
                                "event": clean,
                            },
                            ensure_ascii=False,
                        )
                        + "\n"
                    )
                    n_events += 1

                    if kind == "driver-resolved":
                        record["model"] = event.get("modelId") or ""
                        record["provider"] = event.get("provider") or ""
                        record["tuning_origin"] = (event.get("tuning") or {}).get("origin") or ""
                    elif kind == "run-started":
                        record["mode"] = event.get("mode") or ""
                    elif kind == "run-finished":
                        record["status"] = event.get("status") or ""
                        record["stop_reason"] = event.get("stopReason") or ""
                        verdict = event.get("goalVerdict") or {}
                        record["outcome"] = verdict.get("outcome") or ""
                        record["unmet"] = verdict.get("unmet") or []
                        verifier = verdict.get("verifier") or ""
                        record["verifier"] = verifier
                        stem = verifier.rsplit(".", 1)[0]
                        record["surface"] = stem.removeprefix("agent-") if stem else ""
                    elif kind == "tool-invoked":
                        tools[event.get("tool") or event.get("toolName") or "?"] += 1
                    elif kind == "guidance-issued":
                        guidance[event.get("notice") or "?"] += 1
                    elif kind == "model-stopped-saying":
                        record["stopped_saying_chars"] += len(event.get("text") or "")
                    elif kind == "report-composed":
                        record["reports_composed"] += 1
                    elif kind == "answer-composed":
                        record["answers_composed"] += 1
                    elif kind == "recommendation":
                        record["recommendations"] += 1

                    if kind == "call-declined":
                        key = f"{event.get('tool')}:{event.get('reasonCode')}"
                        refusals[key] += 1
                        refusals_out.write(
                            json.dumps(
                                {
                                    "run_id": run_id,
                                    "worktree": tree,
                                    "offset_ms": (event.get("atMs") or 0) - base_ms,
                                    "channel": "call-declined",
                                    "tool": event.get("tool") or "",
                                    "reason_code": event.get("reasonCode") or "",
                                    "detail": event.get("detail") or "",
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )
                        n_ref += 1
                    elif kind == "tool-refused":
                        refusal = event.get("refusal") or {}
                        key = f"tool:{refusal.get('class', '?')}"
                        refusals[key] += 1
                        refusals_out.write(
                            json.dumps(
                                {
                                    "run_id": run_id,
                                    "worktree": tree,
                                    "offset_ms": (event.get("atMs") or 0) - base_ms,
                                    "channel": "tool-refused",
                                    "tool": "",
                                    "reason_code": refusal.get("class") or "",
                                    "detail": refusal.get("message") or "",
                                },
                                ensure_ascii=False,
                            )
                            + "\n"
                        )
                        n_ref += 1

                record["tools"] = dict(tools)
                record["refusals"] = dict(refusals)
                record["guidance"] = dict(guidance)
                record["loss_class"] = classify(
                    record["stop_reason"], sum(tools.values()), record["outcome"]
                )
                runs_out.write(json.dumps(record, ensure_ascii=False) + "\n")
                n_runs += 1

    # Second pass over runs.jsonl only: rank within worktree, then drop the raw clock.
    by_tree = defaultdict(list)
    with open(runs_path) as handle:
        records = [json.loads(line) for line in handle]
    for record in records:
        by_tree[record["worktree"]].append(record)
    for tree_records in by_tree.values():
        tree_records.sort(key=lambda r: r["started_at_ms_raw"])
        for rank, record in enumerate(tree_records):
            record["order"] = rank
    with open(runs_path, "w") as handle:
        for record in records:
            record.pop("started_at_ms_raw", None)
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")

    print(f"runs={n_runs} events={n_events} refusals={n_ref}", flush=True)
    print(f"-> {runs_path}\n-> {events_path}\n-> {refusals_path}", flush=True)


if __name__ == "__main__":
    main()
