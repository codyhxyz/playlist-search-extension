// L2 — data. Hand-rolled InnerTube client, first-party, from the ISOLATED world.
//
// We run inside a content script on www.youtube.com, so we are same-origin: no CORS,
// no proxy, no backend, cookies attach automatically. Three endpoints, small enough to
// read in one sitting — which is also the CWS review story.
//
// The parsing functions (cfgFrom / scanPlaylists / parseVideoCount / parseMembership /
// classifyHttp) are pure and exported separately from the calls that use them, so
// tests/innertube.test.mjs can pin the response shapes without a network or a browser.
//
// The core insight this whole module exists to exploit: **the native Save dialog's
// 200-playlist cap was never our bug to fix, because we should never have been
// rendering their list.** `browse FEplaylist_aggregation` is a different endpoint with
// a different ceiling — 253 real playlists on the account this was built against,
// terminating because the server said done, not because our loop gave up.

const PLS_ORIGIN = 'https://www.youtube.com';
const PLS_FALLBACK_CTX = {
  client: { clientName: 'WEB', clientVersion: '2.20260801.00.00', hl: 'en', gl: 'US' },
};
const PLS_ID_RE = /^(VL)?(PL|LL|WL|FL|RD|UU|OL)/;

let plsCfgCache = null;

// ─────────────── context ───────────────
// `ytcfg` lives in the MAIN world, so scrape the JSON out of the page's own script
// text. Reachable from the ISOLATED world, and it is data, not markup — we are not
// reading YouTube's *rendered tree*, we are reading the config blob their own client
// reads. The invariant ("never read data from YouTube's DOM") is about playlist data;
// this is the session handshake, and there is no other source for it.

/**
 * Find the balanced `{...}` starting at `from`.
 * @param {string} text
 * @param {number} from
 */
function plsBalancedJson(text, from) {
  let depth = 0, inStr = false, esc = false;
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(from, i + 1);
  }
  return null;
}

/**
 * Extract the InnerTube context + api key + brand delegation + Google session index
 * from a script body.
 * Pure — exported for tests.
 * @param {string | null | undefined} text
 */
