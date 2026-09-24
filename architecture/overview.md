# Architecture — YouTube Playlist Search

**Status: shipped in 2.0.0.** This began as a proposal; every claim in §7 was then
verified against the live site, and the design was implemented as written. Where a
finding contradicted the original proposal, the correction is kept inline rather than
edited away — the wrong version is often the more useful half of the record, because it
shows which plausible-sounding assumption failed and how.

Companion documents: [`coverage.md`](coverage.md) enumerates every surface and state with
an honest status; [`innertube-api.md`](innertube-api.md) documents the endpoints.

---

## 1. What the product actually is

One sentence: **when the user goes to save a video to a playlist, they get a searchable list of *all* their playlists, and can toggle membership.**

That's it. Everything else is out of scope for v1 — including any modification to `/feed/playlists`, which previous attempts kept drifting into and mistaking for the main event.

---

## 2. Diagnosis: every symptom traces to two root causes

| Symptom you lived with | Root cause |
|---|---|
| Filter bar appears inside unrelated menus | Document-wide MutationObserver + selector match, no identity check, observers leaked across dialog instances |
| List length changes artificially | We hid rows inside YouTube's own virtualized list, breaking its windowing/pagination |
| Have to close and reopen to recover | Our state outlived the dialog instance it belonged to |
| Only ~200 playlists | `get_add_to_playlist` — the endpoint backing the native dialog — is the capped source. We inherited its ceiling because we filtered *its* rows |
| Breaks every few weeks | Anchored on generated class names and deep descendant chains, the fastest-churning thing on the page |

Root cause A: **we read and wrote YouTube's DOM.**
Root cause B: **we used the native dialog's own capped data as our data source.**

The rebuild does not mitigate these. It deletes both.

---

## 3. The invariant

> **We never read data from YouTube's DOM, and we never write a node into YouTube's DOM.**

Every bug class above is downstream of violating this. Hold the invariant and they cannot recur — not "are less likely to," *cannot*.

That leaves exactly two places where we still touch the host page, and both are deliberately tiny:

1. **Detecting intent** — knowing the user wants to save video X.
2. **Dismissing YouTube's own dialog** so ours isn't stacked on theirs.

Both are designed below to use zero CSS selectors.

---

## 4. The architecture: four layers, one direction of dependency

```
┌─────────────────────────────────────────────────────────────┐
│  L4  UI — our own surface, 100% ours                        │
│      closed shadow root on <html>, <dialog>.showModal()     │
│      knows nothing about YouTube                            │
└───────────────────────▲─────────────────────────────────────┘
                        │ SaveSession { videoId, playlists, membership }
┌───────────────────────┴─────────────────────────────────────┐
│  L3  Session/state — pure, testable, no DOM, no network      │
│      created on intent, destroyed on close, never reused     │
└───────────────────────▲─────────────────────────────────────┘
                        │
┌───────────────────────┴─────────────────────────────────────┐
│  L2  Data — hand-rolled InnerTube client (~200 lines)        │
│      the *only* source of playlist truth                     │
└───────────────────────▲─────────────────────────────────────┘
                        │ { videoId }
┌───────────────────────┴─────────────────────────────────────┐
│  L1  Intent — "user wants to save video X"                   │
│      network signal + three zero-DOM entrypoints             │
└─────────────────────────────────────────────────────────────┘
```

Dependencies point one way. L4 has no idea it's running on YouTube — it takes a `SaveSession` and renders it. That makes the entire UI testable in a blank page with a fixture, which is where 90% of the code should live.

---

### L1 — Intent: anchor on the network, not the DOM

**Primary signal:** YouTube's own client, when the user clicks Save from *any* surface, POSTs to `/youtubei/v1/get_panel` with `{ panelId: "PAadd_to_playlist", params }`. We observe that from a `world: "MAIN"` content script at `document_start` that wraps `fetch`/`XHR`, `clone()`s the body (never consumes it), gunzips, and posts only `{panelId, params, continuation, videoId}` across to the isolated world.

Why this is the key move: **the trigger becomes a behavioral fact, not a structural guess.** "YouTube's app just told its own server the user wants to save video X" is a far stronger claim than "an element matching `ytd-add-to-playlist-renderer` appeared somewhere in the tree." It costs zero selectors and zero MutationObservers. `panelId` is the gate — `get_panel` is generic (the "Ask" panel uses it too, with no `panelId`), so the URL alone would fire our UI inside unrelated panels.

