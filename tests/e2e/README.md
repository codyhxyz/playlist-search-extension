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

## How auth works

The harness launches agent-browser's bundled Chromium with both the unpacked extension and a dedicated persistent profile. The profile owns its cookies, so the harness does not copy cookies from daily Chrome, read Keychain secrets, or require Full Disk Access.

## One-time setup

1. Run `bash tests/e2e/run.sh`.
2. If `sanity.sh` reports `not signed in`, sign into the test account in the Chromium window that the command opened.
3. Keep at least four playlists in the test account so YouTube renders the supported full Save modal.
4. Run `bash tests/e2e/run.sh` again.

The default profile is `~/.config/browser-harness/profiles/yt-test-auto`. Set `YTPF_BROWSER_PROFILE_DIR` to use another isolated profile. Do not point it at daily Chrome's user-data directory.

## Architecture

| Step | Component |
|---|---|
| Build extension test variant (`e2e-build/`) | `scripts/build-e2e.sh` |
| Launch bundled Chromium with `--extension` and an isolated profile | `agent-browser --profile ... --extension ...` |
| Preserve test-account auth | The isolated profile's own cookie store |
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
- A one-line summary on stderr: `[<spec>] FAIL: <message>`

Artifacts directory is gitignored.

## Tunable thresholds

- `YTPF_EXPECTED_MIN_PLAYLISTS=120 bash tests/e2e/run.sh` — raise the bound for `innertube-fetch.sh`. Default 3 (low because the test account is sparse; set higher for a real-account check).
- `YTPF_BROWSER_PROFILE_DIR='/path/to/isolated-profile' bash tests/e2e/run.sh` — override the persistent test profile.
- `YTPF_TEST_SESSION=foo bash tests/e2e/run.sh` — override the agent-browser session name. Default `ytpf-e2e`.

## Known gaps

- **`save-modal.sh` requires a full modal.** YouTube renders a compact picker for accounts with very few playlists. The spec fails instead of reporting a false pass. Keep enough playlists in the test account to exercise the full modal.
