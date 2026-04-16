# Privacy Policy

**Last updated:** April 15, 2026

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

The extension requests **no** Chrome permissions and **no** host permissions. It runs only as a content script on `youtube.com` (and its subdomains), which is the only site it needs access to. There is no background service worker and no popup.

## Third-Party Code

The extension bundles a local copy of MiniSearch for BM25-based ranking. MiniSearch runs entirely in your browser; no remote executable code is loaded at runtime, and no third-party SDKs are used.

## Changes

If this policy changes, the updated version will be posted on this page with a new "Last updated" date.

## Contact

Email: playlist@codyh.xyz
