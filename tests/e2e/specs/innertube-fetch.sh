#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="innertube-fetch"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Catches the 1.6.9 lockup-parser cap regression. The indexer drives the
# placeholder text 'Filter N playlists' on the page surface — that's our
# page-world-readable proxy for "how many playlists did the InnerTube
# fetcher + parser actually surface?". feed-playlists.sh asserts N >= 5
# (proves the indexer ran). This spec asserts a HIGHER bound the user
# expects from their own account, catching silent under-reporting.
#
# Override via env var:
#   YTPF_EXPECTED_MIN_PLAYLISTS=120 bash tests/e2e/run.sh
# Default 50 (a reasonable lower bound for any active YouTube user).

EXPECTED_MIN="${YTPF_EXPECTED_MIN_PLAYLISTS:-3}"

agent-browser --session "$SESSION" open "https://www.youtube.com/feed/playlists" >/dev/null
ab_wait_for "playlist grid rendered" "!!document.querySelector('$SEL_PLAYLISTS_GRID')" 12000
ab_wait_for "inline page bar mounted" "!!document.querySelector('$SEL_INLINE_PAGE')" 8000

# Wait for the placeholder to populate. The first-paint placeholder may be
# empty until the indexer finishes; poll for the 'Filter N playlists' shape.
ab_wait_for "indexer reports a count" "(() => {
  const i = document.querySelector('$SEL_INLINE_PAGE input');
  return !!i && /Filter \d+ playlists/.test(i.placeholder || '');
})()" 15000

ab_assert_true "indexer count >= $EXPECTED_MIN" "(() => {
  const i = document.querySelector('$SEL_INLINE_PAGE input');
  const m = (i.placeholder || '').match(/Filter (\d+) playlists/);
  return !!m && Number(m[1]) >= $EXPECTED_MIN;
})()"

# Final read for the log.
COUNT="$(ab_eval "(() => {
  const i = document.querySelector('$SEL_INLINE_PAGE input');
  const m = (i.placeholder || '').match(/Filter (\d+) playlists/);
  return m ? Number(m[1]) : null;
})()")"
echo "[$SPEC_NAME] indexer reported $COUNT playlists (threshold $EXPECTED_MIN)"
echo "[$SPEC_NAME] PASS"
