# Coverage — every surface and state, with honest status

**Status as of 2.0.0.** Rows changed by the port into `src/` are marked *(2.0.0)*.

Written because a real gap shipped unnoticed: the save trigger worked on watch pages and
silently did nothing on the home feed. One path was tested and treated as the whole category.
This file exists so gaps are **visible and enumerated** rather than discovered by the user.

Status: ✅ verified live · ⚠️ known broken/missing · ❓ never tested · 🔧 in progress

## A. Entry points — every way a user can reach "save this video"

| # | Surface | Status | Note |
|---|---|---|---|
| A1 | Watch page Save button | ✅ | `get_panel` + `panelId: PAadd_to_playlist`, verified |
| A2 | Home feed thumbnail ⋮ → Save | ✅ | **Fixed and verified live.** Root cause was `params` percent-encoding (`atob` throws on `%`), not the URL fallback |
| A3 | Search results ⋮ → Save | ✅ | `get_panel` + `PAadd_to_playlist`, captured live |
| A4 | Watch sidebar recommendation ⋮ → Save | ✅ | captured live |
| A5 | Channel page video ⋮ → Save | ✅ | captured live |
| A6 | Playlist page row ⋮ → Save | ✅ | captured live |
| A7 | Shorts (`/shorts/<id>`) | ⚠️ | **No save affordance exists** — rail is Like/Comment/Share/Remix/Sound. Nothing to observe. Floor-only (toolbar / right-click / Alt+S) |
| A8 | Subscriptions / Library / History feeds | ✅ | all three captured live |
| A9 | Toolbar action icon | ✅ | URL-only; the zero-DOM floor |
| A10 | Keyboard shortcut (`chrome.commands`) | ✅ | Alt+S registered; resolution path identical to toolbar. Accelerator itself not injectable over CDP |
| A11 | Context menu on a video link | ✅ | `info.linkUrl` |
| A12 | Negative test: the "Ask" panel | ✅ | Also uses `get_panel`, but with no `panelId` — correctly rejected, no sheet. This is the "UI in unrelated menus" bug class, tested for |

## B. Account / identity states

| # | State | Status | Note |
|---|---|---|---|
| B1 | Brand-channel account | ✅ | Needs `context.user.onBehalfOfUser`; without it you get 2 playlists, not 256 |
| B2 | Personal account, no delegation | ✅ | Cody's personal account genuinely has 0 playlists |
| B3 | **Switching accounts mid-session** | ✅ | *(2.0.0)* Fixed. `resetConfigCache()` is called from the SPA-navigation handler in `content.js`, so the cached delegation dies with the page it belonged to. Previously the session kept acting as whichever channel it started on |
| B4 | Signed out | ✅ | *(2.0.0)* Verified in a fresh profile: the sheet opens, then reports `Couldn't load your playlists: no SAPISID cookie — signed out?`. Fails closed with an honest message, exactly as intended, and does not fall back to reading the page |
| B5 | Multiple Google sessions (`authuser=1`) | ❓ | `SESSION_INDEX` never handled |

## C. Data / scale states

| # | State | Status | Note |
|---|---|---|---|
| C1 | 256 playlists | ✅ | 809ms, no cap |
| C2 | 0 playlists | ❓ | Empty state undesigned |
| C3 | >200 playlists in the UI | ⚠️ | Sheet renders max 200 rows. Search still finds the rest, and the list now says how many it is holding back ("N more — keep typing to narrow") instead of truncating silently — but scrolling alone will not reach them. Acceptable for a type-to-find surface; a virtualised list would remove the cap if it ever bites |
| C4 | Duplicate playlist titles | ⚠️ | Two "AGI this" seen — still unconfirmed whether real or a parsing dupe. Ids are deduplicated by `Map` key, so a parsing dupe would require two genuinely different ids; that makes "real duplicates in the account" the likelier explanation, but it has not been checked |
| C5 | Very long titles / emoji | ✅ | Single-line ellipsis (constant row height for arrow-key nav); emoji scaled to 0.9em |
| C6 | Membership, first 200 playlists | ✅ | `get_add_to_playlist {videoIds:[id]}` **with delegation** — real `containsSelectedVideos`, ~180ms |
| C7 | Membership, the >200 tail | ⚠️ | Hard server cap; same 200 ids for every video. YouTube's own client is blind here too. `plsResolveMembershipTail` written + verified but **not wired in** |
| C8 | Why *those* 200 are chosen | ❓ | "Most recently modified" is inference with a known counterexample. Cap itself is proven |

