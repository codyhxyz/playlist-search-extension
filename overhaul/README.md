# This folder is the original spike. Do not load it.

It is kept because `ARCHITECTURE.md` and `COVERAGE.md` are the record of how the
rebuild was reasoned about and what was actually verified against live YouTube.
Both have since been copied into `architecture/` and kept current there.

**The code here is frozen at 2026-08-28 and has none of the fixes made since**,
including: keystrokes leaking into YouTube's shortcuts, "already in" rows
silently double-adding, IME composition committing an unwanted save, the raw
video id shown instead of the video's name, and the load-failure state.

Loading this and concluding a bug is unfixed has already cost real time — which
is why its manifest now names itself `OLD SPIKE — do not load`.

To run the real thing:

```bash
bash scripts/build-dev.sh
# chrome://extensions -> Developer mode -> Load unpacked -> dist/unpacked
```

That build shows up as **YouTube Playlist Search (dev)** and works the moment
Chrome loads it — unlike `src/`, which requests youtube.com as an *optional*
permission and injects nothing until you click through the welcome page.
