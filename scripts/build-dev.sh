#!/usr/bin/env bash
set -euo pipefail

# Build a load-unpacked-ready copy of the CURRENT source under dist/unpacked/.
#
# Why this exists: `src/` cannot be loaded directly and just work. It declares
# youtube.com as an OPTIONAL host permission, so a fresh dev install injects
# nothing until you click through the welcome page — which looks exactly like
# "the extension is broken". And the repo still carries `overhaul/`, the original
# spike, which IS directly loadable, is named "pls spike — sidecar save sheet",
# and predates every fix in src/. Loading that and concluding a bug is unfixed is
# a trap that has already cost real time.
#
# This build changes exactly two things from what ships:
#   1. optional_host_permissions -> mandatory host_permissions, so it works the
#      moment Chrome loads it, with no onboarding click
#   2. drops `key`, so it does not claim the production listing's identity
#
# The name is suffixed so it is unmistakable in chrome://extensions.
#
# Usage:
#   bash scripts/build-dev.sh
#   -> chrome://extensions -> Developer mode -> Load unpacked -> dist/unpacked

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_DIR="$ROOT_DIR/src"
OUT_DIR="$ROOT_DIR/dist/unpacked"

echo "[build-dev] bundling current source"
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
  const m = JSON.parse(fs.readFileSync(path.join(process.env.SRC_DIR, "manifest.json"), "utf8"));
  delete m.optional_host_permissions;
  m.host_permissions = ["https://www.youtube.com/*"];
  delete m.key;
  m.name = m.name + " (dev)";
  fs.writeFileSync(path.join(process.env.OUT_DIR, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
'

VERSION="$(node -e "process.stdout.write(require('$SRC_DIR/manifest.json').version)")"
echo
echo "[build-dev] built $VERSION -> $OUT_DIR"
echo
echo "  Load it:  chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  dist/unpacked"
echo "  It shows up as: YouTube Playlist Search (dev)"
echo
echo "  REMOVE any older copy first — especially 'pls spike — sidecar save sheet'"
echo "  (the overhaul/ folder). That one is the original spike and has none of"
echo "  the fixes; two builds loaded at once will both answer the Save button."
echo
