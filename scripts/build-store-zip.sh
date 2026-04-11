#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DIST_DIR="$ROOT_DIR/dist"
VERSION="$(node -e "const m=require('$ROOT_DIR/manifest.json'); process.stdout.write(m.version)")"
OUT="$DIST_DIR/youtube-playlist-filter-$VERSION.zip"
OAUTH_CONFIG="$ROOT_DIR/.oauth.local.json"

mkdir -p "$DIST_DIR"
rm -f "$OUT"

if [[ ! -f "$OAUTH_CONFIG" ]]; then
  echo "ERROR: missing $OAUTH_CONFIG" >&2
  echo "Create it with the shape of .oauth.local.json.example" >&2
  exit 1
fi

CLIENT_ID="$(node -e "const c=require('$OAUTH_CONFIG'); process.stdout.write(c.client_id||'')")"
CLIENT_SECRET="$(node -e "const c=require('$OAUTH_CONFIG'); process.stdout.write(c.client_secret||'')")"

if [[ -z "$CLIENT_ID" || -z "$CLIENT_SECRET" ]]; then
  echo "ERROR: $OAUTH_CONFIG must define client_id and client_secret" >&2
  exit 1
fi

STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

cp -R \
  "$ROOT_DIR/manifest.json" \
  "$ROOT_DIR/background.js" \
  "$ROOT_DIR/content.js" \
  "$ROOT_DIR/styles.css" \
  "$ROOT_DIR/icons" \
  "$ROOT_DIR/vendor" \
  "$STAGE_DIR/"

node - "$STAGE_DIR/background.js" "$CLIENT_ID" "$CLIENT_SECRET" <<'NODE'
const fs = require("fs");
const [file, id, secret] = process.argv.slice(2);
let src = fs.readFileSync(file, "utf8");
if (!src.includes("__OAUTH_CLIENT_ID__") || !src.includes("__OAUTH_CLIENT_SECRET__")) {
  console.error("ERROR: background.js is missing __OAUTH_CLIENT_ID__ or __OAUTH_CLIENT_SECRET__ placeholders");
  process.exit(1);
}
src = src.replace("__OAUTH_CLIENT_ID__", id);
src = src.replace("__OAUTH_CLIENT_SECRET__", secret);
fs.writeFileSync(file, src);
NODE

cd "$STAGE_DIR"
zip -r "$OUT" \
  manifest.json \
  background.js \
  content.js \
  styles.css \
  icons \
  vendor \
  -x "*.DS_Store"

echo "Built $OUT"
