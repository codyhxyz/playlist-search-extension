# Capturing real InnerTube responses

The JSON files in this directory are what the parser tests run against. Some
are real captures from production YouTube (`real-*.json`), some are
hand-written **synthetic** minimal shapes for branches we haven't grabbed
real captures of yet. Synthetic fixtures only catch the bugs the author
thought of; the 1.6.9 regression was a shape nobody thought of. Replace
each synthetic fixture with a real capture and every YouTube migration
shows up as a red test instead of a support email.

## Fastest path: the capture script

`scripts/capture-innertube.mjs` wraps the agent-browser dance below into
one command per surface. Use this unless you specifically need DevTools.

```bash
# Public channel /playlists — works in any agent-browser session (no login).
node scripts/capture-innertube.mjs channel @MrBeast

# Save-to-playlist modal — requires a logged-in YouTube session.
node scripts/capture-innertube.mjs modal https://www.youtube.com/watch?v=<id>

# Personal /feed/playlists, initial + continuation — requires login.
node scripts/capture-innertube.mjs feed
```

Each command opens an agent-browser tab, navigates / clicks / scrolls as
needed, pulls the InnerTube JSON, scrubs session tokens, writes a
`real-*.json` fixture, and prints a parse summary so you can sanity-check
counts and IDs before committing. The corresponding skipped tests in
`tests/innertube-parse.test.mjs` un-skip automatically once the fixture
file exists.

## Manual fallback (DevTools)

### Recipe (Chrome DevTools, ~3 minutes per capture)

1. Open a YouTube tab where you're signed in.
2. Open DevTools → **Network** tab. Filter on `browse` or `youtubei`.
3. Trigger the request you want to capture:
   - **Save-to-playlist modal**: click "Save" on any video.
   - **/feed/playlists**: navigate to `https://www.youtube.com/feed/playlists`.
   - **Continuation pages**: scroll past the first ~30 playlists on `/feed/playlists`
     until a second `browse?...key=...` request fires.
4. Click the request. In the **Response** tab, click anywhere in the JSON
   blob and ⌘-A / Ctrl-A → copy.
5. Drop it into `tests/fixtures/innertube/<descriptive-name>.json`. Suggested
   names:
   - `real-modal-save-to-playlist.json` — initial Save-modal browse response
   - `real-feed-playlists-initial.json` — first page of /feed/playlists
   - `real-feed-playlists-continuation.json` — a subsequent paginated page
6. **Sanitize**: search the file for your real playlist IDs / titles if any
   of them are private. The parser only needs `playlistId`, `title`, and
   `videoCount` shape — you can find-and-replace IDs with `PLDEADBEEF...`
   and titles with `Test Playlist N` without changing the test value.
   `_provenance` at the top should record the capture date + the YouTube
   surface you grabbed it from.
7. Add a corresponding test in `tests/innertube-parse.test.mjs` that loads
   the file and asserts the **expected** playlist count, the first ID, and
   the continuation token (if present). Run `npm test` to verify it parses
   correctly today — then leave it in place as the regression net for
   tomorrow.

### Recipe (agent-browser, scripted directly — for one-offs not yet wired into capture-innertube.mjs)

If you have `agent-browser` installed (`~/.local/bin/agent-browser`, see the
top-level CLAUDE.md), you can script the capture. The pattern mirrors
`tests/test-feed-page-mount.mjs`:

```bash
# 1. Use your existing logged-in youtube session profile.
#    First time only — opens a real Chrome window, log in, then quit.
agent-browser session --name youtube-real --setup

# 2. Navigate + dump the InnerTube response in the request log.
agent-browser eval --session-name youtube-real \
  --url 'https://www.youtube.com/feed/playlists' \
  --wait-for 'response:url-contains:/youtubei/v1/browse' \
  --emit 'lastResponseBody'
```

The `--emit` JSON goes to stdout — pipe it into a file under
`tests/fixtures/innertube/`. Reuse the `youtube-real` session for repeat
captures; it stays warm.

## What NOT to capture

- Anything with auth tokens (`SAPISIDHASH`, cookie blobs). The parser never
  touches these — only the *response body*. Strip request headers before
  committing.
- Personally identifying data: account email in `accessibility`, real
  playlist titles you don't want public. Replace before commit.
- Sessions newer than ~6 months. YouTube rotates renderer shapes; an
  ancient capture is closer to dead weight than regression protection.
  Recapture seasonally if the suite goes too quiet.

## Why this isn't automated end-to-end

Capturing real InnerTube responses requires your logged-in YouTube session.
Embedding that in CI would either bake real credentials into the repo (bad)
or stand up a fake YouTube account (high-overhead, low-fidelity). The
manual / per-developer recipe stays human-in-the-loop deliberately —
better real data captured occasionally than fake data captured continuously.
