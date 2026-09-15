#!/usr/bin/env bash
#
# Gate script — mechanical definition of "done" for one maintainer-loop iteration.
# Mirrors CLAUDE.md's Pre-Commit Verification and the required CI checks
# (.github/workflows/ci.yml: "Lint, Typecheck and Build" + "Unit & Integration Tests");
# do not reorder or drop a step.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "=== gate: format ==="
bun run format

echo "=== gate: lint ==="
bun run lint

echo "=== gate: typecheck ==="
bun run typecheck

echo "=== gate: knip ==="
bun run knip

echo "=== gate: test ==="
bun run test

# The required "Unit & Integration Tests" job runs these two, not `bun run test`:
# test:coverage is the same runner with --coverage, one lcov per test file, and
# scripts/check-coverage.mjs enforces 100% lines on the merged lcov.
echo "=== gate: coverage ==="
bun run test:coverage
bun run coverage:check

echo "=== gate: build ==="
bun run build

echo "=== gate: ALL GREEN ==="
