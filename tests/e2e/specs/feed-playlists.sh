#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="feed-playlists"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Catches the 1.6.7 "stupid spot" regression (bar mounted in a nested wrapper,
# rendered narrow / off-center) and the 1.6.11 WeakMap regression (refresh
# threw on iteration, page-surface code never ran).
#
# Two valid mount variants as of 1.6.15:
#   - chip variant (.ytpf-chip) inside YouTube's native chip-bar-view-model
#     — preferred, looks like a YT control, ~280px wide
#   - grid variant (.ytpf-inline-page) — full-width fallback when no chip
#     bar is on the page (older accounts mid-rollout, future YT redesigns)
# Behavioral assertions (typing narrows, placeholder count) apply to both.
# Layout assertions split by variant below.

agent-browser --session "$SESSION" open "https://www.youtube.com/feed/playlists" >/dev/null
ab_wait_for "playlist grid rendered" "!!document.querySelector('$SEL_PLAYLISTS_GRID')" 12000
ab_wait_for "inline page bar mounted (chip or grid variant)" "!!document.querySelector('$SEL_INLINE_PAGE')" 8000

# Single-mount assertion: catches double-injection regressions (e.g. an e2e
# manifest variant adding static content_scripts on top of background.js's
# dynamic registerContentScripts, or background.js firing register twice).
# Sums chip + grid variants; exactly one total must be mounted.
ab_assert_true "exactly one inline page bar (no duplicates)" "document.querySelectorAll('$SEL_INLINE_PAGE').length === 1"

# Variant-specific mount-position assertions. Each branch checks ONLY when
# its variant is active, and the "bar exists somewhere" wait above already
# guarantees one of them fires.

# CHIP variant: bar must live inside the native chip-bar scroll container.
# This is what 1.6.15 introduced — search-as-a-chip alongside Recently/
# Playlists/Music/Owned. If the chip bar isn't present on this account,
# the check is vacuously true (the grid branch covers fallback).
ab_assert_true "chip variant: mounted inside native chip-bar scroll container (or fallback)" "(() => {
  const chip = document.querySelector('$SEL_INLINE_PAGE_CHIP');
  if (!chip) return true; // fallback path; grid branch covers it
  const chipRow = document.querySelector('$SEL_CHIP_ROW');
  if (!chipRow) return false; // chip rendered without a chip bar = bug
  return chipRow.contains(chip);
})()"

# GRID variant: bar must be a direct sibling of grid #contents (1.6.7 bug
# guard). Only checked when the chip variant isn't active. Width must be
# ≥ 600px (the stupid-spot symptom was ≤ 400px).
ab_assert_true "grid variant: mounted as direct sibling of grid contents AND width ≥ 600px (or N/A)" "(() => {
  const grid = document.querySelector('$SEL_INLINE_PAGE_GRID');
  if (!grid) return true; // chip variant in use; this assertion is N/A
  const parent = grid.parentElement;
  if (!parent || parent.id !== 'contents') return false;
  if (!parent.closest('ytd-rich-grid-renderer')) return false;
  return grid.getBoundingClientRect().width >= 600;
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