**Corrected 2026-08-28 — MAIN world IS required, contrary to this doc's original claim.** YouTube uploads these bodies as a **gzip stream**, and Chrome hands streamed uploads to `webRequest` as `requestBody: {error: "Unknown error."}` with no bytes at all. So `webRequest` cannot see the payload it would need to gate on, and is demoted to a documented secondary that fires only when bytes happen to exist. Verified live on both the home feed and the watch page: every intent resolved `via hook`, none via `webRequest`.

This costs us something real and should be stated plainly: MAIN world means the page can detect and spoof our hook, so cross-world messages must be treated as untrusted input, and network interception draws more CWS review scrutiny. The mitigation is to keep the hook dumb — observe, extract four fields, forward, no logic — so there is little to attack and little to review.

Non-blocking `webRequest` is still fully available in MV3 (only the *blocking* variant is restricted to enterprise) — availability was never the problem; readability of streamed bodies was.

**Zero-DOM floor — the app works even if YouTube nukes everything:**
- Toolbar action popup — reads `tab.url`, parses videoId. Depends on URL structure only. Most durable path we have.
- `chrome.contextMenus` on a thumbnail link — `linkUrl` gives us `/watch?v=…`. YouTube thumbnails are real `<a href>` elements.
- `chrome.commands` keyboard shortcut.

This matters more than it looks. It means **the DOM-adjacent path is an enhancement, not a foundation.** If YouTube changes everything tomorrow, the extension degrades from "seamless" to "press Alt+S" — not from "works" to "broken and weird." That's the difference between a bad week and a negative review.

**YouTube's own dialog is not dismissed.** Our `<dialog>.showModal()` lands in the browser's top layer, above every stacking context, and `inert`s the rest of the page — so theirs cannot be interacted with. The earlier synthetic-`Escape` dismissal was removed (2026-09): it fired before YouTube's popover had rendered, so it missed, and an untrusted Escape on `document` could reach any other listener on the page. YouTube's popover can therefore sit behind ours, under the backdrop.

Explicitly rejected: capture-phase click interception on the Save button. It needs a durable way to recognize that button, and there isn't one — `aria-label` is localized, class names churn. That's the old architecture wearing a hat.

---

### L2 — Data: hand-rolled InnerTube client, first-party

We run inside a content script on `www.youtube.com`, so we are same-origin. No CORS, no proxy, no backend. Cookies attach automatically.

| Need | Endpoint |
|---|---|
| **All** playlists (the 200 fix) | `POST /youtubei/v1/browse` with `browseId: "FEplaylist_aggregation"`, walking `continuationCommand.token` |
| Membership ("already in X") | `POST /youtubei/v1/playlist/get_add_to_playlist` with `videoIds: [id]` — one call, real `containsSelectedVideos` state, but capped at 200 playlists. Membership source, **not** the list source (see §7) |
| Membership for the >200 tail | `POST /youtubei/v1/browse` with `browseId: "VL"+id`, one paginated walk per unknown playlist. Background only |
| Add / remove | `POST /youtubei/v1/browse/edit_playlist` with `ACTION_ADD_VIDEO` / `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` |

Auth: `Authorization: SAPISIDHASH <ts>_<sha1(ts + " " + SAPISID + " " + origin)>` plus `X-Origin`, with `context` lifted from `ytcfg.get('INNERTUBE_CONTEXT')`. This is exactly what YouTube's own JS does. No PoToken/BotGuard involvement — that's scoped to video playback endpoints, not playlist CRUD.

**Hand-rolled, not `youtubei.js`.** That library is excellent but built for the hard problem (cipher extraction, protobuf, every YouTube surface) and drags a JS parser and ~16MB unpacked in with it. We're first-party, so none of its proxy/CORS scaffolding buys us anything. Three endpoints, ~200 lines, small enough to read in one sitting — which also keeps CWS review friction low, since MV3 review dislikes what it can't read.

The core insight repeated: **the native dialog's 200-playlist cap was never our bug to fix, because we should never have been rendering their list.** Different endpoint, different ceiling, problem gone.

---

### L3 — Session: a value, not a lifecycle