export function cfgFrom(text) {
  if (!text || !text.includes('INNERTUBE_CONTEXT')) return null;
  // Tolerate quoted and unquoted keys; the trailing ':{' is what rules out
  // INNERTUBE_CONTEXT_CLIENT_NAME / _CLIENT_VERSION / _HL, which are scalars.
  const m = text.match(/"?INNERTUBE_CONTEXT"?\s*:\s*\{/);
  const raw = m ? plsBalancedJson(text, m.index + m[0].length - 1) : null;
  if (!raw) return null;
  try {
    const context = JSON.parse(raw);
    if (!context?.client?.clientVersion) return null;
    return {
      context,
      apiKey: text.match(/"INNERTUBE_API_KEY":"([\w-]+)"/)?.[1] ?? null,
      // Brand/channel accounts: INNERTUBE_CONTEXT does NOT carry the delegation,
      // even when DELEGATED_SESSION_ID is set. Without injecting it below you get
      // only Liked + Watch Later instead of the user's real playlists — and
      // membership silently collapses to a single row. Verified 2026-08-28:
      // 2 playlists without it, 256 with it.
      delegatedSessionId: text.match(/"DELEGATED_SESSION_ID":"(\d+)"/)?.[1] ?? null,
      // Multiple signed-in Google accounts: which one this tab is. YouTube's own
      // client echoes it as `X-Goog-AuthUser` on every InnerTube call (see plsPost).
      // Seen both quoted ("1") and bare (1) in ytcfg blobs, so tolerate both, and
      // normalise to a string because it only ever goes into a header. The
      // lookbehind stops a longer key ending in _SESSION_INDEX from matching.
      sessionIndex: text.match(/(?<![\w])"?SESSION_INDEX"?\s*:\s*"?(\d+)"?/)?.[1] ?? null,
    };
  } catch (e) {
    console.warn('[pls] INNERTUBE_CONTEXT parse failed, trying next source', e);
    return null;
  }
}

function plsCfg() {
  if (plsCfgCache) return plsCfgCache;
  let hit = null, how = 'scraped-from-script-tag';
  for (const s of document.scripts) if ((hit = cfgFrom(s.textContent))) break;
  // Last resort: the whole serialized document (slow, so only if the scripts miss).
  if (!hit && (hit = cfgFrom(document.documentElement.innerHTML))) how = 'scraped-from-innerHTML';
  const { context, apiKey, delegatedSessionId, sessionIndex } =
    hit ?? { context: PLS_FALLBACK_CTX, apiKey: null, delegatedSessionId: null, sessionIndex: null };
  if (!hit) how = 'HARDCODED FALLBACK — regex is broken, look at this';

  // Acting as a brand channel: the delegation must be stated explicitly.
  if (delegatedSessionId) {
    context.user = { ...(context.user ?? {}), onBehalfOfUser: delegatedSessionId };
  }

  console.log(`[pls] innertube context: ${how}`, {
    clientVersion: context.client?.clientVersion,
    apiKey: apiKey ? 'found' : 'none',
    delegatedTo: delegatedSessionId ?? 'none (personal account)',
    authUser: sessionIndex ?? '0 (default — SESSION_INDEX not found)',
  });
  plsCfgCache = { context, apiKey, delegatedSessionId, sessionIndex };
  return plsCfgCache;
}

/**
 * Drop the cached config. The delegation is captured on first use, so an account
 * switch inside a single SPA session would otherwise keep acting as the old channel.
 * content.js calls this on navigation.
 */
export function resetConfigCache() {
  plsCfgCache = null;
}

async function plsAuth() {
  // Google uses a DIFFERENT scheme label per cookie: SAPISID -> SAPISIDHASH,
  // __Secure-1PAPISID -> SAPISID1PHASH, __Secure-3PAPISID -> SAPISID3PHASH.
  // Hashing the 3P cookie and still labelling it SAPISIDHASH gets a 401 on every
  // call — the fallback would fail in exactly the situation it exists to rescue.
  const candidates = [
    [/(?:^|;\s*)SAPISID=([^;]+)/, 'SAPISIDHASH'],
    [/(?:^|;\s*)__Secure-1PAPISID=([^;]+)/, 'SAPISID1PHASH'],
    [/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/, 'SAPISID3PHASH'],
  ];
  let value = null, scheme = null;
  for (const [re, label] of candidates) {
    const hit = document.cookie.match(re)?.[1];
    if (hit) { value = hit; scheme = label; break; }
  }
  if (!value) throw plsError('auth', 'no SAPISID cookie — signed out?');
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${ts} ${value} ${PLS_ORIGIN}`)
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${scheme} ${ts}_${hex}`;
}

/**
 * @param {string} path
 * @param {object} body
 * @param {{signal?: AbortSignal}} [opts]
 */
async function plsPost(path, body, { signal } = {}) {
  const { context, apiKey, delegatedSessionId, sessionIndex } = plsCfg();
  const url =
    `${PLS_ORIGIN}/youtubei/v1/${path}?prettyPrint=false` + (apiKey ? `&key=${apiKey}` : '');
  // `navigator.onLine === false` is reliable (true is not — it only means "has a
  // network interface"), so it is worth failing fast on before hashing anything.
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw plsError('offline', `${path} -> not sent, navigator.onLine is false`);
  }
  /** @type {Record<string, string>} */
  const headers = {
    'Content-Type': 'application/json',
    Authorization: await plsAuth(),
    'X-Origin': PLS_ORIGIN,
    // Which of the signed-in Google accounts this call is for. YouTube's own web
    // client sends this on every InnerTube call; "0" is the first/default account,
    // which is also what the server assumes when the header is absent. Without it,
    // a tab on account #2 could have its calls answered for account #0.
    // NOT YET LIVE-VERIFIED with two signed-in accounts — mirrored from YouTube's
    // own requests, not from a failure we have reproduced.
    'X-Goog-AuthUser': sessionIndex ?? '0',
  };
  // Brand channel: YouTube's client also names the delegated page in a header.
  // context.user.onBehalfOfUser (plsCfg) stays — that is the one proven to matter
  // (2 vs 256 playlists); this header is belt-and-braces, same pending caveat.
  if (delegatedSessionId) headers['X-Goog-PageId'] = delegatedSessionId;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body: JSON.stringify({ context, ...body }),
      signal,
    });
  } catch (e) {
    // A cancellation the caller asked for is not a failure: rethrow the AbortError
    // untouched (no `kind`) so callers can tell it apart and stay quiet about it.
    if (signal?.aborted) throw e;
    // fetch() only rejects on a network-level failure (TypeError) — no HTTP response
    // at all. Offline is by far the likeliest cause; a blocking extension or a
    // dropped connection look identical from here, and are reported the same way.
    throw plsError('offline', `${path} -> network failure: ${e?.message ?? e}`, e);
  }
  if (!res.ok) {
    const kind = classifyHttp(res.status) ?? 'http';
    throw plsError(kind, `${path} -> ${res.status} ${res.statusText}`);
  }
  try {
    return await res.json();
  } catch (e) {
    // A 2xx whose body is not JSON is YouTube misbehaving, not the user.
    throw plsError('server', `${path} -> ${res.status} but the body was not JSON`, e);
  }
}

