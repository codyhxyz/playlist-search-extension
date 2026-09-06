# Spike slice — how to run it and what to look at

**Load:** `chrome://extensions` → Developer mode → *Load unpacked* → pick this `overhaul/` folder.
Open a signed-in `https://www.youtube.com/watch?v=…` + DevTools console (content-script logs land in
the page console; SW logs are behind *service worker* on the extensions card). Prefixes: `[pls]`, `[pls][sw]`.
**Trigger two ways:** (a) YouTube's Save button; (b) the toolbar icon — the zero-DOM floor, which must
work even if (a) doesn't.

## The four unknowns — exact console evidence

1. **Does the intent trigger fire?** SW console: `[pls][sw] SAVE_INTENT {videoId, source:"network"}`.
   Page console: `[pls] SAVE_INTENT <id> via network`. If the SW logs
   `saw get_add_to_playlist but found no videoId` the body shape changed; if nothing logs at all,
   `onBeforeRequest` isn't delivering bodies and the MAIN-world fetch-patch fallback is back on the table.
   Toolbar click should log the same line with `via action`.
2. **Does the count exceed 200?** `[pls] page N: +X new, running total Y, continuation yes/NO` per page,
   then `[pls] fetched N playlists in P pages`. **This number is the whole point.** >200 and matching
   your real total = thesis holds; stopping near 200 or `continuation NO` on page 1 kills the design.
   `[pls] membership hints for M playlists` is the capped endpoint — M < N is the proof. Raw first
   response: `window.__plsFirstPage` (isolated-world console context).
3. **Does Escape dismiss YouTube's dialog?** `[pls] dispatched synthetic Escape … defaultPrevented=…`.
   `true` weakly hints something handled it; the real check is your eyes — is their dialog gone behind
   our backdrop or still sitting there? Cosmetic either way.
4. **Does an add stick?** Click a row → `[pls] add PL… -> STATUS_SUCCEEDED`, row shows `✓ added`.
   Reload the video and re-open: the row should now say `already in`. That round-trip is the only real proof.

## What I guessed at / couldn't verify without running it

- **Never ran any of this against live YouTube.** Parsers were only exercised against synthetic
  fixtures for both `gridPlaylistRenderer` and `lockupViewModel` shapes.
- Id/title pairing: I claim the id at the *outermost* object directly owning `playlistId`/`contentId`,
  then take the first `title` beneath it. Different real nesting → wrong titles, or raw ids shown.
- Kept the probe's id regex verbatim, so `RD`/`UU`/`OL` ids count toward the total if the feed emits
  them — that would inflate the headline number. Check the titles look like real playlists.
- `edit_playlist`: I assume a `status` field and treat non-`STATUS_SUCCEEDED` as failure. If the field
  is absent, the add is reported as success unconditionally.
- I send `&key=<INNERTUBE_API_KEY>` when scraped; the probe worked without it. If calls 401/400, drop it.
- Our own `get_add_to_playlist` re-enters the SW listener; the "sheet already open" guard swallows it
  (`[pls] ignoring intent, sheet already open` is expected). A close/reopen race could slip one through.
- No caching (count re-proved each open), no removal (needs `setVideoId`), max 200 rows rendered.
