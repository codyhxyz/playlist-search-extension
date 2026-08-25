#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="save-modal"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Owned-save-sheet contract (since v1.7): clicking the action-bar Save button
# must open OUR shadow-DOM sheet and keep YouTube's native modal closed. All
# assertions run against our own stable host id (#ytpf-save-sheet-host), so
# YouTube DOM drift cannot break this spec — it can only break the product,
# loudly, at the one interception point.
#
# REQUIRES a signed-in YouTube session (see tests/e2e/run.sh).

WATCH_URL="https://www.youtube.com/watch?v=jNQXAC9IVRw"
echo "[$SPEC_NAME] using watch URL: $WATCH_URL"
agent-browser --session "$SESSION" open "$WATCH_URL" >/dev/null
ab_wait_for "video page loaded" "!!document.querySelector('ytd-watch-flexy')" 15000

JS_INACTIONBAR='(b) => b.offsetParent && b.closest("ytd-watch-flexy") && !b.closest("ytd-rich-item-renderer")'

ab_wait_for "save action accessible" "(() => {
  const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
  const inActionBar = $JS_INACTIONBAR;
  return buttons.some(b => inActionBar(b) && /^Save( to|\$)/.test(b.getAttribute('aria-label') || '')) ||
         buttons.some(b => inActionBar(b) && b.getAttribute('aria-label') === 'More actions');
})()" 10000

SAVE_CLICK_ROUTE="$(ab_eval "(() => {
  const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
  const inActionBar = $JS_INACTIONBAR;
  const direct = buttons.find(b => inActionBar(b) && /^Save( to|\$)/.test(b.getAttribute('aria-label') || ''));
  if (direct) { direct.click(); return 'direct'; }
  const more = buttons.find(b => inActionBar(b) && b.getAttribute('aria-label') === 'More actions');
  if (more) { more.click(); return 'overflow'; }
  return 'none';
})()")"
echo "[$SPEC_NAME] save-click route: $SAVE_CLICK_ROUTE"

if [[ "$SAVE_CLICK_ROUTE" == '"overflow"' ]]; then
  agent-browser --session "$SESSION" wait 1000 >/dev/null
  ab_assert_true "overflow Save item clicked" '(() => {
    const items = Array.from(document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer, [role=\"menuitem\"]"));
    const save = items.find(el => el.offsetParent && /^Save\b/i.test((el.innerText || "").trim()));
    if (save) save.click();
    return !!save;
  })()'
fi

# Our sheet host must appear; YouTube's native dialog must NOT.
ab_wait_for "owned save sheet mounted" "!!document.querySelector('$SEL_SHEET_HOST')" 10000

ab_assert_true "YouTube's native save modal stays closed" "(() => {
  return document.querySelectorAll('$SEL_SAVE_DIALOG').length === 0;
})()"

ab_assert_true "sheet search input receives focus on open" "(() => {
  const host = document.querySelector('$SEL_SHEET_HOST');
  const input = host?.shadowRoot?.querySelector('input');
  return !!input && host.shadowRoot.activeElement === input;
})()"

# Behavior: typing narrows rows inside our shadow root.
ab_assert_true "typing narrows sheet rows" "(async () => {
  const host = document.querySelector('$SEL_SHEET_HOST');
  const root = host?.shadowRoot;
  if (!root) return false;
  // Wait for the library fetch to land (rows render into .list).
  for (let i = 0; i < 40 && root.querySelectorAll('.row').length < 2; i++) {
    await new Promise(r => setTimeout(r, 250));
  }
  const before = root.querySelectorAll('.row').length;
  if (before < 2) return false;
  const input = root.querySelector('input');
  input.focus();
  input.value = 'zzzqqqzzz';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  const after = root.querySelectorAll('.row').length;
  input.value = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return after === 0;
})()"

# Escape closes the sheet.
ab_assert_true "escape closes the sheet" "(async () => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise(r => setTimeout(r, 300));
  return !document.querySelector('$SEL_SHEET_HOST');
})()"

echo "[$SPEC_NAME] PASS"
