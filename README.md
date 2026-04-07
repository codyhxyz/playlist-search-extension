# YouTube Playlist Search

Can't find your playlist when saving a video? YouTube's "Save to playlist" modal has no search, and it only loads your most recent 200 playlists. If you have more, they're invisible.

This extension adds a search bar directly inside YouTube's Save modal. Type to filter, and it searches all your playlists — even beyond the 200 cap — using the YouTube API.

## Features

- **Search bar inside YouTube's Save to playlist modal** — filters as you type
- **Loads all playlists** — YouTube caps at 200; the extension uses the YouTube API to find the rest
- **Save to any playlist** — even ones YouTube didn't load in the modal
- **Match highlighting** in playlist names
- **BM25 ranking** for relevant results
- **Works on `/feed/playlists`** too — filter your playlist library page
- **Matches YouTube's theme** — dark and light mode

## Install

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select this folder

## How it works

A content script detects YouTube's Save dialog, injects a search bar, and filters playlist rows as you type. If you have more than 200 playlists, a "Load all playlists" prompt appears — click it to authorize the extension to fetch your full library via the YouTube API.

## Roadmap

- **Semantic search** — find playlists by meaning, not just title match, using embeddings
- **Playlist recommendations** — suggest relevant playlists based on the video you're watching
- **Similar playlists** — when viewing a playlist, surface your most similar playlists

## Privacy

The extension only accesses your YouTube playlist names to power search. No data is stored on external servers — everything stays in your browser. See `docs/privacy-policy.html` for details.

## Development

### Publish Assets

- Privacy policy: `docs/privacy-policy.html`
- Support page: `docs/support.html`
- Store submission: `store/CWS_SUBMISSION.md`

### Build Store ZIP

```bash
scripts/build-store-zip.sh
```
