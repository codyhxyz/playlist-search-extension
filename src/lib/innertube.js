// L2 — data. Hand-rolled InnerTube client, first-party, from the ISOLATED world.
//
// We run inside a content script on www.youtube.com, so we are same-origin: no CORS,
// no proxy, no backend, cookies attach automatically. Three endpoints, small enough to
// read in one sitting — which is also the CWS review story.
//
// The parsing functions (cfgFrom / scanPlaylists / parseMembership) are pure and
// exported separately from the calls that use them, so tests/innertube.test.mjs can
// pin the response shapes without a network or a browser.
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
 * Extract the InnerTube context + api key + brand delegation from a script body.
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
  const { context, apiKey, delegatedSessionId } =
    hit ?? { context: PLS_FALLBACK_CTX, apiKey: null, delegatedSessionId: null };
  if (!hit) how = 'HARDCODED FALLBACK — regex is broken, look at this';

  // Acting as a brand channel: the delegation must be stated explicitly.
  if (delegatedSessionId) {
    context.user = { ...(context.user ?? {}), onBehalfOfUser: delegatedSessionId };
  }

  console.log(`[pls] innertube context: ${how}`, {
    clientVersion: context.client?.clientVersion,
    apiKey: apiKey ? 'found' : 'none',
    delegatedTo: delegatedSessionId ?? 'none (personal account)',
  });
  plsCfgCache = { context, apiKey };
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
  if (!value) throw new Error('no SAPISID cookie — signed out?');
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${ts} ${value} ${PLS_ORIGIN}`)
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${scheme} ${ts}_${hex}`;
}

async function plsPost(path, body) {
  const { context, apiKey } = plsCfg();
  const url =
    `${PLS_ORIGIN}/youtubei/v1/${path}?prettyPrint=false` + (apiKey ? `&key=${apiKey}` : '');
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      Authorization: await plsAuth(),
      'X-Origin': PLS_ORIGIN,
    },
    body: JSON.stringify({ context, ...body }),
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${res.statusText}`);
  return res.json();
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

/**
 * Collect `id -> title` for every playlist mentioned anywhere in a browse response.
 * Pre-order: the outermost object that *directly* owns a playlist id wins, so the
 * renderer/viewModel claims it before its own nested watchEndpoint does.
 * Pure — exported for tests.
 * @param {any} node
 * @param {Map<string, string|null>} out
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
    const title = plsFirstTitle(node);
    if (!out.has(id) || (title && !out.get(id))) out.set(id, title || null);
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

/**
 * Every playlist the user owns. NOT capped at 200 — that ceiling belongs to
 * `get_add_to_playlist`, the endpoint backing YouTube's own dialog.
 * @returns {Promise<Array<{id: string, title: string}>>}
 */
export async function fetchAllPlaylists() {
  /** @type {Map<string, string|null>} */
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
  const list = [...found].map(([id, title]) => ({ id, title: title || id }));
  console.log(`[pls] fetched ${list.length} playlists in ${page} pages`);
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
 * @param {string} videoId
 * @param {string[]} playlistIds
 * @param {(id: string, hit: boolean) => void} [onResolved]
 * @param {number} concurrency
 */
export async function resolveMembershipTail(videoId, playlistIds, onResolved, concurrency = 6) {
  const map = new Map();
  const queue = [...playlistIds];
  const contains = async (playlistId) => {
    let data = await plsPost('browse', { browseId: 'VL' + playlistId });
    for (let page = 0; page < 12; page++) {
      if (scanKey(data, 'videoId', []).includes(videoId)) return true;
      const token = scanKey(data, 'continuationCommand', []).find((c) => c?.token)?.token;
      if (!token) return false;
      data = await plsPost('browse', { continuation: token });
    }
    return false;
  };
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const hit = await contains(id);
        map.set(id, hit);
        onResolved?.(id, hit);
      } catch (e) {
        console.warn('[pls] tail check failed for', id, e); // stays unknown
      }
    }
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log(`[pls] tail: resolved ${map.size}/${playlistIds.length} in ${Date.now() - t0}ms`);
  return map;
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
  if (data?.status && data.status !== 'STATUS_SUCCEEDED') throw new Error(data.status);
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
  if (data?.status && data.status !== 'STATUS_SUCCEEDED') throw new Error(data.status);
  return data;
}
