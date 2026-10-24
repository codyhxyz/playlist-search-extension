# YouTube Playlist Search

YouTube's "Save to playlist" picker has no search, and it loads at most 200 playlists. If you have more than that, the rest are not reachable from it at all: not scrolled past, not paginated, *absent*. YouTube's own client is equally blind. For a video whose only playlist sits outside that window, YouTube's popover shows every row unchecked and doesn't list the playlist.

This extension opens a searchable picker covering **every** playlist you own, in front of YouTube's.

![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-YouTube%20Playlist%20Search-blue) ![License](https://img.shields.io/badge/license-AGPL--3.0-green)

## What it does

- **Search every playlist you own.** The library comes from an endpoint that isn't capped, so the 200 ceiling doesn't apply. Type to narrow; with hundreds of playlists you type rather than scroll.
- **Works from every save surface.** The watch page, the home feed `⋮`, search results, channel pages, the watch sidebar, subscriptions, history, playlist rows.
- **Ways in that don't depend on YouTube's page:** the toolbar icon, right-click on a video link or a watch page, and `Alt`+`S` (`Option`+`S` on Mac). These use only the URL, so they survive a YouTube redesign, and they're the only way to save a Short (which has no Save button of its own).
- **Find a playlist** with `Alt`+`P` (`Option`+`P` on Mac), or the toolbar icon on a YouTube page with no video. Same picker; choosing a row opens the playlist.
- **Shows what's already saved.** YouTube reports membership for 200 playlists. The rest are checked in the background by reading each playlist, and rows gain their "already in" mark as answers arrive.
- **Brand-channel accounts work.** If your playlists live on a channel rather than your personal account, the extension acts as that channel.
- **Search by words, in any order**, ignoring case and accents. Rows show each playlist's privacy and video count.
- **Sort** by YouTube's recent order, A to Z, or Z to A.
- **Instant saves.** A save shows as done the moment you click, and rolls back with the reason if YouTube refuses it. A save that fails after the picker has closed is reported with Try again.
- **Undo** any save from the footer, or with `Ctrl`/`⌘`+`Z` while the search field is empty. Create playlists as Private, Unlisted or Public.
- **Open a playlist** with `Ctrl`/`⌘`-click, middle-click, or `Ctrl`/`⌘`+`Enter`.
- **Opens instantly.** The last playlist list is kept in memory and refreshed in the background on every open.
- **One review request, ever.** After regular use, a confirmed save can show a small "Rate extension" prompt. It never asks again, whether you rate, dismiss, or close it.
- Light and dark, keyboard-driven, respects reduced motion, no third-party code.

## The one rule

> **It never reads playlist data from YouTube's DOM, and never writes a node into YouTube's app.**

Version 1.x did both, and every recurring bug traced back to it: a search bar appearing inside unrelated menus, lists changing length on their own, having to close and reopen the dialog to recover, breaking every few weeks. Those weren't separate bugs. They were one decision with several symptoms.

So 2.0 doesn't mitigate them, it removes the possibility:

- **UI:** a closed shadow root attached to `<html>`, outside YouTube's app tree.
- **Data:** YouTube's own InnerTube JSON API, not rendered markup.
- **Trigger:** YouTube's own network request, not a guess based on class names.

What's left of contact with YouTube's page:

- A script in the page's `MAIN` world wraps `fetch` and XHR to observe the Save request. It reads a clone of the body and always passes the original through.
- The InnerTube session config (`ytcfg`) is read from the page's script text. It's the config blob YouTube's own client reads, not rendered markup.
- `yt-navigate-finish` and `popstate` listeners close the picker when you navigate.

YouTube's own Save popup still opens underneath. The picker's blurred backdrop hides it. (Dismissing it with a synthetic `Escape` was removed in 2.0.2.)

When something breaks, the extension **fails closed**. If it can't tell which video you meant, it does nothing and logs why. If your playlists can't load, the picker says so. There is deliberately no fallback to reading the page, because that fallback is the disease, not the cure.

## Install

Available on the [Chrome Web Store](https://chromewebstore.google.com/detail/efgbkmnooapcpdpgmihemfpedchhmmek), or load it locally:

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

The build step produces what Chrome actually injects. Skip it and the extension fails to register its content scripts, loudly: it writes an actionable error to the service-worker console. `src/content.bundle.js` is gitignored, so every clone builds its own.

Requires Chrome 123 or later.

Chrome requests access to `www.youtube.com` during installation. The welcome page is a short guide, not a permission step; it only asks for access if Chrome's site controls are blocking the extension.
If YouTube was already open, reload that tab or open a fresh YouTube tab before using the extension.

## How it works

Four layers, dependencies pointing one way:

| | |
|---|---|
| **Intent** | A `MAIN`-world script watches two YouTube API paths, `get_panel` and `playlist/get_add_to_playlist`. When YouTube's own client asks for the add-to-playlist panel, the user has asked to save something: a behavioural fact rather than a structural guess. Other uses of `get_panel`, like the Ask panel, are ignored. The toolbar icon, right-click menu, and keyboard shortcuts are URL-only entry points that need nothing from the page. |
| **Data** | A hand-rolled InnerTube client, same-origin from the YouTube tab using your existing session. It lists the library, reads membership, adds and removes videos, and creates playlists. |
| **Session** | Created on intent, destroyed on close or navigation. Membership is fetched fresh on every open. Only the playlist list is cached, in memory, so the next open is instant. |
| **UI** | A closed shadow root on `<html>`, a `<dialog>` in the browser's top layer, styles via `adoptedStyleSheets`, nodes built with `createElement` and never `innerHTML`. It knows nothing about YouTube; hand it a list and it renders one. |

Full write-up in [`architecture/overview.md`](architecture/overview.md), and a per-surface status matrix (what's verified, what's known broken, what has never been tested) in [`architecture/coverage.md`](architecture/coverage.md).

## Privacy

The extension talks only to YouTube, using the session you already have, and never to the developer or any third party. It ships no third-party code.

On disk it stores two display preferences (sort order, and the privacy new playlists are created with) and local counters for the one-time review request. The counters hold no video, playlist, or account identifiers. Your last playlist list (titles, counts, privacy, thumbnails, YouTube's order) is kept in `chrome.storage.session`, which is memory-only and cleared when the browser quits. It never stores which videos are in which playlist, or your searches.

The review request appears after a confirmed save, once you have made at least five successful saves across three days and seven days have passed since the first. Failed saves, already-present videos, removals, and Undo do not count. It does not replace Undo or move focus, and the reviews page opens only when you click "Rate extension".

The one thing worth reading about is how it detects that you clicked Save: it observes YouTube's own request for that action, from a script running in the page. That's a real tradeoff, and the [privacy policy](https://playlist.codyh.xyz/privacy-policy.html) describes it in full, including why the less invasive approach doesn't work.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, project structure, and the test suite.

## License

[AGPL-3.0](LICENSE)
