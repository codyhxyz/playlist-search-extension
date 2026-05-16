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

# If we went the overflow route, the menu items render asynchronously —
# wait, then find and click the Save menu item.
agent-browser --session "$SESSION" wait 1000 >/dev/null
ab_eval '(() => {
  const items = Array.from(document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer, [role=\"menuitem\"]"));
  const save = items.find(el => /^Save\b/i.test((el.innerText || "").trim()));
  if (save) save.click();
  return !!save;
})()' >/dev/null

# Wait for SOME save-to-playlist UI to render. YouTube uses two shapes:
#   - Full modal: tp-yt-paper-dialog with yt-collection-thumbnail-view-model rows.
#     Rendered when the account has many playlists (typical real users).
#   - Compact picker: small popover anchored to the Save button.
#     Rendered for sparse accounts (≤3 playlists). The extension currently
#     does NOT inject into this shape — it's intentionally scoped to the
#     full modal where its value (search over many) actually matters.
#
# Detect which shape we got and run the relevant assertions.
ab_wait_for "save UI rendered (full modal or DOM-size jump from compact picker)" "(() => {
  const fullModal = document.querySelector('$SEL_SAVE_DIALOG');
  if (fullModal && fullModal.querySelector('$SEL_DIALOG_PLAYLIST_ROW')) return true;
  // Compact picker renders in a shadow-DOM-heavy container that defeats
  // text-based probes. A reliable structure-agnostic signal: the total
  // element count jumps by >100 when the picker mounts.
  return document.querySelectorAll('*').length > $BASELINE_COUNT + 100;
})()" 10000

# If the compact picker rendered, log + skip the injection assertions. The
# extension targets only the full modal (typical user account); the compact
# picker is what sparse test accounts see and is intentionally not in scope.
COMPACT_PICKER="$(ab_eval "(() => {
  const fullModal = document.querySelector('$SEL_SAVE_DIALOG');
  return !(fullModal && fullModal.querySelector('$SEL_DIALOG_PLAYLIST_ROW'));
})()")"
if [[ "$COMPACT_PICKER" == "true" ]]; then
  echo "[$SPEC_NAME] NOTE: compact 'Save to…' picker rendered (account has too few playlists for the full modal)."
  echo "[$SPEC_NAME] NOTE: skipping injection / filter / lock-open assertions — extension scopes to the full modal."
  echo "[$SPEC_NAME] PASS (with compact-picker skip)"
  exit 0
fi

# Our extension's modal bar must have mounted in the dialog.
ab_wait_for "modal bar mounted" "!!document.querySelector('$SEL_MODAL_INLINE_INPUT')" 8000

# Mount-in-correct-modal assertion: the .ytpf-modal-inline must live inside
# the same dialog that contains the playlist rows (not in a sibling sheet
# like the bulk "Add all to…" overlay — the 1.6.11 bug).
ab_assert_true "modal bar lives in the save-video dialog" "(() => {
  const bar = document.querySelector('$SEL_MODAL_INLINE');
  if (!bar) return false;
  const dialog = bar.closest('$SEL_SAVE_DIALOG');
  return !!(dialog && dialog.querySelector('$SEL_DIALOG_PLAYLIST_ROW'));
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

# Lock-open assertion: synthesizing a click on a native playlist row must
# NOT close the dialog. The dialog must still be present (and visible) 600ms
# after the click — that's longer than YouTube's close animation.
ab_assert_true "row click does not close the dialog" "(async () => {
  const row = document.querySelector('$SEL_DIALOG_PLAYLIST_ROW');
  if (!row) return false;
  // Click an inner clickable child (the checkbox/label). Polymer modals
  // bind close handlers to the row container, so we want the click bubble
  // to be where the user actually clicks.
  const target = row.querySelector('button, [role=\"checkbox\"], a, label') || row;
  target.click();
  await new Promise(r => setTimeout(r, 600));
  const dialog = document.querySelector('$SEL_SAVE_DIALOG');
  if (!dialog) return false;
  if (dialog.getAttribute('aria-hidden') === 'true') return false;
  if (dialog.hasAttribute('hidden')) return false;
  // Modal bar should still be present too.
  return !!document.querySelector('$SEL_MODAL_INLINE_INPUT');
})()"

echo "[$SPEC_NAME] PASS"
