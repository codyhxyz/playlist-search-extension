# Contributing

Thanks for your interest in YouTube Playlist Search! Here's how to get started.

## Development Setup

1. Clone the repo:
   ```bash
   git clone https://github.com/codyhxyz/playlist-search-extension.git
   cd playlist-search-extension
   ```

2. Load the extension in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select the `src/` folder

3. Make sure you're signed in to YouTube in the same browser profile. The extension uses your existing YouTube session (SAPISID cookie) to fetch your full playlist library — no OAuth setup is required.

## Project Structure

```
src/                — Extension source (load this folder as unpacked)
  manifest.json     — Manifest v3, no permissions, content script only
  content.js        — All extension logic: search UI, BM25 index, InnerTube API calls
  styles.css        — CSS custom properties for theming (dark/light)
  vendor/
    minisearch.js   — Vendored BM25 ranking library
  test-search.js    — Node regression test for dedup behavior
  icons/            — Extension icons

architecture/       — Deep-dive docs on how the extension works
docs/               — Landing page, privacy policy, support (GitHub Pages)
```

See [`architecture/overview.md`](architecture/overview.md) for a tour of the codebase — subsystems, key design decisions, and pointers to each area.

## Making Changes

1. Create a branch off `main`
2. Make your changes
3. Test manually (see CONTRIBUTING guidelines)
4. Open a PR with a clear description of what changed and why

## Code Style

- Plain JS (no build step, no framework)
- Keep it simple — the extension is intentionally lightweight
- Match the existing style in the file you're editing

## Reporting Bugs

Open an issue with:
- Chrome version
- Extension version (from `manifest.json`)
- Steps to reproduce
- Screenshot or video if possible
