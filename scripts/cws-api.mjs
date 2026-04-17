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

import { readFileSync } from "node:fs";

const ENV_NAME_MAP = {
  extensionId: "CWS_EXTENSION_ID",
  clientId: "CWS_CLIENT_ID",
  clientSecret: "CWS_CLIENT_SECRET",
  refreshToken: "CWS_REFRESH_TOKEN",
};

export const SECRET_ENV_NAMES = Object.values(ENV_NAME_MAP);

export function loadSecrets() {
  const out = {};
  for (const [key, envName] of Object.entries(ENV_NAME_MAP)) {
    const value = process.env[envName];
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

export async function getItem(secrets, projection = "PUBLISHED") {
  return cwsFetch(
    secrets,
    "GET",
    `chromewebstore/v1.1/items/${encodeURIComponent(secrets.extensionId)}?projection=${projection}`,
  );
}

export async function getPublishedVersion(secrets) {
  const item = await getItem(secrets, "PUBLISHED");
  return typeof item?.crxVersion === "string" && item.crxVersion.length > 0
    ? item.crxVersion
    : null;
}

export async function getListing(secrets, language = "default") {
  return cwsFetch(
    secrets,
    "GET",
    `chromewebstore/v1.1/items/${encodeURIComponent(secrets.extensionId)}/listings/${encodeURIComponent(language)}?projection=PUBLISHED`,
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

export async function pollStatus(secrets, initialPublish, { pollIntervalMs = 30_000, timeoutMs = 15 * 60_000 } = {}) {
  const statusList = initialPublish?.status ?? [];
  if (statusList.includes("ITEM_PENDING_REVIEW")) {
    return { state: "in-review", detail: initialPublish?.statusDetail?.join("; "), lastStatus: statusList };
  }
  const nonOk = statusList.filter((s) => s !== "OK");
  if (nonOk.length > 0) {
    return { state: "rejected", detail: initialPublish?.statusDetail?.join("; "), lastStatus: statusList };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const item = await getItem(secrets, "PUBLISHED");
    if (item?.uploadState === "SUCCESS") return { state: "live", lastStatus: statusList };
    if (item?.uploadState === "FAILURE") {
      return {
        state: "failed",
        detail: (item.itemError ?? []).map((e) => `${e.error_code}: ${e.error_detail}`).join("; "),
        lastStatus: statusList,
      };
    }
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return { state: "timeout", lastStatus: statusList };
}
