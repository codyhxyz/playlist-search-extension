# Coverage — every surface and state, with honest status

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
| B3 | **Switching accounts mid-session** | ⚠️ | `plsCfgCache` caches the delegation on first use and never invalidates. Still open |
| B4 | Signed out | ❓ | Should fail closed with an honest message; untested |
| B5 | Multiple Google sessions (`authuser=1`) | ❓ | `SESSION_INDEX` never handled |

## C. Data / scale states

| # | State | Status | Note |
|---|---|---|---|
| C1 | 256 playlists | ✅ | 809ms, no cap |
| C2 | 0 playlists | ❓ | Empty state undesigned |
| C3 | >200 playlists in the UI | ⚠️ | Sheet renders max 200 rows; search finds the rest but scrolling won't reach them |
| C4 | Duplicate playlist titles | ⚠️ | Two "AGI this" seen — unclear if real or a parsing dupe. Never confirmed |
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
| E2 | Remove from playlist | ⚠️ | `plsRemoveVideo` written but **never round-tripped** (read-only run). Uses `ACTION_REMOVE_VIDEO_BY_VIDEO_ID` — no `setVideoId` needed, so removal is as cheap as adding. Payload lifted verbatim from YouTube's own client |
| E3 | Create new playlist | ⚠️ | YouTube's own picker offers it; we don't |
| E4 | Add failure / offline / 401 | ❓ | Error path never exercised |
| E5 | Concurrent adds (fast clicking) | ❓ | |

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