// ─────────────── classified errors ───────────────
// Every error that leaves this module's network calls carries `kind` (for code) and
// `userMessage` (for people). `message` stays the descriptive, path-and-status string
// the `[pls]` logs have always printed. The UI composes
//   "Couldn’t save to “X”. " + userMessage
// so each userMessage is one sentence ending in exactly one full stop.

/** @typedef {'offline'|'auth'|'rate'|'server'|'http'|'rejected'} PlsErrorKind */

/** @type {Record<PlsErrorKind, string>} */
export const PLS_USER_MESSAGES = {
  offline: 'You’re offline.',
  auth: 'You’re signed out of YouTube — sign in and try again.',
  rate: 'YouTube is rate-limiting requests — wait a moment.',
  server: 'YouTube had a problem — try again.',
  http: 'YouTube rejected the request.',
  rejected: 'YouTube rejected the change.',
};

/**
 * Build a classified error. Pure — exported for tests and for callers that want
 * to raise the same shape.
 * @param {PlsErrorKind} kind
 * @param {string} message  descriptive, for the console
 * @param {unknown} [cause]
 * @returns {Error & {kind: PlsErrorKind, userMessage: string}}
 */
export function plsError(kind, message, cause) {
  const err = /** @type {Error & {kind: PlsErrorKind, userMessage: string}} */ (
    new Error(message, cause === undefined ? undefined : { cause })
  );
  err.name = 'PlsError';
  err.kind = kind;
  err.userMessage = PLS_USER_MESSAGES[kind];
  return err;
}

/**
 * HTTP status -> error kind; null for a success status. Pure — exported for tests.
 * 401/403 are what an expired or missing SAPISIDHASH gets, so they read as
 * "signed out" — the one thing the user can actually fix.
 * @param {number} status
 * @returns {PlsErrorKind | null}
 */
export function classifyHttp(status) {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500 && status < 600) return 'server';
  return 'http';
}

// ─────────────── deep scans ───────────────
// Shapes are mid-migration (gridPlaylistRenderer vs lockupViewModel), so no fixed
// paths anywhere. Everything here walks and collects.

function plsText(t) {
  if (typeof t === 'string') return t;
  if (!t || typeof t !== 'object') return null;
  if (typeof t.content === 'string') return t.content;
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map((r) => r?.text ?? '').join('') || null;
  return null;
}

function plsFirstTitle(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const t = plsFirstTitle(v, depth + 1);
      if (t) return t;
    }
    return null;
  }
  if ('title' in node) {
    const t = plsText(node.title);
    if (t) return t;
  }
  for (const v of Object.values(node)) {
    const t = plsFirstTitle(v, depth + 1);
    if (t) return t;
  }
  return null;
}

