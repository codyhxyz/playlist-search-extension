# Contributing

Thanks for your interest in YouTube Playlist Search! Here's how to get started.

## Development Setup

1. Clone the repo and install dev dependencies:
   ```bash
   git clone https://github.com/codyhxyz/playlist-search-extension.git
   cd playlist-search-extension
   npm install
   ```

2. **Build the content-script bundle:**
   ```bash
   npm run build              # one-shot
   npm run build:watch        # rebuild on save while developing
   ```

   This produces `src/content.bundle.js`, which is what Chrome actually
   injects. Editing `src/content.js` or anything under `src/lib/` requires
   a rebuild before the extension picks up your change. `src/content.bundle.js`
   is **gitignored** — every contributor builds locally.

3. Load the extension in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select the `src/` folder

   If you skipped step 2, Chrome will silently fail to register the content
   script. Run `npm run build` and click the reload icon next to the extension.

4. Make sure you're signed in to YouTube in the same browser profile. The
   extension uses your existing YouTube session (SAPISID cookie) to fetch
   your full playlist library — no OAuth setup is required.

## Project Structure

```
src/
  manifest.json          — Manifest v3. scripting + storage + contextMenus, optional youtube.com host
  background.js          — Module service worker: content-script registration, intent resolution,
                           the zero-DOM entry points (toolbar / context menu / hotkey), onboarding
  onboarding-state.js    — Shared by the worker and the welcome page (ES module)
  intent-hook.js         — MAIN world, document_start. Observes two YouTube API paths and forwards
                           four fields. NO imports, no chrome.* — it runs in the page's world
  content.js             — ISOLATED world entry: relays the hook, owns the session, opens the sheet
  content.bundle.js      — Built output (esbuild); the file Chrome actually injects. Gitignored
  lib/
    intent.js            — Pure intent decisions: protobuf walk, base64, the panelId gate.
                           Imported by the WORKER at runtime, so it ships unbundled
    innertube.js         — InnerTube client. Parsing exported separately from the calls
    sheet.js             — The UI. Closed shadow root, knows nothing about YouTube
  welcome.html/.js       — First-run page; where the youtube.com host permission is granted
  icons/                 — Extension icons

tests/
  intent.test.mjs        — Intent resolution: field walk, percent-encoding, the panelId gate
  innertube.test.mjs     — Config scrape, delegation, both renderer generations, tri-state membership
  test-sheet-render.mjs  — The sheet's contract in a real engine (agent-browser; skips if absent)
  e2e/                   — Live signed-in YouTube. See tests/e2e/README.md
  fixtures/innertube/    — Captured InnerTube responses + CAPTURE.md

scripts/
  build-store-zip.sh     — Gated packaging. Refuses to zip a source tree that fails its own tests
  publish-cws.mjs        — Upload + publish. Runs tests/run-all.sh as a non-bypassable gate
  validate-cws.mjs       — Structural review-blocker rules
  build-privacy-page.mjs — Generates docs/privacy-policy.html from PRIVACY.md

architecture/            — overview.md (the design), coverage.md (honest per-surface status),
                           innertube-api.md (the endpoints and their traps)
docs/                    — Landing page, privacy policy, support (deployed to playlist.codyh.xyz)
```

**Note the world split.** `intent-hook.js` runs in the page's own JavaScript world; everything else runs isolated. Anything crossing that boundary is untrusted input by definition — the page can see the hook and could forge its messages. Keep the hook dumb: observe, extract, forward, no logic.

See [`architecture/overview.md`](architecture/overview.md) for a tour of the codebase — subsystems, key design decisions, and pointers to each area.

## Making Changes

1. Create a branch off `main`
2. Make your changes — if you edit anything under `src/lib/`, `npm run build:watch` will keep the bundle hot
3. Run `npm test` — it rebuilds the bundle first and then exercises:
   - intent resolution and the InnerTube parsers (fast, no network, no browser)
   - the save sheet's contract in a real browser engine, if `agent-browser` is installed
   Use `npm run test:fast` for the unit tests alone.
4. Test manually in Chrome (reload the extension after each build)
5. Open a PR with a clear description of what changed and why

## When YouTube ships a regression

Since 2.0.0 there are no selectors to drift, so a regression is almost always an
InnerTube response-shape change. The playbook:

