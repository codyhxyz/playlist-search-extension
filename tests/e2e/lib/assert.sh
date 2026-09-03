#!/usr/bin/env bash
# Shared assertion helpers for specs. Source after selectors.sh.
#
# Spec contract: each spec is a bash script that exits 0 on pass, non-zero on
# fail. Specs MUST source this file and use ab_eval / ab_assert / ab_fail
# rather than hand-rolling — that way error reporting (last screenshot, eval
# JSON dump, diag-ring snapshot) is uniform across specs.

SESSION="${YTPF_TEST_SESSION:-ytpf-e2e}"
ARTIFACTS_DIR="${YTPF_ARTIFACTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/artifacts}"
SPEC_NAME="${SPEC_NAME:-$(basename "${BASH_SOURCE[1]:-unknown}" .sh)}"

mkdir -p "$ARTIFACTS_DIR"

# Run JS in the page; print just the result as a JSON-encoded scalar. The raw
# agent-browser envelope is {"success":bool,"data":{"result":<v>},"error":...};
# we extract `.data.result` so callers see `true` / `false` / `"foo"` / `42`,
# not the wrapper. Errors print as `null`.
ab_eval() {
  local js="$1"
  agent-browser --session "$SESSION" --json eval "$js" 2>/dev/null \
    | jq -c 'if .success then .data.result else null end'
}

# Take a screenshot named for the spec + step.
ab_snap() {
  local label="$1"
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  local path="$ARTIFACTS_DIR/${SPEC_NAME}-${label}-${ts}.png"
  agent-browser --session "$SESSION" screenshot "$path" >/dev/null 2>&1 || true
  echo "$path"
}

# Fail with a one-line summary plus a screenshot for forensics. Runtime
# diagnostics stay console-only; exposing them through page DOM leaked data.
ab_fail() {
  local msg="$1"
  local snap; snap="$(ab_snap fail)"
  echo "[$SPEC_NAME] FAIL: $msg" >&2
  echo "[$SPEC_NAME]   screenshot: $snap" >&2
  exit 1
}

# Assert a JS expression evaluates to true on the current page.
ab_assert_true() {
  local label="$1" js="$2"
  local result; result="$(ab_eval "$js")"
  if [[ "$result" == "true" ]]; then
    echo "[$SPEC_NAME] PASS: $label"
  else
    ab_fail "$label (got: $result)"
  fi
}

# Wait for selector or condition. Default 10s, polled every 250ms.
ab_wait_for() {
  local label="$1" js="$2" timeout_ms="${3:-10000}"
  local elapsed=0
  while [[ "$elapsed" -lt "$timeout_ms" ]]; do
    [[ "$(ab_eval "$js")" == "true" ]] && { echo "[$SPEC_NAME] READY: $label (${elapsed}ms)"; return 0; }
    sleep 0.25
    elapsed=$((elapsed + 250))
  done
  ab_fail "wait timeout: $label (${timeout_ms}ms)"
}

# ── Accessibility-tree helpers (2.0.0) ──────────────────────────────────────
# The save sheet is a closed shadow root, so `document.querySelector` cannot see
# inside it and neither can ab_eval. The accessibility tree does pierce closed
# roots, so it is both the only door available AND the more honest assertion:
# it checks what assistive tech is actually handed, not what our markup happens
# to be called this week.

# Print the current accessibility tree.
ab_snapshot() {
  agent-browser --session "$SESSION" snapshot 2>/dev/null
}

# Assert the a11y tree matches an extended regex.
ab_assert_a11y() {
  local label="$1" pattern="$2"
  local tree; tree="$(ab_snapshot)"
  if echo "$tree" | grep -qE "$pattern"; then
    echo "[$SPEC_NAME] PASS: $label"
  else
    echo "[$SPEC_NAME]   a11y tree was:" >&2
    echo "$tree" | head -40 >&2
    ab_fail "$label (no line matched /$pattern/)"
  fi
}

# Assert a count of matching a11y lines meets a minimum.
ab_assert_a11y_min() {
  local label="$1" pattern="$2" min="$3"
  local n; n="$(ab_snapshot | grep -cE "$pattern" || true)"
  if [[ "$n" -ge "$min" ]]; then
    echo "[$SPEC_NAME] PASS: $label ($n >= $min)"
  else
    ab_fail "$label (found $n, wanted >= $min)"
  fi
}

# Wait until the a11y tree matches. Default 15s, polled every 500ms.
ab_wait_a11y() {
  local label="$1" pattern="$2" timeout_ms="${3:-15000}"
  local elapsed=0
  while [[ "$elapsed" -lt "$timeout_ms" ]]; do
    ab_snapshot | grep -qE "$pattern" && { echo "[$SPEC_NAME] READY: $label (${elapsed}ms)"; return 0; }
    sleep 0.5
    elapsed=$((elapsed + 500))
  done
  ab_fail "wait timeout: $label (${timeout_ms}ms)"
}

# "Is our sheet open?" — focus inside a closed shadow root reports as the host,
# so this is true only when the sheet mounted AND took focus.
ab_sheet_open_js='(() => {
  const a = document.activeElement;
  return !!a && a.parentElement === document.documentElement && a.tagName.includes("-");
})()'
