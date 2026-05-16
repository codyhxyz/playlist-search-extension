#!/usr/bin/env bash
# Centralized selectors for e2e specs.
#
# YouTube's DOM changes constantly; every spec sources this file so a single
# selector update unblocks all of them. Specs should assert on BEHAVIOR (bar
# exists, filter narrows results) more than exact selectors — but where a
# selector is unavoidable, reach for the constant from this file.

# Our extension's mounted nodes — these are stable because we own them.
SEL_INLINE_PAGE=".ytpf-inline-page"
SEL_MODAL_INLINE=".ytpf-modal-inline"
SEL_MODAL_INLINE_INPUT=".ytpf-modal-inline input"

# YouTube DOM — drift candidates. Update here, all specs follow.
SEL_PLAYLISTS_GRID="ytd-rich-grid-renderer #contents"
SEL_PLAYLIST_LOCKUP="yt-lockup-view-model, ytd-rich-item-renderer"
SEL_SAVE_BUTTON='button[aria-label*="Save"]'
SEL_SAVE_DIALOG="tp-yt-paper-dialog"
SEL_SAVE_DIALOG_OPEN='tp-yt-paper-dialog[opened], tp-yt-paper-dialog:not([aria-hidden="true"])'
SEL_DIALOG_PLAYLIST_ROW="yt-collection-thumbnail-view-model, toggleable-list-item-view-model, ytd-playlist-add-to-option-renderer"