// ─────────────── video counts ───────────────
// Where the count lives, per generation — read from the entry that owns the id,
// never from elsewhere in the response (the MrBeast capture's page header carries
// "978 videos" for the whole CHANNEL; a loose scan would pin that on a playlist):
//
//   gridPlaylistRenderer (legacy)  videoCountText    {runs: ["42", " videos"]}
//                                  videoCountShortText {simpleText: "42"}
//   lockupViewModel (current)      …thumbnailBadgeViewModel.text  "12 videos"
//
// Evidence: the REAL capture `real-channel-playlists-mrbeast.json` badges read
// "4 episodes", "9 episodes", "8 episodes", "9 episodes", "25 episodes" — a channel's
// podcast-style playlists say "episodes", not "videos", so both nouns are accepted.
// The legacy shape is only covered by the synthetic fixtures.
//
// Deliberately strict. Only English, only whole numbers: "1,234 videos", "1 video",
// "No videos", or a bare "42". Anything else — "1.234" (a German thousands separator,
// or a decimal?), "1,2K", "1 234", "12 vidéos", a "Mix" badge — is undefined. A
// missing count renders as nothing; a wrong one renders as a lie.

const PLS_COUNT_RE = /^(\d{1,3}(?:,\d{3})+|\d+)(?:\s+(?:videos?|episodes?))?$/i;
const PLS_NO_COUNT_RE = /^no\s+(?:videos|episodes)$/i;

/**
 * Parse a YouTube count label into an integer, or undefined when unsure.
 * Pure — exported for tests.
 * @param {unknown} label  a string or an InnerTube text object
 * @returns {number | undefined}
 */
export function parseVideoCount(label) {
  const text = plsText(label)?.replace(/\u00a0/g, ' ').trim();
  if (!text) return undefined;
  if (PLS_NO_COUNT_RE.test(text)) return 0;
  const m = text.match(PLS_COUNT_RE);
  if (!m) return undefined;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * The count carried by ONE playlist entry (the object owning the id), or undefined.
 * @param {any} entry
 * @returns {number | undefined}
 */
function plsEntryCount(entry) {
  for (const k of ['videoCountText', 'videoCountShortText']) {
    const n = parseVideoCount(entry[k]);
    if (n !== undefined) return n;
  }
  // Lockups can carry several badges; take the first that reads as a count.
  for (const b of scanKey(entry, 'thumbnailBadgeViewModel', [])) {
    const n = parseVideoCount(b?.text);
    if (n !== undefined) return n;
  }
  return undefined;
}

/**
 * @typedef {{title: string|null, count?: number}} PlsScanEntry
 */

/**
 * Collect `id -> {title, count?}` for every playlist mentioned anywhere in a browse
 * response. Pre-order: the outermost object that *directly* owns a playlist id wins,
 * so the renderer/viewModel claims it before its own nested watchEndpoint does.
 * A later mention may fill in a missing title or count, never overwrite one; `count`
 * is only present as a key when one was actually parsed.
 * Pure — exported for tests.
 * @param {any} node
 * @param {Map<string, PlsScanEntry>} out
 */
export function scanPlaylists(node, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const v of node) scanPlaylists(v, out);
    return out;
  }
  for (const k of ['playlistId', 'contentId']) {
    const v = node[k];
    if (typeof v !== 'string' || !PLS_ID_RE.test(v)) continue;
    const id = v.replace(/^VL/, '');
    const title = plsFirstTitle(node) || null;
    const count = plsEntryCount(node);
    const prev = out.get(id);
    if (!prev) {
      /** @type {PlsScanEntry} */
      const entry = { title };
      if (count !== undefined) entry.count = count;
      out.set(id, entry);
    } else {
      // Mutate in place: Map.set on an existing key would keep the order anyway,
      // but this makes "first mention fixes the position" obvious.
      if (title && !prev.title) prev.title = title;
      if (count !== undefined && prev.count === undefined) prev.count = count;
    }
    break;
  }
  for (const v of Object.values(node)) scanPlaylists(v, out);
  return out;
}

/**
 * Collect every value stored under `key`, at any depth.
 * @param {any} node
 * @param {string} key
 * @param {any[]} out
 */
export function scanKey(node, key, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const v of node) scanKey(v, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    scanKey(v, key, out);
  }
  return out;
}

// ─────────────── the calls ───────────────

