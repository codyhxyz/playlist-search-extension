#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="save-modal"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Catches the 1.6.11 wrong-modal regression (bar injected into bulk-action
# sheet) and the row-click closes-dialog regression (the lock-open behavior).

# "Me at the zoo" — the first video ever uploaded to YouTube (April 2005).
# It's been pinned as historical and will not be deleted. Using a known-stable
# ID is more reliable than scraping the home feed (which is empty for new
# test accounts with no subscriptions).
WATCH_URL="https://www.youtube.com/watch?v=jNQXAC9IVRw"
echo "[$SPEC_NAME] using watch URL: $WATCH_URL"
agent-browser --session "$SESSION" open "$WATCH_URL" >/dev/null
ab_wait_for "video page loaded" "!!document.querySelector('ytd-watch-flexy')" 15000

# Open the Save dialog. YouTube renders ~20 'More actions' buttons per page
# (one per related-video card), so we MUST scope to the watch-action bar —
# not the related-videos list. The helper inActionBar() picks only buttons
# inside ytd-watch-flexy and outside any video-card container.
JS_INACTIONBAR='(b) => b.offsetParent && b.closest("ytd-watch-flexy") && !b.closest("ytd-rich-item-renderer") && !b.closest("ytd-compact-video-renderer") && !b.closest("ytd-grid-video-renderer")'

ab_wait_for "save action accessible" "(() => {
  const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
  const inActionBar = $JS_INACTIONBAR;
  return buttons.some(b => inActionBar(b) && /^Save( to|\$)/.test(b.getAttribute('aria-label') || '')) ||
         buttons.some(b => inActionBar(b) && b.getAttribute('aria-label') === 'More actions');
})()" 10000

# Capture the element count BEFORE clicking so we can detect dialog opening
# via a DOM-size delta (independent of selector knowledge — YouTube uses
# shadow DOM and offscreen rendering tricks that defeat text-based probes).
BASELINE_COUNT="$(ab_eval 'document.querySelectorAll("*").length')"

SAVE_CLICK_ROUTE="$(ab_eval "(() => {
  const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
  const inActionBar = $JS_INACTIONBAR;
  const direct = buttons.find(b => inActionBar(b) && /^Save( to|\$)/.test(b.getAttribute('aria-label') || ''));
  if (direct) { direct.click(); return 'direct'; }
  const more = buttons.find(b => inActionBar(b) && b.getAttribute('aria-label') === 'More actions');
  if (more) { more.click(); return 'overflow'; }
  return 'none';
})()")"
echo "[$SPEC_NAME] save-click route: $SAVE_CLICK_ROUTE  (baseline DOM size: $BASELINE_COUNT)"

# Only the overflow route needs a second click. Clicking a stale hidden Save
# menu item after the direct button already opened the modal made this spec
# create the same inconsistent behavior it was meant to catch.
if [[ "$SAVE_CLICK_ROUTE" == '"overflow"' ]]; then
  agent-browser --session "$SESSION" wait 1000 >/dev/null
  ab_assert_true "overflow Save item clicked" '(() => {
    const items = Array.from(document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer, [role=\"menuitem\"]"));
    const save = items.find(el => el.offsetParent && /^Save\b/i.test((el.innerText || "").trim()));
    if (save) save.click();
    return !!save;
  })()'
fi

# Wait for SOME save-to-playlist UI to render. YouTube uses two shapes:
#   - Full modal: legacy paper dialog or modern contextual sheet with playlist rows.
#     Rendered when the account has many playlists (typical real users).
#   - Compact picker: small popover anchored to the Save button.
#     Rendered for sparse accounts (≤3 playlists). The extension currently
#     does NOT inject into this shape — it's intentionally scoped to the
#     full modal where its value (search over many) actually matters.
#
# Detect which shape we got and run the relevant assertions.
ab_wait_for "save UI rendered (full modal or DOM-size jump from compact picker)" "(() => {
  const fullModal = Array.from(document.querySelectorAll('$SEL_SAVE_DIALOG'))
    .find((modal) => modal.querySelector('$SEL_DIALOG_PLAYLIST_ROW'));
  if (fullModal) return true;
  // Compact picker renders in a shadow-DOM-heavy container that defeats
  // text-based probes. A reliable structure-agnostic signal: the total
  // element count jumps by >100 when the picker mounts.
  return document.querySelectorAll('*').length > $BASELINE_COUNT + 100;
})()" 10000

