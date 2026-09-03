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
# 2.0.0 layout: the extension is the save sheet and nothing else.
#   background.js       module service worker; imports onboarding-state.js
#                       and lib/intent.js at runtime, so BOTH must ship
#                       unbundled alongside it
#   intent-hook.js      MAIN-world content script, no imports, ships as-is
#   content.bundle.js   esbuild output of content.js + lib/{innertube,sheet}.js
#   welcome.html/.js    onboarding + the optional-host-permission grant
# No styles.css and no vendor/: the sheet is a closed shadow root that styles
# itself via adoptedStyleSheets, and its search is a substring filter over our
# own array, so the vendored BM25 index went with the /feed/playlists surface.

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -e "const m=require('$SRC_DIR/manifest.json'); process.stdout.write(m.version)")"
OUT="$DIST_DIR/youtube-playlist-filter-$VERSION.zip"

echo "[build] Gate 1/6: esbuild bundle (src/content.js + src/lib/*.js → src/content.bundle.js)"
(cd "$ROOT_DIR" && npm run --silent build)

echo "[build] Gate 2/6: node --check on every shipped script"
for f in content.bundle.js background.js intent-hook.js onboarding-state.js welcome.js \
         lib/intent.js lib/innertube.js lib/sheet.js; do
  node --check "$SRC_DIR/$f"
done

echo "[build] Gate 3/6: typecheck (tsc --noEmit --checkJs)"
(cd "$ROOT_DIR" && npm run --silent typecheck)

echo "[build] Gate 4/6: unit tests (intent resolution + InnerTube parsers)"
node --test "$ROOT_DIR/tests/intent.test.mjs" "$ROOT_DIR/tests/innertube.test.mjs"

echo "[build] Gate 5/6: save-sheet UI contract (real engine)"
node "$ROOT_DIR/tests/test-sheet-render.mjs"

echo "[build] Gate 6/6: CWS structural validator + published privacy page in sync"
node "$ROOT_DIR/scripts/validate-cws.mjs"
# The CWS listing and the welcome page both link to the published policy. It
# drifted out of sync with PRIVACY.md once already, silently dropping a whole
# section, so it is now generated and checked rather than maintained twice.
node "$ROOT_DIR/scripts/build-privacy-page.mjs" --check

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
  "$SRC_DIR/onboarding-state.js" \
  "$SRC_DIR/intent-hook.js" \
  "$SRC_DIR/content.bundle.js" \
  "$SRC_DIR/welcome.html" \
  "$SRC_DIR/welcome.js" \
  "$SRC_DIR/icons" \
  "$STAGE_DIR/"

# lib/ ships too, but ONLY the module the service worker imports at runtime.
# lib/innertube.js and lib/sheet.js are already inlined into content.bundle.js;
# shipping them again would put two copies of the same code in front of a
# reviewer for no benefit.
mkdir -p "$STAGE_DIR/lib"
cp "$SRC_DIR/lib/intent.js" "$STAGE_DIR/lib/intent.js"

cd "$STAGE_DIR"
zip -r "$OUT" \
  manifest.json \
  background.js \
  onboarding-state.js \
  intent-hook.js \
  content.bundle.js \
  welcome.html \
  welcome.js \
  icons \
  lib \
  -x "*.DS_Store"

echo "[build] Packaged $OUT"
