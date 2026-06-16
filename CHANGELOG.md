# Changelog

## 1.6.16 - 2026-06-15
- Fixed the remaining dark-mode mismatch in YouTube's "Save to..." modal. The previous `color-scheme: inherit` improvement still let some modal contexts paint the injected search bar as a light/white strip. The filter UI now detects YouTube dark mode from root/body attributes, YouTube dark host attributes, computed YouTube background tokens, and system dark preference as a fallback, then applies a dedicated `ytpf-theme-dark` class.
- Added explicit dark styles for the modal, page, and chip variants: dark background, dark-aware input fill, lighter borders, muted placeholder/meta text, clear-button hover color, and dark chip hover fallback. Existing bars resync on YouTube theme changes without requiring a page reload.

## 1.6.15 - 2026-05-21
- Re-mounted the `/feed/playlists` filter bar **as a chip inside YouTube's native filter-chip row** ("Recently added · Playlists · Music · Owned"). Previously the bar got its own full-width row below the chips, which read as an alien control floating in 1500px of empty pill. Now the search renders as the leftmost chip — 32px tall, 8px radius, fit-content width (clamp 220–320px), `--yt-spec-badge-chip-background` fill, magnifying-glass icon — visually indistinguishable from a native YT chip. Doubles as a `color-scheme: inherit` carrier so the input still themes correctly in dark mode.
- New mount target uses `chip-bar-view-model .ytChipBarViewModelChipBarScrollContainer` (YouTube migrated this surface from the legacy Polymer `ytd-feed-filter-chip-bar-renderer` to the view-model web component as of 2026-05). Selector list includes the legacy chip bar as fallback for mid-rollout users. **Belt-and-suspenders fallback:** when no chip bar is detected on the page at all (channel pages, future YT redesigns that drop the chip bar entirely), `attachHost` falls back to the historic full-width `.ytpf-inline-page` mount — the bar still appears, just in the old position. Both code paths share the same indexer + filter + reconcile loop; only the UI shape differs.
- `tests/test-feed-page-mount.mjs` now injects a synthetic `chip-bar-view-model` above the playlist fixture and asserts the chip mounts INSIDE the chip bar (not the grid-span fallback). `tests/e2e/specs/feed-playlists.sh` was split into variant-conditional assertions: chip-path checks "mounted inside .ytChipBarViewModelChipBarScrollContainer", grid-path keeps the historic "direct sibling of grid #contents + width ≥ 600px" checks; behavioral assertions (typing narrows, placeholder count) apply to both.

## 1.6.14 - 2026-05-21
- Fixed two dark-mode legibility bugs in the injected Save-modal search bar. The `<input>` was painted with Chrome's light UA form-control chrome (white field, dark caret, light-blue focus ring) on YouTube's dark modal because `.ytpf-inline` wasn't inheriting YouTube's `color-scheme: dark` — the `--yt-spec-*` color tokens were already correct, but the UA layer below them ignores CSS background/color fills for form controls. One declaration (`color-scheme: inherit`) propagates whatever scheme YouTube has set, without reading `html[dark]` or any media query — robust across future YouTube themes. Mirrored in both `src/styles.css` (page-feed bar) and the inline `FILTER_BASE_STYLES` template in `src/content.js` (Save-modal bar, which injects later and wins the cascade).
- Also retuned the `mark.ytpf-mark` highlight: the old `rgba(255,255,0,0.4)` + `color:inherit` rendered as unreadable light-text-on-muddy-yellow against YouTube's dark rows. Bumped to a punchy `rgba(255,213,0,0.85)` with forced `#0f0f0f` text — a single rule that's legible in both light AND dark, no `light-dark()` or `mix-blend-mode` games needed.

