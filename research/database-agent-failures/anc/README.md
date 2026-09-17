# Ancillary files

Everything needed to check the paper's numbers, except the full ledger, which is too large to carry
here and is published at https://doi.org/10.57967/hf/10485

## Verifying the paper

    hf download libredb/database-agent-runs runs.jsonl --type=dataset --local-dir .
    python3 verify.py runs.jsonl sweep-logs

It prints one line per figure in the paper and exits non-zero if any disagrees. With the second
argument it also rebuilds the intervention table by joining each sweep log's run identifiers against
the corpus, which is the check that catches a score read from a log's `status=` field rather than
from the run's verdict. Those two are not the same thing, and conflating them inflates a pass rate.

## Files

| File | What it is |
|---|---|
| `verify.py` | Regenerates every figure in the paper from the released corpus. |
| `score.py` | The scorer. Three modes: `row` is the protocol, `session` and `pooled` are looser readings kept so the gap between them can be seen. |
| `hf-export.py` | Builds the released corpus from the raw run ledgers, with the framing format documented in its docstring. |
| `refused-call-arguments.jsonl` | 17 refused calls with their arguments, from `llama3.1:8b` and `mistral-small3.2:24b`, across `compose_report`, `present_answer` and `recommend_change`. The basis of Section 6.2. |
| `refused-call-arguments-granite.jsonl` | 9 refused calls from `granite4:3b` on `compose_report` and `present_answer`. The basis of Section 6.3, the contradictory contract. |
| `refused-call-arguments-recommend-change.jsonl` | 6 refused `recommend_change` calls from `llama3.1:8b`. |
| `sweep-logs/` | 160 per-cell run logs. Each records the run identifiers a sweep started and the process exit of each, and nothing about whether the run answered. Join the identifiers against the corpus for that. |

A production ledger records refusal codes and never the model's arguments, so that model-authored
text cannot enter the server's own audit vocabulary. The three capture files above come from a
temporary, environment-gated dump added for this study. They are the reason Section 6 exists.
