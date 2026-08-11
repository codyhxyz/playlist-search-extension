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

# Require an account avatar and reject any visible Sign in control. Checking
# for one page-specific signed-out sentence produced false passes on Home.
RESULT="$(ab_eval '(() => {
  const visibleSignIn = Array.from(document.querySelectorAll("a, button"))
    .some((el) => el.offsetParent && /^Sign in$/i.test((el.innerText || "").trim()));
  const avatar = document.querySelector("#avatar-btn img, button#avatar-btn img");
  return { signedIn: Boolean(avatar) && !visibleSignIn, url: location.href };
})()')"
echo "[$SPEC_NAME] account probe: $RESULT"

if ! echo "$RESULT" | grep -q '"signedIn":true'; then
  echo "[$SPEC_NAME] FAIL: not signed in." >&2
  echo "[$SPEC_NAME]   The isolated profile '${YTPF_TEST_PROFILE:-unknown}' isn't signed into YouTube." >&2
  echo "[$SPEC_NAME]   Sign into the open test window, then re-run tests/e2e/run.sh." >&2
  echo "[$SPEC_NAME]   See tests/e2e/README.md for the one-time profile setup." >&2
  exit 2
fi

# Note: we don't probe window.__ytpfDiag here because it lives in the
# content-script isolated world, invisible to page-world eval. Injection
# is verified by the next spec (feed-playlists), which only passes if the
# content script ran.

echo "[$SPEC_NAME] PASS"
