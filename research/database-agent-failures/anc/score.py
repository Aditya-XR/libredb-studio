#!/usr/bin/env python3
"""Reference scorer for the LibreDB agent benchmark.

    python3 score.py runs.jsonl [--mode row|session|pooled] [--min-runs 30]

Three modes, and the difference between them is the single most important thing in this benchmark.
`row` is the protocol and the default; the other two exist to show how much a looser reading
inflates, because both looser readings are the obvious implementation and both are wrong.

Measured on this corpus: `pooled` and `session` both put `llama3.1:8b` and `cogito:8b` at 6/6 and
30/30. `row` puts them at 23/30. Re-reading those two models by hand, six surfaces in one sitting,
returned 24/30 and 21/30 - which is `row`, not the other two.

POOLED scans a model-surface cell's entire run history for any streak of five consecutive passes.
It is the obvious implementation and it OVERSTATES, because a pooled history is not one experiment:
the corpus contains runs taken on different days, against different builds of the server, and under
different per-model settings. A streak found across that boundary says a model passed five times in
a row under *some* mixture of conditions, which is not a claim anyone can act on.

The error is not hypothetical and it is not small. Two models in this corpus score 6/6 pooled and
were re-read surface-by-surface in one sitting at 24/30 and 21/30. Their cells were each genuinely
5/5 - thirty runs, thirty passes, all in this dataset - and the row was still wrong, because a model
ships with A reading, never with the union of its readings.

SESSION splits each cell's history into sittings and requires the five consecutive passes to fall
inside one sitting. A sitting ends wherever the cell's runs stop being contiguous in the worktree's
run order - i.e. wherever the harness moved on and came back later. This fixes pooling WITHIN a cell
and leaves it BETWEEN cells, which turns out to be where the error actually lives: six cells each
locked in one sitting, but six DIFFERENT sittings, is six results rather than one row.

ROW is the protocol. It splits the model's whole history into sittings and scores each sitting on its
own, taking the best; all six cells must lock inside one of them. A row is what a deployment gets.

Report `row` if you publish a number, and report the others only to show the gap.
"""
import argparse
import collections
import json


CLOCK = {"model-timeout", "turn-limit", "deadline-exceeded"}
SURFACES = ("investigation", "query-optimization", "database-assessment", "operations", "data-analysis", "planning")
RUNS_PER_CELL = 5


def load(path):
    with open(path) as handle:
        return [json.loads(line) for line in handle if line.strip()]


def sittings(runs, max_gap=2):
    """Split one cell's runs into contiguous sittings by their position in the worktree stream.

    `max_gap` of 2 tolerates the harness's own interleaving - a retry, a server restart recorded as
    a run - without merging two sittings separated by another model's whole cell. Raise it and
    sittings merge toward `pooled`; lower it and a single hiccup splits a real sitting in two.
    """
    blocks = []
    current = []
    previous = None
    for run in runs:
        if previous is not None and run["order"] - previous > max_gap:
            blocks.append(current)
            current = []
        current.append(run)
        previous = run["order"]
    if current:
        blocks.append(current)
    return blocks


def longest_streak(outcomes):
    best = run = 0
    for ok in outcomes:
        run = run + 1 if ok else 0
        best = max(best, run)
    return best


def locked(cell_runs, mode):
    """Whether this cell reaches five consecutive passes under the chosen mode."""
    if mode == "pooled":
        return longest_streak([r["outcome"] == "answered" for r in cell_runs]) >= RUNS_PER_CELL
    for block in sittings(cell_runs):
        if longest_streak([r["outcome"] == "answered" for r in block]) >= RUNS_PER_CELL:
            return True
    return False


