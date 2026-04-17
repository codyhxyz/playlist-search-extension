#!/usr/bin/env node
// Compare the local src/manifest.json version against the live CWS version.
//
//   Local > remote → exit 0 ("ahead, OK to ship")
//   Local ≤ remote → exit 1 (must bump before shipping)
//   No CWS secrets → exit 0 ("skipped")
//   API returned no crxVersion → exit 0 ("skipped", can't compare)
//
// Usage: node scripts/version-sync.mjs [--json]

import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecrets, getPublishedVersion, SECRET_ENV_NAMES } from "./cws-api.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST_PATH = join(ROOT, "src", "manifest.json");
const JSON_MODE = process.argv.includes("--json");

function readLocalVersion() {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  if (!manifest.version) {
    console.error("ERROR: src/manifest.json has no version field.");
    process.exit(2);
  }
  return manifest.version;
}

function compareVersions(a, b) {
  const pa = a.split(".").map((s) => Number.parseInt(s, 10));
  const pb = b.split(".").map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

async function run() {
  const localVersion = readLocalVersion();
  const secrets = loadSecrets();
  if (!secrets) {
    return { kind: "skipped", reason: `no CWS secrets configured (${SECRET_ENV_NAMES.join(", ")})`, localVersion, exitCode: 0 };
  }
  const remoteVersion = await getPublishedVersion(secrets);
  if (!remoteVersion) {
    return { kind: "skipped", reason: "CWS API did not return crxVersion for this item", localVersion, exitCode: 0 };
  }
  const cmp = compareVersions(localVersion, remoteVersion);
  if (cmp > 0) return { kind: "ahead", localVersion, remoteVersion, exitCode: 0 };
  return { kind: "behind-or-equal", localVersion, remoteVersion, exitCode: 1 };
}

run()
  .then((r) => {
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        script: "version-sync",
        skipped: r.kind === "skipped",
        status: r.kind,
        localVersion: r.localVersion,
        remoteVersion: r.remoteVersion ?? null,
        reason: r.kind === "skipped" ? r.reason : undefined,
      }, null, 2) + "\n");
      process.exit(r.exitCode);
    }
    if (r.kind === "skipped") {
      console.log(`version-sync: skipped \u2014 ${r.reason} (local: ${r.localVersion})`);
    } else if (r.kind === "ahead") {
      console.log(`version-sync: local ${r.localVersion} > live ${r.remoteVersion}. OK to ship.`);
    } else {
      console.log(`version-sync: local ${r.localVersion} \u2264 live ${r.remoteVersion}.`);
      console.log("  fix: bump src/manifest.json version, then retry.");
    }
    process.exit(r.exitCode);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, script: "version-sync", status: "error", error: message }) + "\n");
    } else {
      console.error(`version-sync: error \u2014 ${message}`);
      console.error("  If you set fake secrets, an auth error is expected \u2014 proves the script reaches CWS.");
    }
    process.exit(1);
  });
