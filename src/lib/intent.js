// L1 — intent, the pure half: "is this observation a save request, and for which video?"
//
// Every function here is a total function over plain data — no chrome.*, no DOM, no
// network — which is the entire reason it lives in its own module. The service worker
// owns the side effects; this owns the decisions, so the decisions can be tested.
// tests/intent.test.mjs exercises it directly.
//
// ─── WHAT THE LIVE CAPTURE ACTUALLY SAYS (2026-08-28, client 2.20260828.01.00) ───
//
// Every save surface that has a native affordance fires exactly one request:
//     POST /youtubei/v1/get_panel   {panelId:"PAadd_to_playlist", params:"<protobuf>"}
// Verified on: watch page ⋯→Save, home feed ⋮, search results ⋮, watch sidebar ⋮,
// channel /videos ⋮, playlist-page row ⋮, subscriptions feed ⋮, history ⋮, library ⋮.
// `playlist/get_add_to_playlist` is never called by the page. `get_panel` itself is
// GENERIC — the "Ask" panel uses it too — so the URL alone is not a safe trigger and
// `panelId` is the gate. Firing on the URL is precisely how the 1.6.x extension ended
// up rendering itself inside unrelated menus.
//
// Two findings that broke the previous implementation, both fixed here:
//
//  1. **`params` is sometimes percent-encoded.** When the protobuf length makes the
//     base64 padded, YouTube ships `...OA%3D%3D`, and `atob` *throws* on `%`. The feed
//     hits this and the watch page does not — which is the entire reason "it worked on
//     watch but not the feed". Decoding percent-decodes first.
//
//  2. **A fixed-offset regex over the blob was luck.** The real layout is field 111 →
//     field 1 = videoId, with an optional trailing field 5 that differs by surface
//     (present on watch, absent on feed). We walk the protobuf properly and report
//     which field path the id came from, so drift shows up in the log instead of as a
//     silently wrong id.

/** A YouTube video id: exactly 11 chars of base64url. */
export const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** YouTube's own semantic name for the add-to-playlist panel. Our gate. */
export const ADD_TO_PLAYLIST_PANEL = 'PAadd_to_playlist';

// ───────────────────────── videoId from a URL ─────────────────────────
// The zero-DOM floor depends only on this: URL structure, nothing else.

/**
 * @param {unknown} url
 * @returns {string | null}
 */
export function videoIdFromUrl(url) {
  if (typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    const v = u.searchParams.get('v');
    if (v && VIDEO_ID.test(v)) return v;
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/);
    if (m) return m[1];
    if (/(^|\.)youtu\.be$/.test(u.hostname)) {
      const s = u.pathname.match(/^\/([A-Za-z0-9_-]{11})/);
      if (s) return s[1];
    }
  } catch {}
  return null;
}

// ───────────────────────── protobuf blob walking ─────────────────────────

/**
 * base64url, possibly percent-encoded, possibly unpadded -> bytes.
 * The percent-decode is the fix for the home-feed gap; see note 1 above.
 * Throws on garbage — callers treat a throw as "not a blob".
 * @param {string} s
 * @returns {Uint8Array}
 */
