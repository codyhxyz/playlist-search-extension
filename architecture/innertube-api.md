# InnerTube API

The extension talks to YouTube via the **InnerTube API** — the same internal API youtube.com's own web client uses. This is not the public YouTube Data API v3.

Implementation: [`src/lib/innertube.js`](../src/lib/innertube.js). Parsing is split from the calls so the response shapes are unit-testable without a network (`tests/innertube.test.mjs`), and a live contract probe (`tests/e2e/specs/innertube-contract.sh`) re-derives the same requests from YouTube's own config so it fails when *YouTube* changes rather than when our client does.

## Why InnerTube, and why not Data API v3

We run in a content script on `www.youtube.com`, so we are same-origin: no CORS, no proxy, no backend, and the session cookie attaches automatically.

The Data API v3 is not merely more work — it is **non-viable for this product**, for two independent reasons:

1. **There is no bulk membership endpoint.** Answering "which of your playlists already contain this video" costs one request per playlist, against a 10,000-unit daily quota **pooled across the entire user base**. That is roughly 60–100 daily active users before the extension stops working for everyone.
2. **It is the higher-risk option, not the safer one.** Registering for API credentials binds you to the YouTube API Developer Policies, which explicitly forbid use of undocumented APIs — converting a vague consumer-ToS gray area into a documented breach of a contract you opted into.

We also evaluated `youtubei.js` and did not adopt it: it is built for the hard problems (cipher extraction, protobuf, every YouTube surface) and drags a JS parser and ~16 MB unpacked along with it. First-party and same-origin, none of its proxy/CORS scaffolding buys us anything, and three endpoints do not justify putting a megabyte of someone else's client in front of a Chrome Web Store reviewer.

## Endpoints

All requests go through `plsPost(path, body)`:

```
POST https://www.youtube.com/youtubei/v1/{path}?prettyPrint=false[&key={apiKey}]
```

| Path | Body | Purpose |
|---|---|---|
| `browse` | `{ browseId: "FEplaylist_aggregation" }` | The user's full playlist library, page 1 |
| `browse` | `{ continuation: <token> }` | Subsequent pages |
| `playlist/get_add_to_playlist` | `{ videoIds: [videoId] }` | Which playlists already contain this video |
| `browse/edit_playlist` | `{ playlistId, actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId }] }` | Add |
| `browse/edit_playlist` | `{ playlistId, actions: [{ action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID", removedVideoId }] }` | Remove after explicit UI confirmation (see `coverage.md` E2) |
| `playlist/create` | `{ title, privacyStatus, videoIds: [videoId] }` | Create new playlist and immediately add the video |

### The two-endpoint split is the whole product

`get_add_to_playlist` is the endpoint behind YouTube's own Save picker, and it returns **at most 200 playlists**. Earlier versions of this extension filtered *YouTube's rendered list*, so they inherited *YouTube's ceiling*. Fetching the library from `browse FEplaylist_aggregation` instead is not an optimisation — it is the entire reason the extension can show you playlist 201.

Measured against a 256-playlist account on 2026-08-28: 253 real playlists (256 ids including Liked / Watch Later / Favourites) in a **single** response, with a continuation token that led to a page adding nothing and returning no further token. The walk terminated because the server said done, not because the loop gave up.

### The 200 cap is a hard server limit

This was established exhaustively, because the temptation to assume it is a paging boundary is strong:

- The 200-id set is **byte-identical across different videoIds** — a fixed per-account window, not a per-video selection.
- It is the 200 most-recently-modified *addable* playlists. `LL` (Liked) is structurally excluded — you cannot add to it from a picker. `WL` is always index 0.
- No continuation token appears anywhere in the response. `maxResults`, `pageSize`, `count`, `offset`, `continuation` and `includeAllPlaylists` are all ignored. Every field of the `get_panel` `params` protobuf was fuzzed. Always 200.
- Other clients don't help: `MWEB` 200, `TVHTML5` 200, `WEB_REMIX` 33 (music only), `ANDROID`/`IOS` 400.
- **YouTube's own client is equally blind.** For a video whose only playlist sat outside the window, YouTube's popover rendered every row unchecked and did not list that playlist at all.