def row_score(model_runs, max_gap=12):
    """The strict metric: all six cells locked inside ONE sitting of this model.

    `session` above fixes pooling WITHIN a cell and leaves it BETWEEN cells, which turns out to be
    where the error actually lives. Both `llama3.1:8b` and `cogito:8b` have all six cells at 5/5
    under `session` - each cell genuinely five consecutive passes inside one sitting - and read
    24/30 and 21/30 when the six were taken together. Six cells locked on six different days is six
    results, not one row, and a row is what a deployment gets.

    So: split this model's whole run history into sittings, and score each sitting on its own. The
    row is the best single sitting. `max_gap` of 12 keeps one pass over six cells together (the
    harness runs them back-to-back, thirty runs) while still splitting two passes taken days apart.

    Returns (best_of_30, best_cells_locked, per_surface_scores) for that best sitting.
    """
    blocks = sittings(model_runs, max_gap=max_gap)
    best = (-1, -1, ["-"] * len(SURFACES))
    for block in blocks:
        by_surface = collections.defaultdict(list)
        for run in block:
            if run.get("surface") in SURFACES:
                by_surface[run["surface"]].append(run)
        scores = []
        passes = 0
        locks = 0
        for surface in SURFACES:
            runs = by_surface.get(surface, [])
            if not runs:
                scores.append("-")
                continue
            streak = longest_streak([r["outcome"] == "answered" for r in runs])
            window = min(streak, RUNS_PER_CELL)
            if streak >= RUNS_PER_CELL:
                locks += 1
                scores.append("5/5*")
            else:
                scores.append(f"{window}/5")
            passes += window
        if (passes, locks) > (best[0], best[1]):
            best = (passes, locks, scores)
    return best


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("runs", nargs="?", default="runs.jsonl")
    parser.add_argument("--mode", choices=("row", "session", "pooled"), default="row")
    parser.add_argument("--min-runs", type=int, default=30, help="skip models with fewer runs")
    args = parser.parse_args()

    rows = [r for r in load(args.runs) if r.get("model")]
    per_model = collections.Counter(r["model"] for r in rows)

    cells = collections.defaultdict(list)
    for row in sorted(rows, key=lambda r: (r["worktree"], r["order"])):
        if row.get("surface") in SURFACES:
            cells[(row["model"], row["surface"])].append(row)

    by_model = collections.defaultdict(list)
    for row in sorted(rows, key=lambda r: (r["worktree"], r["order"])):
        by_model[row["model"]].append(row)

    table = []
    for model, total in per_model.items():
        if total < args.min_runs:
            continue
        if args.mode == "row":
            passes, locks, cell_scores = row_score(by_model[model])
            table.append((passes, locks, model, total, cell_scores))
            continue
        cell_scores = []
        locks = 0
        passes = 0
        for surface in SURFACES:
            runs = cells.get((model, surface), [])
            if not runs:
                cell_scores.append("-")
                continue
            # The cell's best five-run window, which is what /30 counts.
            window = max(
                (sum(1 for r in runs[i : i + RUNS_PER_CELL] if r["outcome"] == "answered")
                 for i in range(max(1, len(runs) - RUNS_PER_CELL + 1))),
                default=0,
            )
            window = min(window, RUNS_PER_CELL)
            is_locked = locked(runs, args.mode)
            if is_locked:
                locks += 1
                window = RUNS_PER_CELL
            passes += window
            cell_scores.append(f"{window}/5" + ("*" if is_locked else ""))
        table.append((passes, locks, model, total, cell_scores))

    table.sort(reverse=True)
    header = ["model", "runs", *[s[:3] for s in SURFACES], "of30", "cells"]
    print(f"mode={args.mode}  models={len(table)}  (* = five consecutive passes)")
    print(" | ".join(header))
    for passes, locks, model, total, cell_scores in table:
        print(" | ".join([model, str(total), *cell_scores, f"{passes}/30", f"{locks}/6"]))

    lost = [r for r in rows if r["outcome"] == "unanswered"]
    classes = collections.Counter(r["loss_class"] for r in lost)
    print(f"\nlosses={len(lost)}")
    for name, count in classes.most_common():
        print(f"  {name or '(unclassified)':14} {count:5}  {100 * count / len(lost):.1f}%")


if __name__ == "__main__":
    main()
