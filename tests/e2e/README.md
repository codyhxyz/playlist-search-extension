# E2E test harness

Live tests against signed-in YouTube via [agent-browser](https://github.com/vercel-labs/agent-browser). Catches the regressions that fixture tests can't: real DOM drift, real API responses, real save-modal behavior.

The fixture suite (`tests/test-feed-page-mount.mjs`) stays — it's fast, doesn't need auth, and runs against a captured DOM. E2E is the second layer.

## What's tested

| Spec | Catches |
|---|---|
| `sanity.sh` | cookies expired, test profile not signed in |
| `feed-playlists.sh` | inline bar mounts in wrong spot (1.6.7), bar never mounts (1.6.11 WeakMap), filter doesn't narrow rows |
| `save-modal.sh` | bar injects into wrong modal (1.6.11), search broken, dialog closes on row click |
| `innertube-fetch.sh` | InnerTube parser drops items (1.6.9 lockup-cap), indexed count below threshold |

All four run sequentially, sharing one signed-in agent-browser session named `ytpf-e2e`.

## How auth works (no clicks per run)

Two technical walls forced an unusual design:

1. **Google's automation block** — accounts.google.com refuses to log in inside an automated browser ("This browser or app may not be secure"). So we can't programmatically sign in.
2. **macOS Chrome blocks `--load-extension`** — Google's recent anti-malware policy makes real Chrome silently drop the CLI flag. So we can't load the unpacked extension into real Chrome via agent-browser.

Resolution: bundled Chromium (which loads `--extension` fine) is launched fresh each run, and we extract the auth cookies out-of-band from a **real Chrome `YT Test` profile** that's signed into the test account. The cookies are decrypted via the macOS Keychain key, then injected into the live agent-browser session via the cookies API. Zero manual steps per run.

## One-time setup

```bash
bash tests/e2e/setup.sh
```

This creates a Python venv at `/tmp/ytpf-venv` with `pycryptodome` (needed to decrypt Chrome's cookie DB).

Then **create the Chrome profile** that holds the test account's auth state:

1. Open Chrome → click your profile icon (top right) → **Add**.
2. Name the new profile `YT Test` (or anything — set `YTPF_CHROME_PROFILE_DIR=<absolute-path>` to override).
3. In the new Chromium window, sign into youtube.com with your **test** YouTube account (not your daily one — the extension reads its playlist library during tests).
4. Close that Chrome window.

The new profile is fully isolated — no bookmarks, history, extensions, or cookies carry over from your main profile. Your normal Chrome is untouched.

Then run the suite:

```bash
bash tests/e2e/run.sh
```

The first run may trigger a one-time macOS Keychain prompt asking for permission to read "Chrome Safe Storage" — click **Always Allow** so future runs are silent.

## When the session expires

Cookies in the YT Test profile last as long as YouTube wants them to (typically months). When `sanity.sh` reports `not signed in`, open real Chrome with that profile, sign back in, close Chrome, re-run.

## Architecture

| Step | Component |
|---|---|
| Build extension test variant (`e2e-build/`) | `scripts/build-e2e.sh` |
| Launch bundled Chromium with `--extension` | `agent-browser --session ytpf-e2e --extension ...` |
| Decrypt cookies from real Chrome's `YT Test` profile | `tests/e2e/import-chrome-cookies.py` (pycryptodome) |
| Inject cookies into running session | `agent-browser cookies set` (per cookie) |
| Run specs | `tests/e2e/specs/{sanity,feed-playlists,save-modal,innertube-fetch}.sh` |

## Adding a new spec

1. Create `tests/e2e/specs/<name>.sh`.
2. Source the libs:

   ```bash
   LIB="$(cd "$(dirname "$0")/../lib" && pwd)"
   SPEC_NAME="<name>"
   source "$LIB/selectors.sh"
   source "$LIB/assert.sh"
   ```

3. Use `ab_eval`, `ab_wait_for`, `ab_assert_true`, `ab_fail` — they handle screenshot + diag-ring dumping on failure.
4. Assert on **behavior**, not exact selectors. Bar exists / filter narrows / dialog stays open are stable; specific class names drift.
5. Don't hardcode account-specific content (playlist names, video IDs). Discover at runtime — pull the first watch link from the home feed, etc.
6. Add the spec name to the `SPECS=(...)` array in `tests/e2e/run.sh`.

## Why we drop `optional_host_permissions` in the test build

A fresh agent-browser profile never grants optional permissions, so the shipped manifest's content script never injects on youtube.com. `scripts/build-e2e.sh` produces a variant manifest under `e2e-build/` that converts those into mandatory `host_permissions` plus an explicit `content_scripts` entry. The variant build is gitignored and rebuilt by `tests/e2e/run.sh` on every run.

## Why headed mode

Chromium's extension loader requires a real (headed) browser window. Headless mode silently drops `--load-extension`. This matters if you ever try to run the suite on a remote/CI box without a display server — you'll need Xvfb or a similar virtual framebuffer.

## Diagnostics on failure

Each failing spec dumps:
- A screenshot to `tests/e2e/artifacts/<spec>-fail-<timestamp>.png`
- The first 400 chars of the in-product diagnostics ring (`chrome.storage.local.ytpfDiagnostics`)
- A one-line summary on stderr: `[<spec>] FAIL: <message>`

Artifacts directory is gitignored.

## Tunable thresholds

- `YTPF_EXPECTED_MIN_PLAYLISTS=120 bash tests/e2e/run.sh` — raise the bound for `innertube-fetch.sh`. Default 3 (low because the test account is sparse; set higher for a real-account check).
- `YTPF_CHROME_PROFILE_DIR='/path/to/Profile X' bash tests/e2e/run.sh` — override which Chrome profile the cookie-import reads from. Default `~/Library/Application Support/Google/Chrome/Profile 2` (the second profile created, which Chrome assigns when you click "Add" once).
- `YTPF_TEST_SESSION=foo bash tests/e2e/run.sh` — override the agent-browser session name. Default `ytpf-e2e`.
- `YTPF_VENV_PY=/path/to/python bash tests/e2e/run.sh` — override the cookie-decrypt python interpreter. Default `~/.local/share/ytpf-venv/bin/python` (set up by `tests/e2e/setup.sh`).

## Known gaps

- **`save-modal.sh` skips assertions on sparse test accounts.** YouTube renders a compact "Save to…" picker (instead of the full `tp-yt-paper-dialog` modal) for accounts with very few playlists. The extension intentionally only targets the full modal — that's where its search value lives. The spec detects which shape rendered and skips injection assertions on the compact case. To exercise the full modal, the test account needs more playlists (~10+ seems to be YouTube's threshold).
