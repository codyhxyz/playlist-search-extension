// Shared Chrome Web Store API helpers.
//
// Vanilla fetch against the Chrome Web Store Publish API v1.1 plus Google
// OAuth2 for the refresh-token exchange. Zero npm deps so the repo stays
// install-free for anyone who isn't publishing.
//
// Opt-in pattern: every consumer calls loadSecrets() first and returns
// cleanly on null. The repo must stay usable with no CWS secrets configured.
//
// See https://developer.chrome.com/docs/webstore/using-api for API shape.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ENV_NAME_MAP = {
  extensionId: "CWS_EXTENSION_ID",
  clientId: "CWS_CLIENT_ID",
  clientSecret: "CWS_CLIENT_SECRET",
  refreshToken: "CWS_REFRESH_TOKEN",
};

export const SECRET_ENV_NAMES = Object.values(ENV_NAME_MAP);

const SECRETS_FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".secrets.local.json",
);

function loadSecretsFile() {
  if (!existsSync(SECRETS_FILE)) return {};
  try {
    return JSON.parse(readFileSync(SECRETS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function loadSecrets() {
  const file = loadSecretsFile();
  const out = {};
  for (const [key, envName] of Object.entries(ENV_NAME_MAP)) {
    const value = process.env[envName] || file[envName];
    if (!value) return null;
    out[key] = value;
  }
  return out;
}

async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = body?.error_description || body?.error || `HTTP ${response.status}`;
    throw new Error(`CWS token exchange failed: ${detail}`);
  }
  return body.access_token;
}

async function cwsFetch(secrets, method, path, { body, contentType } = {}) {
  const token = await getAccessToken(secrets);
  const headers = {
    Authorization: `Bearer ${token}`,
    "x-goog-api-version": "2",
  };
  if (contentType) headers["Content-Type"] = contentType;
  // CWS publish endpoint rejects chunked POSTs without an explicit length.
  if (method === "POST" && !body) headers["Content-Length"] = "0";
  const response = await fetch(`https://www.googleapis.com/${path}`, {
    method,
    headers,
    body,
  });
  const respBody = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      respBody && typeof respBody === "object"
        ? JSON.stringify(respBody)
        : `HTTP ${response.status}`;
    throw new Error(`CWS ${method} ${path} failed: ${detail}`);
  }
  return respBody;
}

// CWS API v1.1 only accepts projection=DRAFT now; PUBLISHED returns HTTP 400.
// The DRAFT projection's crxVersion reflects whatever version CWS currently
// has on file, which is what version-sync needs to compare against.
export async function getItem(secrets, projection = "DRAFT") {
  return cwsFetch(
    secrets,
    "GET",
    `chromewebstore/v1.1/items/${encodeURIComponent(secrets.extensionId)}?projection=${projection}`,
  );
}

/**
 * The version STAGED in the dashboard — i.e. the most recent successful upload.
 * This is NOT what users have.
 *
 * Renamed from getPublishedVersion(), which read the DRAFT projection while
 * claiming to report the published one. That is the worst kind of wrong: it
 * answers "did my release go out?" with a confident yes the moment an upload
 * succeeds, whether or not the publish step was ever accepted. Exactly that
 * happened on the 2.0.0 upload — publish returned 400, and the old helper still
 * said "2.0.0".
 */
export async function getStagedVersion(secrets) {
  const item = await getItem(secrets, "DRAFT");
  return typeof item?.crxVersion === "string" && item.crxVersion.length > 0
    ? item.crxVersion
    : null;
}

export async function getListing(secrets, language = "default") {
  return cwsFetch(
    secrets,
    "GET",
    `chromewebstore/v1.1/items/${encodeURIComponent(secrets.extensionId)}/listings/${encodeURIComponent(language)}?projection=DRAFT`,
  );
}

export async function uploadZip(secrets, zipPath) {
  // Load into memory: store zips are small (~600KB today) and streaming
  // uploads via Node fetch require duplex: 'half' plumbing we don't need.
  const buffer = readFileSync(zipPath);
  return cwsFetch(
    secrets,
    "PUT",
    `upload/chromewebstore/v1.1/items/${encodeURIComponent(secrets.extensionId)}`,
    { body: buffer, contentType: "application/zip" },
  );
}

export async function publish(secrets, target = "default") {
  return cwsFetch(
    secrets,
    "POST",
    `chromewebstore/v1.1/items/${encodeURIComponent(secrets.extensionId)}/publish?publishTarget=${target}`,
  );
}

// CWS returns status=["OK"] when a publish is accepted and enters review.
// Full review takes hours to days, so polling for "live" is pointless in CI —
// we just confirm the submission was accepted and exit.
export async function pollStatus(_secrets, initialPublish) {
  const statusList = initialPublish?.status ?? [];
  const detail = initialPublish?.statusDetail?.join("; ");
  const accepted = new Set(["OK", "ITEM_PENDING_REVIEW"]);
  const allAccepted = statusList.length > 0 && statusList.every((s) => accepted.has(s));
  if (allAccepted) return { state: "in-review", detail, lastStatus: statusList };
  return { state: "rejected", detail, lastStatus: statusList };
}
