#!/usr/bin/env bash
set -euo pipefail

# Build a test-only copy of the extension under e2e-build/.
#
# The shipped extension uses optional_host_permissions, which a fresh
# agent-browser profile never grants — so the content script never injects
# and live tests would always fail. This variant:
#   1. Drops optional_host_permissions
#   2. Adds mandatory host_permissions for youtube.com
#   3. Adds a content_scripts entry so content.bundle.js auto-injects on
#      every youtube.com tab without needing a service-worker programmatic
#      call
#
# Output is gitignored. Regenerate by re-running this script before each
# tests/e2e/run.sh invocation (tests/e2e/run.sh does this for you).
#
# Post-1.6.13: Chrome injects src/content.bundle.js (esbuild output), not
# src/content.js. The build step is delegated to `npm run build` — keeps
# build configuration in one place and ensures e2e tests run against the
# same bundle the production extension ships.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
OUT_DIR="$ROOT_DIR/e2e-build"

echo "[build-e2e] esbuild bundle (delegated to npm run build)"
(cd "$ROOT_DIR" && npm run --silent build)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

cp -R \
  "$SRC_DIR/background.js" \
  "$SRC_DIR/content.bundle.js" \
  "$SRC_DIR/styles.css" \
  "$SRC_DIR/onboarding-state.js" \
  "$SRC_DIR/welcome.html" \
  "$SRC_DIR/welcome.js" \
  "$SRC_DIR/icons" \
  "$SRC_DIR/vendor" \
  "$SRC_DIR/welcome-assets" \
  "$OUT_DIR/"

SRC_DIR="$SRC_DIR" OUT_DIR="$OUT_DIR" node -e '
  const fs = require("fs");
  const path = require("path");
  const src = path.join(process.env.SRC_DIR, "manifest.json");
  const dst = path.join(process.env.OUT_DIR, "manifest.json");
  const m = JSON.parse(fs.readFileSync(src, "utf8"));
  // Drop optional_host_permissions (a fresh agent-browser profile never
  // grants them) and replace with mandatory host_permissions plus a static
  // content_scripts entry — that guarantees content.bundle.js fires on every
  // YT navigation without a service-worker race.
  delete m.optional_host_permissions;
  m.host_permissions = ["https://www.youtube.com/*"];
  m.content_scripts = [{
    matches: ["*://www.youtube.com/*"],
    js: ["content.bundle.js"],
    run_at: "document_idle",
  }];
  // The signing key is for the production CWS listing; an unpacked test
  // build should not assert that identity.
  delete m.key;
  // Mark as a test build so it is impossible to confuse with a release.
  m.name = m.name + " (E2E TEST BUILD)";
  fs.writeFileSync(dst, JSON.stringify(m, null, 2) + "\n");
'

# Replace background.js with a no-op. The production background.js calls
# chrome.scripting.registerContentScripts dynamically, which would double
# up with the static content_scripts entry above and mount the bar 2× on
# every page. The welcome-page / onboarding logic is irrelevant for tests.
cat > "$OUT_DIR/background.js" <<EOF
// E2E TEST BUILD: production background.js dynamically registers content.js,
// which would double-inject with the static content_scripts entry in the
// variant manifest. This stub does nothing — content_scripts handles all
// injection in the test build.
"use strict";
EOF

echo "[build-e2e] wrote $OUT_DIR (variant manifest, no optional_host_permissions)"
