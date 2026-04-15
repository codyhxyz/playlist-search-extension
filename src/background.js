"use strict";

const STORAGE_KEYS = {
  token: "ytpf_oauth_token",
  refreshToken: "ytpf_oauth_refresh_token",
  playlistCache: "ytpf_playlist_cache",
  authProfile: "ytpf_auth_profile",
  oauthClientId: "ytpf_oauth_client_id",
  oauthClientSecret: "ytpf_oauth_client_secret",
  useCustomOauth: "ytpf_use_custom_oauth_client",
  customOauthVersion: "ytpf_custom_oauth_mode_version",
};

// NOTE: This is a Google "Web application" OAuth client used from a Chrome
// extension. Google requires a client_secret for this client type, but in an
// extension context the secret ships inside the .crx anyway — it is not
// actually confidential. Security for this flow comes from PKCE plus the
// Authorized redirect URI registered in Google Cloud Console, which restricts
// auth codes to this extension's chromiumapp.org URL.
//
// The default ID/secret are left blank in source and injected at build time
// from .oauth.local.json (gitignored) via scripts/build-store-zip.sh. Users
// who build from source can either populate that file or configure a custom
// OAuth client at runtime via the extension's settings.
const DEFAULT_OAUTH_CLIENT_ID = "__OAUTH_CLIENT_ID__";
const DEFAULT_OAUTH_CLIENT_SECRET = "__OAUTH_CLIENT_SECRET__";

const YT_SCOPES = [
  "https://www.googleapis.com/auth/youtube.force-ssl",
];

const TOKEN_EARLY_EXPIRY_MS = 30_000;
const PLAYLIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

let memoryPlaylistCache = null;
let interactiveAuthInFlight = null;
let refreshInFlight = null;

function storageGet(keys) {
  return chrome.storage.local.get(keys);
}

function storageSet(values) {
  return chrome.storage.local.set(values);
}

function storageRemove(keys) {
  return chrome.storage.local.remove(keys);
}

function base64UrlEncode(bytes) {
  const raw = btoa(String.fromCharCode(...bytes));
  return raw.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function randomString(length = 64) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes).slice(0, length);
}

async function sha256Base64Url(input) {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

function redirectUri() {
  return chrome.identity.getRedirectURL();
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function normalizeError(error, fallback = "Request failed") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  if (error.message) return error.message;
  return fallback;
}

function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, { ...options, signal: controller.signal })
    .catch((error) => {
      if (error.name === "AbortError") {
        throw new Error("Request timed out. Check your network connection and try again.");
      }
      throw error;
    })
    .finally(() => clearTimeout(timeoutId));
}

const USER_FRIENDLY_ERRORS = {
  keyInvalid: "API key is invalid. Please reconnect your account.",
  quotaExceeded: "YouTube API quota exceeded. Try again tomorrow.",
  forbidden: "Access denied. Your account may not have permission for this action.",
  notFound: "Playlist not found. It may have been deleted.",
  dailyLimitExceeded: "Daily API limit reached. Try again tomorrow.",
};

async function getConfig() {
  const custom = await storageGet([
    STORAGE_KEYS.oauthClientId,
    STORAGE_KEYS.oauthClientSecret,
  ]);
  const customId = custom[STORAGE_KEYS.oauthClientId];
  const customSecret = custom[STORAGE_KEYS.oauthClientSecret];
  return {
    oauthClientId: customId || DEFAULT_OAUTH_CLIENT_ID,
    oauthClientSecret: customSecret || DEFAULT_OAUTH_CLIENT_SECRET,
    usingDefaultClientId: !customId,
  };
}

async function getStoredTokenBundle() {
  const stored = await storageGet([
    STORAGE_KEYS.token,
    STORAGE_KEYS.refreshToken,
  ]);
  return {
    token: stored[STORAGE_KEYS.token] || null,
    refreshToken: stored[STORAGE_KEYS.refreshToken] || null,
  };
}

