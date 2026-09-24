# Changelog

## 2.0.4

- **Stores less.** The extension no longer writes onboarding flags or a content-script registration error to `chrome.storage`; nothing read them. Existing copies are deleted on update. The two display preferences (sort order, new-playlist privacy) are now the only thing it stores. The privacy policy is updated to match.
- **Internal cleanup, no change in behaviour.** Removed duplicated code across the save sheet, the InnerTube client, intent resolution and the service worker: one row-state table instead of six branches, one helper behind save/remove/create, one playlist-edit call behind add/remove, one pagination loop, one reader for request bodies. A membership check past the 200 that YouTube reports now stops at its 12-page limit instead of fetching a 13th page it would throw away.
- Removed the superseded 2026-08 spike (`overhaul/`) from the repository.

## 2.0.3

- **The blurred backdrop is back.** 2.0.2 replaced it with YouTube's flat 30% black to match YouTube's styling. Since 2.0.2 also stopped dismissing YouTube's own Save popup, that left YouTube's playlist picker plainly visible behind ours. The 2.0.1 blur (6px dark, 4px light) is restored, so the popup underneath is hidden again.

## 2.0.2

- **The save sheet now looks like YouTube's own.** Every colour, font size, spacing, corner radius, icon and hover shade was measured off YouTube's native Save sheet and New-playlist dialog, in both themes: "Save to..." header with the video's title under it, an outlined search field, flat full-width rows, YouTube's bookmark icon (filled when the video is already in the playlist), and a full-width "New playlist" button in the footer. It follows YouTube's own dark/light setting rather than the operating system's.
- **Playlist thumbnails and privacy, as YouTube shows them.** Each row shows the playlist's thumbnail with its coloured stack card, and a subtitle reading "Private • 23 videos". Both come from the same library response the list already used (257 of 257 playlists carried a thumbnail in a live check). Images load from YouTube's image server only for rows on screen, and the browser caches them as it does YouTube's. Privacy appears only when YouTube says Public, Private or Unlisted — playlists saved from other channels show none.
- **Removed the synthetic Escape** that tried to close YouTube's own Save popup. It fired before the popup existed, so it did nothing useful, and it sent a fake keypress into the page. YouTube's popup can sit behind ours, under the backdrop, where it cannot be clicked.

## 2.0.1

