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
// No test gate: tests do not run before upload, by the owner's decision
// (2026-09-24). The build (scripts/build-store-zip.sh) still bundles,
// syntax-checks, typechecks and validates before a zip exists.
//
// If zip-path is omitted, looks for dist/youtube-playlist-filter-<version>.zip
// where <version> matches src/manifest.json.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
  const exact = `youtube-playlist-filter-${version}.zip`;
  return existsSync(join(distDir, exact)) ? join(distDir, exact) : null;
}

function validateZipAgainstSource(zipPath) {
  const list = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`cannot list zip: ${zipPath}`);
  const allowedTopLevel = new Set([
    "manifest.json", "background.js", "onboarding-state.js", "intent-hook.js",
    "content.bundle.js", "welcome.html", "welcome.js",
  ]);
  // Files the extension cannot run without, that aren't top-level. lib/intent.js
  // is imported by the module service worker at runtime, so a zip missing it
  // installs cleanly and then does nothing at all.
  const requiredNested = ["lib/intent.js", "icons/icon128.png"];
  const files = list.stdout.split("\n").filter((name) => name && !name.endsWith("/"));
  for (const file of files) {
    if (
      !allowedTopLevel.has(file) &&
      !file.startsWith("icons/") &&
      !file.startsWith("lib/")
    ) {
      throw new Error(`unexpected file in upload zip: ${file}`);
    }
    const sourcePath = join(ROOT, "src", file);
    if (!existsSync(sourcePath)) throw new Error(`zip file has no source counterpart: ${file}`);
    const zipped = spawnSync("unzip", ["-p", zipPath, file], { encoding: null, maxBuffer: 16 * 1024 * 1024 });
    if (zipped.status !== 0 || !zipped.stdout.equals(readFileSync(sourcePath))) {
      throw new Error(`upload zip does not match tested source: ${file}`);
    }
  }
  for (const required of [...allowedTopLevel, ...requiredNested]) {
    if (!files.includes(required)) throw new Error(`upload zip is missing ${required}`);
  }
}

const transitions = [];
function log(state, detail) {
  const t = { at: new Date().toISOString(), state, detail };
  transitions.push(t);
  if (!JSON_MODE) console.log(`[${t.at}] ${state}${detail ? ` \u2014 ${detail}` : ""}`);
}

async function run() {
  // Build the default upload from the current source in this process, so an old
  // dist zip can never be the one that ships.
  if (!ZIP_PATH_ARG) {
    log("building", "running scripts/build-store-zip.sh");
    const build = spawnSync("bash", [join(ROOT, "scripts", "build-store-zip.sh")], {
      stdio: "inherit",
    });
    if (build.status !== 0) {
      return { kind: "build-failed", reason: `build-store-zip.sh exited ${build.status}` };
    }
  }

  const secrets = loadSecrets();
  if (!secrets) {
    const reason = `no CWS secrets configured \u2014 set ${SECRET_ENV_NAMES.join(", ")} to enable automated publish.`;
    log("skipped", reason);
    return { kind: "skipped", reason };
  }
  const zipPath = ZIP_PATH_ARG ?? findDefaultZip();
  if (!zipPath || !existsSync(zipPath)) {
    console.error(`publish-cws: no zip found${ZIP_PATH_ARG ? ` at ${ZIP_PATH_ARG}` : " in dist/"}. Run bash scripts/build-store-zip.sh first.`);
    process.exit(2);
  }
  validateZipAgainstSource(zipPath);
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
  if (outcome.kind === "build-failed") return 1;
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
          : outcome.kind === "build-failed"
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
