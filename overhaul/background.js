// L1 — intent, part 2 of 2: resolution. ONE code path, four entrypoints, zero DOM.
//
// Every signal — wherever it came from — is normalised into a single call to
// `dispatchIntent()`. There is deliberately no per-surface branching anywhere in this
// file: "saving from the home feed" is not a case we handle, it is one of the things
// that happens to produce the same observation as everything else.
//
// ─── WHAT THE LIVE CAPTURE ACTUALLY SAYS (2026-08-28, client 2.20260828.01.00) ───
//
// Every save surface that has a native affordance fires exactly one request:
//     POST /youtubei/v1/get_panel   {panelId:"PAadd_to_playlist", params:"<protobuf>"}
// Verified on: watch page ⋯→Save, home feed ⋮, search results ⋮, watch sidebar ⋮,
// channel /videos ⋮, playlist-page row ⋮, subscriptions feed ⋮, history ⋮, library ⋮.
// `playlist/get_add_to_playlist` is never called by the page. `get_panel` itself is
// GENERIC — the "Ask" panel uses it too — so the URL alone is not a safe trigger and
// `panelId` is the gate.
//
// Three findings that broke the previous implementation, all fixed here:
//
//  1. **webRequest cannot read the body.** YouTube uploads a gzip *stream*, and Chrome
//     reports streamed uploads as `requestBody: {error:"Unknown error."}` with no
//     bytes. The old code did `if (!body) return;` — a silent no-op on 100% of saves.
//     Primary observation therefore moved to intent-hook.js (MAIN world); webRequest
//     stays as a secondary that fires only on the days Chrome hands us bytes, and
//     otherwise says so out loud.
//
//  2. **`params` is sometimes percent-encoded.** When the protobuf length makes the
//     base64 padded, YouTube ships `...OA%3D%3D`, and `atob` *throws* on `%`. The feed
//     hits this and the watch page does not — which is the entire reason "it worked on
//     watch but not the feed". Decoding now percent-decodes first.
//
//  3. **The old fixed-offset regex `\x0a\x0b(...)` was luck.** The real layout is
//     field 111 → field 1 = videoId, with an optional trailing field 5 that differs by
//     surface (present on watch, absent on feed). We now walk the protobuf properly and
//     say which field path the id came from, so drift shows up in the log instead of
//     as a wrong id.
//
// ─── SURFACES WITH NO NATIVE AFFORDANCE ───
// The Shorts player (`/shorts/<id>`) has no ⋮ and no Save in its action rail, and
// Shorts shelf items offer only queue/not-interested/report. There is nothing to
// observe because YouTube never makes the request. Those are covered by the zero-DOM
// floor below (toolbar icon, right-click, hotkey), exactly as ARCHITECTURE.md §L1
// intends: the DOM-adjacent path is an enhancement, the floor is the foundation.

const VERSION = 'intent-2026-08-28c';
const ADD_TO_PLAYLIST_PANEL = 'PAadd_to_playlist';
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const DEDUPE_MS = 1500;

const recent = new Map(); // `${tabId}:${videoId}` -> timestamp

// ───────────────────────── videoId sources ─────────────────────────

