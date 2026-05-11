# Changelog

## 1.6.11 - 2026-05-11
- Fixed search bar incorrectly injecting into the "Add all to…" sub-dialog on playlist pages. The `yt-contextual-sheet-layout` and `tp-yt-paper-dialog` selectors now require `yt-collection-thumbnail-view-model` inside the toggleable rows — a structural marker present in the "Save video to…" modal's playlist rows but absent in bulk-action and unrelated contextual menus. A belt-and-suspenders JS guard (`isSaveVideoModal`) also rejects old-style `ytd-add-to-playlist-renderer` hosts whose Polymer data carries no `videoId` (indicating a playlist-level bulk operation rather than a single-video save).
- Added "keep dialog open" behaviour: clicking a native playlist row in the "Save video to…" modal no longer closes the sheet, restoring the pre-Oct-2025 multi-select flow. The click is stopped from reaching YouTube's sheet-close handler above the host so the user can add a video to several playlists in one session. Controlled by `ytpfSettings.keepDialogOpen` (default `true`), readable from `chrome.storage.sync`.

## 1.6.10 - 2026-05-10
- Fixed `/feed/playlists` showing floating cards with massive gaps when filtering. YouTube wraps lockups inside fixed `ytd-rich-grid-row` slots; hiding individual lockups left those slots half-empty. While a filter query is active, `#contents` now becomes a flat grid and the row wrappers collapse via `display: contents` so visible lockups pack tight. Native layout is untouched when no query is active.
- Fixed the "filter bar disappears but cards stay hidden" lock-in. Row hiding is now class-only (`ytpf-hidden`) instead of inline `display:none`, and every `refresh()` tick sweeps any `.ytpf-hidden` node that isn't claimed by a live controller. If the controller is ever lost mid-filter (SPA cache restore, racing re-render), the next tick unhides everything instead of stranding the user in a filtered-but-uncontrollable state.

## 1.6.9 - 2026-05-10
- Fixed InnerTube playlist fetch capping at ~200 playlists after YouTube migrated `/feed/playlists` rows to `lockupViewModel`. The parser walked past lockup-shaped items, so any playlist YouTube shipped in the new renderer was silently dropped while continuation paging still advanced. `parsePlaylistRenderers` now extracts `id` from `lockupViewModel.contentId`, title from `metadata.lockupMetadataViewModel.title.content`, and a best-effort `itemCount` from the metadata rows.

## 1.6.8 - 2026-05-08
- Fixed playlist search bar rendering inside the first grid cell (next to the first playlist card) instead of spanning the row above the grid. The mount point now climbs from rows[0] up to the grid `#contents`, pinning the bar at the top-level grid child so `grid-column: 1 / -1` actually spans it.

## 1.6.7 - 2026-05-08
- Fixed playlist search bar still not mounting on `/feed/playlists` after YouTube swapped the per-row primitive to `yt-lockup-view-model` (no `ytd-rich-item-renderer` wrapper). `hasDeepMatch` now self-matches, so when the outer row IS the renderer, the renderer-presence check passes instead of filtering the row out.

## 1.6.6 - 2026-05-07
- Fixed playlist search not appearing on `/feed/playlists` after YouTube migrated playlist URLs from `/playlist?list=PL...` to `/show/VL{PL...}` and rebuilt the page around `ytd-grid-renderer` + `yt-lockup-view-model`. Broadened the grid, outer-row, link, and title-text selectors so the in-page search bar mounts on both old and new layouts.

## 1.6.5 - 2026-04-28
- Reframed welcome onboarding step 2 around saving a video (where the extension's value lands) instead of opening the playlist library; button now drops the user on YouTube's home page.

## 1.6.4 - 2026-04-27
- Centered the playlist search bar on `/feed/playlists` instead of left-aligning it.

## 1.6.3 - 2026-04-25
- Fixed save-modal search input rendering with a white background in dark mode by inheriting the panel background instead of forcing a light token.

## 1.6.1 - 2026-04-17
- Fixed duplicate-script-ID race in the service worker by coalescing concurrent registration calls into a single in-flight promise.

## 1.6.0 - 2026-04-16
- Added welcome onboarding page with one-click permission grant and animated demo loop.
- Rewrote privacy policy for the InnerTube architecture; removed all OAuth artifacts.
- Restored save-modal filter for YouTube's new view-model dialog DOM.
- Fixed scroll-container detection above the modal host for the new view-model sheet.
- Narrowed content-script matches to `https://www.youtube.com/*` to reduce review risk.

## 1.5.5 - 2026-04-16
- Hardened save-modal: unified highlight builder and stopped transient filter-bar teardown.
- Stopped injecting the filter bar into non-playlist dialogs.
- Fixed title-based dedup dropping exact-match playlists; hardened fragile fallbacks.
- Simplified paint logic and removed dead DOM-stub methods.
- Dropped ™ from the extension name in manifest.

## 1.5.3 - 2026-04-13
- Migrated to YouTube's internal InnerTube API (same-origin, uses existing session — no OAuth).
- Unified search architecture across save modal and `/feed/playlists`.
- Fixed search ranking and inconsistent modal results.
- Deduplicated API playlists by ID to prevent modal duplicates.
- Fixed search highlight destroying playlist row DOM structure.
- Restructured repo: `src/` for the extension, `private/` for maintainer files.

## 1.4.0 - 2026-03-08
- Added inline filtering support on `https://www.youtube.com/feed/playlists`.
- Kept Save-dialog inline search and BM25 ranking behavior.
- Updated CWS submission and QA docs to include playlist feed filtering support.

## 1.3.0 - 2026-03-08
- Replaced heuristic ranking with BM25-backed ranking using bundled MiniSearch.
- Added robust fallback behavior if BM25 is unavailable.
- Removed invasive global shadow DOM patch to reduce policy/review risk.
- Added publish docs: privacy policy, support page, CWS submission pack, QA checklist.
- Cleaned package by removing debug-only scripts.

## 1.2.0 - 2026-03-07
- Added MiniSearch integration groundwork and improved inline modal search UX.

## 1.1.x - 2026-03-07
- Stabilized inline modal injection and filtering behavior across YouTube layouts.
