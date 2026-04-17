# Changelog

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
