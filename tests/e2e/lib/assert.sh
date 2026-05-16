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

# Dump the in-product diagnostics ring. content.js mirrors the latest ring to
# document.documentElement.dataset.ytpfDiag on every diag write — that's the
# bridge from extension's isolated world into page-world reach.
ab_dump_diag() {
  ab_eval 'document.documentElement.dataset.ytpfDiag || "(empty)"'
}

# Fail with a one-line summary, plus screenshot + diag dump for forensics.
ab_fail() {
  local msg="$1"
  local snap; snap="$(ab_snap fail)"
  echo "[$SPEC_NAME] FAIL: $msg" >&2
  echo "[$SPEC_NAME]   screenshot: $snap" >&2
  echo "[$SPEC_NAME]   diag ring:  $(ab_dump_diag | tr -d '\n' | cut -c1-400)" >&2
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
