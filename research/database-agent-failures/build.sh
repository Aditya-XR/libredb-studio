#!/usr/bin/env bash
# Build the arXiv submission package and verify the paper against the released data.
#
# Everything that ships lives under anc/. There is no second copy of anything, because a
# second copy is how the submission ended up carrying a stale verifier once already.
set -euo pipefail
cd "$(dirname "$0")"

DATA="${1:-}"
OUT=dist

if [ -n "$DATA" ]; then
  echo "== verifying the paper against $DATA"
  ( cd anc && python3 verify.py "$DATA" sweep-logs )
else
  echo "== skipping verification (pass the path to runs.jsonl to run it)"
  echo "   hf download libredb/database-agent-runs runs.jsonl --type=dataset --local-dir ."
fi

echo "== building $OUT/arxiv-submission.tar.gz"
rm -rf "$OUT" && mkdir -p "$OUT"
tar czf "$OUT/arxiv-submission.tar.gz" paper.tex anc
echo "   $(du -h "$OUT/arxiv-submission.tar.gz" | cut -f1), arXiv accepts up to 50 MB"

if command -v tectonic >/dev/null; then
  echo "== compiling"
  tectonic -X compile paper.tex --outdir "$OUT" 2>&1 | grep -E "^error|Writing" || true
  grep -E "Overfull" "$OUT/paper.log" 2>/dev/null | sed 's/^/   /' || echo "   no overfull boxes"
else
  echo "== tectonic not installed, skipping the compile check"
  echo "   curl --proto '=https' --tlsv1.2 -fsSL https://drop-sh.fullyjustified.net | sh"
fi
