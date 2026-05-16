#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="feed-playlists"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Catches the 1.6.7 "stupid spot" regression (bar mounted in a nested wrapper,
# rendered narrow / off-center) and the 1.6.11 WeakMap regression (refresh
# threw on iteration, page-surface code never ran).

agent-browser --session "$SESSION" open "https://www.youtube.com/feed/playlists" >/dev/null
ab_wait_for "playlist grid rendered" "!!document.querySelector('$SEL_PLAYLISTS_GRID')" 12000
ab_wait_for "inline page bar mounted" "!!document.querySelector('$SEL_INLINE_PAGE')" 8000

# Single-mount assertion: catches double-injection regressions (e.g. an e2e
# manifest variant adding static content_scripts on top of background.js's
# dynamic registerContentScripts, or background.js firing register twice).
ab_assert_true "exactly one inline page bar (no duplicates)" "document.querySelectorAll('$SEL_INLINE_PAGE').length === 1"

# Mount-position assertion: the bar's parent must be the rich-grid #contents,
# not a nested wrapper. This is what 1.6.7 got wrong.
ab_assert_true "mounted as direct sibling of grid contents" "(() => {
  const bar = document.querySelector('$SEL_INLINE_PAGE');
  if (!bar) return false;
  const parent = bar.parentElement;
  if (!parent) return false;
  if (parent.id !== 'contents') return false;
  const grid = parent.closest('ytd-rich-grid-renderer');
  return !!grid;
})()"

# Width assertion: the bar should span the full grid width. A nested-wrapper
# mount typically renders ≤ 400px (the stupid-spot symptom). Threshold is
# 600px which is well below normal full-width but well above the bug.
ab_assert_true "bar width >= 600px" "(() => {
  const bar = document.querySelector('$SEL_INLINE_PAGE');
  return bar && bar.getBoundingClientRect().width >= 600;
})()"

# Behavior assertion: typing into the input filters rows. Don't rely on a
# specific playlist name — the user's account may have any content. Use the
# first 3 chars of the first visible playlist's title; that guarantees ≥1
# match. After filtering, hidden-row count must increase.
ab_assert_true "typing narrows visible rows" "(async () => {
  const bar = document.querySelector('$SEL_INLINE_PAGE');
  if (!bar) return false;
  const input = bar.querySelector('input');
  if (!input) return false;
  const beforeHidden = document.querySelectorAll('.ytpf-hidden').length;
  // Synthesize a multi-key input event (the extension debounces on input).
  input.focus();
  input.value = 'zzzqqqzzz';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 350));
  const afterHidden = document.querySelectorAll('.ytpf-hidden').length;
  // Reset for the next spec.
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return afterHidden > beforeHidden;
})()"

# Indexed count assertion: the placeholder reads 'Filter N playlists' once
# the page index populates. N >= 1 catches the InnerTube-cap regression in
# its degenerate form (1.6.9: parser walked past lockup-shaped items,
# dropping ALL of them, leaving 0). The minimum threshold here stays low
# so the spec works on any test account; innertube-fetch.sh enforces a
# higher account-specific bound via YTPF_EXPECTED_MIN_PLAYLISTS.
ab_assert_true "placeholder reports indexed count >= 1" "(() => {
  const input = document.querySelector('$SEL_INLINE_PAGE input');
  if (!input) return false;
  const m = (input.placeholder || '').match(/Filter (\d+) playlists/);
  return !!m && Number(m[1]) >= 1;
})()"

echo "[$SPEC_NAME] PASS"