```
SaveSession = {
  videoId,
  playlists: Playlist[],        // from FEplaylist_aggregation
  membership: Map<id, boolean>,
  pending: Set<id>,             // in-flight optimistic writes
}
```

Created fresh on every intent. Destroyed on close. **Nothing survives a session** — no observer, no cached node, no listener. This is a one-line answer to "why did I have to close and reopen it": there is no state that can go stale, because there is no state that outlives the dialog.

Playlist list is cached (memory + `chrome.storage.session`, short TTL, invalidated by our own writes) so the second open is instant. Writes are optimistic with rollback on failure.

---

### L4 — UI: a surface we own outright

- Closed shadow root, host attached to `document.documentElement` — **outside `<ytd-app>` entirely**, so Polymer/Lit reconciliation never sees it. Their renderer cannot touch what isn't in its subtree.
- `<dialog>.showModal()` for the top layer: no z-index war, background auto-`inert`.
- `all: initial` at the shadow boundary. Shadow DOM blocks selector bleed but **not inherited properties** — YouTube's theme classes set `color`/`font-family` on `:root` and will leak in without this.
- `adoptedStyleSheets`, and node-construction APIs only (`createElement`/`textContent`/`append`). **Never `innerHTML`.** YouTube enforces `require-trusted-types-for 'script'`; building nodes rather than parsing strings sidesteps that question entirely instead of relying on content-script CSP exemptions holding.

The UI renders *our* data. Search filters *our* array. There is no virtualized list of YouTube's to corrupt, and no row of theirs to hide.

---

## 5. The generalizable idea (and the answer to the Amazon question)

Call the pattern **Sidecar**. Four rules:

1. **Intent from the network.** The host app's own API calls are a truthful, stable statement of user intent. Class names are not.
2. **Data from the host's private JSON API.** Never scrape the DOM for data that already exists as structured JSON one layer down.
3. **UI in a surface you own.** Top layer, closed shadow root, outside their tree. Non-negotiable.
4. **Every host coupling is a named contract with a fail-closed behavior.**

Rule 4 is the part that's actually a library, and it's the direct answer to "it broke and did something insane." Today's coupling points are implicit and scattered. Instead, declare each one:

```
contract("innertube.playlists.list")   → validator, fail: disable list, show honest message
contract("innertube.edit_playlist")    → validator, fail: disable writes, keep search read-only
contract("intent.get_add_to_playlist") → validator, fail: fall back to hotkey/popup entry
contract("host.escape_dismisses")      → validator, fail: cosmetic only, continue
```

Two properties fall out:

- **Runtime:** a failing contract disables exactly the feature that depends on it and says so. **Nothing degrades into nonsense; everything degrades into off.** The old extension's cardinal sin wasn't breaking — it was breaking *invisibly and weirdly*. A filter bar in an unrelated menu is worse than no filter bar.
- **CI:** each contract is a probe runnable against the live site on a schedule, using the existing headed-login E2E session pattern. **You find out YouTube changed something before your users do.** That is the entire difference between "solo dev whose extension is broken" and "solo dev who ships a fix the same week."

This is the transferable asset. Amazon has internal JSON endpoints and its own SPA router; the four rules port directly, and so does the contract registry. That's the thing worth building once and reusing — not another selector file.

**Deliberately deferred:** contracts could be hot-updatable as remote JSON (CWS permits remote *data*, only remote *code* is banned — this is how ad-blocker filter lists dodge review round-trips, and you already have playlist.codyh.xyz to serve it). Build the seam, don't ship the fetch until a breakage justifies the added privacy surface.

---

## 6. Risks and where they land

| Risk | Mitigation |
|---|---|
| InnerTube response shape drifts | Defensive parsing + contract probes in CI. **Fail closed, never fall back to DOM scraping** — DOM fallback is the disease, not the cure |
| Intent signal misses a UI variant (e.g. the compact picker on sparse accounts) | Zero-DOM entrypoints always work; worst case that variant needs the hotkey. Verify coverage in the spike |
| YouTube ToS | Consumer ToS "automated means" clause is technically implicated and broadly unenforced at this scale. Reads/writes are strictly the user's own data in their own session, fully client-side, no relay |
| CWS review friction on `webRequest` | Legal and non-blocking, but 2025's malicious-extension wave raised scrutiny. Keep permissions tight, code readable, privacy story unambiguous |
| `world: MAIN` tamper/detection surface | **Required after all** — Chrome can't read YouTube's streamed gzip bodies via `webRequest`. Mitigate by keeping the hook minimal (observe → extract 4 fields → forward, no logic) and treating every cross-world message as untrusted input. Budget for extra CWS review scrutiny |