Hence membership is **tri-state**: `true` / `false` / `undefined`. The parser only ever *sets* a key for a playlist the server actually reported, so absence means unknown, and the UI draws unknown rows bare. An unchecked row asserts "not in this playlist", and we do not make that claim without evidence.

`resolveMembershipTail()` can settle the remainder by walking `browse VL<id>` per unknown playlist — measured at 56 playlists → 124 requests → ~9 s at concurrency 6, and it correctly found the one true member the fast path could not see. Too slow for first paint; correct as a background refinement. Implemented, not wired in.

### Two traps worth keeping on the record

Both produced **confident, plausible, false** conclusions — the failure mode that survives review:

| Call | Result |
|---|---|
| `{ videoId: id }` (singular) | 400 — wrong key |
| `{ videoIds: [id, id2] }` | 400 — the array must hold exactly one |
| `{ videoIds: [id] }` **without delegation** | 200, and **exactly one row: Watch Later** |
| `{ videoIds: [id] }` **with delegation** | 200, **200 rows with real `containsSelectedVideos`** |

The third row is how "there is no bulk membership endpoint anymore" got written down and believed. The other half of that same wrong conclusion was parsing the *first* `listItems` array found rather than doing a full recursive collect. Both are now unit-tested by name.

## Authentication

YouTube's own web client authenticates with a SHA-1 hash of the `SAPISID` cookie plus a timestamp and origin. We replicate that scheme exactly:

```js
Authorization: `SAPISIDHASH ${ts}_${sha1(`${ts} ${sapisid} https://www.youtube.com`)}`
X-Origin: https://www.youtube.com
```

### Request headers

| Header | Value | Why |
|---|---|---|
| `Authorization` | `SAPISIDHASH …` (or the 1P/3P variant) | Session auth, above |
| `X-Origin` | `https://www.youtube.com` | Part of the hash contract |
| `X-Goog-AuthUser` | ytcfg `SESSION_INDEX`, default `"0"` | Which signed-in Google account the call is for |
| `X-Goog-PageId` | ytcfg `DELEGATED_SESSION_ID`, only when set | Names the brand channel being acted as |

`X-Goog-AuthUser` matters when several Google accounts are signed in: the cookies are shared across all of them, and `SESSION_INDEX` (quoted `"1"` or bare `1` in ytcfg — `cfgFrom` accepts both) is how the page says which one this tab is. `"0"` is the first account and the server's default when the header is absent. `X-Goog-PageId` is sent *in addition to* `context.user.onBehalfOfUser`, which stays: the body field is the one proven to matter (2 vs 256 playlists); the header mirrors what YouTube's own client sends.

**Both headers are mirrored from YouTube's own requests and unit-tested for what we send, but NOT yet live-verified with two signed-in accounts.** Until that is done, treat multi-account correctness as expected, not established.

No OAuth, no `chrome.identity`, no tokens stored anywhere. The cookie value and the derived hash go only back to youtube.com as part of these same-origin calls.

PoToken / BotGuard is not involved: that machinery is scoped to video playback endpoints, not playlist CRUD.

## Context, and the brand-account requirement

Every request carries a `context` object lifted from the page's own `INNERTUBE_CONTEXT`. `ytcfg` lives in the MAIN world, so the isolated-world client scrapes the JSON out of the page's script text (`cfgFrom`). This reads *configuration*, not rendered markup — there is no other source for the session handshake, and it does not violate the "never read data from YouTube's DOM" invariant, which is about playlist data.

**`INNERTUBE_CONTEXT` does not carry the channel delegation, even when the page has it.** If the user's playlists live on a brand channel, `context.user.onBehalfOfUser` must be set explicitly from `DELEGATED_SESSION_ID`. Without it:

- `browse FEplaylist_aggregation` returns **2** playlists (Liked + Watch Later) instead of 256
- `get_add_to_playlist` returns **1** row instead of 200

