#!/usr/bin/env bash
set -euo pipefail

# Top-level e2e runner. Sequential by design — specs share one signed-in
# session, parallelism would interfere.
#
# Why this dance:
#   - Real Chrome on macOS hard-blocks --load-extension via CLI (Google's
#     anti-malware policy), so we use agent-browser's bundled Chromium for
#     the launch — that loads --extension fine.
#   - Bundled Chromium can't decrypt real Chrome's Keychain cookies, so we
#     extract them out-of-band via tests/e2e/import-chrome-cookies.py and
#     re-inject via the agent-browser cookies API while the session is live
#     (cookies set after a close don't persist, so import must happen post-launch).
#
# Net effect: zero manual steps once tests/e2e/setup.sh has been run once.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
E2E_DIR="$ROOT_DIR/tests/e2e"
SESSION="${YTPF_TEST_SESSION:-ytpf-e2e}"
EXT_DIR="$ROOT_DIR/e2e-build"
VENV_PY="${YTPF_VENV_PY:-$HOME/.local/share/ytpf-venv/bin/python}"

cd "$ROOT_DIR"

if [[ ! -x "$VENV_PY" ]]; then
  echo "[e2e] FAIL: cookie-decrypt venv missing at $VENV_PY" >&2
  echo "[e2e]   Run tests/e2e/setup.sh first (one-time bootstrap)." >&2
  exit 2
fi

echo "[e2e] step 1/5: rebuilding $EXT_DIR (variant manifest)"
bash scripts/build-e2e.sh

echo "[e2e] step 2/5: closing any prior $SESSION session"
agent-browser --session "$SESSION" close >/dev/null 2>&1 || true

echo "[e2e] step 3/5: launching bundled Chromium with extension loaded"
agent-browser --session "$SESSION" --extension "$EXT_DIR" \
  open "https://www.youtube.com/" >/dev/null
agent-browser --session "$SESSION" wait 1500 >/dev/null

echo "[e2e] step 4/5: importing YouTube auth cookies from real Chrome profile"
"$VENV_PY" "$E2E_DIR/import-chrome-cookies.py"
# Navigate again so the freshly-set cookies take effect on the next request.
agent-browser --session "$SESSION" open "https://www.youtube.com/" >/dev/null
agent-browser --session "$SESSION" wait 2000 >/dev/null

echo "[e2e] step 5/5: running specs"
SPECS=(sanity feed-playlists save-modal innertube-fetch)
FAILED=()
for spec in "${SPECS[@]}"; do
  echo
  echo "===== spec: $spec ====="
  if YTPF_TEST_SESSION="$SESSION" bash "$E2E_DIR/specs/$spec.sh"; then
    :
  else
    FAILED+=("$spec")
    if [[ "$spec" == "sanity" ]]; then
      echo "[e2e] sanity failed — aborting remaining specs."
      break
    fi
  fi
done

echo
if [[ "${#FAILED[@]}" -eq 0 ]]; then
  echo "[e2e] all ${#SPECS[@]} specs PASSED"
  exit 0
else
  echo "[e2e] FAILED specs: ${FAILED[*]}"
  exit 1
fi
