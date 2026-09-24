# Privacy Policy

**Last updated:** September 24, 2026

## Overview

YouTube Playlist Search is a Chrome extension that replaces YouTube's "Save to playlist" picker with a searchable one covering every playlist you own. It fetches your playlists directly from YouTube and lets you save videos to them.

As of version 2.0.0 the extension adds nothing to YouTube's own page and reads no data out of it. Its interface is drawn in a private container of its own, and its data comes from YouTube's API rather than from the rendered page.

## Data Collection

This extension does **not** collect, store, transmit, or sell personal data to the extension developer or any third party. No analytics, tracking, or remote logging is performed. The extension developer does not operate a backend server and never receives any of your data.

Your username, email, and profile photo are ignored. The extension reads only the playlist content, the YouTube session value, and the save-request signal described below. None of it is sent to the developer or any third party.

## External Services

The extension only communicates with YouTube. It calls YouTube's internal "InnerTube" API (`https://www.youtube.com/youtubei/v1/*`) as a same-origin request from the YouTube tab you already have open. The only other requests are for the playlist thumbnails shown in the picker: these are the image addresses YouTube itself returns, on YouTube's image server (`i.ytimg.com`), loaded the same way YouTube's own pages load them — so your browser fetches and caches them exactly as it does when you browse YouTube. No requests are made to any other server, and no data is sent to the extension developer.

## Authentication

The extension does **not** use OAuth, does **not** use `chrome.identity`, and does **not** obtain, store, or transmit any access tokens or refresh tokens.

Because InnerTube requests originate from a youtube.com page, your browser automatically attaches your existing YouTube session cookie — the same way it does when you click around YouTube normally. To satisfy InnerTube's authentication scheme, the extension reads the `SAPISID` cookie from `document.cookie` on the current YouTube tab and uses it to compute a short-lived `SAPISIDHASH` authentication header. The cookie value and the derived hash are only ever sent back to `youtube.com` itself as part of these same-origin API calls. They are never stored, logged, or transmitted anywhere else.

## How the extension knows you clicked Save

This is the one genuinely new behaviour in version 2.0.0, and it deserves to be described plainly rather than buried.

When you click "Save" on a YouTube video — from the player, from a `⋮` menu in a feed, from search results, anywhere — YouTube's own web app sends a request to its own server saying, in effect, "this user wants to save this video." The extension watches for **that specific request** and uses it as the signal to open its picker.

To do that, it installs a small script into the YouTube page itself (a `MAIN`-world content script, `intent-hook.js`) that wraps the browser's `fetch` and `XMLHttpRequest` functions. Concretely:

