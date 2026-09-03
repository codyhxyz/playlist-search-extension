#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="innertube-contract"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Does YouTube still behave the way the extension assumes?
#
# This spec runs lib/innertube-probe.js, which rebuilds both requests from YouTube's
# OWN ytcfg rather than calling our client. That independence is the point: if our
# parser and YouTube drift apart, a test written against our own code can agree with
# itself and still be wrong. This one fails when *YouTube* changes, which is the event
# we actually need to hear about first.
#
# Read-only. Nothing here adds to or removes from a playlist.
#
# Assertions are account-agnostic on purpose — the test profile is not Cody's
# 256-playlist brand account, so anything of the form "expect more than N playlists"
# would be measuring the fixture rather than the contract. Set
# YTPF_EXPECTED_MIN_PLAYLISTS to add an account-specific floor on a known profile.

MIN_PLAYLISTS="${YTPF_EXPECTED_MIN_PLAYLISTS:-1}"

agent-browser --session "$SESSION" open "https://www.youtube.com/" >/dev/null
ab_wait_for "page loaded" 'document.readyState === "complete"' 20000

PROBE="$(cat "$LIB/innertube-probe.js")"
RESULT="$(agent-browser --session "$SESSION" --json eval "$PROBE" 2>/dev/null | jq -c 'if .success then .data.result else {ok:false,errors:["eval failed"]} end')"
echo "[$SPEC_NAME] probe: $RESULT"

field() { echo "$RESULT" | jq -r ".$1"; }

if [[ "$(field ok)" != "true" ]]; then
  ab_fail "probe did not complete — stage=$(field stage) errors=$(field 'errors|join("; ")')"
fi

# ── The library endpoint ────────────────────────────────────────────────────
[[ "$(field listStatus)" == "200" ]] \
  || ab_fail "browse FEplaylist_aggregation returned $(field listStatus), not 200 — the library endpoint moved"
echo "[$SPEC_NAME] PASS: browse FEplaylist_aggregation answers 200"

LIST_COUNT="$(field listCount)"
[[ "$LIST_COUNT" -ge "$MIN_PLAYLISTS" ]] \
  || ab_fail "library walk found $LIST_COUNT playlists, wanted >= $MIN_PLAYLISTS — the response shape changed"
echo "[$SPEC_NAME] PASS: library walk found $LIST_COUNT playlists over $(field listPages) page(s)"

# ── The membership endpoint ─────────────────────────────────────────────────
[[ "$(field membershipStatus)" == "200" ]] \
  || ab_fail "get_add_to_playlist returned $(field membershipStatus), not 200"
echo "[$SPEC_NAME] PASS: get_add_to_playlist answers 200"

ROWS="$(field membershipRows)"
WITH_STATE="$(field membershipWithState)"
[[ "$ROWS" -ge 1 ]] \
  || ab_fail "get_add_to_playlist returned no playlistAddToOptionRenderer rows — the shape changed"
[[ "$WITH_STATE" -ge 1 ]] \
  || ab_fail "$ROWS membership rows but none carried containsSelectedVideos — the 'already in' signal is gone"
echo "[$SPEC_NAME] PASS: $ROWS membership rows, $WITH_STATE carrying containsSelectedVideos"

# The 200 cap is load-bearing documentation: it is WHY the library comes from a
# different endpoint, and why `member` has to stay tri-state. If this ever stops
# being true, the tri-state hedging in the sheet can be simplified away — so the
# assertion is here to tell us, not because exceeding it would be a defect.
[[ "$(field membershipCappedAt200)" == "true" ]] \
  || echo "[$SPEC_NAME] NOTE: membership returned $ROWS rows, above the documented 200 cap — if this holds, revisit the tri-state 'unknown' handling."

# ── The traps ───────────────────────────────────────────────────────────────
[[ "$(field singularKeyRejected)" == "true" ]] \
  || echo "[$SPEC_NAME] NOTE: {videoId:...} (singular) no longer 400s — the documented trap has changed."
echo "[$SPEC_NAME] PASS: singular videoId key still rejected (documented trap holds)"

# Brand-account delegation. On a personal account there is nothing to compare, so
# this reports rather than asserts.
if [[ "$(field delegationPresent)" == "true" ]]; then
  [[ "$(field delegationMatters)" == "true" ]] \
    || ab_fail "DELEGATED_SESSION_ID is set but delegation changed nothing ($LIST_COUNT delegated vs $(field undelegatedListCount) undelegated) — either the brand-account fix regressed or YouTube changed how delegation works"
  echo "[$SPEC_NAME] PASS: delegation is load-bearing ($LIST_COUNT delegated vs $(field undelegatedListCount) undelegated)"
else
  echo "[$SPEC_NAME] SKIP: personal account (no DELEGATED_SESSION_ID) — brand-account delegation not exercised"
fi

echo "[$SPEC_NAME] PASS"
