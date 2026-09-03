#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="feed-playlists"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Contract for the owned /feed/playlists surface (v1.7+).
#
# The extension does NOT filter YouTube's rendered playlist cards any more.
# It renders its own result list from the InnerTube library snapshot and hides
# YouTube's grid while those results are showing. That removes the entire
# class of regression this spec used to chase (1.6.6 / 1.6.7 / 1.6.8 / 1.6.10
# / 1.6.15 / 1.6.17 were all "YouTube changed their card markup").
#
# What's left to assert, against the real signed-in page:
#   1. Both DOM anchors resolve, and the chip mounts in the right one.
#   2. There is no fallback bar and no hidden-row machinery any more.
#   3. Typing shows OUR results and hides THEIR grid.
#   4. Clearing restores their grid exactly.

agent-browser --session "$SESSION" open "https://www.youtube.com/feed/playlists" >/dev/null

# ── 1. Anchors ──────────────────────────────────────────────────────────
ab_wait_for "anchor 2/2: YouTube's playlist grid rendered" \
  "!!document.querySelector('$SEL_FEED_GRID_ANCHOR')" 12000
ab_wait_for "anchor 1/2: native chip bar rendered" \
  "!!document.querySelector(\"$SEL_FEED_MOUNT_ANCHOR\")" 12000
ab_wait_for "search chip mounted" "!!document.querySelector('$SEL_CHIP')" 8000

# Single-mount assertion: catches double-injection regressions (e.g. an e2e
# manifest variant adding static content_scripts on top of background.js's
# dynamic registerContentScripts, or background.js firing register twice).
ab_assert_true "exactly one search chip (no duplicates)" \
  "document.querySelectorAll('$SEL_CHIP').length === 1"

ab_assert_true "chip mounted inside the native chip bar (1.6.7 'stupid spot' guard)" "(() => {
  const chip = document.querySelector('$SEL_CHIP');
  const bar = document.querySelector(\"$SEL_FEED_MOUNT_ANCHOR\");
  return !!chip && !!bar && bar.contains(chip);
})()"

# ── 2. The deleted architecture stays deleted ───────────────────────────
# NO FALLBACK MOUNTS: the full-width grid-span bar is gone. If it ever comes
# back it means someone re-added a fallback, which is how the bar ends up
# rendering somewhere nobody expected.
ab_assert_true "no legacy full-width fallback bar exists" \
  "document.querySelectorAll('$SEL_LEGACY_FALLBACK_BAR').length === 0"

# We never hide, mark, or reflow YouTube's cards any more.
ab_assert_true "no .ytpf-hidden rows anywhere (we don't touch their cards)" \
  "document.querySelectorAll('.ytpf-hidden').length === 0"
ab_assert_true "no .ytpf-page-filtering reflow classes anywhere" \
  "document.querySelectorAll('.ytpf-page-filtering, .ytpf-page-filtering-rows').length === 0"

ab_assert_true "extension reports exactly 2 DOM anchors for this surface" "(() => {
  const d = window.__ytpfDiag && window.__ytpfDiag();
  return !!d && d.anchors.length === 2 && d.anchors.every(a => a.visible === 1);
})()"

# ── 3. Library indexed from InnerTube ───────────────────────────────────
# The placeholder is our page-world-readable proxy for "how many playlists
# did the InnerTube fetch + parser actually surface?". Pre-1.7 this counted
# rendered DOM rows, which made it blind to the 1.6.9 parser cap it claimed
# to guard. It now counts the library snapshot we render from.
ab_wait_for "library indexed (placeholder reports a count)" "(() => {
  const i = document.querySelector('$SEL_CHIP input');
  return !!i && /Search \d+ playlists/.test(i.placeholder || '');
})()" 20000

ab_assert_true "indexed count >= 1" "(() => {
  const i = document.querySelector('$SEL_CHIP input');
  const m = (i.placeholder || '').match(/Search (\d+) playlists/);
  return !!m && Number(m[1]) >= 1;
})()"

# ── 4. Idle state: their grid untouched, our panel dormant ──────────────
ab_assert_true "results panel is attached but hidden with no query" "(() => {
  const p = document.querySelector('$SEL_FEED_PANEL');
  return !!p && p.hidden === true;
})()"

ab_assert_true "YouTube's grid is visible with no query" "(() => {
  const g = document.querySelector('$SEL_FEED_GRID_ANCHOR');
  return !!g && getComputedStyle(g).display !== 'none';
})()"

# ── 5. Query active: our results render, their grid hides ───────────────
# Don't rely on a specific playlist name — the account may hold anything.
# Probe common letters until one matches, then assert on that.
ab_assert_true "typing renders OUR result cards and hides THEIR grid" "(async () => {
  const input = document.querySelector('$SEL_CHIP input');
  const grid = document.querySelector('$SEL_FEED_GRID_ANCHOR');
  const panel = document.querySelector('$SEL_FEED_PANEL');
  if (!input || !grid || !panel) return false;
  window.__ytpfSpecGridStyle = grid.getAttribute('style');

  const type = async (v) => {
    input.focus();
    input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 400));
  };

  for (const letter of ['a', 'e', 'i', 'o', 's', 'm']) {
    await type(letter);
    const cards = panel.shadowRoot.querySelectorAll('li .link');
    if (!cards.length) continue;
    const href = cards[0].getAttribute('href') || '';
    return panel.hidden === false
      && /^\/playlist\?list=/.test(href)
      && getComputedStyle(grid).display === 'none';
  }
  return false;
})()"

ab_assert_true "result meta reports 'N of M playlists'" "(() => {
  const panel = document.querySelector('$SEL_FEED_PANEL');
  const meta = panel && panel.shadowRoot.querySelector('.meta');
  return !!meta && /\d+ of \d+ playlists/.test(meta.textContent || '');
})()"

# ── 6. Clearing restores their grid exactly ─────────────────────────────
ab_assert_true "clearing the query restores YouTube's grid byte-for-byte" "(async () => {
  const input = document.querySelector('$SEL_CHIP input');
  const grid = document.querySelector('$SEL_FEED_GRID_ANCHOR');
  const panel = document.querySelector('$SEL_FEED_PANEL');
  if (!input || !grid || !panel) return false;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  return panel.hidden === true
    && getComputedStyle(grid).display !== 'none'
    && grid.getAttribute('style') === window.__ytpfSpecGridStyle;
})()"

echo "[$SPEC_NAME] PASS"
