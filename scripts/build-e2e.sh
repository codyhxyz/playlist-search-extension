#!/usr/bin/env bash
set -euo pipefail

# Build a test-only copy of the extension under e2e-build/.
#
# The shipped extension uses optional_host_permissions, which a fresh
# agent-browser profile never grants — so nothing would ever register and
# every live test would fail. This variant changes exactly two things:
#
#   1. optional_host_permissions -> mandatory host_permissions
#   2. drops `key` (the signing key asserts the production CWS identity;
#      an unpacked test build must not claim it)
#
# Deliberately NOT changed, and this is the point: the real background.js
# ships as-is and does its own `chrome.scripting.registerContentScripts` call.
# Before 2.0.0 this script replaced background.js with a stub and declared a
# static `content_scripts` block instead — which meant the registration path,
# the MAIN/ISOLATED world split, and the whole intent-resolution service worker
# were the one part of the extension that live tests never touched. They are
# now the part most likely to break, so they are the part under test.
#
# `chrome.permissions.contains()` returns true for host permissions declared as
# mandatory, so hasYouTubePermission() is satisfied and the production code path
# runs unmodified.
#
# Output is gitignored. tests/e2e/run.sh regenerates it before each run.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
OUT_DIR="$ROOT_DIR/e2e-build"

echo "[build-e2e] esbuild bundle (delegated to npm run build)"
(cd "$ROOT_DIR" && npm run --silent build)

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR/lib"

cp -R \
  "$SRC_DIR/background.js" \
  "$SRC_DIR/onboarding-state.js" \
  "$SRC_DIR/intent-hook.js" \
  "$SRC_DIR/content.bundle.js" \
  "$SRC_DIR/welcome.html" \
  "$SRC_DIR/welcome.js" \
  "$SRC_DIR/icons" \
  "$OUT_DIR/"
cp "$SRC_DIR/lib/intent.js" "$OUT_DIR/lib/intent.js"

SRC_DIR="$SRC_DIR" OUT_DIR="$OUT_DIR" node -e '
  const fs = require("fs");
  const path = require("path");
  const src = path.join(process.env.SRC_DIR, "manifest.json");
  const dst = path.join(process.env.OUT_DIR, "manifest.json");
  const m = JSON.parse(fs.readFileSync(src, "utf8"));
  delete m.optional_host_permissions;
  m.host_permissions = ["https://www.youtube.com/*"];
  delete m.key;
  m.name = m.name + " (E2E TEST BUILD)";
  fs.writeFileSync(dst, JSON.stringify(m, null, 2) + "\n");
'

echo "[build-e2e] wrote $OUT_DIR (mandatory host_permissions, real service worker)"
