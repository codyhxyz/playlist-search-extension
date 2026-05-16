# YouTube Playlist Search

Can't find your playlist when saving a video? YouTube's "Save to playlist" modal has no search, and it only loads your most recent 200 playlists. If you have more, they're invisible.

This extension adds a search bar directly inside YouTube's Save modal. Type to filter, and it searches all your playlists — even beyond the 200 cap.

## Features

- **Search bar inside YouTube's Save to playlist modal** — filters as you type
- **Loads all playlists** — YouTube caps at 200; the extension fetches the rest directly from YouTube
- **Save to any playlist** — even ones YouTube didn't load in the modal
- **Match highlighting** in playlist names
- **BM25 ranking** for relevant results
- **Works on `/feed/playlists`** too — filter your playlist library page
- **Matches YouTube's theme** — dark and light mode

## Install

Available on the [Chrome Web Store](https://chromewebstore.google.com/) (search "YouTube Playlist Search"), or load it locally:

1. Clone this repo
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the `src/` folder

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup.

## How it works

A content script detects YouTube's Save dialog, injects a search bar, and filters playlist rows as you type. In the background, it uses YouTube's own internal API (the same one youtube.com uses) to fetch your full playlist library — authenticated with your existing YouTube session, no OAuth required. Results from both the modal's visible rows and your full library are ranked together with BM25 scoring.

For an in-depth look at the architecture, see [`architecture/overview.md`](architecture/overview.md).

## Roadmap

- **Semantic search** — find playlists by meaning, not just title match, using embeddings
- **Playlist recommendations** — suggest relevant playlists based on the video you're watching
- **Similar playlists** — when viewing a playlist, surface your most similar playlists

## Privacy

The extension only accesses your YouTube playlist names to power search. It talks only to YouTube — the same server you're already on — and never to the developer or any third party. Nothing is stored outside your browser. See the [privacy policy](https://playlist.codyh.xyz/privacy-policy.html) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and how to submit changes.

## License

[MIT](LICENSE)
