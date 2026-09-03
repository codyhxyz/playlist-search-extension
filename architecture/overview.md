# Architecture Overview

> **v2 rebuild factory:** Ground-up rewrite is specified in [`../private/v2-rebuild-factory.md`](../private/v2-rebuild-factory.md). That document is the permanent, executable plan (architecture briefing + workhorse phases). Prefer it over this folder when implementing v2.

> **Doc status (as of v1.6.12):** Partially outdated. The "single content script, no service worker, no permissions" framing predates v1.6.0, which added a service worker (`src/background.js`), an onboarding welcome page (`src/welcome.html` + `src/welcome.js`), and the `scripting` + `storage` Chrome API permissions. The host permission for `youtube.com` is now an *optional* permission granted via the welcome page, not a declared one. Inline corrections have been applied below; the ASCII diagram still depicts only the content-script subsystem and should be read as one of three execution contexts (SW, welcome page, content script), not the whole extension.

This folder documents how the extension is built and why it's built that way. If you're trying to understand the code, start here.

## What the extension does

YouTube's "Save to playlist" dialog has no search and caps at ~200 playlists. The extension:

1. Injects a search bar into that dialog.
2. Fetches the user's full playlist library via YouTube's internal API (bypassing the 200 cap).
3. Ranks results using BM25 and highlights matches as the user types.
4. On `/feed/playlists`, a search chip in YouTube's native chip bar renders our own
   result list from the same InnerTube library snapshot, hiding YouTube's grid while
   results are showing. We do not read, filter, or restyle their playlist cards.

## High-level shape

The interesting work happens in a **content script** injected at `document_start` on youtube.com pages where the user has granted the optional host permission. There is no popup, no OAuth flow, and no external server. A small service worker (`background.js`, ~115 LOC) exists only to dynamically register/unregister that content script when the user grants/revokes host permission, and to open the welcome page on first install — it does not handle, transmit, or persist user data. MiniSearch is vendored in for BM25 ranking.

```
┌────────────────────────── youtube.com ──────────────────────────┐
│                                                                 │
│   ┌────────────────────────────────────────────────────────┐    │
│   │ content.js (single IIFE)                               │    │
│   │                                                        │    │
│   │  ┌──────────────┐   ┌──────────────┐   ┌────────────┐  │    │
│   │  │  Lifecycle   │──▶│   Unified    │◀──│ InnerTube  │  │    │
│   │  │ (observers)  │   │ search index │   │  API       │  │    │
│   │  └──────┬───────┘   │   (BM25)     │   │ (SAPISID)  │  │    │
│   │         │           └──────┬───────┘   └────────────┘  │    │
│   │         ▼                  ▼                           │    │
│   │  ┌──────────────────────────────────┐                  │    │
│   │  │  Owned UI (shadow DOM)           │                  │    │
│   │  │  save sheet · feed result list   │                  │    │
│   │  └──────────────────────────────────┘                  │    │
│   └────────────────────────────────────────────────────────┘    │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Why it looks like this

| Decision | Rationale |
|---|---|
| **All real work in the content script** | The service worker exists only to flip dynamic content-script registration when host permission changes and to open the welcome tab on install — nothing user-data-handling runs in it. Cookies give us same-origin auth to YouTube from the content script, so no OAuth token management is needed in either context. |
| **InnerTube API, not YouTube Data API v3** | InnerTube has no quota limits and returns the full playlist library in one paginated call. Data API v3 required OAuth + a Google Cloud project and capped at partial results. |
| **SAPISID cookie auth** | If the user is logged into YouTube in this tab, we already have everything we need to call InnerTube. No sign-in flow, no token refresh, no `chrome.identity`. |
| **One BM25 index over the InnerTube snapshot** | Both surfaces rank the same library snapshot. Pre-v1.7 the index merged YouTube's rendered DOM rows with API playlists and had to reconcile the two; since both surfaces render their own UI there is a single source and nothing to dedup. |
| **Two DOM anchors on `/feed/playlists`, enforced by a test** | One mount point (the native chip bar) and one container to hide (their grid). Anything more means we started reading their markup again — see `tests/selectors-anchor-budget.test.mjs`. |
| **Vendor MiniSearch instead of rolling our own** | BM25 + prefix + fuzzy scoring is non-trivial. MiniSearch is ~60KB, runs entirely locally, and matches what users expect from a search box. |
| **No build step** | Plain JS loaded directly. The only "dependency" is MiniSearch, vendored as a single file. Makes loading unpacked trivial. |

## `src/` layout

```
src/
├── manifest.json          Manifest v3. Permissions: scripting + storage. Optional host: youtube.com.
├── background.js          Service worker. Dynamic content-script registration; opens welcome page on install.
├── content.js             All feature logic (single IIFE; ES-module entry, bundled by esbuild)
├── content.bundle.js      Built artifact Chrome actually injects (gitignored)
├── lib/
│   ├── selectors.js       The COMPLETE YouTube DOM coupling surface (2 /feed anchors)
│   └── innertube-parse.js Pure InnerTube response parsers + shape canary
├── onboarding-state.js    Globals shared by SW + welcome page + content script (chrome.storage helpers)
├── welcome.html           First-run onboarding page (chrome.permissions.request flow)
├── welcome.js             Welcome page controller
├── welcome-assets/        Demo video shown on the welcome page
├── styles.css             CSS vars for theming (dark/light). Most styles live inline in content.js.
├── vendor/
│   ├── minisearch.js      BM25 ranking library (UMD build)
│   └── README.md          Vendor provenance
├── test-search.cjs        vm-sandbox regression test over the built bundle
└── icons/                 16/48/128 px extension icons
```

## Subsystems

Each document in this folder covers one subsystem:

- **[search.md](search.md)** — How BM25 ranks DOM and API playlists through one index, and how query highlighting works.
- **[innertube-api.md](innertube-api.md)** — How we fetch playlists and save videos using YouTube's internal API with SAPISID auth.
- **[ui-injection.md](ui-injection.md)** — How our UI attaches to YouTube: two owned shadow-DOM surfaces plus the two enumerated DOM anchors on `/feed/playlists`.
- **[lifecycle.md](lifecycle.md)** — Startup, mutation observation, per-host controllers, and teardown.

## Key constants worth knowing

Defined at the top of `src/content.js`:

- `PLAYLIST_CACHE_TTL_MS` — 6 hours. How long the in-memory API playlist cache lives.
- `SHEET_MAX_ROWS` — 100. Max rows rendered in the owned save sheet.
- `FEED_MAX_RESULTS` — 120. Max result cards rendered on `/feed/playlists`.
- `FEED_DOM_ANCHOR_BUDGET` (src/lib/selectors.js) — 2. Hard, tested cap on the number of YouTube DOM anchors the feed surface may use.
- `BM25_SEARCH_OPTIONS` — `prefix: true`, `fuzzy: 0.2`, weighted 0.75 prefix / 0.1 fuzzy.
- `INNERTUBE_API_KEY_FALLBACK` / `INNERTUBE_CLIENT_VERSION_FALLBACK` — Used only if we can't extract them from the current page's scripts.
