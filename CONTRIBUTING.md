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
  manifest.json          — Manifest v3, scripting + storage perms, optional youtube.com host
  background.js          — Service worker: dynamic content-script registration, welcome page opener
  content.js             — Source entry for the content script (uses ES module imports)
  content.bundle.js      — Built output (esbuild); the file Chrome actually injects. Gitignored.
  lib/
    selectors.js         — The COMPLETE YouTube DOM coupling surface: 2 anchors for /feed/playlists
    innertube-parse.js   — Pure parser for InnerTube responses + shape canary
  styles.css             — CSS custom properties for theming (dark/light)
  vendor/
    minisearch.js        — Vendored BM25 ranking library (UMD)
    package.json         — Pins this directory to CommonJS for test-search.cjs's require()
  test-search.cjs        — Integration test: runs content.bundle.js in a vm sandbox with DOM stubs
  icons/                 — Extension icons

tests/
  innertube-parse.test.mjs        — Fixture-driven unit tests for the InnerTube parser
  selectors-anchor-budget.test.mjs — Fails the build if /feed/playlists grows a 3rd DOM anchor
  test-feed-page-mount.mjs        — Live-Chromium DOM harness (agent-browser, optional)
  fixtures/
    innertube/           — Captured (or synthetic) InnerTube JSON responses + CAPTURE.md
    *.html               — Captured YouTube DOM snapshots

esbuild.config.mjs       — Bundles src/content.js + src/lib/*.js into src/content.bundle.js
architecture/            — Deep-dive docs on how the extension works
docs/                    — Landing page, privacy policy, support (GitHub Pages)
```

See [`architecture/overview.md`](architecture/overview.md) for a tour of the codebase — subsystems, key design decisions, and pointers to each area.

## Making Changes

1. Create a branch off `main`
2. Make your changes — if you edit anything under `src/lib/`, `npm run build:watch` will keep the bundle hot
3. Run `npm test` — it rebuilds the bundle first and then exercises:
   - the InnerTube parser (fixture-driven unit tests, fast)
   - the `/feed/playlists` anchor budget (fails if the coupling surface grows)
   - the bundled content script in a vm sandbox (38 regression assertions)
   - the live-Chromium feed-surface contract, if `agent-browser` is installed
4. Test manually in Chrome (reload the extension after each build)
5. Open a PR with a clear description of what changed and why

## When YouTube ships a regression

The playbook for selector / renderer drift:

1. Capture the new shape — a fixture under `tests/fixtures/innertube/*.json`
   for API changes, `tests/fixtures/*.html` for DOM changes. See
   `tests/fixtures/innertube/CAPTURE.md` for the exact recipe.
2. Add a test that asserts the expected parse result. It will fail.
3. Fix the parser or selector in `src/lib/*.js`. The test goes green.
4. Rebuild (`npm run build`), smoke-test in Chrome, ship.

This is the loop the fixture-driven test suite exists to enable. If your fix
required editing `src/content.js` instead of a `src/lib/*` file, that's a
signal the coupling surface is leaking — consider extending the extraction.

## Code Style

- ES modules under `src/lib/`, bundled into a single IIFE by esbuild
- Keep it simple — the extension is intentionally lightweight
- Match the existing style in the file you're editing

## Intervening in YouTube's DOM (principles)

YouTube's rendered DOM is not an API. Every regression this project has
shipped — 1.6.6, 1.6.7, 1.6.8, 1.6.10, 1.6.15, 1.6.17 on `/feed/playlists`,
and 1.6.6–1.6.18 on the Save modal — was the same bug: we parsed their
markup, and they changed their markup. Both surfaces have since been rebuilt
to render from InnerTube data we already hold. These rules keep them that way.

1. **Own the surface; don't read theirs.** If the data is already in an
   InnerTube response, render it yourself. Re-deriving it from their DOM
   trades a stable JSON shape for an unstable HTML one and buys nothing.

2. **Enumerate and budget the coupling.** Every YouTube selector lives in
   `src/lib/selectors.js`, and `/feed/playlists` is budgeted to exactly two
   anchors: one mount point, one container to hide.
   `tests/selectors-anchor-budget.test.mjs` fails the build if that grows.
   When you want a third, the fix is nearly always to derive it from one of
   the two by DOM relationship, take it from InnerTube, or drop the need.

3. **Anchor on the accessibility tree first, tag names second, generated
   classes never.** `chip-bar-view-model [role='tablist']` survives a CSS
   rebuild; `.ytChipBarViewModelChipBarScrollContainer` does not. The budget
   test enforces this too.

4. **No fallback mounts.** If an anchor doesn't resolve, render nothing and
   record a diagnostic. A fallback that puts our UI somewhere unexpected is
   worse than no UI: the user can't tell it apart from a YouTube bug, and we
   never hear about it. Every anchor records a `recordDiagnostic` entry when
   it resolves to nothing *or* to more than one node.

5. **Touch their nodes reversibly, or not at all.** The one thing we still do
   to YouTube's DOM on `/feed/playlists` is toggle `display` on a single
   container. We capture its inline `style` before, and restore it
   byte-for-byte after — the e2e spec asserts the attribute is identical.
   We no longer hide, re-grid, or inject `<mark>` into their cards.

6. **Don't generalize from one captured fixture.** A fixture is *one*
   observed shape, not "the /feed/playlists layout." Document fixtures as
   shape coverage. (This mattered enormously when we parsed their cards; it
   matters less now, which is the point.)

7. **Write comments about the *current shape*, not about "YouTube."**
   Phrasing like "YouTube wraps lockups inside row slots" reads as a law of
   the surface. Prefer "on the row-wrapped layout, lockups sit inside row
   slots, so…" — so the next reader knows it's conditional.

The short version: **own it, enumerate what you can't own, fail loudly.**
Treat YouTube's layout as hostile/variable infrastructure we nudge, not a
stable component we restyle wholesale.

## Reporting Bugs

Open an issue with:
- Chrome version
- Extension version (from `manifest.json`)
- Steps to reproduce
- Screenshot or video if possible
