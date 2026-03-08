# YouTube Playlist Filter

Chrome extension that adds a search/filter bar to YouTube playlist modals and views.

## Features

- **Inline search bar inside YouTube's Save to playlist modal**
- **Inline filter on** `https://www.youtube.com/feed/playlists`
- Real-time filtering with visible match count
- Match highlighting in playlist names
- Fuzzy matching for near-miss queries/typos
- BM25 ranking powered by bundled MiniSearch
- Keyboard support: `Escape` clears search
- Paste works normally in the search field
- Auto-matches YouTube dark/light theme
- Zero permissions required

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder

## How it works

A content script watches YouTube's dynamic DOM, detects playlist option rows in Save dialogs/sheets and playlist cards on `/feed/playlists`, builds a BM25 index with MiniSearch, injects a native-looking inline filter bar, and filters results as you type.

## Publish Assets

- Privacy policy page source: `docs/privacy-policy.html`
- Support page source: `docs/support.html`
- Store submission answers: `store/CWS_SUBMISSION.md`
- QA checklist: `QA_CHECKLIST.md`
- Store images:
  - `store-assets/screenshot-1.png` (1280x800)
  - `store-assets/screenshot-2.png` (1280x800)
  - `store-assets/small-promo-tile.png` (440x280)
  - `store-assets/marquee-promo-tile.png` (1400x560)

## Build Store ZIP

Run:

```bash
scripts/build-store-zip.sh
```

Output:

- `dist/youtube-playlist-filter-<version>.zip`
