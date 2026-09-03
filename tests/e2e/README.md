# E2E test harness

Live tests against signed-in YouTube via [agent-browser](https://github.com/vercel-labs/agent-browser). Catches what fixture tests structurally cannot: a save surface that quietly stopped working, and YouTube changing its API out from under us.

The fixture and unit suites stay — they're fast and need no auth. E2E is the second layer, and it exists to answer the two questions the first layer structurally cannot: *does this work on every surface*, and *does YouTube still behave the way we assume*.

## What's tested

| Spec | Catches |
|---|---|
| `sanity.sh` | cookies expired, test profile not signed in |
| `intent-chain.sh` | **our own plumbing**, isolated from YouTube's UI — the MAIN-world hook not installing, the relay to the worker breaking, the `panelId` gate letting a generic `get_panel` through, or the videoId failing to decode out of a percent-encoded `params` protobuf (the exact bug that killed the home feed). Needs no signed-in session, so it stays green when cookies expire |
| `save-sheet.sh` | the sheet failing to open **on any one surface** — it drives the watch page and the home feed separately and reports them separately; also: the sheet not taking focus, YouTube's own dialog stacking behind ours, typing not narrowing |
| `innertube-contract.sh` | YouTube changing the endpoints out from under us — the library endpoint moving, the membership renderer being renamed, the singular-key trap changing, brand-channel delegation ceasing to matter |

All four run sequentially, sharing one agent-browser session named `ytpf-e2e`.

They are ordered to localise a failure. `intent-chain.sh` tests our side without touching YouTube's UI; `save-sheet.sh` then clicks YouTube's real buttons. If the first passes and the second fails, YouTube moved something. If the first fails, we broke something. That distinction used to take an afternoon to establish.

### Why `save-sheet.sh` drives two surfaces

Because testing one and generalising to the category is the specific mistake that shipped a broken home feed for a full release. The watch page worked; the feed silently did nothing; nothing in the workflow forced the question "what are the other members of this set?". A spec that asserts per-surface cannot pass by inference.

### Why `innertube-contract.sh` doesn't call our own code

It rebuilds both requests from YouTube's own `ytcfg` rather than importing `src/lib/innertube.js`. A test written against our client can agree with itself and still be wrong about YouTube — this one fails when *YouTube* changes, which is the event we need to hear about first. It is read-only; it never adds to or removes from a playlist.

### Asserting through a closed shadow root

The sheet is a `mode: "closed"` shadow root, so page-world `eval` cannot see inside it. That's deliberate, and it's why the specs assert through two other doors:

- **`document.activeElement`** — focus inside a closed root reports as the *host* element, so "the sheet opened and took focus" is observable from the page without piercing anything.
- **the accessibility tree** (`agent-browser snapshot`), which *does* pierce closed roots. `ab_assert_a11y` / `ab_assert_a11y_min` / `ab_wait_a11y` in `lib/assert.sh` wrap it. This is the better assertion anyway: it checks what assistive technology is actually handed, rather than what our markup happens to be called this week.

## How auth works

The harness launches agent-browser's bundled Chromium with both the unpacked extension and a dedicated persistent profile. The profile owns its cookies, so the harness does not copy cookies from daily Chrome, read Keychain secrets, or require Full Disk Access.

## One-time setup

1. Run `bash tests/e2e/run.sh`.
2. If `sanity.sh` reports `not signed in`, sign into the test account in the Chromium window that the command opened.
3. Keep at least four playlists in the test account. Sparse accounts get YouTube's *compact* save popover rather than the full one, which the extension does not target (see `architecture/coverage.md` A7).
4. Run `bash tests/e2e/run.sh` again.

The default profile is `~/.config/browser-harness/profiles/yt-test-auto`. Set `YTPF_BROWSER_PROFILE_DIR` to use another isolated profile. Do not point it at daily Chrome's user-data directory.

## Architecture

| Step | Component |
|---|---|
| Build extension test variant (`e2e-build/`) | `scripts/build-e2e.sh` |
| Launch bundled Chromium with `--extension` and an isolated profile | `agent-browser --profile ... --extension ...` |
| Preserve test-account auth | The isolated profile's own cookie store |
| Run specs | `tests/e2e/specs/{sanity,save-sheet,innertube-contract}.sh` |

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

A fresh agent-browser profile never grants optional permissions, so nothing would ever register and every live test would fail. `scripts/build-e2e.sh` produces a variant manifest under `e2e-build/` that converts them into mandatory `host_permissions` and drops the CWS signing `key`. The variant build is gitignored and rebuilt by `tests/e2e/run.sh` on every run.

**Two things it deliberately no longer does.** Before 2.0.0 the variant also declared a static `content_scripts` block and replaced `background.js` with a stub — which meant the registration path, the MAIN/ISOLATED world split, and the entire intent-resolution service worker were the one part of the extension live tests never touched. They are now the part most likely to break, so the real `background.js` ships unmodified and does its own `chrome.scripting.registerContentScripts` call. `chrome.permissions.contains()` returns true for mandatory host permissions, so the production code path runs unchanged.

## Why headed mode

Chromium's extension loader requires a real (headed) browser window. Headless mode silently drops `--load-extension`. This matters if you ever try to run the suite on a remote/CI box without a display server — you'll need Xvfb or a similar virtual framebuffer.

## Diagnostics on failure

Each failing spec dumps:
- A screenshot to `tests/e2e/artifacts/<spec>-fail-<timestamp>.png`
- A one-line summary on stderr: `[<spec>] FAIL: <message>`

Artifacts directory is gitignored.

## Tunable thresholds

- `YTPF_EXPECTED_MIN_PLAYLISTS=120 bash tests/e2e/run.sh` — add an account-specific floor to `innertube-contract.sh`. Default 1: the spec's assertions are otherwise account-agnostic on purpose, because "expect more than N playlists" measures the test fixture rather than the contract. Set it high when running against a real, populated account.
- `YTPF_BROWSER_PROFILE_DIR='/path/to/isolated-profile' bash tests/e2e/run.sh` — override the persistent test profile.
- `YTPF_TEST_SESSION=foo bash tests/e2e/run.sh` — override the agent-browser session name. Default `ytpf-e2e`.

## Known gaps

- **`save-sheet.sh` needs an account YouTube gives the full save flow to.** Very sparse accounts get a compact popover that the extension does not target (`architecture/coverage.md` A7). Keep at least four playlists in the test account. The spec fails rather than reporting a false pass.
