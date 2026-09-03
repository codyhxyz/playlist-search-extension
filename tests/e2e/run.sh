#!/usr/bin/env bash
set -euo pipefail

# Live specs share one signed-in, isolated Chromium profile. The profile owns
# its cookies, so the harness never reads another browser's cookie database.

ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
E2E_DIR="$ROOT_DIR/tests/e2e"
SESSION="${YTPF_TEST_SESSION:-ytpf-e2e}"
EXT_DIR="$ROOT_DIR/e2e-build"
PROFILE="${YTPF_BROWSER_PROFILE_DIR:-$HOME/.config/browser-harness/profiles/yt-test-auto}"

cd "$ROOT_DIR"

mkdir -p "$PROFILE"

echo "[e2e] step 1/4: rebuilding $EXT_DIR (variant manifest)"
bash scripts/build-e2e.sh

echo "[e2e] step 2/4: closing any prior $SESSION session"
agent-browser --session "$SESSION" close >/dev/null 2>&1 || true

echo "[e2e] step 3/4: launching isolated Chromium profile with extension loaded"
# The close above tears the daemon down asynchronously; an immediate open can
# race the dying socket ("Failed to connect: No such file or directory").
# One short-fuse retry absorbs it.
launch() {
  agent-browser --session "$SESSION" --profile "$PROFILE" --extension "$EXT_DIR" \
    open "https://www.youtube.com/" >/dev/null
}
launch || { echo "[e2e] launch raced daemon teardown, retrying"; sleep 2; launch; }
agent-browser --session "$SESSION" wait 2000 >/dev/null

echo "[e2e] step 4/4: running specs"
SPECS=(sanity intent-chain save-sheet innertube-contract)
FAILED=()
for spec in "${SPECS[@]}"; do
  echo
  echo "===== spec: $spec ====="
  if YTPF_TEST_SESSION="$SESSION" YTPF_TEST_PROFILE="$PROFILE" bash "$E2E_DIR/specs/$spec.sh"; then
    :
  else
    FAILED+=("$spec")
    if [[ "$spec" == "sanity" ]]; then
      echo "[e2e] sanity failed — sign into YouTube in the open test window, then rerun."
      break
    fi
  fi
done

echo
if [[ "${#FAILED[@]}" -eq 0 ]]; then
  echo "[e2e] all ${#SPECS[@]} specs PASSED"
else
  echo "[e2e] FAILED specs: ${FAILED[*]}"
  exit 1
fi