## 1.6.13 - 2026-05-16
- Locked the keep-dialog-open behavior on, removing the `ytpfSettings.keepDialogOpen` toggle entirely. This is a power-user extension; YouTube's auto-close-on-select breaks multi-select, which is the entire point of having a search bar over the playlist list. Click outside the dialog to close it. Documented in README "Behavior". Old `ytpfSettings` entries in `chrome.storage.sync` are now ignored (no migration needed — the setting was the only key).
- Added an end-to-end test harness under `tests/e2e/` that runs against signed-in YouTube via `agent-browser`. Four specs (`sanity`, `feed-playlists`, `save-modal`, `innertube-fetch`) cover the regressions that the fixture suite can't reach: real DOM drift, real save-modal injection target, real InnerTube parser output. `scripts/publish-cws.mjs` now runs `tests/run-all.sh` (fixture + e2e) as a non-bypassable gate before any zip is uploaded — a stale or hand-built zip cannot reach the CWS without passing. `scripts/build-store-zip.sh` runs only the fast gates (parse + regression tests + validator + fixture).
- Auth path navigates around two walls Google added: programmatic login is blocked by accounts.google.com's automation detection, and macOS Chrome silently drops `--load-extension` from the CLI. Resolution: agent-browser launches its bundled Chromium (loads `--extension` fine), and a Python helper (`tests/e2e/import-chrome-cookies.py`) decrypts the YouTube auth cookies from a dedicated real Chrome `YT Test` profile (via the macOS Keychain key) and injects them into the live session. One-time setup: `bash tests/e2e/setup.sh` (creates a venv with `pycryptodome`) plus creating the `YT Test` Chrome profile and signing it into the test account once.
- Added `scripts/build-e2e.sh` and a gitignored `e2e-build/` variant manifest that drops `optional_host_permissions` (which a fresh agent-browser profile never grants) and adds an explicit `content_scripts` entry. Production manifest unchanged.
- Extracted the YouTube-coupling surface into `src/lib/`: selectors (`selectors.js`), InnerTube response parser (`innertube-parse.js`), and Polymer-data extractors (`dom-parse.js`). `parsePlaylistRenderers` now carries a **shape canary** that fires `recordDiagnostic("innertube_shape_unknown:<sorted-keys>", …)` whenever YouTube ships a renderer key we don't recognize — even on mid-rollouts where some items still parse via known shapes (the exact 1.6.9 failure pattern). Diagnostic invariant keys encode the unknown-keys signature so distinct migrations get their own throttled ring entries instead of one suppressing the other.
- Added 30 fixture-driven Node unit tests under `tests/innertube-parse.test.mjs` + `tests/dom-parse.test.mjs` covering every renderer shape we know about (legacy `gridPlaylistRenderer`, post-2026 `lockupViewModel`, continuation pages), the shape-canary triggers (empty / mid-rollout / mixed / sorted keys), and the Polymer-data extractors. Includes one **real captured** response from the public MrBeast channel `/playlists` page (no auth needed) plus three skipped stubs for Save modal + personal `/feed/playlists` initial + continuation captures — they un-skip automatically once the fixture file appears.
- Added `scripts/capture-innertube.mjs` — wraps the agent-browser dance into one command per surface (`channel @<handle>`, `modal <watch-url>`, `feed`). Writes a `real-*.json` fixture, scrubs `visitorData`/`trackingParams`/`clickTrackingParams`, and prints a parse summary so you can sanity-check counts and IDs before committing.
- Adopted esbuild: `src/content.js` is now an ES module entry that imports from `src/lib/*.js`; the bundler produces `src/content.bundle.js` (gitignored, regenerated by every `npm run build`), which is the file Chrome actually injects. `build-store-zip.sh` runs the build as gate 1/6 and now zips the bundle instead of the source. CI installs deps via `npm ci`, builds the bundle, syntax-checks source AND bundle, typechecks, then runs the unit + integration + feed-mount suites.
- Centralized 8 magic millisecond values into a `TIMINGS` block at the top of `src/content.js` (`RECONCILE_DEBOUNCE_MS`, `NAVIGATE_SETTLE_MS`, `SYNTH_ERROR_FADEOUT_MS`, `MOUNT_CHECK_DELAY_MS`, `PAGE_SURFACE_PROBE_COOLDOWN_MS`, etc.). No behavior change; greppable tuning surface for the next time YouTube moves their animation budgets.
- `background.js` now traps the `chrome.scripting.registerContentScripts` throw and writes an actionable diagnostic to `chrome.storage.local.ytpf_registration_error`. The common case is a contributor who skipped `npm install && npm run build` before `Load unpacked` — Chrome's default silent failure now becomes a loud, fix-able error.
- Fixed a latent false-positive in `scripts/validate-cws.mjs`'s `remote-code-patterns` rule. The `\beval\s*\(/g` regex was matching the literal word "eval" inside JS comments (commit 7ac54e8's "page-world eval" comment had been tripping it). Validator now strips JS line + block comments before scanning, preserving line offsets so error locations still point at the right source line.

## 1.6.12 - 2026-05-13
- Fixed the search bar failing to appear on `/feed/playlists` (and silently breaking modal mounting too). 1.6.11's `sweepOrphanedHidden` iterated `controllers.values()` but `controllers` is a `WeakMap` — every `refresh()` tick threw on the very first line, so nothing downstream (modal or page surface) ever ran. Now iterates via the parallel `controllerHosts` `Set`, which `attachHost` was already populating in lockstep.
- Added a live-DOM regression harness (`tests/test-feed-page-mount.mjs`) that boots a real Chromium tab via `agent-browser`, serves a captured YouTube playlists DOM at `http://127.0.0.1/feed/playlists`, runs the unmodified `src/content.js` against it, and asserts `.ytpf-inline-page` actually renders. This is what would have caught the 1.6.11 regression before shipping. Fixture captured from the post-2026 `yt-lockup-view-model` layout; checked in under `tests/fixtures/`.
- Added in-product self-diagnostic: when `isPlaylistsFeedPage()` is true but `collectFeedPageSurface()` returns null, the extension now schedules a structured probe 2.5s later and writes the result (grid count, candidate breakdown, sample hrefs) to the existing `chrome.storage.local` diagnostics ring. The modal surface had `scheduleFilterBarMountCheck` for years; the page surface never did, which is exactly how invisible-bar bugs kept slipping past us.
- Exposed `window.__ytpfDiag()` on YouTube pages for ad-hoc page-surface probing from DevTools.

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
