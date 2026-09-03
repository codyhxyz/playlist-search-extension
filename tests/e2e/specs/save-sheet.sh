#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="save-sheet"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# The save sheet, driven the way a person drives it, on MORE THAN ONE SURFACE.
#
# Why the plural matters: the 1.x extension worked on the watch page and silently
# did nothing on the home feed for an entire release. The bug was not that the feed
# was hard — it was that one surface was tested and the result was generalised to a
# category. tests/e2e is where that generalisation gets refused, so this spec drives
# the watch page AND the feed and reports them separately.
#
# We never reach into the sheet: it is a closed shadow root. Everything below is
# asserted through the accessibility tree (which pierces closed roots) and through
# document.activeElement (focus inside a closed root reports as the host). Both
# describe what a user gets rather than what our markup is called.
#
# REQUIRES a signed-in YouTube session (see tests/e2e/run.sh).

FAILED_SURFACES=()

# Close whatever is open so each surface starts from nothing. Escape closes our
# dialog (UA behaviour) and YouTube's popovers alike.
reset_page() {
  agent-browser --session "$SESSION" eval \
    'document.activeElement && document.activeElement.blur(); document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))' \
    >/dev/null 2>&1 || true
  agent-browser --session "$SESSION" press Escape >/dev/null 2>&1 || true
  agent-browser --session "$SESSION" wait 400 >/dev/null 2>&1 || true
}

# The shared contract, asserted identically for every surface. If a surface can
# open the sheet at all, it must open THE SAME sheet.
assert_sheet_opened() {
  local surface="$1"

  if [[ -z "$(ab_sheet_tree)" ]]; then
    echo "[$SPEC_NAME] FAIL: $surface — no sheet appeared" >&2
    echo "[$SPEC_NAME]   screenshot: $(ab_snap "$surface-nosheet")" >&2
    FAILED_SURFACES+=("$surface")
    return 1
  fi

  # Soft on purpose. A hard assertion exits the whole script, which would mean a
  # watch-page failure silently skips the home feed — the one surface this spec
  # exists to stop us from inferring.
  local ok=0
  ab_soft_true "$surface: sheet took focus into its own surface" "$ab_sheet_open_js" || ok=1
  ab_soft_sheet_a11y "$surface: a search field is exposed" '(combobox|textbox|searchbox)' || ok=1
  ab_soft_sheet_a11y_min "$surface: playlists are listed as options" '^\s*-?\s*option' 3 || ok=1
  ab_soft_true "$surface: YouTube's own save dialog is not stacked behind ours" \
    "document.querySelectorAll('$SEL_NATIVE_SAVE_DIALOG').length === 0" || ok=1

  if [[ "$ok" -ne 0 ]]; then
    echo "[$SPEC_NAME]   screenshot: $(ab_snap "$surface-partial")" >&2
    FAILED_SURFACES+=("$surface")
    return 1
  fi
  return 0
}

# ── Surface 1: the watch page action bar ────────────────────────────────────
# Discovered at runtime rather than hardcoded — "Me at the zoo", the oldest video
# on YouTube, is as close to a permanent fixture as the site has.
WATCH_URL="https://www.youtube.com/watch?v=jNQXAC9IVRw"
echo "[$SPEC_NAME] ── surface: watch page ──"
agent-browser --session "$SESSION" open "$WATCH_URL" >/dev/null
ab_wait_for "watch page loaded" "!!document.querySelector('$SEL_WATCH_PAGE')" 20000
# The content script registers at document_idle and the MAIN-world hook at
# document_start; give the SPA a moment to settle before clicking.
agent-browser --session "$SESSION" wait 2500 >/dev/null

# YouTube moves Save between the action bar and the overflow menu depending on
# width and rollout, so try the direct button and fall back to the menu — that is
# what a user does too.
IN_ACTION_BAR='(b) => b.offsetParent && b.closest("ytd-watch-flexy") && !b.closest("ytd-rich-item-renderer")'
ROUTE="$(ab_eval "(() => {
  const buttons = Array.from(document.querySelectorAll('button[aria-label]'));
  const inBar = $IN_ACTION_BAR;
  const direct = buttons.find(b => inBar(b) && /^Save( to|\$)/.test(b.getAttribute('aria-label') || ''));
  if (direct) { direct.click(); return 'direct'; }
  const more = buttons.find(b => inBar(b) && b.getAttribute('aria-label') === 'More actions');
  if (more) { more.click(); return 'overflow'; }
  return 'none';
})()")"
echo "[$SPEC_NAME] watch-page save route: $ROUTE"

