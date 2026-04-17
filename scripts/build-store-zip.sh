#!/usr/bin/env bash
set -euo pipefail

# Packages src/ into a Chrome Web Store zip under dist/.
#
# This script intentionally refuses to package a broken source tree. Before
# copying files we run the content-script test suite and node --check. If
# either gate fails, no zip is produced. The 1.5.4 release shipped a broken
# build (ReferenceError: buildHighlightHtml is not defined) because nothing
# exercised content.js end-to-end before zipping — that's what these gates
# are here to prevent.
#
# Post-InnerTube migration (commit 6ef48ac): no OAuth client credentials,
# no .oauth.local.json. The extension ships a content script plus vendored
# MiniSearch. The 1.6.0 welcome-onboarding release also added a service
# worker (background.js + onboarding-state.js) and the welcome page assets
# (welcome.html, welcome.js, welcome-assets/), all of which must be zipped.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -e "const m=require('$SRC_DIR/manifest.json'); process.stdout.write(m.version)")"
OUT="$DIST_DIR/youtube-playlist-filter-$VERSION.zip"

echo "[build] Gate 1/3: node --check src/content.js"
node --check "$SRC_DIR/content.js"

echo "[build] Gate 2/3: regression tests"
node "$SRC_DIR/test-search.js"

echo "[build] Gate 3/3: CWS structural validator"
node "$ROOT_DIR/scripts/validate-cws.mjs"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

cp -R \
  "$SRC_DIR/manifest.json" \
  "$SRC_DIR/background.js" \
  "$SRC_DIR/content.js" \
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
  content.js \
  styles.css \
  onboarding-state.js \
  welcome.html \
  welcome.js \
  icons \
  vendor \
  welcome-assets \
  -x "*.DS_Store"

echo "[build] Packaged $OUT"