function videoIdFromUrl(url) {
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

// base64url, possibly percent-encoded, possibly unpadded -> bytes.
// The percent-decode is the fix for the home-feed gap; see note 2 above.
function b64ToBytes(s) {
  let t = String(s);
  if (t.includes('%')) {
    try {
      t = decodeURIComponent(t);
    } catch {}
  }
  t = t.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
  t += '='.repeat((4 - (t.length % 4)) % 4);
  const bin = atob(t); // throws on garbage; callers treat that as "not a blob"
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Minimal protobuf reader: yields every length-delimited field with its field path.
// We only care about wire type 2; varints/fixed are skipped, not decoded.
function* protoFields(bytes, prefix = '', depth = 0) {
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

function ascii(b) {
  let s = '';
  for (let i = 0; i < b.length; i += 4096) s += String.fromCharCode(...b.subarray(i, i + 4096));
  return s;
}

// Collect every plausible videoId inside a base64 protobuf blob, with its field path,
// following one level of nested-base64 (continuation tokens embed another token).
function idsInBlob(b64, depth = 1) {
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

function blobMentions(b64, needle, depth = 1) {
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
// "Is this observation the user asking to save a video?" — semantic, not structural.
function isAddToPlaylist(path, body) {
  if (!body || typeof body !== 'object') return false;
  if (body.panelId === ADD_TO_PLAYLIST_PANEL) return true;
  if (typeof path === 'string' && path.includes('get_add_to_playlist')) return true;
  // Paginated / restored panels carry the panel name inside the continuation token.
  if (typeof body.continuation === 'string' && blobMentions(body.continuation, ADD_TO_PLAYLIST_PANEL)) return true;
  return false;
}

// ───────────────────────── one resolution path ─────────────────────────
// Ordered by how directly the source states the answer. Every step it tried is kept so
// a failure can print the whole trail instead of "undefined".
function resolveVideoId(body = {}, ctx = {}) {
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

async function dispatchIntent({ tabId, source, path, body = {}, linkUrl, srcUrl, tabUrl }) {
  if (typeof tabId !== 'number' || tabId < 0) {
    console.warn('[pls][sw] intent with no tab to deliver it to', { source });
    return;
  }
  if (tabUrl === undefined) {
    tabUrl = (await chrome.tabs.get(tabId).catch(() => null))?.url;
  }

  const r = resolveVideoId(body, { linkUrl, srcUrl, tabUrl });

  if (!r.videoId) {
    // LOUD. This is the failure mode we are escaping: a gap must never be silent.
    console.error(
      `[pls][sw] INTENT DROPPED — recognised a save intent (source=${source}) but could ` +
        `not resolve a videoId from any source. This is a coverage gap; the trail is below.`,
      { path, source, tabUrl, linkUrl, srcUrl, bodyKeys: Object.keys(body), body, tried: r.tried }
    );
    return;
  }

  const key = `${tabId}:${r.videoId}`;
  const now = Date.now();
  const prev = recent.get(key);
  if (prev && now - prev < DEDUPE_MS) {
    console.log(`[pls][sw] duplicate intent within ${now - prev}ms, ignoring`, { source, videoId: r.videoId });
    return;
  }
  recent.set(key, now);
  for (const [k, t] of recent) if (now - t > 10 * DEDUPE_MS) recent.delete(k);

  console.log(`[pls][sw] SAVE_INTENT ${r.videoId} — source=${source}, videoId from ${r.from}${r.note ? ' — ' + r.note : ''}`);
  chrome.tabs
    .sendMessage(tabId, { type: 'SAVE_INTENT', videoId: r.videoId, source })
    .catch((e) =>
      console.warn(
        `[pls][sw] resolved ${r.videoId} but the tab has no content script to receive it ` +
          `(reload the tab if the extension was just installed/updated) — ${e.message}`
      )
    );
}

// ═══════════════ entrypoint 1: the MAIN-world hook, relayed by content.js ═══════════
// Primary. This is the only path that reliably sees the request body today.

const hookedTabs = new Set();
chrome.tabs.onRemoved.addListener((id) => hookedTabs.delete(id));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === 'HOOK_READY') {
    hookedTabs.add(sender.tab?.id);
    return;
  }
  if (msg?.type !== 'PANEL_REQUEST') return;
  const tabId = sender.tab?.id;
  if (!isAddToPlaylist(msg.path, msg.body)) {
    // get_panel is generic — the Ask/YouChat panel uses it too. Rejecting these is
    // correct behaviour, not a miss, so it stays quiet at log level.
    console.log('[pls][sw] panel request seen but it is not add-to-playlist, ignoring', {
      path: msg.path,
      panelId: msg.body?.panelId ?? '(none)',
    });
    return;
  }
  dispatchIntent({ tabId, source: 'hook', path: msg.path, body: msg.body, tabUrl: sender.tab?.url });
});

// ═══════════════ entrypoint 2: webRequest — secondary, and honest about it ═════════
// Kept because it needs no page-world code and would survive a CSP change that killed
// the hook. As of 2026-08-28 Chrome gives us no body for these requests, so on its own
// it can only tell us *that* a panel was fetched, never *which* one — and firing blind
// on a generic endpoint is precisely how the old extension ended up rendering itself
// inside unrelated menus. So: fire when there are bytes, complain when there are not.

let unreadableCount = 0;

chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.method !== 'POST' || d.tabId < 0) return;

    const rb = d.requestBody;
    const bytes = rb?.raw?.[0]?.bytes;
    if (!bytes) {
      unreadableCount++;
      if (unreadableCount === 1 || unreadableCount % 25 === 0) {
        console.warn(
          `[pls][sw] webRequest delivered no body for ${d.url.split('?')[0]} ` +
            `(requestBody=${rb ? JSON.stringify(Object.keys(rb)) : 'undefined'}` +
            `${rb?.error ? ' error=' + rb.error : ''}). Chrome cannot read YouTube's ` +
            `streamed gzip uploads. The MAIN-world hook is the live path; this listener ` +
            `is a fallback only. Count so far: ${unreadableCount}.` +
            (hookedTabs.has(d.tabId) ? '' : ' NOTE: no hook has reported from this tab — if saves do nothing, that is why.')
        );
      }
      return;
    }

    (async () => {
      let body;
      try {
        const head = new Uint8Array(bytes.slice(0, 2));
        const text =
          head[0] === 0x1f && head[1] === 0x8b
            ? await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
            : new TextDecoder().decode(new Uint8Array(bytes));
        body = JSON.parse(text);
      } catch (e) {
        console.warn('[pls][sw] webRequest body present but unparseable', e.message);
        return;
      }
      let path = d.url;
      try {
        path = new URL(d.url).pathname;
      } catch {}
      if (!isAddToPlaylist(path, body)) return;
      dispatchIntent({ tabId: d.tabId, source: 'webrequest', path, body });
    })();
  },
  // Only `get_panel`. `playlist/get_add_to_playlist` is deliberately NOT watched here:
  // YouTube's page never calls it, but *we* do (membership hints), and watching it made
  // the extension trigger itself in a loop. The MAIN-world hook still watches it, and
  // is structurally immune — our own calls run in the isolated world.
  { urls: ['https://www.youtube.com/youtubei/v1/get_panel*'] },
  ['requestBody']
);

// ═══════════════ entrypoints 3–5: the zero-DOM floor ══════════════════════════════
// URL structure only. These must keep working if YouTube changes everything, and they
// are the *only* coverage for Shorts, which has no native save affordance at all.

chrome.action.onClicked.addListener((tab) => {
  dispatchIntent({ tabId: tab.id, source: 'toolbar', tabUrl: tab.url });
});

const MENU_ID = 'pls-save-here';

function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: 'Save to playlist (search all playlists)',
        contexts: ['link', 'video', 'page'],
        documentUrlPatterns: ['https://www.youtube.com/*'],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn('[pls][sw] context-menu entrypoint NOT installed —', err.message);
        else console.log('[pls][sw] context-menu entrypoint installed');
      }
    );
  });
}
chrome.runtime.onInstalled.addListener(installMenu);
chrome.runtime.onStartup.addListener(installMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  dispatchIntent({
    tabId: tab?.id,
    source: 'context-menu',
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    tabUrl: info.pageUrl ?? tab?.url,
  });
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-save-sheet') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  dispatchIntent({ tabId: tab.id, source: 'hotkey', tabUrl: tab.url });
});

console.log(`[pls][sw] ${VERSION} — listeners registered (hook + webRequest + toolbar + context menu + hotkey)`);
