#!/usr/bin/env python3
"""
Decrypt Chrome's cookies for the YT Test profile and push them into the
agent-browser session. Fully automated — sidesteps Google's bot-detection
on accounts.google.com (we never sign in programmatically) AND macOS
Chrome's hard block on --load-extension (we use bundled Chromium).

Why both: bundled Chromium loads --extension fine but can't read real
Chrome's Keychain-encrypted cookies. So we decrypt them out-of-band here
and re-inject via agent-browser's cookies API (which writes them into the
bundled-Chromium session profile, which IS readable by bundled Chromium).

macOS Chrome cookie crypto:
  key = PBKDF2-HMAC-SHA1(keychain_password, salt='saltysalt', iter=1003, len=16)
  cipher = AES-128-CBC, IV = b' ' * 16
  encrypted_value bytes start with 'v10' or 'v11' prefix; strip and decrypt.

Run via: /tmp/ytpf-venv/bin/python tests/e2e/import-chrome-cookies.py
"""
import os
import sqlite3
import subprocess
import sys
from Crypto.Cipher import AES
from Crypto.Protocol.KDF import PBKDF2

PROFILE_DIR = os.path.expanduser(
    os.environ.get(
        "YTPF_CHROME_PROFILE_DIR",
        "~/Library/Application Support/Google/Chrome/Profile 2",
    )
)
COOKIE_DB = os.path.join(PROFILE_DIR, "Cookies")
SESSION = os.environ.get("YTPF_TEST_SESSION", "ytpf-e2e")

# Cookie domains we care about: youtube.com (the test target) and google.com
# (where the SID auth cookies live).
DOMAIN_FILTERS = ("%youtube.com", "%google.com")


def keychain_password() -> bytes:
    out = subprocess.check_output(
        ["security", "find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"],
        stderr=subprocess.PIPE,
    )
    return out.strip()


def derive_key(password: bytes) -> bytes:
    return PBKDF2(password, b"saltysalt", dkLen=16, count=1003)


def decrypt_value(key: bytes, encrypted: bytes) -> str:
    if not encrypted:
        return ""
    has_v10_prefix = encrypted.startswith(b"v10") or encrypted.startswith(b"v11")
    if has_v10_prefix:
        encrypted = encrypted[3:]
    cipher = AES.new(key, AES.MODE_CBC, IV=b" " * 16)
    decrypted = cipher.decrypt(encrypted)
    pad_len = decrypted[-1]
    plaintext = decrypted[:-pad_len]
    # macOS Chrome v10+ prepends a 32-byte SHA256 of the host_key to the
    # plaintext for integrity verification. The actual cookie value follows.
    if has_v10_prefix and len(plaintext) >= 32:
        plaintext = plaintext[32:]
    return plaintext.decode("utf-8", errors="replace")


def chrome_to_unix_timestamp(chrome_us: int) -> int:
    # Chrome stores timestamps as microseconds since 1601-01-01.
    if chrome_us == 0:
        return 0
    return int(chrome_us / 1_000_000 - 11_644_473_600)


def main() -> int:
    if not os.path.exists(COOKIE_DB):
        print(f"FAIL: {COOKIE_DB} not found", file=sys.stderr)
        return 2
    try:
        password = keychain_password()
    except subprocess.CalledProcessError as exc:
        # Surface the actual Keychain prompt error if any.
        msg = exc.stderr.decode().strip() if exc.stderr else "unknown"
        print(f"FAIL: keychain access denied: {msg}", file=sys.stderr)
        print("Hint: macOS Keychain may have prompted for permission. Click Always Allow.", file=sys.stderr)
        return 3
    key = derive_key(password)

    # Use a temp copy of the DB — Chrome may hold an exclusive lock on the
    # original even when not running, depending on shutdown cleanliness.
    tmp_db = "/tmp/ytpf-cookies-snapshot.sqlite"
    subprocess.check_call(["cp", COOKIE_DB, tmp_db])
    conn = sqlite3.connect(tmp_db)

    where_clause = " OR ".join(["host_key LIKE ?"] * len(DOMAIN_FILTERS))
    rows = conn.execute(
        f"SELECT host_key, name, encrypted_value, path, expires_utc, "
        f"is_secure, is_httponly, samesite "
        f"FROM cookies WHERE {where_clause}",
        DOMAIN_FILTERS,
    ).fetchall()

    if not rows:
        print(f"FAIL: 0 youtube/google cookies in {COOKIE_DB}.", file=sys.stderr)
        print("Hint: did you sign into YouTube in real Chrome with this profile?", file=sys.stderr)
        return 4

    # Wipe any previous cookies in the agent-browser session so we never
    # mix in stale entries from prior runs.
    subprocess.run(["agent-browser", "--session", SESSION, "cookies", "clear"],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    samesite_map = {0: "None", 1: "Lax", 2: "Strict", -1: "Lax"}
    imported = 0
    skipped = 0
    for host, name, enc, path, expires_us, secure, httponly, samesite in rows:
        try:
            value = decrypt_value(key, enc)
        except Exception as exc:  # noqa: BLE001 — best-effort import, log and continue
            print(f"  skip {name} ({host}): decrypt error: {exc}", file=sys.stderr)
            skipped += 1
            continue
        if not value:
            skipped += 1
            continue
        flags = ["--domain", host, "--path", path, "--sameSite", samesite_map.get(samesite, "Lax")]
        if secure:
            flags.append("--secure")
        if httponly:
            flags.append("--httpOnly")
        unix_expires = chrome_to_unix_timestamp(expires_us)
        if unix_expires > 0:
            flags += ["--expires", str(unix_expires)]
        try:
            subprocess.run(
                ["agent-browser", "--session", SESSION, "cookies", "set", name, value, *flags],
                check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            )
            imported += 1
        except subprocess.CalledProcessError as exc:
            err = exc.stderr.decode().strip() if exc.stderr else "unknown"
            print(f"  skip {name} ({host}): cookies set failed: {err}", file=sys.stderr)
            skipped += 1

    print(f"[import-chrome-cookies] imported {imported} cookies, skipped {skipped}")
    return 0 if imported > 0 else 5


if __name__ == "__main__":
    sys.exit(main())