export function b64ToBytes(s) {
  let t = String(s);
  if (t.includes('%')) {
    try {
      t = decodeURIComponent(t);
    } catch {}
  }
  t = t.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Minimal protobuf reader: yields every length-delimited field with its field path.
 * We only care about wire type 2; varints/fixed widths are skipped, not decoded.
 * @param {Uint8Array} bytes
 * @param {string} prefix
 * @param {number} depth
 */
export function* protoFields(bytes, prefix = '', depth = 0) {
  if (depth > 6) return;
  let i = 0;
  while (i < bytes.length) {
    let tag = 0;
    let shift = 0;
    while (i < bytes.length) {
      const b = bytes[i++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
      if (shift > 28) return;
    }
    const field = tag >>> 3;
    const wire = tag & 7;
    const path = prefix + field;
    if (wire === 2) {
      let len = 0;
      let sh = 0;
      while (i < bytes.length) {
        const b = bytes[i++];
        len |= (b & 0x7f) << sh;
        sh += 7;
        if (!(b & 0x80)) break;
        if (sh > 28) return;
      }
      if (len < 0 || i + len > bytes.length) return;
      const sub = bytes.subarray(i, i + len);
      i += len;
      yield { path, bytes: sub };
      yield* protoFields(sub, path + '.', depth + 1);
    } else if (wire === 0) {
      while (i < bytes.length && bytes[i++] & 0x80);
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else return;
  }
}

/** @param {Uint8Array} b */
function ascii(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
  return s;
}

/**
 * Collect every plausible videoId inside a base64 protobuf blob, with its field path,
 * following one level of nested base64 (continuation tokens embed another token).
 * @param {string} b64
 * @param {number} depth
 * @returns {Array<{id: string, path: string}>}
 */
export function idsInBlob(b64, depth = 1) {
  /** @type {Array<{id: string, path: string}>} */
  const found = [];
  let bytes;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    return found;
  }
  for (const f of protoFields(bytes)) {
    const s = ascii(f.bytes);
    if (VIDEO_ID.test(s)) found.push({ id: s, path: f.path });
    else if (depth > 0 && f.bytes.length >= 12 && /^[A-Za-z0-9_%+/=-]+$/.test(s)) {
      for (const inner of idsInBlob(s, depth - 1)) found.push({ id: inner.id, path: f.path + '/' + inner.path });
    }
  }
  return found;
}

/**
 * Does this base64 protobuf blob mention `needle` anywhere, including one level of
 * nested base64? Used to recognise a restored/paginated add-to-playlist panel whose
 * name is buried in the continuation token rather than stated as `panelId`.
 * @param {string} b64
 * @param {string} needle
 * @param {number} depth
 */
export function blobMentions(b64, needle, depth = 1) {
  let bytes;
  try {
    bytes = b64ToBytes(b64);
  } catch {
    return false;
  }
  if (ascii(bytes).includes(needle)) return true;
  if (depth <= 0) return false;
  for (const f of protoFields(bytes)) {
    const s = ascii(f.bytes);
    if (f.bytes.length >= 12 && /^[A-Za-z0-9_%+/=-]+$/.test(s) && blobMentions(s, needle, depth - 1)) return true;
  }
  return false;
}

// ───────────────────────── the gate ─────────────────────────

/**
 * "Is this observation the user asking to save a video?" — semantic, not structural.
 * Returning false for the Ask/YouChat panel is correct behaviour, not a miss.
 * @param {unknown} path
 * @param {any} body
 */
export function isAddToPlaylist(path, body) {
  if (!body || typeof body !== 'object') return false;
  if (body.panelId === ADD_TO_PLAYLIST_PANEL) return true;
  if (typeof path === 'string' && path.includes('get_add_to_playlist')) return true;
  // Paginated / restored panels carry the panel name inside the continuation token.
  if (typeof body.continuation === 'string' && blobMentions(body.continuation, ADD_TO_PLAYLIST_PANEL)) return true;
  return false;
}

// ───────────────────────── one resolution path ─────────────────────────

/**
 * Ordered by how directly the source states the answer. Every step it tried is kept
 * so a failure can print the whole trail instead of "undefined".
 *
 * @param {any} body        the InnerTube request body (or {} for the zero-DOM floor)
 * @param {{linkUrl?: string, srcUrl?: string, tabUrl?: string}} ctx
 * @returns {{videoId: string | null, from: string | null, tried: string[], note?: string}}
 */
export function resolveVideoId(body = {}, ctx = {}) {
  /** @type {string[]} */
  const tried = [];

  if (typeof body.videoId === 'string' && VIDEO_ID.test(body.videoId)) {
    return { videoId: body.videoId, from: 'body.videoId', tried };
  }
  tried.push('body.videoId');

  if (Array.isArray(body.videoIds)) {
    const v = body.videoIds.find((x) => typeof x === 'string' && VIDEO_ID.test(x));
    if (v) return { videoId: v, from: 'body.videoIds[]', tried };
  }
  tried.push('body.videoIds[]');

  for (const key of ['params', 'continuation']) {
    if (typeof body[key] !== 'string') {
      tried.push(`body.${key} (absent)`);
      continue;
    }
    const hits = idsInBlob(body[key]);
    if (hits.length) {
      // 111.1 is where every surface put it on 2026-08-28. Prefer it, but do not
      // *require* it — and report which path won so drift is visible in the log.
      const best = hits.find((h) => h.path === '111.1') || hits[0];
      return {
        videoId: best.id,
        from: `body.${key}[field ${best.path}]`,
        tried,
        note: hits.length > 1 ? `${hits.length} candidates: ${hits.map((h) => `${h.path}=${h.id}`).join(', ')}` : undefined,
      };
    }
    tried.push(`body.${key} (${body[key].length} chars, no videoId-shaped field)`);
  }

  for (const [name, url] of [
    ['info.linkUrl', ctx.linkUrl],
    ['info.srcUrl', ctx.srcUrl],
    ['tab.url', ctx.tabUrl],
  ]) {
    const v = videoIdFromUrl(url);
    if (v) return { videoId: v, from: name, tried };
    tried.push(`${name} (${url ? 'no id in ' + url : 'absent'})`);
  }

  return { videoId: null, from: null, tried };
}
