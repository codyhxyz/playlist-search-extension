// L2 — data. Hand-rolled InnerTube client, first-party, from the ISOLATED world.
// Content scripts can't use ES imports, so everything here is a plain global.

const PLS_ORIGIN = 'https://www.youtube.com';
const PLS_FALLBACK_CTX = {
  client: { clientName: 'WEB', clientVersion: '2.20260801.00.00', hl: 'en', gl: 'US' },
};
const PLS_ID_RE = /^(VL)?(PL|LL|WL|FL|RD|UU|OL)/;

let plsCfgCache = null;

// --- context: ytcfg lives in the MAIN world, so scrape the JSON out of the page's own script text.
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

function plsCfgFrom(text) {
  if (!text || !text.includes('INNERTUBE_CONTEXT')) return null;
  // tolerate quoted and unquoted keys; the trailing ':{' is what rules out
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
      // only Liked+Watch Later instead of the user's real playlists.
      // Verified 2026-08-28: 2 playlists without it, 256 with it.
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
  for (const s of document.scripts) if ((hit = plsCfgFrom(s.textContent))) break;
  // last resort: the whole serialized document (slow, so only if the scripts miss)
  if (!hit && (hit = plsCfgFrom(document.documentElement.innerHTML))) how = 'scraped-from-innerHTML';
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

async function plsAuth() {
  const sapisid =
    document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ??
    document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
  if (!sapisid) throw new Error('no SAPISID cookie — signed out?');
  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${ts} ${sapisid} ${PLS_ORIGIN}`)
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `SAPISIDHASH ${ts}_${hex}`;
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

// --- deep scans. Shapes are mid-migration (gridPlaylistRenderer vs lockupViewModel) so no paths.
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

// pre-order: the outermost object that *directly* owns a playlist id wins, so the
// renderer/viewModel claims it before its own nested watchEndpoint does.
function plsScanPlaylists(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const v of node) plsScanPlaylists(v, out);
    return;
  }
  for (const k of ['playlistId', 'contentId']) {
    const v = node[k];
    if (typeof v !== 'string' || !PLS_ID_RE.test(v)) continue;
    const id = v.replace(/^VL/, '');
    const title = plsFirstTitle(node);
    if (!out.has(id) || (title && !out.get(id))) out.set(id, title || null);
    break;
  }
  for (const v of Object.values(node)) plsScanPlaylists(v, out);
}

function plsScanKey(node, key, out) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const v of node) plsScanKey(v, key, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === key) out.push(v);
    plsScanKey(v, key, out);
  }
  return out;
}

// --- the three calls
async function plsFetchAllPlaylists() {
  const found = new Map(); // id -> title|null
  let data = await plsPost('browse', { browseId: 'FEplaylist_aggregation' });
  let page = 0;
  window.__plsFirstPage = data; // for eyeballing if the count looks wrong
  while (true) {
    page++;
    const before = found.size;
    plsScanPlaylists(data, found);
    const token = plsScanKey(data, 'continuationCommand', []).find((c) => c?.token)?.token;
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

// "Which playlists already contain this video?"
//
// There IS a bulk membership endpoint. VERIFIED LIVE 2026-08-28 against a
// 256-playlist brand account:
//
//   POST /youtubei/v1/playlist/get_add_to_playlist   { videoIds: [videoId] }
//   -> $.contents[0].addToPlaylistRenderer.playlists[] .playlistAddToOptionRenderer
//        { playlistId, title.simpleText, privacy, containsSelectedVideos: "ALL"|"NONE" }
//
// One call, ~230 KB, ~200 ms, 200 rows, real per-playlist state. Confirmed with a
// true positive: a video in two playlists came back "ALL" for exactly those two.
//
// Two traps that previously made this look like it didn't work:
//   1. `{ videoId: id }` (singular) is rejected with 400. It must be `videoIds: [id]`,
//      and the array must hold exactly one id — two ids is also a 400.
//   2. WITHOUT `context.user.onBehalfOfUser` a brand account gets back exactly ONE
//      row, Watch Later. That is the delegation bug, not an API limit. plsCfg()
//      already injects the delegation; if it ever regresses, this call is the
//      canary — see the map.size warning below.
//
// The hard limit is 200. The server returns the 200 most-recently-modified
// addable playlists, the same fixed set for every videoId, with no continuation
// and no param that widens it (fuzzed: maxResults/pageSize/count/offset/
// continuation, every get_panel params protobuf field, and the MWEB/TVHTML5/
// WEB_REMIX clients — all 200 or fewer). YouTube's own Save popover is built from
// the same 200 and is equally blind past it: with a video whose only playlist was
// outside the window, YouTube's own client rendered every row unchecked.
// So for accounts over 200 playlists the tail is genuinely unknown here — hence
// entries are only ever SET for playlists the server actually reported. Absent
// key means "unknown", which content.js maps to `undefined`, never to `false`.
// plsResolveMembershipTail() below can settle that tail if a caller wants it.
async function plsFetchMembership(videoId) {
  const data = await plsPost('playlist/get_add_to_playlist', { videoIds: [videoId] });
  const map = new Map();
  // Deep walk collecting EVERY option renderer, not the first list we stumble on —
  // the response shape is mid-migration and paths are not stable.
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

// Optional second pass for accounts with >200 playlists, where plsFetchMembership
// leaves a tail unknown. Pass the ids it did NOT report (from plsFetchAllPlaylists
// minus the membership map's keys) and this settles each one by walking that
// playlist's own contents.
//
// Measured 2026-08-28: 56 unknown playlists -> 124 HTTP calls, 9.1 s at
// concurrency 6 (~162 ms per playlist). Correct — it found the one true member
// that get_add_to_playlist could not see. Far too slow for first paint, fine as a
// background refinement, and the result is cacheable: the tail is by definition
// the playlists the user rarely touches.
//
// NOT wired into the save flow. Deliberately opt-in.
async function plsResolveMembershipTail(videoId, playlistIds, onResolved, concurrency = 6) {
  const map = new Map();
  const queue = [...playlistIds];
  const contains = async (playlistId) => {
    let data = await plsPost('browse', { browseId: 'VL' + playlistId });
    for (let page = 0; page < 12; page++) {
      if (plsScanKey(data, 'videoId', []).includes(videoId)) return true;
      const token = plsScanKey(data, 'continuationCommand', []).find((c) => c?.token)?.token;
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

async function plsAddVideo(playlistId, videoId) {
  const data = await plsPost('browse/edit_playlist', {
    playlistId,
    actions: [{ action: 'ACTION_ADD_VIDEO', addedVideoId: videoId }],
  });
  console.log('[pls] add', playlistId, '->', data?.status ?? '(no status field)', data);
  if (data?.status && data.status !== 'STATUS_SUCCEEDED') throw new Error(data.status);
  return data;
}

// Removal does NOT need setVideoId. This is lifted verbatim from the
// `removeFromPlaylistServiceEndpoint` YouTube itself ships on every row of
// get_add_to_playlist, so it is the client's own documented undo for plsAddVideo.
// Shape is authoritative; not round-tripped in this session (read-only run).
async function plsRemoveVideo(playlistId, videoId) {
  const data = await plsPost('browse/edit_playlist', {
    playlistId,
    actions: [{ action: 'ACTION_REMOVE_VIDEO_BY_VIDEO_ID', removedVideoId: videoId }],
  });
  console.log('[pls] remove', playlistId, '->', data?.status ?? '(no status field)', data);
  if (data?.status && data.status !== 'STATUS_SUCCEEDED') throw new Error(data.status);
  return data;
}
