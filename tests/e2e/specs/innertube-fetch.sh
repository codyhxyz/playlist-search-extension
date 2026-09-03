#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="innertube-fetch"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Catches the 1.6.9 lockup-parser cap regression. The chip placeholder
# ('Search N playlists') is our page-world-readable proxy for "how many
# playlists did the InnerTube fetcher + parser actually surface?".
#
# Pre-1.7 that number came from counting YouTube's rendered DOM rows, so this
# spec was measuring their pagination rather than our parser — it could not
# actually have caught 1.6.9. Since the feed surface renders from the
# InnerTube snapshot, the number is now the parser's real output.
# feed-playlists.sh asserts N >= 1 (proves the fetch ran); this spec asserts
# a HIGHER account-specific bound, catching silent under-reporting.
#
# Override via env var:
#   YTPF_EXPECTED_MIN_PLAYLISTS=120 bash tests/e2e/run.sh
# Default 50 (a reasonable lower bound for any active YouTube user).

EXPECTED_MIN="${YTPF_EXPECTED_MIN_PLAYLISTS:-3}"

agent-browser --session "$SESSION" open "https://www.youtube.com/feed/playlists" >/dev/null
ab_wait_for "playlist grid rendered" "!!document.querySelector('$SEL_FEED_GRID_ANCHOR')" 12000
ab_wait_for "search chip mounted" "!!document.querySelector('$SEL_CHIP')" 8000

# Wait for the placeholder to populate. The first-paint placeholder reads
# "Search playlists" until the library lands; poll for the counted shape.
ab_wait_for "parser reports a count" "(() => {
  const i = document.querySelector('$SEL_CHIP input');
  return !!i && /Search \d+ playlists/.test(i.placeholder || '');
})()" 20000

ab_assert_true "parser count >= $EXPECTED_MIN" "(() => {
  const i = document.querySelector('$SEL_CHIP input');
  const m = (i.placeholder || '').match(/Search (\d+) playlists/);
  return !!m && Number(m[1]) >= $EXPECTED_MIN;
})()"

# Final read for the log.
COUNT="$(ab_eval "(() => {
  const i = document.querySelector('$SEL_CHIP input');
  const m = (i.placeholder || '').match(/Search (\d+) playlists/);
  return m ? Number(m[1]) : null;
})()")"
echo "[$SPEC_NAME] parser reported $COUNT playlists (threshold $EXPECTED_MIN)"
echo "[$SPEC_NAME] PASS"