1. **Run the contract probe first**: `bash tests/e2e/specs/innertube-contract.sh`.
   It rebuilds both requests from YouTube's own config, so it tells you whether
   YouTube changed or we did — which is a different bug each way.
2. Capture the new shape into `tests/fixtures/innertube/*.json`. See
   `tests/fixtures/innertube/CAPTURE.md` for the recipe.
3. Add a test asserting the expected parse. It will fail.
4. Fix the parser in `src/lib/innertube.js`. The test goes green.
5. Rebuild (`npm run build`), smoke-test in Chrome, ship.

**Do not add a DOM fallback.** When a parse fails the extension must say so and
stop. Reading YouTube's rendered page to paper over an API change is what
produced every symptom the 2.0.0 rebuild deleted, and it fails in the worst
possible way: not visibly, but strangely.

**Before claiming a fix works, name the set it belongs to.** "Save works" is not
a verifiable claim; "save works from the watch page, untested on the feed" is.
That exact generalisation shipped a broken home feed for a full release. See
`architecture/coverage.md`, and keep it updated — a ❓ there is an admission,
not a gap.

## Code Style

- ES modules under `src/lib/`, bundled into a single IIFE by esbuild for the content script and loaded natively by the module service worker
- Keep it simple — the extension ships no third-party code, and that is a feature
- Match the existing style in the file you're editing

## The invariant

> **We never read data from YouTube's DOM, and we never write a node into YouTube's DOM.**

This is not a guideline. Every regression this project shipped — 1.6.6, 1.6.7,
1.6.8, 1.6.10, 1.6.15, 1.6.17 on `/feed/playlists`, and 1.6.6–1.6.18 on the Save
modal — was one bug wearing different hats: we parsed their markup, and they
changed their markup. 2.0.0 does not mitigate that. It deletes the code that
made it possible.

Earlier versions of this file carried seven rules for intervening in YouTube's
DOM *carefully* — a selector budget, an anchoring hierarchy, reversible
mutation, no fallback mounts. They were good rules and they still did not work,
because the safest amount of DOM coupling turned out to be none. They are
preserved in git history if you ever need them for a different host app.

What remains today:

1. **Data comes from InnerTube, never from rendered markup.** If you find
   yourself writing a selector to *learn* something, stop — the answer is
   already in a JSON response one layer down.

2. **The UI lives in a surface we own.** A closed shadow root on
   `document.documentElement`, outside `<ytd-app>` entirely, so YouTube's
   renderer cannot reconcile away what isn't in its subtree. A `<dialog>` in the
   top layer, so there is no z-index war. `all: initial` at the shadow boundary,
   because shadow DOM blocks selector bleed but *not* inherited properties.

3. **Nodes only, never `innerHTML`.** YouTube enforces
   `require-trusted-types-for 'script'`. Building nodes with `createElement` /
   `textContent` / `append` sidesteps the question entirely instead of betting
   on a content-script CSP exemption holding. `tests/test-sheet-render.mjs`
   fails the build if a string-to-HTML sink appears.

4. **Intent comes from behaviour, not structure.** "YouTube's app just told its
   own server the user wants to save video X" is a far stronger claim than "an
   element matching some selector appeared." The gate is `panelId`, YouTube's
   own semantic name for the panel — not the URL, which is generic and shared
   with unrelated features.

5. **Two contact points remain, and both fail harmlessly.** Reading
   `INNERTUBE_CONTEXT` out of the page's config script (there is no other source
   for the session handshake; it is configuration, not content), and dispatching
   one synthetic `Escape` to dismiss YouTube's dialog (if it stops working,
   their dialog sits behind ours, inert, under the backdrop).

6. **Fail closed, never sideways.** A broken contract disables exactly the
   feature that depends on it and says so. The old extension's cardinal sin was
   not breaking — it was breaking *invisibly and weirdly*. A search bar in an
   unrelated menu is worse than no search bar, because the user cannot tell it
   from a YouTube bug and so never reports it.

7. **Don't generalise from one observation.** One captured fixture is one
   observed shape. One working surface is one working surface. Before claiming a
   capability works, enumerate the set it belongs to and say which members you
   actually tested — then write it down in `architecture/coverage.md`.

## Reporting Bugs

Open an issue with:
- Chrome version
- Extension version (from `manifest.json`)
- Steps to reproduce
- Screenshot or video if possible