function isTokenValid(tokenBundle) {
  if (!tokenBundle?.access_token || !tokenBundle?.expires_at) return false;
  return Date.now() + TOKEN_EARLY_EXPIRY_MS < Number(tokenBundle.expires_at);
}

async function storeTokenBundle(tokenBundle) {
  const payload = {
    [STORAGE_KEYS.token]: tokenBundle,
  };
  if (tokenBundle.refresh_token) {
    payload[STORAGE_KEYS.refreshToken] = tokenBundle.refresh_token;
  }
  await storageSet(payload);
}

async function clearAuth() {
  await storageRemove([
    STORAGE_KEYS.token,
    STORAGE_KEYS.refreshToken,
    STORAGE_KEYS.playlistCache,
    STORAGE_KEYS.authProfile,
    STORAGE_KEYS.oauthClientId,
    STORAGE_KEYS.oauthClientSecret,
    STORAGE_KEYS.useCustomOauth,
    STORAGE_KEYS.customOauthVersion,
  ]);
  memoryPlaylistCache = null;
}

async function refreshAccessToken(clientId, refreshToken, clientSecret = "") {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await response.text();
  const data = parseJsonSafe(text);

  if (!response.ok || !data?.access_token) {
    const apiError = data?.error_description || data?.error || text;
    throw new Error(`Token refresh failed: ${apiError || response.status}`);
  }

  const expiresInMs = Math.max(0, Number(data.expires_in || 3600) * 1000);
  return {
    access_token: data.access_token,
    token_type: data.token_type || "Bearer",
    scope: data.scope || YT_SCOPES.join(" "),
    expires_at: Date.now() + expiresInMs,
    refresh_token: refreshToken,
  };
}

async function interactiveAuth(clientId, clientSecret = "") {
  const verifier = randomString(96);
  const challenge = await sha256Base64Url(verifier);
  const redirectUriValue = redirectUri();

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUriValue);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", YT_SCOPES.join(" "));
  authUrl.searchParams.set("access_type", "offline");
  authUrl.searchParams.set("prompt", "select_account consent");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  const redirectedTo = await chrome.identity.launchWebAuthFlow({
    url: authUrl.toString(),
    interactive: true,
  });

  if (!redirectedTo) {
    throw new Error("Authorization was cancelled");
  }

  const redirectedUrl = new URL(redirectedTo);
  const authError = redirectedUrl.searchParams.get("error");
  if (authError) {
    throw new Error(`Authorization failed: ${authError}`);
  }

  const code = redirectedUrl.searchParams.get("code");
  if (!code) {
    throw new Error("Authorization code was not returned");
  }

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    code_verifier: verifier,
    grant_type: "authorization_code",
    redirect_uri: redirectUriValue,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const tokenResponse = await fetchWithTimeout("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const text = await tokenResponse.text();
  const data = parseJsonSafe(text);

  if (!tokenResponse.ok || !data?.access_token) {
    const apiError = data?.error_description || data?.error || text;
    throw new Error(`Token exchange failed: ${apiError || tokenResponse.status}`);
  }

  const expiresInMs = Math.max(0, Number(data.expires_in || 3600) * 1000);
  return {
    access_token: data.access_token,
    token_type: data.token_type || "Bearer",
    scope: data.scope || YT_SCOPES.join(" "),
    expires_at: Date.now() + expiresInMs,
    refresh_token: data.refresh_token || null,
  };
}