**One finding worth calling out separately:** do **not** hybridize with the official YouTube Data API. Registering for API credentials binds you to the Developer Policies, which explicitly forbid undocumented-API use — turning a vague consumer-ToS gray area into a documented breach of a contract you opted into. Pure InnerTube is genuinely the lower-risk fork, not just the easier one. (The official API is separately non-viable anyway: no bulk "which playlists contain video X" endpoint, so membership costs one call per playlist, against a 10k/day quota **pooled across your entire user base** — roughly 60–100 daily actives before it dies.)

---

## 7. Spike results — verified live 2026-08-28

Run against Cody's real account via `tools/import-chrome-cookies.py` + agent-browser (headless, read-only).

**#1 — ANSWERED, thesis confirmed. `FEplaylist_aggregation` is not capped.**
Returned **253 real playlists (256 ids incl. Liked/Watch Later/Favorites) in a single response**, then followed the continuation token to a second page which added nothing and returned no further token — i.e. the walk terminated because the *server* said done, not because our loop gave up. The ~200 ceiling is purely an artifact of `get_add_to_playlist`, the native dialog's endpoint. **The core product claim holds.**

**BUG FOUND BEFORE SHIPPING — brand-account delegation.**
`ytcfg`'s `INNERTUBE_CONTEXT` does **not** carry the delegation, even when `DELEGATED_SESSION_ID` is set. Without explicitly setting `context.user.onBehalfOfUser`, the same call returns **2 playlists** (Liked + Watch Later) instead of 253. Cody's playlists live on a brand channel, not the personal account — the personal account genuinely has zero. This is a first-class requirement, not an edge case: any user on a brand channel would have seen an empty extension. Fixed in `innertube.js`; the `DELEGATED_SESSION_ID` scrape is verified to match `ytcfg` truth from script-tag text (reachable from the ISOLATED world).

**#2, #3, #4 — ANSWERED by running the slice end-to-end against the live site.**

- **Intent trigger: WORKS, but every published fact about it was wrong.** Clicking Save fires `POST /youtubei/v1/get_panel` — `get_add_to_playlist` is never called at all (and returns 400 if you call it yourself). The body is **gzipped**, so naive `JSON.parse` fails silently. And `get_panel` is *generic*, so the URL alone is an unsafe trigger — firing on it blind would recreate the "UI in unrelated menus" bug. The correct gate is `body.panelId === "PAadd_to_playlist"`, YouTube's own semantic name for the panel. ~~`webRequest` delivers the body fine; **MAIN world is not needed**.~~ **Reversed on further testing — see §L1 and unknown #4 below.** `webRequest` delivers *nothing*: these bodies are gzip streams and Chrome reports streamed uploads with no bytes at all. The first measurement happened to observe sibling `log_event` calls, which have plain string bodies, and generalised from them.
- **Sheet renders and searches.** 256 playlists fetched in 809ms, shadow-DOM dialog over YouTube's UI, filter narrows correctly ("ocean" → 1 of 256). Destroyed cleanly on close with no retained state.
- **Escape dismissal: inconclusive/cosmetic**, as predicted. YouTube's popover was still visible behind ours in one run, gone in another. Harmless either way.
- **Write path: WORKS, verified round-trip.** Clicked a filtered row → `add PL2upEFEREDHvPg0pySzqkqiVi3Ipoqp_m -> STATUS_SUCCEEDED`. Confirmed by an *independent* code path (separate `browse VL<id>` walk, not the extension's own code, so an extension bug couldn't self-confirm): video present, playlist 4→5. Then removed via `ACTION_REMOVE_VIDEO` + `setVideoId` and re-checked: 5→4, `present: false`. Account restored.
  - ~~Note `setVideoId` — needed for removal — is only obtainable by browsing the playlist's contents.~~ **Corrected 2026-08-28:** removal does *not* need `setVideoId`. Every row of `get_add_to_playlist` ships a `removeFromPlaylistServiceEndpoint` using `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` + `removedVideoId` — YouTube's own client removes by videoId, no per-playlist fetch. Removal is exactly as cheap as adding. `plsRemoveVideo` in `innertube.js` is lifted verbatim from that payload (shape authoritative; the read-only investigation run did not round-trip it).