// ─────────────── what a playlist entry actually carries ───────────────
// Checked before designing a "Recently updated" sort, and the answer is NO, so
// the finding is written down here rather than re-derived (and re-guessed) later.
//
// A playlist entry carries an id, a title, and a video count (parsed — see "video
// counts" above scanPlaylists). It does NOT carry a
// modified date, a created date, a publish time, or an "Updated …" string — not in
// either renderer generation:
//
//   gridPlaylistRenderer (legacy)  playlistId, title, videoCountText,
//                                  videoCountShortText, navigationEndpoint, shareUrl
//   lockupViewModel (current)      contentId, metadata.…title.content, a thumbnail
//                                  badge holding the count
//
// Evidence, not recollection: `tests/fixtures/innertube/real-channel-playlists-mrbeast.json`
// is a real capture, and its `contentMetadataViewModel` is EMPTY — `{delimiter: " • "}`
// with no metadataRows at all. The rendered DOM of the same page agrees: title and
// "N episodes", nothing else. `tests/innertube.test.mjs` pins this as an assertion, so
// the day YouTube starts shipping a timestamp the test goes red and the sort becomes
// buildable. Note the SYNTHETIC `lockup-view-model.json` fixture does contain an
// invented "Updated yesterday" row; the real capture is what disproves it, and
// designing against the synthetic one is exactly how a sort that lies gets shipped.
//
// The response ORDER is available — the Map below preserves it, so `fetchAllPlaylists`
// returns rows in the order the server sent them — but what that order MEANS has never
// been established. Same for `get_add_to_playlist`: it is widely assumed to be the 200
// most-recently-modified playlists, and `coverage.md` C8 records that as ❓ with a known
// counterexample. The sheet's Recent mode now uses this response order by request,
// with live verification waived for 2.0.1; it is an assumption, not timestamp data.

/**
 * Every playlist the user owns. NOT capped at 200 — that ceiling belongs to
 * `get_add_to_playlist`, the endpoint backing YouTube's own dialog.
 *
 * Returned in the server's own response order (`found` is a Map, and Maps iterate
 * in insertion order). Callers may rely on that being *stable*; they may not
 * rely on it *meaning* anything — see the note above.
 *
 * `count` is the entry's own video count when one could be parsed (see "video
 * counts" above) and ABSENT otherwise — never 0 as a stand-in for "unknown".
 *
 * @returns {Promise<Array<{id: string, title: string, count?: number}>>}
 */
export async function fetchAllPlaylists() {
  /** @type {Map<string, PlsScanEntry>} */
  const found = new Map();
  let data = await plsPost('browse', { browseId: 'FEplaylist_aggregation' });
  let page = 0;
  while (true) {
    page++;
    const before = found.size;
    scanPlaylists(data, found);
    const token = scanKey(data, 'continuationCommand', []).find((c) => c?.token)?.token;
    console.log(
      `[pls] page ${page}: +${found.size - before} new, running total ${found.size}, continuation ${token ? 'yes' : 'NO'}`
    );
    if (!token || page >= 60) break;
    if (found.size === before && page > 1) {
      console.warn('[pls] a page added nothing new — stopping');
      break;
    }
    data = await plsPost('browse', { continuation: token });
  }
  const list = [...found].map(([id, { title, count }]) => {
    /** @type {{id: string, title: string, count?: number}} */
    const row = { id, title: title || id };
    if (count !== undefined) row.count = count;
    return row;
  });
  const counted = list.filter((p) => p.count !== undefined).length;
  console.log(`[pls] fetched ${list.length} playlists in ${page} pages (${counted} with a video count)`);
  return list;
}

/**
 * Parse a `get_add_to_playlist` response into `playlistId -> contains`.
 * Deep walk collecting EVERY option renderer, not the first list we stumble on —
 * the response shape is mid-migration and paths are not stable. Taking the first
 * `listItems` array is one of the two mistakes that made this endpoint look dead.
 * Pure — exported for tests.
 * @param {any} data
 * @returns {Map<string, boolean>}
 */
export function parseMembership(data) {
  const map = new Map();
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    const o = n.playlistAddToOptionRenderer;
    if (o && typeof o.playlistId === 'string' && typeof o.containsSelectedVideos === 'string') {
      // With a single videoId the enum is only ever ALL or NONE. SOME is the
      // multi-video case, which we never ask for; treat it as "contains" anyway.
      map.set(o.playlistId, o.containsSelectedVideos !== 'NONE');
    }
    Object.values(n).forEach(walk);
  };
  walk(data);
  return map;
}

