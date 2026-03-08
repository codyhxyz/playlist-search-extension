#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -e "const m=require('$ROOT_DIR/manifest.json'); process.stdout.write(m.version)")"
OUT="$DIST_DIR/youtube-playlist-filter-$VERSION.zip"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

cd "$ROOT_DIR"
zip -r "$OUT" \
  manifest.json \
  content.js \
  styles.css \
  icons \
  vendor \
  -x "*.DS_Store"

echo "Built $OUT"