async function ensureAccessToken(options = {}) {
  const interactive = Boolean(options.interactive);
  const forceReauth = Boolean(options.forceReauth);
  const { oauthClientId, oauthClientSecret } = await getConfig();
  if (!oauthClientId) {
    throw new Error("OAuth client ID is not configured");
  }

  if (forceReauth) {
    await storageRemove([
      STORAGE_KEYS.token,
      STORAGE_KEYS.refreshToken,
      STORAGE_KEYS.playlistCache,
    ]);
    memoryPlaylistCache = null;
  }

  const stored = await getStoredTokenBundle();
  if (isTokenValid(stored.token)) {
    return stored.token.access_token;
  }

  if (stored.refreshToken) {
    try {
      if (!refreshInFlight) {
        refreshInFlight = refreshAccessToken(
          oauthClientId,
          stored.refreshToken,
          oauthClientSecret,
        ).finally(() => { refreshInFlight = null; });
      }
      const refreshed = await refreshInFlight;
      await storeTokenBundle(refreshed);
      return refreshed.access_token;
    } catch (error) {
      if (!interactive) {
        throw error;
      }
    }
  }

  if (!interactive) {
    throw new Error("Authentication required");
  }

  if (!interactiveAuthInFlight) {
    interactiveAuthInFlight = interactiveAuth(oauthClientId, oauthClientSecret)
      .then(async (tokenBundle) => {
        await storeTokenBundle(tokenBundle);
        return tokenBundle;
      })
      .finally(() => {
        interactiveAuthInFlight = null;
      });
  }

  const tokenBundle = await interactiveAuthInFlight;
  return tokenBundle.access_token;
}

async function youtubeRequest(url, options = {}) {
  const method = options.method || "GET";
  const interactive = Boolean(options.interactive);
  const config = await getConfig();

  let token = await ensureAccessToken({ interactive });

  async function doFetch(accessToken) {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers || {}),
    };

    return fetchWithTimeout(url, {
      method,
      headers,
      body: options.body,
    });
  }

  let response = await doFetch(token);

  if (response.status === 401) {
    const stored = await getStoredTokenBundle();
    if (config.oauthClientId && stored.refreshToken) {
      const refreshed = await refreshAccessToken(
        config.oauthClientId,
        stored.refreshToken,
        config.oauthClientSecret,
      );
      await storeTokenBundle(refreshed);
      token = refreshed.access_token;
      response = await doFetch(token);
    }
  }

  const text = await response.text();
  const data = parseJsonSafe(text);
  if (!response.ok) {
    const rawCode = data?.error?.errors?.[0]?.reason || data?.error?.status || "";
    const friendly = USER_FRIENDLY_ERRORS[rawCode];
    const message = friendly ||
      data?.error?.message ||
      data?.error_description ||
      data?.error ||
      text ||
      `HTTP ${response.status}`;
    throw new Error(message);
  }

  return data || {};
}

async function loadPlaylistsFromApi(interactive) {
  let pageToken = "";
  const rows = [];

  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/playlists");
    url.searchParams.set("part", "id,snippet,contentDetails,status");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    if (pageToken) {
      url.searchParams.set("pageToken", pageToken);
    }

    const data = await youtubeRequest(url.toString(), { interactive });
    const items = Array.isArray(data.items) ? data.items : [];

    items.forEach((item) => {
      const title = item?.snippet?.title || "Untitled playlist";
      rows.push({
        id: item.id,
        title,
        itemCount: Number(item?.contentDetails?.itemCount || 0),
        privacyStatus: item?.status?.privacyStatus || "private",
      });
    });

    pageToken = data.nextPageToken || "";
  } while (pageToken);

  return rows;
}

async function loadAuthChannels(interactive) {
  const url = new URL("https://www.googleapis.com/youtube/v3/channels");
  url.searchParams.set("part", "id,snippet");
  url.searchParams.set("mine", "true");
  url.searchParams.set("maxResults", "50");
  const data = await youtubeRequest(url.toString(), { interactive });
  const items = Array.isArray(data.items) ? data.items : [];
  return items
    .map((item) => ({
      id: item?.id || "",
      title: item?.snippet?.title || "Unknown channel",
      customUrl: item?.snippet?.customUrl || "",
    }))
    .filter((item) => item.id);
}