/**
 * "Which playlists already contain this video?" — one call, real per-playlist state.
 *
 *   POST /youtubei/v1/playlist/get_add_to_playlist   { videoIds: [videoId] }
 *   -> $.contents[0].addToPlaylistRenderer.playlists[] .playlistAddToOptionRenderer
 *        { playlistId, title.simpleText, privacy, containsSelectedVideos: "ALL"|"NONE" }
 *
 * ~230 KB, ~180 ms, 200 rows. Two traps that previously made this look like it
 * didn't work: `{videoId: id}` (singular) is a 400 — it must be `videoIds: [id]`
 * with exactly one id; and WITHOUT `context.user.onBehalfOfUser` a brand account
 * gets back exactly ONE row, Watch Later. plsCfg() injects the delegation; the
 * `map.size <= 1` warning below is the canary if that ever regresses.
 *
 * **The 200 is a hard server cap**, not a paging boundary: the same 200 ids come
 * back for every videoId, there is no continuation token, and maxResults/pageSize/
 * count/offset are all ignored. YouTube's own Save popover is built from the same
 * 200 and is equally blind past it. So entries are only ever SET for playlists the
 * server actually reported — an absent key means **unknown**, which content.js maps
 * to `undefined`, never to `false`. resolveMembershipTail() can settle the rest.
 *
 * @param {string} videoId
 * @returns {Promise<Map<string, boolean>>}
 */
export async function fetchMembership(videoId) {
  const data = await plsPost('playlist/get_add_to_playlist', { videoIds: [videoId] });
  const map = parseMembership(data);
  const known = [...map.values()].filter(Boolean).length;
  console.log(`[pls] membership: ${map.size} playlist(s) reported, ${known} contain ${videoId}`);
  if (map.size <= 1) {
    console.warn(
      '[pls] get_add_to_playlist reported <=1 playlist. On a brand account that means ' +
        'context.user.onBehalfOfUser is missing — check plsCfg()/DELEGATED_SESSION_ID.'
    );
  }
  return map;
}

/**
 * Optional second pass for accounts with >200 playlists, where fetchMembership
 * leaves a tail unknown. Pass the ids it did NOT report and this settles each one
 * by walking that playlist's own contents.
 *
 * Measured 2026-08-28: 56 unknown playlists -> 124 HTTP calls, ~9 s at concurrency
 * 6. Correct — it found the one true member the fast path could not see. Far too
 * slow for first paint, fine as a background refinement, and highly cacheable: the
 * tail is by definition the playlists the user rarely touches.
 *
 * `signal` cancels it (content.js aborts when the sheet closes, so a dismissed
 * sheet does not keep ~100 requests going). On abort: workers stop dequeuing,
 * in-flight walks stop before fetching their next page (and the in-flight fetch
 * itself is aborted), `onResolved` is never called again, and the promise RESOLVES
 * with whatever was settled before the abort — it never rejects for a cancel, and a
 * cancel is not logged as a failure.
 *
 * @param {string} videoId
 * @param {string[]} playlistIds
 * @param {(id: string, hit: boolean) => void} [onResolved]
 * @param {number} [concurrency=6]
 * @param {AbortSignal} [signal]
 */