if [[ "$ROUTE" == '"overflow"' ]]; then
  agent-browser --session "$SESSION" wait 900 >/dev/null
  ab_assert_true "overflow menu offers Save" '(() => {
    const items = Array.from(document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer, [role=\"menuitem\"]"));
    const save = items.find(el => el.offsetParent && /^Save\b/i.test((el.innerText || "").trim()));
    if (save) save.click();
    return !!save;
  })()'
elif [[ "$ROUTE" == '"none"' ]]; then
  ab_fail "no Save affordance on the watch page at all"
fi

ab_wait_a11y "watch page: sheet rendered" '^\s*-?\s*option' 20000
assert_sheet_opened "watch" || true

# Typing must narrow the list. Driven through the a11y tree so the closed root
# stays closed: we type into the exposed search field and count the options.
BEFORE="$(ab_sheet_a11y_count '^\s*-?\s*option')"
agent-browser --session "$SESSION" eval '(() => {
  const host = document.activeElement;
  host.dispatchEvent(new KeyboardEvent("keydown", { key: "z", bubbles: true }));
})()' >/dev/null 2>&1 || true
# Real keystrokes, so the input handler runs exactly as it does for a person.
agent-browser --session "$SESSION" keyboard type "zzzqqq" >/dev/null 2>&1 || true
agent-browser --session "$SESSION" wait 600 >/dev/null
AFTER="$(ab_sheet_a11y_count '^\s*-?\s*option')"
if [[ "$AFTER" -lt "$BEFORE" ]]; then
  echo "[$SPEC_NAME] PASS: watch: typing narrows the list ($BEFORE -> $AFTER)"
else
  echo "[$SPEC_NAME] FAIL: watch: typing did not narrow the list ($BEFORE -> $AFTER)" >&2
  echo "[$SPEC_NAME]   screenshot: $(ab_snap watch-nofilter)" >&2
  FAILED_SURFACES+=("watch-filter")
fi

reset_page
ab_assert_true "watch: Escape closes the sheet and leaves nothing behind" "!($ab_sheet_open_js)"

# ── Surface 2: the home feed ⋮ menu ─────────────────────────────────────────
# THE regression. Same intent, different surface, and for one release it silently
# did nothing here. The root cause was percent-encoded `params` throwing inside
# atob() — invisible unless a spec actually clicks this menu.
echo "[$SPEC_NAME] ── surface: home feed ──"
agent-browser --session "$SESSION" open "https://www.youtube.com/" >/dev/null
ab_wait_for "feed rendered" "document.querySelectorAll('ytd-rich-item-renderer').length > 2" 20000
agent-browser --session "$SESSION" wait 2000 >/dev/null

MENU_OPENED="$(ab_eval '(() => {
  const items = Array.from(document.querySelectorAll("ytd-rich-item-renderer"))
    .filter((el) => el.offsetParent && el.querySelector("a#thumbnail[href*=\"watch?v=\"]"));
  for (const item of items.slice(0, 6)) {
    const menu = item.querySelector("button[aria-label=\"More actions\"], ytd-menu-renderer button");
    if (menu && menu.offsetParent) { menu.click(); return true; }
  }
  return false;
})()')"
if [[ "$MENU_OPENED" != "true" ]]; then
  ab_fail "could not open a ⋮ menu on any home-feed video"
fi
agent-browser --session "$SESSION" wait 900 >/dev/null

SAVE_CLICKED="$(ab_eval '(() => {
  const items = Array.from(document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer, [role=\"menuitem\"]"));
  // "Save to playlist" specifically — "Save to Watch Later" is a different action
  // that never opens a picker, so matching /^Save/ would pass without proving
  // anything.
  const save = items.find((el) => el.offsetParent && /save to playlist/i.test(el.innerText || ""));
  if (save) { save.click(); return true; }
  return false;
})()')"
if [[ "$SAVE_CLICKED" != "true" ]]; then
  echo "[$SPEC_NAME]   menu items were: $(ab_eval '(() => Array.from(document.querySelectorAll("tp-yt-paper-item, ytd-menu-service-item-renderer, [role=\"menuitem\"]")).filter(e=>e.offsetParent).map(e=>(e.innerText||"").trim()).join(" | "))')" >&2
  ab_fail "the home-feed ⋮ menu has no 'Save to playlist' item"
fi

ab_wait_a11y "home feed: sheet rendered" '^\s*-?\s*option' 20000
assert_sheet_opened "feed" || true
reset_page

# ── Result ──────────────────────────────────────────────────────────────────
if [[ "${#FAILED_SURFACES[@]}" -eq 0 ]]; then
  echo "[$SPEC_NAME] PASS (watch + feed)"
else
  echo "[$SPEC_NAME] FAIL on: ${FAILED_SURFACES[*]}" >&2
  exit 1
fi
