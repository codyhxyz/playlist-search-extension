#!/usr/bin/env bash
set -euo pipefail
LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
SPEC_NAME="intent-chain"
source "$LIB/selectors.sh"
source "$LIB/assert.sh"

# Our plumbing, isolated from YouTube's UI.
#
# `save-sheet.sh` clicks YouTube's real Save button, which is the test that matters
# — but when it fails it cannot tell you *which side* broke: did YouTube move the
# button, or did our chain stop working? This spec answers that half. It fires the
# request YouTube's own client fires, directly, and asserts every hop:
#
#     page fetch  ->  MAIN-world hook  ->  content script relay
#                 ->  service worker (decode + gate)  ->  content script  ->  sheet
#
# It needs no Save button, no menu, and **no signed-in session** — so it stays green
# when cookies expire, and a failure here is unambiguously ours.
#
# The `params` blob is the exact shape that broke the home feed: a padded,
# percent-encoded base64 protobuf with the videoId at field 111.1. `atob` throws on
# `%`, which is why saving worked on the watch page and silently did nothing in the
# feed for a full release. If that regresses, this spec fails before a user finds it.

VIDEO_ID="jNQXAC9IVRw"
# field 111 { field 1: "jNQXAC9IVRw" }, base64url, padded, percent-encoded.
PARAMS='-gYNCgtqTlFYQUM5SVZSdw%3D%3D'

agent-browser --session "$SESSION" open "https://www.youtube.com/watch?v=$VIDEO_ID" >/dev/null
ab_wait_for "page loaded" 'document.readyState === "complete"' 20000

# Hop 1: is the observer even installed? It runs in the page's own world, so unlike
# everything else in the extension it is directly visible from a page-world eval.
ab_wait_for "MAIN-world hook installed" 'window.__plsIntentHook === true' 15000
ab_assert_true "hook patched window.fetch" '!/\[native code\]/.test(String(window.fetch))'

# Hops 2-5, in one shot.
RESULT="$(ab_eval "(async () => {
  try {
    await fetch('/youtubei/v1/get_panel?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panelId: 'PAadd_to_playlist', params: '$PARAMS' })
    });
  } catch (e) { /* the response is irrelevant; the request is the signal */ }
  for (let i = 0; i < 40; i++) {
    const a = document.activeElement;
    if (a && a.parentElement === document.documentElement && a.tagName.includes('-')) {
      return { opened: true, host: a.tagName.toLowerCase() };
    }
    await new Promise(r => setTimeout(r, 250));
  }
  return { opened: false, host: null };
})()")"
echo "[$SPEC_NAME] chain result: $RESULT"

echo "$RESULT" | grep -q '"opened":true' || ab_fail \
  "the sheet never opened. One of: the hook did not observe the request, the relay to the service worker failed, the panelId gate rejected it, the videoId did not decode out of the params protobuf, or the content script never received SAVE_INTENT. Check the service-worker console for [pls][sw] lines"

# The videoId is the real proof: the sheet can only carry it if the worker walked
# the percent-encoded protobuf and pulled field 111.1 out of it. It is no longer
# rendered — showing users an 11-character id was debug output that escaped — so
# read it from the host element, where the sheet parks it for exactly this.
ab_assert_true "the decoded videoId reached the sheet" "(() => {
  const a = document.activeElement;
  return !!a && a.getAttribute('data-video-id') === '$VIDEO_ID';
})()"
ab_assert_sheet_a11y "the sheet exposes a search field" '(combobox|textbox|searchbox)'
ab_assert_sheet_a11y "the sheet exposes a listbox" 'listbox'

# ── The sheet owns the keyboard while it is open ────────────────────────────
# YouTube binds single keys on `document` — f fullscreen, k play/pause, m mute,
# t theater — and guards them with "ignore this if the user is typing". Shadow
# retargeting defeats that guard: the event reaches document with our HOST as its
# target, which is not an input. Typing a query used to fire the shortcuts.
#
# Real keystrokes, real page, and we check YouTube's actual state rather than
# whether an event was seen — this is the assertion that would have caught it.
PRE_STATE="$(ab_eval '(() => {
  const v = document.querySelector("video");
  return { fullscreen: !!document.fullscreenElement, paused: v ? v.paused : null, theater: !!document.querySelector("ytd-watch-flexy[theater]") };
})()')"
echo "[$SPEC_NAME] player state before typing: $PRE_STATE"

# Every one of these is a YouTube shortcut. They are also just letters someone
# might plausibly type while searching for a playlist.
agent-browser --session "$SESSION" keyboard type "fkmt" >/dev/null 2>&1 || true
agent-browser --session "$SESSION" wait 900 >/dev/null

POST_STATE="$(ab_eval '(() => {
  const v = document.querySelector("video");
  return { fullscreen: !!document.fullscreenElement, paused: v ? v.paused : null, theater: !!document.querySelector("ytd-watch-flexy[theater]") };
})()')"
echo "[$SPEC_NAME] player state after typing:  $POST_STATE"

if [[ "$PRE_STATE" == "$POST_STATE" ]]; then
  echo "[$SPEC_NAME] PASS: typing f/k/m/t in the sheet changed nothing about YouTube's player"
else
  ab_fail "typing in the sheet leaked to YouTube's keyboard shortcuts — player state changed from $PRE_STATE to $POST_STATE"
fi

# And the query actually received those keystrokes, so the block is not just
# "no keys reached anything".
ab_assert_sheet_a11y "the keystrokes landed in our search field instead" '(No playlist matches|fkmt|0 of)'

agent-browser --session "$SESSION" press Escape >/dev/null 2>&1 || true
agent-browser --session "$SESSION" wait 500 >/dev/null

# The generic-endpoint gate. `get_panel` is shared with unrelated panels (the "Ask"
# panel uses it with no panelId), and firing on the URL alone is exactly how the 1.x
# extension rendered itself inside menus that had nothing to do with saving.
agent-browser --session "$SESSION" press Escape >/dev/null 2>&1 || true
agent-browser --session "$SESSION" wait 500 >/dev/null
DECOY="$(ab_eval "(async () => {
  try {
    await fetch('/youtubei/v1/get_panel?prettyPrint=false', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ params: 'CAF6BlBUOkNBVQ' })
    });
  } catch (e) {}
  await new Promise(r => setTimeout(r, 2500));
  const a = document.activeElement;
  return { opened: !!(a && a.parentElement === document.documentElement && a.tagName.includes('-')) };
})()")"
echo "$DECOY" | grep -q '"opened":false' \
  || ab_fail "a get_panel request WITHOUT panelId opened the sheet — the gate is off, and the extension will appear inside unrelated YouTube menus"
echo "[$SPEC_NAME] PASS: a get_panel call with no panelId is correctly ignored"

echo "[$SPEC_NAME] PASS"