**Row-checked state ("already in this playlist") — SOLVED. One call, 200 rows, real state.**

> Supersedes an earlier draft of this section that claimed "there is no bulk membership endpoint anymore." That was wrong, and wrong for two specific reasons worth keeping on the record: the probe ran **without brand delegation**, and it parsed with *the first* `listItems` array it found rather than a full recursive collect. Both failure modes produce a confident, plausible, false negative.

There *is* a bulk membership endpoint, and it is the same one we already call:

```
POST /youtubei/v1/playlist/get_add_to_playlist   { videoIds: [videoId] }
  -> $.contents[0].addToPlaylistRenderer.playlists[]
       .playlistAddToOptionRenderer {
           playlistId,
           title.simpleText,
           privacy,                             // PRIVATE | PUBLIC | UNLISTED
           containsSelectedVideos,              // "ALL" | "NONE"  (single videoId => binary)
           addToPlaylistServiceEndpoint,        // ready-made ACTION_ADD_VIDEO
           removeFromPlaylistServiceEndpoint,   // ready-made ACTION_REMOVE_VIDEO_BY_VIDEO_ID
       }
```

Measured live 2026-08-28 against the 256-playlist brand account: **230 KB, ~180 ms, 200 rows, correct state.** Ground truth check — a video known to be in two playlists came back `ALL` for exactly those two and `NONE` for the other 198.

The two traps that made this look dead:

| call | result |
|---|---|
| `{videoId: id}` (singular) | 400 — wrong key |
| `{videoIds: [id, id2]}` | 400 — the array must hold exactly one |
| `{videoIds: [id]}` **without `context.user.onBehalfOfUser`** | 200, **exactly one row: Watch Later** |
| `{videoIds: [id]}` **with delegation** | 200, **200 rows with `containsSelectedVideos`** |

That third row is the whole story of the earlier wrong conclusion. Brand-account delegation is not just the fix for "2 playlists instead of 256" in the *list* — it is also the difference between membership working and appearing not to exist. `plsFetchMembership` now warns when it gets ≤1 row, so this can never be silently misread again.

