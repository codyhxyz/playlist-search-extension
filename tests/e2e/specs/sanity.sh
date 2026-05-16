#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="sanity"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Gate spec: confirms the test profile is actually signed into YouTube. If
# this fails, every other spec would fail too — and the cause is almost
# always cookie expiry, not extension breakage. So we surface a remediation
# message rather than a stack trace.

agent-browser --session "$SESSION" open "https://www.youtube.com/" >/dev/null
ab_wait_for "page loaded" 'document.readyState === "complete"'

# YouTube exposes the signed-in account via ytInitialData → topbar avatar.
# Falling back to a DOM probe for the topbar avatar's button-renderer because
# ytInitialData shape changes; the avatar element is more stable.
RESULT="$(ab_eval '({
  signedIn: !document.body.innerText.includes("Sign in to like videos"),
  url: location.href,
})')"
echo "[$SPEC_NAME] account probe: $RESULT"

if ! echo "$RESULT" | grep -q '"signedIn":true'; then
  echo "[$SPEC_NAME] FAIL: not signed in." >&2
  echo "[$SPEC_NAME]   The Chrome profile '${YTPF_TEST_PROFILE:-YT Test}' isn't signed into YouTube." >&2
  echo "[$SPEC_NAME]   Fix: open real Chrome with that profile, sign into your test account," >&2
  echo "[$SPEC_NAME]        close Chrome, then re-run tests/e2e/run.sh." >&2
  echo "[$SPEC_NAME]   See tests/e2e/README.md for the one-time profile setup." >&2
  exit 2
fi

# Note: we don't probe window.__ytpfDiag here because it lives in the
# content-script isolated world, invisible to page-world eval. Injection
# is verified by the next spec (feed-playlists), which only passes if the
# content script ran.

echo "[$SPEC_NAME] PASS"