- It looks at requests to exactly two YouTube API paths: `/youtubei/v1/get_panel` and `/youtubei/v1/playlist/get_add_to_playlist`. Every other request on the page — video playback, comments, ads, search, sign-in, everything — is ignored and never inspected.
- For those two, it reads a **copy** of the request body (the original is always passed through untouched, so YouTube's own functionality is unaffected) and extracts at most four short fields: `panelId`, `params`, `continuation`, and `videoId`.
- Those four fields, and nothing else, are passed to the extension. YouTube's client-configuration blob — which contains identifiers like your visitor ID — is deliberately **not** forwarded, even though the script can see it.
- Nothing observed here is stored, and nothing leaves your browser.

Two honest consequences of this design:

1. **The page can see this script.** Code running in the `MAIN` world shares the page's environment, which means youtube.com could in principle detect that the extension is installed, or feed it a fake save request. The extension therefore treats everything crossing that boundary as untrusted, and the worst a forged message can achieve is opening the extension's own picker for a video of YouTube's choosing — something the page could equally do by navigating. The script is kept deliberately small and logic-free to keep that surface minimal.
2. **We tried to avoid it and could not.** The intended design used Chrome's `webRequest` permission, which does not require any page-world code. It does not work: YouTube sends these request bodies as a compressed stream, and Chrome hands streamed uploads to extensions with no readable content whatsoever. The permission was removed rather than kept as dead weight.

If you would rather the extension not observe anything at all, it works without this: the toolbar icon, the right-click menu, and `Alt`+`S` all open the same picker using only the page's URL. Those paths involve no observation of YouTube's requests.

## Local Processing and Storage

The extension reads the following from YouTube:

- **Playlist titles, IDs and video counts**, and whether a given video is already in a playlist — from InnerTube API responses only. Version 2.0.0 removed all reading of playlist data out of the rendered page.
- **The video ID you are trying to save**, from one of: YouTube's own save request (see "How the extension knows you clicked Save"), the URL of the tab, or the URL of a link you right-clicked.
- **YouTube's client configuration** (`INNERTUBE_CONTEXT`, the brand-channel session ID if you are acting as a channel, and which of your signed-in Google accounts the page is using), read from the page's own configuration script. This is what makes an API call from your session valid, and is the same configuration YouTube's own code uses. It is sent only back to YouTube.

All searching and filtering happens locally in your browser, over an in-memory list. No playlist data, search text, or video IDs are written to `chrome.storage`, `localStorage`, cookies, or any other persistent storage, and none of it survives closing the sheet: the extension keeps no playlist cache at all in this version. The only thing it remembers about how you use it is two display preferences, listed under Permissions below.

## Permissions

The extension declares three Chrome API permissions in `manifest.json`:

- `scripting` — to dynamically register its content scripts once you grant the YouTube host permission.
- `contextMenus` — to add a single "Save to playlist" item to the right-click menu on YouTube video links.
- `storage` — used for non-personal operational state only:
  - **Onboarding flags** (`chrome.storage.local`): whether you've seen the welcome page and whether host permission is currently granted.
  - **Registration errors** (`chrome.storage.local`): an error message and timestamp when Chrome cannot register the packaged content script. This contains no playlist, search, page, or authentication data.
  - **Display preferences** (`chrome.storage.local`): the sort order you last chose (for example "A → Z") and the privacy setting new playlists are created with (Private, Unlisted or Public). These are two fixed words, not playlist names, IDs or searches, and they never leave your browser.

Runtime diagnostics are written only to the local DevTools console. They are not persisted, copied into the YouTube page DOM, or transmitted.

Site access is `https://www.youtube.com/*` only, and is requested as an **optional host permission** that you grant explicitly via the welcome page's "Grant access" button. The extension does not run on any other site, subdomain, or scheme.

A small service worker (`background.js`) registers or unregisters the content scripts, works out which video a save request refers to, opens the welcome page on first install, and stores the non-personal operational state listed above. It never sees your playlists, your cookies, or your authentication headers — those exist only inside the YouTube tab. There is no popup.

The extension does **not** request the `webRequest` permission. An earlier design used it to observe save requests; it was removed because Chrome cannot read the bodies of these particular requests at all, making the permission useless while still widening what the extension could see.

## Third-Party Code

**There is none.** Version 2.0.0 removed the last bundled dependency (MiniSearch, previously used for search ranking; the current search is a plain substring match over your own playlist titles). The extension is entirely first-party code. No remote executable code is loaded at runtime, and no third-party SDKs, analytics, or frameworks are used.

## On YouTube's Internal "InnerTube" API

The extension calls YouTube's internal InnerTube API (`https://www.youtube.com/youtubei/v1/*`) — the same API YouTube's own web UI uses. This is not a public, documented API, and Google may change or restrict it without notice.

Three honest implications of that choice:

1. **Reliability.** If YouTube changes the InnerTube surface or its authentication scheme, the extension will stop working until an update ships. It is designed to **fail closed**: when it cannot load your playlists it says so and does nothing, rather than falling back to reading YouTube's page. That fallback is what produced the misbehaviour in earlier versions — a search box appearing inside unrelated menus, lists changing length on their own — so it was removed deliberately, accepting a visible outage over a confusing one.
2. **Scope of access.** Every InnerTube call uses your existing logged-in YouTube session, same-origin, with the same authentication scheme YouTube's own web client uses. The extension does not gain any access you don't already have when you're logged into YouTube in your browser.
3. **No data goes to the developer.** Whatever the extension reads via InnerTube stays in your browser tab. The extension developer does not operate any server and does not receive any of your data.

We chose this design over the public YouTube Data API v3 because v3 requires OAuth, a Google Cloud project, and is subject to daily quotas — adding friction for users without changing what data is accessible.

## Changes

If this policy changes, the updated version will be posted on this page with a new "Last updated" date.

## Contact

Email: playlist@codyh.xyz
