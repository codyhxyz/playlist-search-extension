#!/usr/bin/env bash
set -euo pipefail

# Top-level test orchestrator: fixture tests first (fast, no auth), then e2e.
# Used by build-store-zip.sh to gate publishing.
#
# The e2e stage is opt-out via PLS_SKIP_E2E=1, and nothing else is.
#
# It used to have no skip at all, on the reasoning that past regressions came
# from someone deciding "this once is fine." That reasoning still holds, and the
# skip is deliberately loud, recorded in the publish envelope, and never the
# default — but a gate whose only failure mode is "the test account's cookies
# expired" stops being a quality control and becomes a hostage situation. The
# fixture, unit, bundle-boot and UI-contract stages remain non-bypassable,
# because those can never be blocked by anything outside this repo.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[run-all] build: production content bundle"
npm run --silent build

echo "[run-all] unit: intent resolution + InnerTube parsers"
node --test tests/intent.test.mjs tests/innertube.test.mjs

echo "[run-all] smoke: the shipped bundle boots"
node tests/test-bundle-boots.mjs

echo "[run-all] contract: save-sheet UI in a real engine"
node tests/test-sheet-render.mjs

if [[ "${PLS_SKIP_E2E:-}" == "1" ]]; then
  echo
  echo "  ############################################################"
  echo "  #  E2E SKIPPED — PLS_SKIP_E2E=1                            #"
  echo "  #                                                          #"
  echo "  #  Nothing has been checked against live, signed-in        #"
  echo "  #  YouTube. Specifically UNVERIFIED for this build:        #"
  echo "  #    - the playlist library actually loads                 #"
  echo "  #    - 'already in' membership state is real               #"
  echo "  #    - YouTube's Save button still opens our sheet, on     #"
  echo "  #      the watch page AND on the home feed                 #"
  echo "  #    - the InnerTube endpoints still answer as expected    #"
  echo "  #                                                          #"
  echo "  #  Everything else in this suite DID run.                  #"
  echo "  ############################################################"
  echo
else
  echo "[run-all] e2e: tests/e2e/run.sh"
  bash tests/e2e/run.sh
fi

echo "[run-all] all tests passed${PLS_SKIP_E2E:+ (e2e skipped)}"
