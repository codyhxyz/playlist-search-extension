#!/usr/bin/env bash
set -euo pipefail

# Top-level test orchestrator: fixture tests first (fast, no auth), then e2e.
# Used by build-store-zip.sh to gate publishing.
#
# No skip flag, by design. The publish ritual is: refresh cookies if expired,
# run the suite, then publish. If e2e is broken (e.g. cookies expired mid-day),
# fix the cookies — don't bypass the test. Past regressions all came from
# someone deciding "this once is fine."

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[run-all] build: production content bundle"
npm run --silent build

echo "[run-all] unit: InnerTube parser + /feed anchor budget"
node --test tests/innertube-parse.test.mjs tests/selectors-anchor-budget.test.mjs

echo "[run-all] integration: bundled content.js in a vm sandbox"
node src/test-search.cjs

echo "[run-all] fixture: tests/test-feed-page-mount.mjs"
node tests/test-feed-page-mount.mjs

echo "[run-all] e2e: tests/e2e/run.sh"
bash tests/e2e/run.sh

echo "[run-all] all tests passed"
