#!/usr/bin/env bash
# Centralized selectors for e2e specs.
#
# As of 2.0.0 this file is nearly empty, and that is the headline result of the
# rebuild rather than an oversight. The extension reads no data from YouTube's DOM
# and writes no node into it, so there is almost nothing left to select. What
# remains is: the affordances a *user* clicks (which the specs must drive, exactly
# as a person would), and the native dialog we assert is NOT showing.
#
# Assert on behaviour, not markup. YouTube's class names churn weekly; roles and
# visible labels do not.

# ── Ours ────────────────────────────────────────────────────────────────────
# The sheet lives in a CLOSED shadow root, so page-world JS cannot look inside it
# — by design. Specs therefore assert through two doors that do not require
# reaching in:
#   1. `document.activeElement` — focus inside a closed root reports as the HOST,
#      so "the sheet opened and took focus" is observable from the page.
#   2. the accessibility tree (`agent-browser snapshot`), which DOES pierce closed
#      roots. That also means we assert what a screen-reader user actually gets.
SEL_SHEET_HOST="pls-save-sheet"

# ── YouTube's, and only where a user would click ────────────────────────────
SEL_WATCH_PAGE="ytd-watch-flexy"
# The native Save dialog. Asserted ABSENT once ours is up: if this is on screen
# we have stacked two pickers, which is the failure the Escape dismissal covers.
SEL_NATIVE_SAVE_DIALOG="ytd-add-to-playlist-renderer, yt-contextual-sheet-layout, tp-yt-paper-dialog:has(toggleable-list-item-view-model)"
