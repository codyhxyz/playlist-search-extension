# browser-use

Probe live YouTube DOM via [browser-use](https://github.com/browser-use/browser-use) (CDP). Selectors: `src/lib/selectors.js`.

## Default: isolated Chrome

Do **not** attach to the daily browser on 9222.

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --user-data-dir="$HOME/.config/browser-harness/profiles/yt-test-auto" \
  --remote-debugging-port=9333 \
  --no-first-run &

export BU_CDP_URL=http://127.0.0.1:9333
export BU_NAME=yt-dom
```

Sign into YouTube once in that window (test account). `/json/version` works on non-default profiles — no `DevToolsActivePort` dance.

## Attach to running Chrome (9222)

Chrome 147+ default profile: `/json/version` returns 404. `browser-use` reads `DevToolsActivePort` instead — needs **Full Disk Access** on the agent host (cmux/Cursor/Terminal).

**`BU_CDP_WS` changes every Chrome launch.** Re-export before each session:

```bash
f="$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"
export BU_CDP_WS="ws://127.0.0.1:$(head -1 "$f")$(tail -1 "$f")"
export BU_CDP_URL=http://127.0.0.1:9222
export BU_NAME=yt-dom
```

YT Test profile: `~/Library/Application Support/Google/Chrome/Profile 2` (override: `YTPF_CHROME_PROFILE_DIR`).

## Run

```bash
browser-use <<'PY'
ensure_real_tab()
goto_url("https://www.youtube.com/feed/playlists")
wait_for_load(10)
print(js("({ signedIn: !!document.querySelector('#avatar-btn'), path: location.pathname })"))
capture_screenshot()  # ~/.config/browser-harness/tmp/
PY
```

Gate: if not signed in, stop — do not invent login flows.

Helpers: `goto_url`, `js`, `wait`, `wait_for_load`, `capture_screenshot`, `list_tabs`, `switch_tab`, `new_tab`. Screenshots: `~/.config/browser-harness/tmp/`.

Stale daemon: `browser-use --reload`.

## Surfaces

| Surface | URL / trigger |
|---------|----------------|
| Playlists filter | `/feed/playlists` (also `/feed/library`) |
| Save modal | watch page → Save (`aria-label` ~ `/Save( to\|$)/`) |

## Alternative: e2e harness

Bundled Chromium + cookie decrypt from YT Test profile — no CDP attach. `tests/e2e/README.md`, `bash tests/e2e/run.sh`.