## D. Lifecycle

| # | State | Status | Note |
|---|---|---|---|
| D1 | Hard page load → save | ✅ | |
| D2 | SPA nav (feed → watch) then save | ✅ | `yt-navigate-finish` + `popstate` destroy the previous page's sheet; verified with browser-Back |
| D3 | Save twice without reload | ✅ | Guard logs "sheet already open" |
| D4 | Sheet close → reopen | ✅ | Fresh session each time, no retained state |
| D5 | Rapid open/close race | ❓ | A stale intent could slip past the open-guard |

## E. Write operations

| # | Operation | Status | Note |
|---|---|---|---|
| E1 | Add to playlist | ✅ | Verified round-trip, then rolled back |
| E2 | Remove from playlist | ⚠️ | *(2.0.0)* `removeVideo()` ships in the data layer but is **deliberately not exposed in the UI**, because it was never round-tripped. Payload is lifted verbatim from the `removeFromPlaylistServiceEndpoint` YouTube ships on every row, so the shape is authoritative — but shipping an untested write against a user's real playlists is not a trade worth making. "Already in" is a terminal state, not a toggle |
| E3 | Create new playlist | ⚠️ | YouTube's own picker offers it; we don't |
| E4 | Add failure / offline / 401 | ❓ | Error path never exercised |
| E5 | Concurrent adds (fast clicking) | ✅ | *(2.0.0)* Per-row state guards it: a row in `adding` or `added` returns early from `pick()`. Covered by `tests/test-sheet-render.mjs` |
| E6 | Saving to a playlist the video is already in | ✅ | *(2.0.0)* **Was a real bug, found by the new UI contract test.** `member === true` rows were still clickable, and YouTube permits duplicate entries — so clicking one silently added the video a second time. Those rows are now non-actionable |

## F. Environment

| # | State | Status | Note |
|---|---|---|---|
| F1 | Dark / light theme | ✅ | Both rendered and checked from a fixture; contrast verified |
| F2 | Non-English locale | ❓ | We anchor on `panelId`, not localized text, so it *should* hold — unverified |
| F3 | Theater / fullscreen mode | ❓ | Our dialog is top-layer, should be unaffected |
| F4 | Other extensions on the page | ❓ | |
| F5 | Real Chrome vs bundled Chromium | ⚠️ | All verification so far is bundled Chromium. Real Chrome only manually spot-checked |

---

## The process fix

The bug wasn't "the home feed was hard." It's that **one surface was tested and the result was generalized to a category**, and nothing in the workflow forced the question "what are the other members of this category?"

Rule going forward: **before claiming a capability works, enumerate the set it belongs to and state which members were actually tested.** "Save works" is not a claim that can be verified — "save works from A1, untested on A2–A8" is. Every ✅ above should trace to an actual observed run, and every ❓ is an admission, not a gap in the document.

### What 2.0.0 did to enforce it

The rule is now partly mechanical rather than purely a discipline:

- `tests/e2e/specs/save-sheet.sh` drives **the watch page and the home feed separately and reports them separately**. It cannot pass by testing one and inferring the other, which is the exact shape of the original failure.
- `tests/e2e/specs/innertube-contract.sh` probes YouTube's endpoints by rebuilding the requests from YouTube's own `ytcfg` rather than calling our client. A test written against our own code can agree with itself and still be wrong; this one fails when *YouTube* changes.
- `tests/test-sheet-render.mjs` pins the UI contract in a real engine. It earned its place immediately by finding E6 on its first run.
- Both remaining false-negative traps are now unit-tested by name: brand-channel delegation (`cfgFrom` lifting `DELEGATED_SESSION_ID`) and the recursive membership collect. Both previously produced *confident, plausible, wrong* answers, which is the failure mode that survives review.

Still not mechanised: everything marked ❓ above. Those are admissions.
