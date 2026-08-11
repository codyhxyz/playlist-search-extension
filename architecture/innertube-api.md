# InnerTube API

The extension talks to YouTube via the **InnerTube API** — the same internal API youtube.com's own UI uses. This is not the public YouTube Data API v3.

## Why InnerTube, not Data API v3

The extension previously used the Data API v3 with OAuth. That path required:

- A Google Cloud project with the YouTube Data API enabled
- OAuth consent screen + verification
- Daily quota limits
- Refresh token management in a background service worker

InnerTube solves all of that because we're already on youtube.com:

- No quota (reasonable rate limits only)
- No OAuth — reuse the SAPISID cookie the user already has
- No background worker — call it directly from the content script
- Returns the full playlist library, paginated, without the 200-item cap the modal imposes

See commit `6ef48ac` ("Migrate to InnerTube API and unify search architecture") for the removal of the old OAuth path.

## Endpoints used

Both go through `innertubeRequest(endpoint, body)` at content.js:1076:

```
POST https://www.youtube.com/youtubei/v1/{endpoint}?key={apiKey}&prettyPrint=false
```

| Endpoint | Purpose | Called from |
|---|---|---|
| `browse` with `browseId: "FEplaylist_aggregation"` | First page of the user's playlist library | `innertubeLoadPlaylists` |
| `browse` with `continuation: <token>` | Subsequent pages | `innertubeLoadPlaylists` |
| `browse/edit_playlist` | Add a video to a playlist | `innertubeSaveVideo` |

`browseId: "FEplaylist_aggregation"` is the browse ID for the "Your playlists" aggregation shelf. It returns a paginated list of `gridPlaylistRenderer` / `playlistRenderer` entries.

## Authentication: SAPISID hash

YouTube's own web client authenticates itself using a SHA-1 hash of the `SAPISID` cookie plus a timestamp and origin. We replicate that exact scheme (content.js:1061):

```js
async function getSapisidHash() {
  const sapisid = getSapisid();                                    // from document.cookie
  if (!sapisid) return null;
  const timestamp = Math.floor(Date.now() / 1000);
  const input = `${timestamp} ${sapisid} https://www.youtube.com`;
  const hash = sha1(input);                                         // via crypto.subtle
  return `SAPISIDHASH ${timestamp}_${hash}`;
}
```

Sent as the `Authorization` header. YouTube's server validates it against the SAPISID cookie it already has, so nothing sensitive leaves the browser — we're just proving we can read the user's cookies (which we can, because we run in a youtube.com content script).

**If the user isn't logged in, `getSapisid()` returns `null` and API calls are skipped gracefully.** The modal still works with whatever DOM rows YouTube rendered.

## Config extraction from page scripts

`getInnertubeConfig()` rescans bounded bootstrap-script text on every API session snapshot. It extracts the API key, client version, `SESSION_INDEX`, `DELEGATED_SESSION_ID`, and `DATASYNC_ID`; later configuration blocks win. It is intentionally not memoized because YouTube can switch Google accounts or Brand channels without replacing the content-script document.

Authenticated requests send the extracted session index as `X-Goog-AuthUser` and, for delegated channels, send `X-Goog-PageId`. If the active account identity cannot be determined, the extension fails safely to DOM-only search instead of assuming account 0.

## Pagination

`innertubeLoadPlaylists` (content.js:1194) paginates via continuation tokens:

```js
let data = await innertubeRequest("browse", { browseId: "FEplaylist_aggregation" });
for (let page = 0; page < 50; page += 1) {
  const { playlists, continuation } = parsePlaylistRenderers(data);
  for (const pl of playlists) if (!byId.has(pl.id)) byId.set(pl.id, pl);
  if (!continuation) break;
  data = await innertubeRequest("browse", { continuation });
}
```

Hard cap of 50 pages is defensive — at ~100 playlists per page that's 5000 playlists, which dwarfs any realistic user library and prevents runaway loops if YouTube's response ever omits the terminator.

## Response parsing

`parsePlaylistRenderers(data)` (content.js:1116) walks YouTube's deeply nested response and pulls out playlists from several shapes:

- `gridPlaylistRenderer` — the main shelf format
- `playlistRenderer` — alternate format
- `richItemRenderer.content` — wrapped format on newer layouts
- Continuation tokens from:
  - `continuationItemRenderer.continuationEndpoint.continuationCommand.token`
  - `grid.continuations[0].nextContinuationData.continuation` (older format)

It also handles `onResponseReceivedActions` with `appendContinuationItemsAction` / `reloadContinuationItemsCommand` for continuation responses.

All of this is necessary because YouTube varies its response shape by account, experiment bucket, and client version. The parser is intentionally permissive.

## Session cache

`apiSessionCaches` stores one in-memory cache entry per `[SESSION_INDEX, DELEGATED_SESSION_ID, DATASYNC_ID]` identity. Cache hits and in-flight joins therefore cannot cross Google accounts or Brand channels. Each controller also keeps the exact API playlist snapshot and account key used to build its index.

Entries refresh after six hours when next requested. **Nothing is persisted to `chrome.storage`**.

## Stale-request cancellation

When a modal opens, `bootstrapModalApi(ctrl)` snapshots the active account and increments the per-controller `apiToken`. A response is applied only when the controller is still live, its token still matches, and the current account key equals the request snapshot. `apiPendingAccountKey` prevents duplicate bootstrap calls while still allowing a new account to start its own request immediately.

`teardownHost` increments `apiToken`, so a response for a closed modal lands in the account cache but cannot update dead UI.

## Saving a video to a playlist

`innertubeSaveVideo(playlistId, videoId)` (content.js:1215):

```js
await innertubeRequest("browse/edit_playlist", {
  playlistId,
  actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: videoId }],
});
```

Called when the user clicks the "+" button on a synthetic API-only row. Pending/done operations are keyed by account, video, and playlist, so filtering can recreate DOM rows without issuing duplicate requests. Completed operations retain a short checkmark/dedup window, then expire rather than pretending to be permanent membership state.

`getCurrentVideoId()` trusts only:

1. The modal's own hydrated `data.videoId` / `__data.videoId`.
2. An 11-character `?v=` or `ytd-watch-flexy[video-id]` on `/watch`.
3. An 11-character `/shorts/:id` path.

It never guesses from arbitrary page links. If no authoritative target exists, synthetic saves are disabled while native YouTube rows remain usable.
