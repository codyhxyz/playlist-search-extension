#!/usr/bin/env node
// Upload the store zip to CWS and (optionally) publish it.
//
// Emits transitions on stdout: uploading, uploaded, publishing, in-review,
// live, rejected, failed, timeout. Use --json for a single envelope.
//
// Usage:
//   node scripts/publish-cws.mjs [zip-path] [--json] [--no-auto-publish]
//                                [--target=default|trustedTesters]
//
// If zip-path is omitted, looks for dist/youtube-playlist-filter-<version>.zip
// where <version> matches src/manifest.json.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSecrets, uploadZip, publish, pollStatus, SECRET_ENV_NAMES } from "./cws-api.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const JSON_MODE = ARGS.includes("--json");
const AUTO_PUBLISH = !ARGS.includes("--no-auto-publish");
const TARGET = (ARGS.find((a) => a.startsWith("--target="))?.split("=")[1] === "trustedTesters")
  ? "trustedTesters"
  : "default";
const ZIP_PATH_ARG = ARGS.find((a) => !a.startsWith("--"));

function readManifestVersion() {
  const m = JSON.parse(readFileSync(join(ROOT, "src", "manifest.json"), "utf8"));
  return m.version;
}

function findDefaultZip() {
  const distDir = join(ROOT, "dist");
  if (!existsSync(distDir)) return null;
  const version = readManifestVersion();
  // Prefer the zip that matches the current manifest version; fall back to
  // the lexicographically-latest .zip so we don't silently ship a stale one.
  const exact = `youtube-playlist-filter-${version}.zip`;
  if (existsSync(join(distDir, exact))) return join(distDir, exact);
  const zips = readdirSync(distDir).filter((f) => f.endsWith(".zip")).sort();
  return zips.length ? join(distDir, zips[zips.length - 1]) : null;
}

const transitions = [];
function log(state, detail) {
  const t = { at: new Date().toISOString(), state, detail };
  transitions.push(t);
  if (!JSON_MODE) console.log(`[${t.at}] ${state}${detail ? ` \u2014 ${detail}` : ""}`);
}

async function run() {
  const secrets = loadSecrets();
  if (!secrets) {
    const reason = `no CWS secrets configured \u2014 set ${SECRET_ENV_NAMES.join(", ")} to enable automated publish.`;
    log("skipped", reason);
    return { kind: "skipped", reason };
  }
  const zipPath = ZIP_PATH_ARG ?? findDefaultZip();
  if (!zipPath || !existsSync(zipPath)) {
    console.error(`publish-cws: no zip found${ZIP_PATH_ARG ? ` at ${ZIP_PATH_ARG}` : " in dist/"}. Run bash private/scripts/build-store-zip.sh first.`);
    process.exit(2);
  }
  log("uploading", `path=${zipPath}`);
  const upload = await uploadZip(secrets, zipPath);
  if (upload?.uploadState === "FAILURE") {
    const detail = (upload.itemError ?? []).map((e) => `${e.error_code}: ${e.error_detail}`).join("; ");
    log("upload-failed", detail);
    return { kind: "upload-failed", upload };
  }
  log("uploaded", `state=${upload?.uploadState ?? "unknown"}${upload?.crxVersion ? ` version=${upload.crxVersion}` : ""}`);
  if (!AUTO_PUBLISH) {
    log("skipped-publish", "--no-auto-publish set");
    return { kind: "terminal", poll: { state: "live" }, upload };
  }
  log("publishing", `target=${TARGET}`);
  const publishResp = await publish(secrets, TARGET);
  const pollResult = await pollStatus(secrets, publishResp);
  log(pollResult.state, pollResult.detail);
  return { kind: "terminal", poll: pollResult, upload, publish: publishResp };
}

function exitCodeFor(outcome) {
  if (outcome.kind === "skipped") return 0;
  if (outcome.kind === "upload-failed") return 1;
  const s = outcome.poll.state;
  return (s === "live" || s === "in-review") ? 0 : 1;
}

run()
  .then((outcome) => {
    const exitCode = exitCodeFor(outcome);
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify({
        schemaVersion: 1,
        script: "publish-cws",
        skipped: outcome.kind === "skipped",
        status: outcome.kind === "skipped" ? "skipped" : outcome.kind,
        state: outcome.kind === "terminal" ? outcome.poll.state : outcome.kind,
        detail: outcome.kind === "skipped"
          ? outcome.reason
          : outcome.kind === "upload-failed"
            ? (outcome.upload.itemError ?? []).map((e) => `${e.error_code}: ${e.error_detail}`).join("; ")
            : outcome.poll.detail,
        transitions,
      }, null, 2) + "\n");
    } else if (outcome.kind === "terminal") {
      console.log(`publish-cws: terminal state \u2014 ${outcome.poll.state}.`);
    }
    process.exit(exitCode);
  })
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    log("error", message);
    if (JSON_MODE) {
      process.stdout.write(JSON.stringify({ schemaVersion: 1, script: "publish-cws", status: "error", state: "error", detail: message, transitions }, null, 2) + "\n");
    } else {
      console.error(`publish-cws: error \u2014 ${message}`);
    }
    process.exit(1);
  });