export async function resolveMembershipTail(videoId, playlistIds, onResolved, concurrency = 6, signal) {
  const map = new Map();
  const queue = [...playlistIds];
  const opts = { signal };
  /** @returns {Promise<boolean | undefined>} undefined = aborted, unknown */
  const contains = async (playlistId) => {
    let data = await plsPost('browse', { browseId: 'VL' + playlistId }, opts);
    for (let page = 0; page < 12; page++) {
      if (scanKey(data, 'videoId', []).includes(videoId)) return true;
      const token = scanKey(data, 'continuationCommand', []).find((c) => c?.token)?.token;
      if (!token) return false;
      if (signal?.aborted) return undefined;
      data = await plsPost('browse', { continuation: token }, opts);
    }
    return false;
  };
  const worker = async () => {
    while (queue.length && !signal?.aborted) {
      const id = queue.shift();
      try {
        const hit = await contains(id);
        // Re-check after the await: a walk that finished just as the sheet closed
        // must not call back into UI that no longer exists.
        if (hit === undefined || signal?.aborted) return;
        map.set(id, hit);
        onResolved?.(id, hit);
      } catch (e) {
        if (signal?.aborted) return; // the AbortError we asked for — not a failure
        console.warn('[pls] tail check failed for', id, e); // stays unknown
      }
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(
    `[pls] tail: resolved ${map.size}/${playlistIds.length} in ${Date.now() - t0}ms` +
      (signal?.aborted ? ' (aborted)' : '')
  );
  return map;
}

/**
 * The video's human name, for the sheet's header.
 *
 * Uses `next` rather than `player`: both carry the title, but `player` is a
 * playback endpoint and playback is where PoToken/BotGuard lives. `next` is
 * not, and this is a label — it is not worth putting the one attested
 * bot-check surface in the path of every save.
 *
 * Deep-scans rather than indexing a path, like everything else here. Returns
 * null rather than throwing: a missing title costs the user a label, and the
 * caller must not let that take the sheet down.
 *
 * @param {string} videoId
 * @returns {Promise<string | null>}
 */
export async function fetchVideoTitle(videoId) {
  try {
    const data = await plsPost('next', { videoId });
    // videoPrimaryInfoRenderer is the watch-page heading; videoDetails is the
    // player-response shape. Prefer the first, accept either.
    const primary = scanKey(data, 'videoPrimaryInfoRenderer', []).find((r) => r && r.title);
    const fromPrimary = primary ? plsText(primary.title) : null;
    if (fromPrimary) return fromPrimary;
    const details = scanKey(data, 'videoDetails', []).find((d) => d && typeof d.title === 'string');
    return details ? details.title : null;
  } catch (e) {
    console.warn('[pls] could not fetch the video title (non-fatal)', e);
    return null;
  }
}

/**
 * @param {string} playlistId
 * @param {string} videoId
 */
export async function addVideo(playlistId, videoId) {
  const data = await plsPost('browse/edit_playlist', {
    playlistId,
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
  });
  console.log('[pls] add', playlistId, '->', data?.status ?? '(no status field)');
  if (data?.status && data.status !== 'STATUS_SUCCEEDED') {
    throw plsError('rejected', `edit_playlist add ${playlistId} -> ${data.status}`);
  }
  return data;
}

/**
 * Removal does NOT need `setVideoId`. This is lifted verbatim from the
 * `removeFromPlaylistServiceEndpoint` YouTube itself ships on every row of
 * get_add_to_playlist, so it is the client's own documented undo for addVideo.
 * @param {string} playlistId
 * @param {string} videoId
 */
export async function removeVideo(playlistId, videoId) {
  const data = await plsPost('browse/edit_playlist', {
    playlistId,
    actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }],
  });
  console.log('[pls] remove', playlistId, '->', data?.status ?? '(no status field)');
  if (data?.status && data.status !== 'STATUS_SUCCEEDED') {
    throw plsError('rejected', `edit_playlist remove ${playlistId} -> ${data.status}`);
  }
  return data;
}

/**
 * Extract playlistId from a playlist/create response.
 * Pure — exported for tests.
 * @param {any} data
 * @returns {string | null}
 */
export function parseCreateResponse(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.playlistId === 'string') return data.playlistId;
  const found = scanKey(data, 'playlistId', []).find((id) => typeof id === 'string');
  return found || null;
}

/**
 * Creates a new playlist, optionally saving the video in the same request.
 *
 *   POST /youtubei/v1/playlist/create { title, privacyStatus, videoIds: [videoId] }
 *   -> { playlistId: "PL..." }
 *
 * @param {string} title
 * @param {string} [privacyStatus='PRIVATE']
 * @param {string} [videoId]
 * @returns {Promise<{id: string, title: string}>}
 */
export async function createPlaylist(title, privacyStatus = 'PRIVATE', videoId) {
  // ponytail: defaults to PRIVATE; upgrade with privacy selector if requested
  const body = { title, privacyStatus };
  if (videoId) body.videoIds = [videoId];
  const data = await plsPost('playlist/create', body);
  console.log('[pls] create', title, '->', data?.playlistId ?? '(no playlistId)');
  const playlistId = parseCreateResponse(data);
  if (!playlistId) {
    const why = data?.status || data?.error?.message || 'no playlistId in response';
    throw plsError('rejected', `playlist/create "${title}" -> ${why}`);
  }
  return { id: playlistId, title };
}