Neither errors. You simply get a smaller, wrong answer that looks like an API limit — which is exactly what it was mistaken for. `fetchMembership` warns whenever it sees ≤1 row so this can never be silently misread again, and the delegation scrape is unit-tested.

The cache holding this is invalidated on SPA navigation, because switching accounts on YouTube is a client-side navigation and a session that kept its first delegation would go on listing the wrong library.

## Video counts

`fetchAllPlaylists()` returns `Array<{id, title, count?}>`. `count` is read from the entry that owns the playlist id — never from elsewhere in the response — and is **absent** (not `0`) when it could not be parsed.

| Generation | Source | Example |
|---|---|---|
| `gridPlaylistRenderer` (legacy) | `videoCountText`, then `videoCountShortText` | `{runs: ["42", " videos"]}`, `{simpleText: "42"}` |
| `lockupViewModel` (current) | first `thumbnailBadgeViewModel.text` that reads as a count | `"12 videos"`, `"4 episodes"` |

`parseVideoCount` accepts only whole English counts: `"1,234 videos"`, `"1 video"`, `"No videos"` → 0, a bare `"42"`, and the same with `episode(s)`. Everything else — `"1.234"` (German grouping or a decimal?), `"1,2K"`, `"1 234"`, `"12 vidéos"`, a `"Mix"` badge — is `undefined`. A missing count shows nothing; a misread one would be a lie.

Evidence: the real capture `tests/fixtures/innertube/real-channel-playlists-mrbeast.json` yields 4, 9, 8, 9, 25 — all from `"N episodes"` badges (podcast-style playlists say episodes, not videos). The same payload carries the *channel's* `"978 videos"` in its page header, which is why the scan is scoped to the owning entry; a test pins that. The legacy shape is only covered by synthetic fixtures. The synthetic lockup's `"Playlist • 1,234 videos"` metadata row is deliberately not read — the real capture has no such row.

## Error kinds

Every error thrown by `plsPost` and by the calls built on it (`addVideo`, `removeVideo`, `createPlaylist`, `fetchAllPlaylists`, `fetchMembership`, …) is built by `plsError(kind, message, cause?)` and carries `kind` and `userMessage`; `message` stays the descriptive `path -> status` string the `[pls]` logs print. The UI renders `Couldn’t save to “X”. <userMessage>`, so each `userMessage` is one sentence with one full stop.

| `kind` | Trigger | `userMessage` |
|---|---|---|
| `offline` | `navigator.onLine === false` (checked before sending), or `fetch` rejects | You’re offline. |
| `auth` | no `SAPISID`-family cookie, HTTP 401 / 403 | You’re signed out of YouTube — sign in and try again. |
| `rate` | HTTP 429 | YouTube is rate-limiting requests — wait a moment. |
| `server` | HTTP 5xx, or a 2xx whose body is not JSON | YouTube had a problem — try again. |
| `http` | any other non-ok HTTP status | YouTube rejected the request. |
| `rejected` | `edit_playlist` status other than `STATUS_SUCCEEDED`; `playlist/create` with no playlistId | YouTube rejected the change. |

`classifyHttp(status)` is the pure status → kind mapping (null for 2xx). Caveat on `offline`: a rejected `fetch` means *no HTTP response at all*. Offline is the likeliest cause, but a blocking extension looks identical from inside the page and is reported the same way.

Cancellation is not an error kind: `resolveMembershipTail(…, signal)` passes its `AbortSignal` to `fetch`, and an aborted request's `AbortError` is rethrown unwrapped and swallowed silently by the tail walk, which resolves with whatever it had settled.

## Failure policy

**Fail closed.** If InnerTube changes shape or authentication, the sheet says it could not load your playlists and does nothing. There is deliberately no fallback to reading YouTube's rendered page — that fallback is the disease, not the cure, and reintroducing it would recreate every symptom the rebuild deleted.

This is not a public, documented API. Google may change or restrict it without notice. The mitigation is the contract probe, not a fallback: find out before users do.
