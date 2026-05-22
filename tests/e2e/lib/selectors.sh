#!/usr/bin/env bash
# Centralized selectors for e2e specs.
#
# YouTube's DOM changes constantly; every spec sources this file so a single
# selector update unblocks all of them. Specs should assert on BEHAVIOR (bar
# exists, filter narrows results) more than exact selectors — but where a
# selector is unavoidable, reach for the constant from this file.

# Our extension's mounted nodes — these are stable because we own them.
# SEL_INLINE_PAGE matches BOTH page-surface variants: the historic grid-span
# bar (.ytpf-inline-page) and the post-1.6.15 chip variant (.ytpf-chip) that
# mounts into YouTube's native filter-chip row. Specs that care about layout
# specifics use SEL_INLINE_PAGE_CHIP or SEL_INLINE_PAGE_GRID directly.
SEL_INLINE_PAGE=".ytpf-inline-page, .ytpf-chip"
SEL_INLINE_PAGE_CHIP=".ytpf-chip"
SEL_INLINE_PAGE_GRID=".ytpf-inline-page"
SEL_MODAL_INLINE=".ytpf-modal-inline"
SEL_MODAL_INLINE_INPUT=".ytpf-modal-inline input"

# YouTube DOM — drift candidates. Update here, all specs follow.
SEL_PLAYLISTS_GRID="ytd-rich-grid-renderer #contents"
SEL_PLAYLIST_LOCKUP="yt-lockup-view-model, ytd-rich-item-renderer"
# Native filter-chip row on /feed/playlists. Post-2026-05 YouTube uses the
# `chip-bar-view-model` web component; the legacy Polymer chip-bar is kept
# for any mid-rollout user. Mirrors src/lib/selectors.js#CHIP_ROW_SELECTORS.
SEL_CHIP_ROW="chip-bar-view-model .ytChipBarViewModelChipBarScrollContainer, ytd-feed-filter-chip-bar-renderer #chips"
SEL_SAVE_BUTTON='button[aria-label*="Save"]'
SEL_SAVE_DIALOG="tp-yt-paper-dialog"
SEL_SAVE_DIALOG_OPEN='tp-yt-paper-dialog[opened], tp-yt-paper-dialog:not([aria-hidden="true"])'
SEL_DIALOG_PLAYLIST_ROW="yt-collection-thumbnail-view-model, toggleable-list-item-view-model, ytd-playlist-add-to-option-renderer"