- **Create new playlists directly from the save sheet.** Type a name and press Enter when there are no matches, click the inline create button, or click `New` in the header. Automatically adds the current video and marks it Saved in one request via InnerTube `playlist/create`.
- **Recently added is the default sort.** It preserves YouTube's response order within each membership group, including during search.
- Match, A → Z, and Z → A remain available. The selected sort lasts until the page reloads.
- Recency assumes that YouTube returns playlists in recently-added order. No timestamps are available, and this assumption remains unverified.
- **Undo.** Every save says where it went and offers Undo in the footer, which removes the video again without a second confirmation. A row saved this session can also be picked again to arm the usual confirmed removal; it can never add twice.
- **Choose privacy when creating.** A chip beside every create control says what the new playlist will be — Private (default), Unlisted or Public — and cycles on click.
- **Video counts on rows**, parsed from the same `FEplaylist_aggregation` response (the lockup's thumbnail badge, or `videoCountText` on the legacy renderer). Absent when YouTube didn't report one. This is also what tells two identically-titled playlists apart.
- **Word-based search.** Every word must match, in any order, ignoring case and accents: "rain focus" finds "Focus — Rain & Thunder", "cafe" finds "Café". Each matched word is highlighted on the original characters.
- **Open a playlist** with Ctrl/⌘-click, middle-click, or Ctrl/⌘+Enter on the cursor's row. Opens in a new tab; the sheet stays open.
- **Sort order and new-playlist privacy persist** across page loads, in `chrome.storage.local`. They are the only usage state the extension stores; PRIVACY.md lists them.
- **No row cap.** The list builds a page at a time as you scroll or arrow down, so every playlist is reachable without typing. The "N more — keep typing" line is gone.
- **Membership past 200.** After the sheet loads, playlists outside the 200 YouTube reports are checked in the background by walking their contents, and gain "Already in" as answers arrive. The cursor stays on the same playlist while rows move. Cancelled when the sheet closes; skipped when the fast path returned ≤1 row (missing brand delegation), since that would crawl the whole library.
- **Multiple signed-in Google accounts.** Requests now send `X-Goog-AuthUser` from the page's `SESSION_INDEX` (and `X-Goog-PageId` for brand channels), as YouTube's own client does.
- **Failures say why.** Offline, signed out, rate-limited, YouTube errors and rejected edits each carry a plain-language reason into the status line: "Couldn’t save to “X”. You’re offline. Select it again to retry."
- Live YouTube verification was skipped with approval. Local build, unit, browser UI, and store validation tests still gate submission. Everything above is verified against fixtures and a real engine only — see `architecture/coverage.md` for which rows remain unverified live.

## 2.0.0 - 2026-09-05

A rebuild. The extension is now the save sheet and nothing else, and it holds one invariant that the 1.x line did not: **it never reads data from YouTube's DOM, and never writes a node into it.**

Every recurring bug in 1.6.x traced to breaking that rule. The filter bar appearing inside unrelated menus, lists changing length on their own, having to close and reopen the dialog to recover, breaking every few weeks — those were not six bugs, they were one architectural decision with six symptoms. They are gone because the code that produced them is gone.

### What's new

- **Every playlist, not 200.** The library now comes from `browse FEplaylist_aggregation`, which is not capped. YouTube's own Save picker is built from `get_add_to_playlist`, which returns at most 200 playlists — a hard server limit with no continuation token and no parameter that widens it. Previous versions filtered *YouTube's* list, so they inherited *YouTube's* ceiling. Measured against a 256-playlist account: 253 real playlists in a single response.
- **"Already in this playlist" is real state**, from one call rather than a guess. Known-member rows can now remove the video through a separate confirmation action; the row itself never performs a destructive write. Past that same 200-playlist window YouTube reports membership to nobody, including its own client — so those rows are drawn unmarked rather than shown as "not in". An unchecked row now claims nothing, because it is not an answer we have.
- **Saving works from every surface that offers it.** The home feed, search results, a channel page, the watch sidebar, subscriptions, history, playlist rows. In 1.x, Save worked on the watch page and silently did nothing on the home feed for a full release.
- **Four ways in that need nothing from YouTube's page at all**: the toolbar icon, right-click on any video link, `Alt`+`S`, and the native Save button. The first three depend only on URL structure, so they keep working through any YouTube redesign — and they are the only way to save a Short, which has no Save affordance of its own.
- **Brand-channel accounts work.** `INNERTUBE_CONTEXT` does not carry the channel delegation even when the page has it. Without explicitly setting `context.user.onBehalfOfUser`, an account whose playlists live on a brand channel got back 2 playlists instead of 256, and one membership row instead of 200 — no error, just a confidently wrong, smaller answer. Switching accounts mid-session now invalidates that delegation instead of caching it for the life of the tab.
- **Keyboard-first.** Type to narrow, arrows to move, Enter to save. With hundreds of playlists you type; you do not scroll.

### Sorting

Three orders, cycled from one control in the header: **Match** (default — where the query lands in the title, then shorter title, then A→Z; plain A→Z at rest), **A → Z**, and **Z → A**. Playlists you've already saved to group above the rest in all three, and `false`/`undefined` stay in the same group, so the tri-state hedge survives sorting.

**"Recently updated" is deliberately absent, because YouTube does not give us the data.** The real captured `browse FEplaylist_aggregation` response contains zero date-shaped fields — no modified date, no publish time, no "Updated…" string; its `contentMetadataViewModel` is literally empty. The rendered page agrees. Note that a *synthetic* fixture in this repo contains an invented `"Updated yesterday"` row, and designing against it would have shipped a sort that ordered by nothing — precisely the failure `architecture/coverage.md` was written to stop. A test now asserts the real capture has no date field and the synthetic one does, so the two can never be confused again; the day YouTube ships a timestamp, it goes red and the sort becomes buildable.

Two bugs surfaced while building it, both of which would have shipped:

- **Enter did nothing for any video you'd already saved.** Members float to the top, the cursor started at row 0, and `pick()` returned early on members. The resting cursor still lands on the first add target; navigating to a known-member row now opens an explicit removal confirmation.
- **Enter on the close button saved a playlist instead of closing.** The dialog's Enter handler fired regardless of what had focus, and its `preventDefault()` swallowed the button's own click.

### How the trigger changed

Saving is now detected from **YouTube's own network request** rather than from an intercepted button click. When you click Save anywhere, YouTube's client POSTs `get_panel` with `panelId: "PAadd_to_playlist"`. That is a behavioural fact — YouTube's app stating what the user asked for — rather than a guess based on class names, which are the fastest-churning thing on the page.

Three findings from the live capture, each of which had broken an earlier attempt:

- `get_panel` is **generic** — the "Ask" panel uses the same endpoint. Firing on the URL alone is exactly how 1.x rendered its UI inside unrelated menus. `panelId` is the gate.
- The `params` blob is **sometimes percent-encoded**, and `atob` throws on `%`. The home feed hits this and the watch page does not. That single detail is the whole of "it worked on watch but not the feed."
- `chrome.webRequest` **cannot read these bodies at all.** YouTube uploads them as a gzip stream and Chrome reports streamed uploads with no bytes. The old code's `if (!body) return;` was a silent no-op on 100% of saves. The permission is not declared in 2.0.0, because a permission that buys nothing and costs review scrutiny is a liability, not a fallback.

Observation now happens in a `MAIN`-world script that watches two API paths, copies at most four fields out of matching requests, and forwards nothing else — notably not YouTube's client-configuration blob, which it can see. This is a real tradeoff and it is documented in full in PRIVACY.md rather than buried.

### Removed

- **The `/feed/playlists` search surface.** 2.0.0 does one thing. Filtering your playlists library was a second product sharing a codebase with the first, and it was the source of most of the DOM coupling.
- **MiniSearch**, and with it the last bundled dependency. Search over your own array of titles is a substring match; BM25 ranking over a few hundred short strings was solving a problem nobody had. The extension now ships no third-party code whatsoever.
- **The `webRequest` permission**, as above. Permissions are now `scripting`, `storage`, `contextMenus`.
- The selectors layer, the DOM extractors, and the row-filtering machinery — roughly 2,800 lines. The remaining coupling to YouTube's markup is: nothing, plus one synthetic `Escape` keypress to dismiss their dialog, whose failure mode is cosmetic.
- The welcome page's demo video, which showed a feature that no longer exists.

### A note on what isn't here

Between 1.6.18 and this release an unshipped rewrite of the `/feed/playlists` surface and a first owned save sheet were built and then superseded by this one. Nothing from that work reached users, so it has been dropped from this changelog rather than listed as released. It is preserved in full on the `v2-overhaul` branch at commit `c93a417` if the feed surface is ever revived.

### Upgrading

The service worker now **reconciles** its content-script registrations on update instead of leaving an existing one alone. A surviving 1.6.x registration names `vendor/minisearch.js` and `styles.css`, neither of which exists in 2.0.0 — Chrome would have failed to inject anything and the extension would have installed silently dead. Open YouTube tabs need one reload after updating.

`minimum_chrome_version` is now 123.

### Testing

- 49 unit assertions across intent resolution and InnerTube parsing, including the protobuf field walk, the percent-encoded blob, the `panelId` gate, brand-channel delegation, and both renderer generations — run against captured responses, not only synthetic ones.
- `tests/test-sheet-render.mjs` pins the sheet's contract in a real browser engine: closed shadow root outside YouTube's tree, top-layer dialog, no string-to-HTML sink, tri-state membership rendering, failure and retry, keyboard navigation, constant row height. It found a real bug on its first run — "already in" rows were still clickable, and YouTube permits duplicate playlist entries, so clicking one silently added the video twice.
- E2E now drives **the watch page and the home feed**, separately, and reports them separately. Testing one surface and generalising to the category is the specific process failure that shipped the feed bug; asserting per-surface is how it stops.
- A new e2e spec probes the InnerTube contract by rebuilding both requests from YouTube's own config rather than calling our client — so it fails when *YouTube* changes, independently of whether our parser agrees with itself.
- `docs/privacy-policy.html` is generated from `PRIVACY.md` and checked in the build. The two had already drifted; the published copy was missing an entire section.


## 1.6.18 - 2026-08-11
- Fixed repeated Save-modal opens, same-element reuse, detached-host reuse, nested modal ownership, and modal discovery inside open shadow roots.
- Made the modal's video ID authoritative. InnerTube requests now follow the active Google account and Brand channel, and playlist caches are isolated by account.
- Reconciled modern ID-less playlist rows without duplicate synthetic results. Synthetic saves now share one request per account, video, and playlist and retain pending or completed state across rerenders.
- Kept the Save dialog open without swallowing YouTube's native playlist toggle.
- Removed persistent and page-readable diagnostics, purged legacy diagnostic records, and updated the privacy policy.
- Added deterministic modal lifecycle, identity, account-routing, row-replacement, and save-deduplication checks. Fixed the live E2E build and assertions so signed-out sessions and unsupported compact pickers cannot report false passes. The harness now uses its own persistent Chromium profile and does not copy another browser's cookies.
- Hardened publishing so the upload ZIP is rebuilt from current source and checked byte-for-byte before submission.

## 1.6.17 - 2026-06-18
- Fixed `/feed/playlists` filtering on YouTube's direct-lockup layout. The old row-wrapper reflow workaround is now applied only when the playlist grid actually has direct `ytd-rich-grid-row` children; direct `yt-lockup-view-model` grids keep YouTube's native layout, preventing filtered results from collapsing into tiny squashed cards.
- Added a feed-page regression probe that types into the filter and asserts direct-lockup grids are not force-regridded.

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
  <!-- Editorial note (added 1.6.17): the framing above reads as a universal
       rule of /feed/playlists. It was not — it only applied to the
       row-wrapped layout (direct ytd-rich-grid-row children). YouTube also
       ships a direct-lockup grid where this override squashed cards into
       tiny slots (the 1.6.17 regression). The reflow is now shape-gated;
       see CONTRIBUTING.md "Intervening in YouTube's DOM". -->
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
