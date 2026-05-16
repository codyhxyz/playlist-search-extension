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
    selectors.js         — Every YouTube CSS selector + the OLD/NEW renderer reference notes
    innertube-parse.js   — Pure parser for InnerTube responses + shape canary
    dom-parse.js         — Pure Polymer .data extractors (getRowPlaylistId, isSaveVideoModal, …)
  styles.css             — CSS custom properties for theming (dark/light)
  vendor/
    minisearch.js        — Vendored BM25 ranking library (UMD)
    package.json         — Pins this directory to CommonJS for test-search.cjs's require()
  test-search.cjs        — Integration test: runs content.bundle.js in a vm sandbox with DOM stubs
  icons/                 — Extension icons

tests/
  innertube-parse.test.mjs  — Fixture-driven unit tests for the InnerTube parser
  dom-parse.test.mjs        — Object-stub unit tests for Polymer extractors
  test-feed-page-mount.mjs  — Live-Chromium DOM harness (agent-browser, optional)
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
   - the pure parsers (fixture-driven unit tests, fast)
   - the bundled content script in a vm sandbox (39 regression assertions)
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

## Reporting Bugs

Open an issue with:
- Chrome version
- Extension version (from `manifest.json`)
- Steps to reproduce
- Screenshot or video if possible