async function getPlaylists(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const interactive = Boolean(options.interactive);
  const now = Date.now();

  if (!forceRefresh && memoryPlaylistCache && now - memoryPlaylistCache.fetchedAt < PLAYLIST_CACHE_TTL_MS) {
    return {
      playlists: memoryPlaylistCache.playlists,
      fetchedAt: memoryPlaylistCache.fetchedAt,
      source: "memory",
    };
  }

  if (!forceRefresh) {
    const stored = await storageGet([STORAGE_KEYS.playlistCache]);
    const cached = stored[STORAGE_KEYS.playlistCache];
    if (
      cached &&
      Array.isArray(cached.playlists) &&
      cached.fetchedAt &&
      now - cached.fetchedAt < PLAYLIST_CACHE_TTL_MS
    ) {
      memoryPlaylistCache = cached;
      return {
        playlists: cached.playlists,
        fetchedAt: cached.fetchedAt,
        source: "storage",
      };
    }
  }

  const playlists = await loadPlaylistsFromApi(interactive);
  const cache = {
    playlists,
    fetchedAt: Date.now(),
  };

  memoryPlaylistCache = cache;
  await storageSet({ [STORAGE_KEYS.playlistCache]: cache });

  return {
    playlists,
    fetchedAt: cache.fetchedAt,
    source: "api",
  };
}

async function saveVideoToPlaylist({ playlistId, videoId, interactive }) {
  if (!playlistId) throw new Error("playlistId is required");
  if (!videoId) throw new Error("videoId is required");

  const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
  url.searchParams.set("part", "snippet");

  return youtubeRequest(url.toString(), {
    method: "POST",
    interactive,
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    }),
  });
}

async function getAuthStatus() {
  const config = await getConfig();
  const stored = await getStoredTokenBundle();
  const profileStore = await storageGet([STORAGE_KEYS.authProfile]);
  const authProfile = profileStore[STORAGE_KEYS.authProfile] || null;
  const hasToken = Boolean(stored.token?.access_token);
  const tokenValid = isTokenValid(stored.token);
  const hasRefreshToken = Boolean(stored.refreshToken);

  return {
    hasClientId: Boolean(config.oauthClientId),
    hasClientSecret: Boolean(config.oauthClientSecret),
    usingDefaultClientId: Boolean(config.usingDefaultClientId),
    redirectUri: redirectUri(),
    hasToken,
    hasRefreshToken,
    tokenValid,
    authProfile: hasToken || hasRefreshToken ? authProfile : null,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    const type = message?.type;

    if (type === "YTPF_GET_AUTH_STATUS") {
      return { status: await getAuthStatus() };
    }

    if (type === "YTPF_CONNECT") {
      await ensureAccessToken({
        interactive: true,
        forceReauth: Boolean(message.forceReauth),
      });
      const channels = await loadAuthChannels(false);
      if (!channels.length) {
        throw new Error(
          "Connected account has no accessible YouTube channel. If you use a Brand Account, switch to that channel in YouTube and reconnect.",
        );
      }
      await storageSet({
        [STORAGE_KEYS.authProfile]: {
          channels,
          updatedAt: Date.now(),
        },
      });
      return { status: await getAuthStatus() };
    }

    if (type === "YTPF_GET_PLAYLISTS") {
      const result = await getPlaylists({
        forceRefresh: Boolean(message.forceRefresh),
        interactive: Boolean(message.interactive),
      });
      return result;
    }

    if (type === "YTPF_SAVE_VIDEO") {
      const result = await saveVideoToPlaylist({
        playlistId: message.playlistId,
        videoId: message.videoId,
        interactive: Boolean(message.interactive),
      });
      return { result };
    }

    if (type === "YTPF_SIGN_OUT") {
      await clearAuth();
      return { status: await getAuthStatus() };
    }

    throw new Error(`Unsupported message type: ${type || "unknown"}`);
  })()
    .then((payload) => {
      sendResponse({ ok: true, ...payload });
    })
    .catch((error) => {
      sendResponse({ ok: false, error: normalizeError(error) });
    });

  return true;
});
