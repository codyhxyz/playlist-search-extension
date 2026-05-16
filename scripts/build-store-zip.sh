#!/usr/bin/env bash
set -euo pipefail

# Packages src/ into a Chrome Web Store zip under dist/.
#
# This script intentionally refuses to package a broken source tree. Before
# copying files we build the bundle, run the test suites, and validate the
# CWS structural rules. If any gate fails, no zip is produced. The 1.5.4
# release shipped a broken build (ReferenceError: buildHighlightHtml is not
# defined) because nothing exercised content.js end-to-end before zipping —
# that's what these gates are here to prevent.
#
# Post-InnerTube migration (commit 6ef48ac): no OAuth client credentials,
# no .oauth.local.json. Post-1.6.13: src/content.js is now an ES module
# entry that imports from src/lib/*.js; esbuild bundles them into
# src/content.bundle.js, which is the file Chrome actually injects.
# Background script + welcome page + vendored MiniSearch ship alongside.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -e "const m=require('$SRC_DIR/manifest.json'); process.stdout.write(m.version)")"
OUT="$DIST_DIR/youtube-playlist-filter-$VERSION.zip"

echo "[build] Gate 1/6: esbuild bundle (src/content.js + src/lib/*.js → src/content.bundle.js)"
(cd "$ROOT_DIR" && npm run --silent build)

echo "[build] Gate 2/6: node --check src/content.bundle.js (what Chrome injects)"
node --check "$SRC_DIR/content.bundle.js"

echo "[build] Gate 3/6: typecheck (tsc --noEmit --checkJs)"
(cd "$ROOT_DIR" && npm run --silent typecheck)

echo "[build] Gate 4/6: unit tests (fixture-driven parsers)"
node --test "$ROOT_DIR/tests/innertube-parse.test.mjs" "$ROOT_DIR/tests/dom-parse.test.mjs"

echo "[build] Gate 5/6: integration test (bundled content.js in vm sandbox)"
node "$SRC_DIR/test-search.cjs"

echo "[build] Gate 6/6: CWS structural validator + fixture mount harness"
node "$ROOT_DIR/scripts/validate-cws.mjs"
node "$ROOT_DIR/tests/test-feed-page-mount.mjs"

# NOTE: the full e2e suite (signed-in YouTube via agent-browser) runs as the
# pre-upload gate inside scripts/publish-cws.mjs, NOT here. Build = fast gates;
# publish = full gate. This avoids running the slow e2e twice on a fresh release.

mkdir -p "$DIST_DIR"
rm -f "$OUT"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

cp -R \
  "$SRC_DIR/manifest.json" \
  "$SRC_DIR/background.js" \
  "$SRC_DIR/content.bundle.js" \
  "$SRC_DIR/styles.css" \
  "$SRC_DIR/onboarding-state.js" \
  "$SRC_DIR/welcome.html" \
  "$SRC_DIR/welcome.js" \
  "$SRC_DIR/icons" \
  "$SRC_DIR/vendor" \
  "$SRC_DIR/welcome-assets" \
  "$STAGE_DIR/"

cd "$STAGE_DIR"
zip -r "$OUT" \
  manifest.json \
  background.js \
  content.bundle.js \
  styles.css \
  onboarding-state.js \
  welcome.html \
  welcome.js \
  icons \
  vendor \
  welcome-assets \
  -x "*.DS_Store"

echo "[build] Packaged $OUT"
