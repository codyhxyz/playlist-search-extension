#!/usr/bin/env bash
# Centralized selectors for e2e specs.
#
# YouTube's DOM changes constantly; every spec sources this file so a single
# selector update unblocks all of them. Specs should assert on BEHAVIOR (bar
# exists, filter narrows results) more than exact selectors — but where a
# selector is unavoidable, reach for the constant from this file.

# Our extension's mounted nodes — these are stable because we own them.
# Since v1.7 there is exactly ONE mount shape on /feed/playlists: the search
# chip inside YouTube's native filter-chip row. The historic full-width
# `.ytpf-inline-page` fallback bar is gone on purpose (see CHANGELOG /
# selectors.js "NO FALLBACK MOUNTS"), so specs assert its ABSENCE.
SEL_CHIP=".ytpf-inline.ytpf-chip"
SEL_LEGACY_FALLBACK_BAR=".ytpf-inline-page"
# Our owned, shadow-DOM results panel on /feed/playlists.
SEL_FEED_PANEL="#ytpf-feed-results-host"
# Owned save sheet (v1.7+): our shadow-DOM host, zero YouTube DOM coupling.
SEL_SHEET_HOST="#ytpf-save-sheet-host"

# YouTube DOM — the COMPLETE coupling surface for /feed/playlists is these
# two anchors. They mirror FEED_DOM_ANCHORS in src/lib/selectors.js; if you
# find yourself adding a third here, the extension has regrown a dependency
# the anchor-budget test is supposed to prevent.
SEL_FEED_MOUNT_ANCHOR="chip-bar-view-model [role='tablist']"
SEL_FEED_GRID_ANCHOR="ytd-rich-grid-renderer > #contents"

SEL_SAVE_BUTTON='button[aria-label*="Save"]'
# YouTube's native modal — asserted ABSENT after interception (regression:
# if this selector matches, our interceptor failed to own the click).
SEL_SAVE_DIALOG="ytd-add-to-playlist-renderer, yt-contextual-sheet-layout, tp-yt-paper-dialog:has(toggleable-list-item-view-model)"