`get_panel PAadd_to_playlist` is the same data in the new shape: 200 `toggleableListItemViewModel` entries each carrying `initialState.isToggled`, plus a `frameworkUpdates.entityBatchUpdate` mutation whose `saveToPlaylistListEntity.playlistIds` is the containing set directly. It is 1.2 MB and 370 ms — strictly worse than `get_add_to_playlist` for our purposes. (`visibleElementCount: 5` is a render hint for the popover's initial height, **not** a payload size. Reading it as "the panel only returns 5 items" is what produced the "~5 items" claim.)

**The real limit is 200, and it is a hard server cap.** Confirmed exhaustively:

- The 200-id set is **byte-identical across different videoIds** — a fixed per-account window, not a per-video selection. So a playlist outside it is unknowable via this endpoint for *any* video.
- It is the 200 most-recently-modified *addable* playlists. `LL` (Liked) is structurally excluded — you cannot add to it from the picker. `WL` is always index 0.
- No continuation token anywhere in either response. `maxResults` / `pageSize` / `count` / `offset` / `continuation` / `includeAllPlaylists` are all ignored. Every field of the `get_panel` `params` protobuf was fuzzed (field 5 = 0…8, added varints in fields 2/3/4/6) — always 200.
- Other clients don't help: `MWEB` 200, `TVHTML5` 200, `WEB_REMIX` 33 (music only), `ANDROID`/`IOS` 400.
- **YouTube's own client is equally blind.** Captured its real request by patching `window.fetch` and clicking Save: it POSTs `get_panel {panelId:"PAadd_to_playlist", params}` and receives the same 200 items. For a video whose only playlist sits outside the window, YouTube's own popover rendered every row unchecked and did not list that playlist at all.

**So: `member` is still tri-state — `true` / `false` / `undefined` — but the proportions invert.** For an account with ≤200 playlists, every row is known. For this 256-playlist account, 200 rows are known and **56 are unknown**. `plsFetchMembership` only ever *sets* a key for a playlist the server reported, so absence means unknown; `content.js` maps that to `undefined`. An unchecked box asserts "not in this playlist," and we still never make that claim without evidence.

**The 56 are recoverable if we want them.** `plsResolveMembershipTail(videoId, unknownIds)` walks `browse VL<id>` per playlist. Measured: 56 playlists → 124 HTTP calls → **8.5 s at concurrency 6**, and it correctly found the one true member the fast path could not see. End to end that is 256/256 coverage. Too slow for first paint; correct as a background refinement, and highly cacheable — the tail is by definition the playlists the user rarely touches, so a resolved answer stays valid far longer than a hot one. Shipped in `innertube.js` but **not wired in**; the sheet should paint from the 200 immediately and may upgrade rows in place afterwards.

Local persistence of our own writes is still worth doing, but it is now a latency optimization, not the primary membership signal.

Remaining unknowns, resolved:

2. **Does the compact save picker (sparse accounts) also fire `get_add_to_playlist`?** Still open. Sparse accounts get a compact popover rather than the full modal, and 2.0.0 does not target it; those users fall back to the toolbar/right-click/hotkey floor. Tracked as A-series coverage in `coverage.md`.
3. **Does a synthetic `Escape` keydown actually dismiss YouTube's dialog?** Inconclusive and it does not matter. Our `showModal()` puts us in the top layer and `inert`s the page regardless, so the worst case is their dialog sitting behind ours under the backdrop. Shipped as-is; no CSS fallback was needed.
4. **Does `webRequest.onBeforeRequest` reliably deliver the POST body for these calls?** **No — answered definitively, and it is the reason for `intent-hook.js`.** Chrome hands streamed gzip uploads to `webRequest` as `requestBody: {error: "Unknown error."}` with no bytes. The pre-authorised fallback (MAIN-world `fetch` patching) is what shipped, and the `webRequest` permission was removed entirely rather than kept as a dead secondary — a permission that cannot work is not a fallback, it is review surface for nothing.

---

## 8. The decisions, as made

1. **Replace YouTube's dialog outright, or render ours alongside theirs?** → **Replace.** Partial ownership of a surface is what produced every symptom in §2.
2. **When InnerTube breaks, fail closed or attempt a DOM fallback?** → **Fail closed**, with an honest message. A DOM fallback would reintroduce the exact code path being deleted. This is a deliberate trade of "visibly broken" for "quietly wrong", and visibly broken is the one users can report.
3. **Build the contract registry as a real extractable library now, or inline it?** → **Inline, cleanly seamed.** The four contracts exist as named behaviours (`intent.get_panel`, `innertube.playlists.list`, `innertube.membership`, `host.escape_dismisses`) and each has a probe — `tests/e2e/specs/innertube-contract.sh` runs the data ones against the live site, rebuilding the requests from YouTube's own config so it fails when *YouTube* changes rather than when our client does. No registry abstraction until a second host app makes it real.
4. **Does `/feed/playlists` stay out of scope?** → **Yes, and it was removed.** 2.0.0 does one thing.

## 9. What shipped differently from this document

- **`webRequest` is gone entirely**, not demoted. See unknown #4.
- **`chrome.storage.session` caching was dropped.** §L3 proposed a short-TTL playlist cache; 2.0.0 ships none. The full library fetch measured ~800 ms against a 256-playlist account, which is under the threshold where a cache pays for its own invalidation bugs — and a stale playlist list is exactly the class of "why is this wrong" problem this rebuild exists to eliminate. Revisit if real-world numbers disagree.
- **`plsResolveMembershipTail` is implemented but not wired in.** It resolves the >200 tail correctly in ~9 s at concurrency 6, which is far too slow for first paint. The sheet renders unknown rows as unmarked instead, which is honest and instant. Wiring it as a background upgrade-in-place is the obvious next step.
- **Removal is exposed with confirmation.** `removeVideo()` uses the authoritative payload lifted from YouTube's own client. Known-member rows open a separate confirmation action before the write; unknown rows never offer removal. The request shape is fixture-tested, but a manual round-trip against a disposable playlist is still outstanding.
