# Architecture Overview

> **Doc status (as of v1.6.12):** Partially outdated. The "single content script, no service worker, no permissions" framing predates v1.6.0, which added a service worker (`src/background.js`), an onboarding welcome page (`src/welcome.html` + `src/welcome.js`), and the `scripting` + `storage` Chrome API permissions. The host permission for `youtube.com` is now an *optional* permission granted via the welcome page, not a declared one. Inline corrections have been applied below; the ASCII diagram still depicts only the content-script subsystem and should be read as one of three execution contexts (SW, welcome page, content script), not the whole extension.

This folder documents how the extension is built and why it's built that way. If you're trying to understand the code, start here.

## What the extension does

YouTube's "Save to playlist" dialog has no search and caps at ~200 playlists. The extension:

1. Injects a search bar into that dialog.
2. Fetches the user's full playlist library via YouTube's internal API (bypassing the 200 cap).
3. Ranks results using BM25 and highlights matches as the user types.
4. Also works on `/feed/playlists` for filtering the playlist library page.

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
│   │  │  UI injection (modal / feed)     │                  │    │
│   │  │  + synthetic rows for API hits   │                  │    │
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
| **Single unified BM25 index** | DOM rows (visible in the modal) and API-fetched playlists (beyond the 200 cap) share one ranking so the top result is always the best match, regardless of source. |
| **Vendor MiniSearch instead of rolling our own** | BM25 + prefix + fuzzy scoring is non-trivial. MiniSearch is ~60KB, runs entirely locally, and matches what users expect from a search box. |
| **No build step** | Plain JS loaded directly. The only "dependency" is MiniSearch, vendored as a single file. Makes loading unpacked trivial. |

## `src/` layout

```
src/
├── manifest.json          Manifest v3. Permissions: scripting + storage. Optional host: youtube.com.
├── background.js          Service worker. Dynamic content-script registration; opens welcome page on install.
├── content.js             All feature logic (~1700 lines, single IIFE)
├── onboarding-state.js    Globals shared by SW + welcome page + content script (chrome.storage helpers)
├── welcome.html           First-run onboarding page (chrome.permissions.request flow)
├── welcome.js             Welcome page controller
├── welcome-assets/        Demo video shown on the welcome page
├── styles.css             CSS vars for theming (dark/light). Most styles live inline in content.js.
├── vendor/
│   ├── minisearch.js      BM25 ranking library (UMD build)
│   └── README.md          Vendor provenance
├── test-search.js         Node-based regression test for ID-based dedup
└── icons/                 16/48/128 px extension icons
```

## Subsystems

Each document in this folder covers one subsystem:

- **[search.md](search.md)** — How BM25 ranks DOM and API playlists through one index, and how query highlighting works.
- **[innertube-api.md](innertube-api.md)** — How we fetch playlists and save videos using YouTube's internal API with SAPISID auth.
- **[ui-injection.md](ui-injection.md)** — How the search bar gets into YouTube's DOM across multiple component variants and shadow roots.
- **[lifecycle.md](lifecycle.md)** — Startup, mutation observation, per-host controllers, and teardown.

## Key constants worth knowing

Defined at the top of `src/content.js`:

- `PLAYLIST_CACHE_TTL_MS` — 6 hours. How long the in-memory API playlist cache lives.
- `MODAL_API_RESULTS_LIMIT` — 24. Max synthetic rows rendered in the modal for API-only matches.
- `BM25_SEARCH_OPTIONS` — `prefix: true`, `fuzzy: 0.2`, weighted 0.75 prefix / 0.1 fuzzy.
- `INNERTUBE_API_KEY_FALLBACK` / `INNERTUBE_CLIENT_VERSION_FALLBACK` — Used only if we can't extract them from the current page's scripts.
