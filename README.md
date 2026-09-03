# YouTube Playlist Search

YouTube's "Save to playlist" picker has no search, and it loads at most 200 playlists. If you have more than that, the rest are simply not reachable from it — not scrolled past, not paginated, *absent*. YouTube's own client is equally blind: for a video whose only playlist sits outside that window, YouTube's popover shows every row unchecked and doesn't list the playlist at all.

This extension replaces that picker with a searchable one covering **every** playlist you own.

![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-YouTube%20Playlist%20Search-blue) ![License](https://img.shields.io/badge/license-AGPL--3.0-green)

## What it does

- **Search every playlist you own.** The library comes from an endpoint that isn't capped, so the 200 ceiling doesn't apply. Type to narrow; with hundreds of playlists you type rather than scroll.
- **Works from every save surface.** The watch page, the home feed `⋮`, search results, channel pages, the watch sidebar, subscriptions, history, playlist rows.
- **Three ways in that don't depend on YouTube's page at all** — the toolbar icon, right-click on any video link, and `Alt`+`S`. These use only the URL, so they survive any YouTube redesign, and they're the only way to save a Short (which has no Save button of its own).
- **Shows what's already saved**, and is honest about what it can't know: past 200 playlists YouTube reports membership to nobody, so those rows are drawn unmarked rather than claimed as "not in".
- **Brand-channel accounts work.** If your playlists live on a channel rather than your personal account, the extension acts as that channel.
- Light and dark, keyboard-driven, no third-party code.

## The one rule

> **It never reads data from YouTube's DOM, and never writes a node into YouTube's DOM.**

Version 1.x did both, and every recurring bug traced back to it: a search bar appearing inside unrelated menus, lists changing length on their own, having to close and reopen the dialog to recover, breaking every few weeks. Those weren't separate bugs — they were one decision with several symptoms.

So 2.0.0 doesn't mitigate them, it deletes the possibility. The UI is drawn in a closed shadow root attached outside YouTube's app tree; the data comes from YouTube's own JSON API rather than from rendered markup; and the trigger is YouTube's own network request rather than a guess based on class names. The remaining contact with YouTube's page is a single synthetic `Escape` keypress to dismiss their dialog, and if that ever stops working the failure is cosmetic.

When something does break, the extension **fails closed** — it says it couldn't load your playlists and does nothing. There is deliberately no fallback to reading the page, because that fallback is the disease, not the cure.

## Install

Available on the [Chrome Web Store](https://chromewebstore.google.com/) (search "YouTube Playlist Search"), or load it locally:

```bash
git clone https://github.com/codyhxyz/playlist-search-extension.git
cd playlist-search-extension
npm install
npm run build                       # produces src/content.bundle.js
```

Then in Chrome:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `src/` folder

The build step is what Chrome actually injects — skip it and the extension fails to register its content scripts (loudly: it writes an actionable error to the service-worker console). `src/content.bundle.js` is gitignored, so every clone builds its own.

Requires Chrome 123 or later.

## How it works

Four layers, dependencies pointing one way:

| | |
|---|---|
| **Intent** | A `MAIN`-world script watches two YouTube API paths. When YouTube's own client POSTs `get_panel` with `panelId: "PAadd_to_playlist"`, the user has asked to save something — that's a behavioural fact rather than a structural guess. Plus three URL-only entry points that need nothing from the page. |
| **Data** | A hand-rolled InnerTube client, ~300 lines, same-origin from the YouTube tab using your existing session. Three endpoints: list the library, read membership, add/remove. |
| **Session** | Created on intent, destroyed on close. Nothing outlives the sheet — which is a one-line answer to "why did I have to close and reopen it". |
| **UI** | A closed shadow root on `<html>`, a `<dialog>` in the browser's top layer, styles via `adoptedStyleSheets`, nodes built with `createElement` and never `innerHTML`. It knows nothing about YouTube; hand it a list and it renders one. |

Full write-up in [`architecture/overview.md`](architecture/overview.md), and an honest per-surface status matrix — including what's verified, what's known broken, and what has never been tested — in [`architecture/coverage.md`](architecture/coverage.md).

## Privacy

The extension talks only to `youtube.com`, using the session you already have, and never to the developer or any third party. It ships no third-party code and stores nothing.

The one thing worth reading about is how it detects that you clicked Save: it observes YouTube's own request for that action, from a script running in the page. That's a real tradeoff and it's described in full — including why the less invasive approach doesn't work — in the [privacy policy](https://playlist.codyh.xyz/privacy-policy.html).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and the test suite.

## License

[AGPL-3.0](LICENSE)
