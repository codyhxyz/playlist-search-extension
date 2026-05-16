# Privacy Policy

**Last updated:** May 15, 2026

## Overview

YouTube Playlist Search is a Chrome extension that adds an in-page search bar to YouTube's playlist selection interfaces. It fetches your playlists directly from YouTube and lets you save videos to them.

## Data Collection

This extension does **not** collect, store, transmit, or sell personal data to the extension developer or any third party. No analytics, tracking, or remote logging is performed. The extension developer does not operate a backend server and never receives any of your data.

No personally identifying information is ever read, stored, or transmitted. Your username, email, and profile photo are ignored by the extension.

## External Services

The extension only communicates with `youtube.com` — the same server you are already browsing. It does this by calling YouTube's internal "InnerTube" API (`https://www.youtube.com/youtubei/v1/*`) as a same-origin request from the YouTube tab you already have open. No requests are made to any other server, and no data is sent to the extension developer.

## Authentication

The extension does **not** use OAuth, does **not** use `chrome.identity`, and does **not** obtain, store, or transmit any access tokens or refresh tokens.

Because InnerTube requests originate from a youtube.com page, your browser automatically attaches your existing YouTube session cookie — the same way it does when you click around YouTube normally. To satisfy InnerTube's authentication scheme, the extension reads the `SAPISID` cookie from `document.cookie` on the current YouTube tab and uses it to compute a short-lived `SAPISIDHASH` authentication header. The cookie value and the derived hash are only ever sent back to `youtube.com` itself as part of these same-origin API calls. They are never stored, logged, or transmitted anywhere else.

## Local Processing and Storage

The extension reads the following "website content" from the YouTube pages you visit:

- Playlist titles and IDs (from the page DOM and from InnerTube API responses)

This data is indexed locally in your browser using MiniSearch so you can type-ahead search your playlists. The index lives only in the tab's memory — the extension does not use `chrome.storage`, `localStorage`, cookies, or any other persistent storage. A short (6-hour) in-memory cache of your playlist list may be kept while the tab is open; it is cleared when the tab closes.

All search, ranking, and filtering is performed locally in your browser.

## Permissions

The extension declares two Chrome API permissions in `manifest.json`:

- `scripting` — to dynamically register the content script once you grant the YouTube host permission.
- `storage` — used in three narrow ways, none of which write personal data:
  - **Onboarding flags** (`chrome.storage.local`): whether you've seen the welcome page; whether host permission is currently granted.
  - **User settings** (`chrome.storage.sync`): a small `ytpfSettings` object — currently a single boolean (`keepDialogOpen`) controlling whether the Save dialog stays open after you tick a playlist. Synced across your Chrome profile by Chrome itself; the extension never reads or transmits sync contents elsewhere.
  - **In-browser diagnostic ring** (`chrome.storage.local`): a short capped buffer of structured events (selector counts, mount-point probes, parser sample shapes) the extension records when it detects a layout it doesn't recognize, so issue reports can include concrete data. The ring is read-only from the extension's side once written, lives only on your machine, and is never transmitted anywhere.

Site access is `https://www.youtube.com/*` only, and is requested as an **optional host permission** that you grant explicitly via the welcome page's "Grant access" button. The extension does not run on any other site, subdomain, or scheme.

A small service worker (`background.js`) exists for two purposes only: (1) registering and unregistering the content script when you grant or revoke the YouTube host permission, and (2) opening the welcome page on first install. It does not handle, transmit, or persist any user data. There is no popup.

## Third-Party Code

The extension bundles a local copy of MiniSearch for BM25-based ranking. MiniSearch runs entirely in your browser; no remote executable code is loaded at runtime, and no third-party SDKs are used.

## On YouTube's Internal "InnerTube" API

The extension calls YouTube's internal InnerTube API (`https://www.youtube.com/youtubei/v1/*`) — the same API YouTube's own web UI uses. This is not a public, documented API, and Google may change or restrict it without notice.

Three honest implications of that choice:

1. **Reliability.** If YouTube changes the InnerTube surface or its authentication scheme, parts of the extension may stop working until an update ships. The extension degrades gracefully — the in-modal search continues to work over whatever playlists YouTube has already rendered — but the "fetch all playlists beyond the 200-item modal cap" feature depends on InnerTube remaining accessible.
2. **Scope of access.** Every InnerTube call uses your existing logged-in YouTube session, same-origin, with the same authentication scheme YouTube's own web client uses. The extension does not gain any access you don't already have when you're logged into YouTube in your browser.
3. **No data goes to the developer.** Whatever the extension reads via InnerTube stays in your browser tab. The extension developer does not operate any server and does not receive any of your data.

We chose this design over the public YouTube Data API v3 because v3 requires OAuth, a Google Cloud project, and is subject to daily quotas — adding friction for users without changing what data is accessible.

## Changes

If this policy changes, the updated version will be posted on this page with a new "Last updated" date.

## Contact

Email: playlist@codyh.xyz