# If the compact picker rendered, log + skip the injection assertions. The
# extension targets only the full modal (typical user account); the compact
# picker is what sparse test accounts see and is intentionally not in scope.
COMPACT_PICKER="$(ab_eval "(() => {
  const fullModal = Array.from(document.querySelectorAll('$SEL_SAVE_DIALOG'))
    .find((modal) => modal.querySelector('$SEL_DIALOG_PLAYLIST_ROW'));
  return !fullModal;
})()")"
if [[ "$COMPACT_PICKER" == "true" ]]; then
  ab_fail "compact picker rendered; this account does not exercise the supported full modal"
fi

# Our extension's modal bar must have mounted in the dialog.
ab_wait_for "modal bar mounted" "!!document.querySelector('$SEL_MODAL_INLINE_INPUT')" 8000

# Mount-in-correct-modal assertion: the .ytpf-inline-modal must live inside
# the same dialog that contains the playlist rows (not in a sibling sheet
# like the bulk "Add all to…" overlay — the 1.6.11 bug).
ab_assert_true "modal bar lives in the save-video dialog" "(() => {
  const bar = document.querySelector('$SEL_MODAL_INLINE');
  if (!bar) return false;
  const dialog = bar.closest('$SEL_SAVE_DIALOG');
  return !!(dialog && dialog.querySelector('$SEL_DIALOG_PLAYLIST_ROW'));
})()"

# Opening Save is explicit search intent: once the bar mounts, its input must
# own focus so the user can type immediately without a second click.
ab_assert_true "modal search input receives focus on open" "(() => {
  const input = document.querySelector('$SEL_MODAL_INLINE_INPUT');
  return !!input && document.activeElement === input;
})()"

# Behavior assertion: typing narrows visible playlist rows in the modal.
ab_assert_true "typing narrows modal rows" "(async () => {
  const input = document.querySelector('$SEL_MODAL_INLINE_INPUT');
  if (!input) return false;
  const visibleRows = () => Array.from(
    document.querySelectorAll('$SEL_DIALOG_PLAYLIST_ROW')
  ).filter(r => !r.classList.contains('ytpf-hidden') && r.offsetParent).length;
  const before = visibleRows();
  input.focus();
  input.value = 'zzzqqqzzz';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));
  const after = visibleRows();
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return after < before;
})()"

# A passing keep-open check must also prove YouTube's native toggle ran. Merely
# keeping the dialog visible can mean the extension swallowed the save click.
ab_assert_true "row toggles once and dialog stays open" "(async () => {
  const row = document.querySelector('$SEL_DIALOG_PLAYLIST_ROW');
  if (!row) return false;
  const target = row.querySelector('button[aria-pressed], [role=\"checkbox\"], input[type=\"checkbox\"], button, a, label') || row;
  const state = () => {
    for (const el of [target, row, ...row.querySelectorAll('[aria-pressed], [aria-checked], input[type=\"checkbox\"]')]) {
      if (el.hasAttribute?.('aria-pressed')) return `pressed:${el.getAttribute('aria-pressed')}`;
      if (el.hasAttribute?.('aria-checked')) return `checked:${el.getAttribute('aria-checked')}`;
      if ('checked' in el) return `native:${Boolean(el.checked)}`;
    }
    return null;
  };
  const before = state();
  if (before === null) return false;
  target.click();
  await new Promise(r => setTimeout(r, 600));
  const dialog = row.closest('$SEL_SAVE_DIALOG') || document.querySelector('$SEL_SAVE_DIALOG');
  if (!dialog || dialog.getAttribute('aria-hidden') === 'true' || dialog.hasAttribute('hidden')) return false;
  return state() !== before && !!dialog.querySelector('$SEL_MODAL_INLINE_INPUT');
})()"

echo "[$SPEC_NAME] PASS"
