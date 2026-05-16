#!/usr/bin/env bash
set -euo pipefail

# One-time bootstrap for the e2e harness. Idempotent — re-running is safe.
#
# Sets up the Python venv with pycryptodome that the cookie-decrypt step
# needs. Run once after cloning, or whenever the venv path is missing.

VENV_DIR="${YTPF_VENV_DIR:-$HOME/.local/share/ytpf-venv}"
mkdir -p "$(dirname "$VENV_DIR")"

if [[ ! -d "$VENV_DIR" ]]; then
  echo "[setup] creating venv at $VENV_DIR"
  uv venv "$VENV_DIR"
fi

echo "[setup] installing pycryptodome"
uv pip install --python "$VENV_DIR" --quiet pycryptodome

echo "[setup] verifying"
"$VENV_DIR/bin/python" -c "from Crypto.Cipher import AES; from Crypto.Protocol.KDF import PBKDF2; print('ok')"

echo
echo "[setup] done. Now make sure your Chrome 'YT Test' profile is signed"
echo "[setup] into the test YouTube account (real Chrome, one-time), then run:"
echo "[setup]   bash tests/e2e/run.sh"
