// L3 — session. Created on intent, destroyed on close, nothing survives.
// Also the isolated-world half of L1: it relays what intent-hook.js sees in the MAIN
// world to the service worker, which owns the single intent-resolution path.
//
// This is the esbuild entry point. Chrome injects src/content.bundle.js, not this
// file — see esbuild.config.mjs.

import { createSheet } from './lib/sheet.js';
import {
  accountKey,
  addVideo,
  removeVideo,
  createPlaylist,
  fetchAllPlaylists,
  fetchPicker,
  fetchVideoTitle,
  orderLikePicker,
  resetConfigCache,
  resolveMembershipTail,
  saveTargets,
} from './lib/innertube.js';

// The open sheet and the video it was opened for, or null. One slot, so the two can
// never disagree about which sheet is current.
/** @type {{ sheet: ReturnType<typeof createSheet>, videoId: string | null } | null} */
let plsCurrent = null;
// Two display preferences, remembered across page loads: the sort order and the
// privacy new playlists are created with. They are the only things this extension
// writes to disk — two enum strings, no playlist ids, titles or queries — and
// PRIVACY.md lists them by name. (The library cache below lives in memory only.)
// Read once at startup; a sheet opened in the few milliseconds before the read
// lands just gets the defaults.
const PLS_PREFS_KEY = 'plsPrefs';
/** @type {{sort?: string, privacy?: string}} */
let plsPrefs = {};
// Guarded, because this runs at module scope: a throw here would take the whole
// content script down with it, and a preference is not worth a dead extension.
try {
  chrome.storage.local.get(PLS_PREFS_KEY)
    .then((r) => { plsPrefs = { ...r?.[PLS_PREFS_KEY], ...plsPrefs }; })
    .catch((e) => console.warn('[pls] could not read preferences (using defaults)', e));
} catch (e) {
  console.warn('[pls] chrome.storage unavailable — preferences will not persist', e);
}

function plsSavePref(key, value) {
  plsPrefs = { ...plsPrefs, [key]: value };
  try {
    chrome.storage.local.set({ [PLS_PREFS_KEY]: plsPrefs })
      .catch((e) => console.warn('[pls] could not save preference', key, e));
  } catch (e) {
    console.warn('[pls] could not save preference', key, e);
  }
}

// ─────────────── the library cache ───────────────
// The sheet opens on the last library this account loaded and refreshes it in the
// background — a picker used a dozen times a day must not make you watch a
// spinner every time. Fetching everything costs ~800 ms on 256 playlists; this
// costs one in-memory read.
//
// Held in `chrome.storage.session`, which is RAM-only and cleared when the browser
// quits, so a new tab gets it instantly too; mirrored in a variable for this tab.
// One account at a time, keyed by accountKey() so a list is never shown to a
// different identity. What it holds is the library as fetched (titles, counts,
// thumbnails) and YouTube's picker ORDER (ids and titles) — never per-video
// membership, which is fetched fresh on every open because it is the one thing
// that must not be stale: it decides whether a row can add.
const PLS_LIB_KEY = 'plsLibrary';
/** @typedef {{account: string, library: any[], picker: Array<{id: string, title: string | null}>}} PlsCache */
/** @type {PlsCache | null} */
let plsMem = null;

/** @param {string | null} account @returns {Promise<PlsCache | null>} */
async function plsCacheRead(account) {
  if (!account) return null;
  if (plsMem?.account === account) return plsMem;
  try {
    const c = (await chrome.storage.session.get(PLS_LIB_KEY))?.[PLS_LIB_KEY];
    if (c?.account === account && Array.isArray(c.library) && Array.isArray(c.picker)) return (plsMem = c);
  } catch (e) {
    console.warn('[pls] library cache unreadable (loading fresh)', e);
  }
  return null;
}

/** @param {PlsCache} c */
function plsCacheWrite(c) {
  plsMem = c;
  try {
    chrome.storage.session.set({ [PLS_LIB_KEY]: c })
      .catch((e) => console.warn('[pls] could not cache the library', e));
  } catch (e) {
    console.warn('[pls] could not cache the library', e);
  }
}

/**
 * After a save, move that playlist to the front of the cached order, keeping Watch
 * Later first if it was first — so "recently used" holds on the very next open.
 * This ASSUMES YouTube's picker ranks by recent use with Watch Later pinned; that
 * is the common reading and is NOT verified here. It is only a placeholder: every
 * open fetches YouTube's real order and replaces this with it.
 * @param {string | null} account
 * @param {{id: string, title?: string}} p
 * @param {any} [created]  a playlist made just now, to add to the library too
 */
function plsCacheTouch(account, p, created) {
  if (!account || plsMem?.account !== account) return;
  const picker = plsMem.picker.filter((r) => r.id !== p.id);
  const at = picker[0]?.id === 'WL' && p.id !== 'WL' ? 1 : 0;
  picker.splice(at, 0, { id: p.id, title: p.title ?? null });
  const library = created ? [created, ...plsMem.library.filter((x) => x.id !== p.id)] : plsMem.library;
  plsCacheWrite({ account, library, picker });
}

// ─────────────── L1 relay: MAIN world -> service worker ───────────────
// intent-hook.js cannot use chrome.* APIs, and the service worker cannot see page
// requests. This is the three-line bridge between them. It forwards only the tiny
// routing fields the hook extracted — never YouTube's `context` blob.
//
// The hook runs in the MAIN world, so the page can see it and could in principle
// forge these messages. That is why the bridge carries no authority: the worst a
// forged message can do is open our own sheet for a video id of the page's choosing,
// which the page could equally achieve by navigating. Nothing here is trusted with
// more than "a save was requested".
let plsHookAlive = false;

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.__pls === 'hook-ready') {
    plsHookAlive = true;
    chrome.runtime.sendMessage({ type: 'HOOK_READY' }).catch(() => {});
    return;
  }
  if (e.data?.__pls !== 'panel-request') return;
  chrome.runtime
    .sendMessage({ type: 'PANEL_REQUEST', path: e.data.path, body: e.data.body })
    .catch((err) => console.warn('[pls] could not relay panel request to the service worker', err.message));
});

// Prove the MAIN-world observer is actually there. It is the only path that can read
// YouTube's request bodies, so if it is missing, every native Save button is dead and
// only the toolbar/right-click/hotkey floor works — the user deserves to be told.
window.postMessage({ __pls: 'hook-ping' }, location.origin);
setTimeout(() => {
  if (plsHookAlive) return;
  console.error(
    '[pls] the MAIN-world intent hook did not answer. Clicking YouTube’s Save button ' +
      'will do nothing — use the toolbar icon, the right-click menu, or Alt+S. ' +
      '(Check that intent-hook.js is still registered as a world:"MAIN" content script.)'
  );
}, 3000);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'SAVE_INTENT') plsHandleIntent(msg.videoId, msg.source);
  if (msg?.type === 'FIND_INTENT') plsHandleIntent(null, msg.source);
  // no async response; don't return true
});

// ─────────────── SPA navigation ───────────────
// youtube.com never reloads: feed -> watch -> feed is all client-side. The content
// script survives that, but a sheet opened for the *previous* video must not. Before
// this, an open sheet outlived the navigation and its `plsCurrent` guard then swallowed
// every subsequent intent — the classic "I had to reload the page" bug.
//
// This is an event listener on `document`, not a query against YouTube's markup: no
// selectors, no MutationObserver, nothing read out of their tree. If YouTube ever stops
// firing the event, the href check below still catches the change on the next intent.
let plsHref = location.href;

function plsOnNavigation(reason) {
  if (location.href === plsHref) return; // yt-navigate-finish also fires on no-op navs
  plsHref = location.href;
  console.log(`[pls] ${reason} -> ${location.pathname}${location.search} (no reload; content script still live)`);
  // The InnerTube config caches the brand-channel delegation on first use. Switching
  // accounts is a client-side navigation, so without this the session keeps acting as
  // the channel it started on and silently lists the wrong library.
  resetConfigCache();
  if (plsCurrent) {
    console.log(`[pls] ${reason}: destroying the sheet for ${plsCurrent.videoId}, it belonged to the previous page`);
    plsDestroyCurrent();
  }
}

// destroy() fires the sheet's onClose exactly once, and onClose is what aborts the
// membership tail — so tearing the sheet down is the whole job.
function plsDestroyCurrent() {
  const s = plsCurrent?.sheet;
  plsCurrent = null;
  if (!s) return;
  try {
    s.destroy();
  } catch (e) {
    console.warn('[pls] sheet.destroy() threw', e);
  }
}

document.addEventListener('yt-navigate-finish', () => plsOnNavigation('SPA navigation'));
window.addEventListener('popstate', () => plsOnNavigation('history navigation'));

/**
 * One path for both jobs. With a videoId it is the Save sheet; with null it is the
 * finder — the same sheet, the same cache and ordering, but a row opens its
 * playlist instead of taking the video.
 * @param {string | null} videoId
 * @param {string} source
 */
async function plsHandleIntent(videoId, source) {
  // Catch up on any navigation whose event we missed before deciding what's stale.
  plsOnNavigation('late-detected navigation');

  if (plsCurrent?.sheet.dead) {
    // The sheet closed without telling us. Don't let a corpse block every future save.
    console.warn('[pls] previous sheet was dead but still referenced — clearing');
    plsDestroyCurrent();
  }
  if (plsCurrent) {
    if (plsCurrent.videoId === videoId) {
      console.log('[pls] sheet already open for this, ignoring duplicate intent', { videoId, source });
      return;
    }
    // Something else: replace rather than silently drop. Dropping is how a user
    // ends up clicking Save and getting nothing.
    console.log(`[pls] intent for ${videoId ?? 'the finder'} while ${plsCurrent.videoId ?? 'the finder'} was open — replacing`);
    plsDestroyCurrent();
  }

  const finding = !videoId;
  console.log(`[pls] ${finding ? 'FIND_INTENT' : `SAVE_INTENT ${videoId}`} via ${source}`);
  const account = accountKey();

  // Aborts the >200 membership walk below. That walk can be a hundred-odd requests;
  // a closed sheet must not keep spending them, so onClose — which every teardown
  // path reaches, including plsDestroyCurrent() — aborts it.
  const tail = new AbortController();

  // Started before the sheet exists: membership (~180 ms) decides whether a row can
  // add, so it has the head start. The finder has no video and needs none of it.
  /** @type {Promise<Array<{id: string, title: string | null, member: boolean}> | null>} */
  const pickerP = finding
    ? Promise.resolve(null)
    : fetchPicker(videoId).catch((e) => {
      console.warn('[pls] membership hints failed (non-fatal)', e);
      return null;
    });

  const openUrl = (p) => `https://www.youtube.com/playlist?list=${encodeURIComponent(p.id)}`;
  const sheet = createSheet({
    videoId: videoId ?? undefined,
    sort: plsPrefs.sort,
    onSort: (mode) => plsSavePref('sort', mode),
    privacy: plsPrefs.privacy,
    onPrivacy: (privacy) => plsSavePref('privacy', privacy),
    onPick: finding ? undefined : async (p) => {
      // A row drawn from the cache before membership landed has `member`
      // undefined. If YouTube says the video is already there, adding would put
      // it in twice (YouTube allows duplicates), so don't.
      if (p.member === undefined && (await pickerP)?.find((r) => r.id === p.id)?.member) {
        return { already: true };
      }
      const r = await addVideo(p.id, videoId);
      plsCacheTouch(account, p);
      return r;
    },
    onRemove: (p) => removeVideo(p.id, videoId),
    onCreate: async (title, privacy) => {
      const made = await createPlaylist(title, privacy || 'PRIVATE', videoId);
      plsCacheTouch(account, made, { id: made.id, title: made.title });
      return made;
    },
    // Ctrl/⌘/middle-click open a new tab, like any link, and the sheet stays open
    // for the next save. A finder's plain pick goes there in this tab.
    onOpen: (p, newTab) => {
      if (newTab) window.open(openUrl(p), '_blank', 'noopener');
      else location.assign(openUrl(p));
    },
    onClose: () => {
      tail.abort();
      if (plsCurrent?.sheet === sheet) plsCurrent = null;
      console.log('[pls] sheet destroyed');
    },
  });
  plsCurrent = { sheet, videoId };

  if (!finding) {
    // Deliberately NOT awaited: the sheet is already on screen and typing must
    // work immediately. The name arrives when it arrives, and if it never does
    // the header simply stays empty.
    fetchVideoTitle(videoId).then((t) => {
      if (t && !sheet.dead && plsCurrent?.sheet === sheet) sheet.setTitle(t);
    });
  }

  // What the sheet shows is recomputed from whatever has arrived so far — cache,
  // membership, fresh library — each time one of them lands.
  /** @type {any[] | null} */ let library = null;
  /** @type {Array<{id: string, title: string | null, member: boolean}> | null} */ let picker = null;
  /** @type {Array<{id: string, title: string | null}>} */ let lastOrder = [];
  const draw = () => {
    if (sheet.dead || !library) return;
    // YouTube's order: the picker's, else the order it last had, else the library's.
    const order = picker ?? lastOrder;
    const ordered = orderLikePicker(library, order);
    if (finding) { sheet.setData(ordered.map((p) => ({ ...p }))); return; }
    const member = new Map((picker ?? []).map((r) => [r.id, r.member]));
    // `member` is deliberately tri-state: true / false / undefined ("we don't
    // know"). get_add_to_playlist reports at most 200 playlists, so on a larger
    // library the tail is unknowable until resolveMembershipTail settles it, and
    // claiming `false` would be inventing an answer.
    sheet.setData(saveTargets(ordered, order).map((p) => ({
      ...p,
      member: member.has(p.id) ? member.get(p.id) : undefined,
    })));
  };

  const cached = await plsCacheRead(account);
  if (sheet.dead) return;
  if (cached) {
    library = cached.library;
    lastOrder = cached.picker;
    draw();
  } else {
    sheet.setStatus('Loading your playlists…');
  }

  pickerP.then((rows) => {
    if (!rows || sheet.dead) return;
    picker = rows;
    draw();
  });

  try {
    const [list] = await Promise.all([fetchAllPlaylists(), pickerP]);
    if (sheet.dead) return;
    library = list;
    if (account) {
      plsCacheWrite({
        account,
        library: list,
        picker: (picker ?? lastOrder).map(({ id, title }) => ({ id, title })),
      });
    }
    draw();
    sheet.setStatus('');
  } catch (e) {
    console.error('[pls] load failed — failing closed, no DOM fallback', e);
    if (sheet.dead) return;
    const why = e?.userMessage ?? e?.message ?? String(e);
    if (library) {
      // The cached list stays usable; say it could not be brought up to date.
      sheet.setStatus('Couldn’t refresh your playlists. ' + why);
      return;
    }
    // setData BEFORE setStatus. Without it the sheet is still in its loading
    // state, so it shows shimmering skeletons under a footer that already says
    // the load failed — two contradictory claims at once.
    sheet.setData([]);
    sheet.setStatus('Couldn’t load your playlists. ' + why);
    return;
  }

  // Past the 200 that get_add_to_playlist reports, membership is unknown. Settle
  // it in the background by walking those playlists' own contents — correct but
  // slow (~9 s for 56 playlists), so it never blocks the sheet: rows gain their
  // "Already in" mark as answers arrive. Skipped when the fast path failed, or
  // answered with <=1 row (the missing-delegation canary): then nearly EVERY row
  // is unknown, and walking a whole library is not a refinement, it is a crawl.
  if (finding || !picker || picker.length <= 1 || tail.signal.aborted) return;
  const known = new Set(picker.map((r) => r.id));
  const unknown = saveTargets(library, picker).map((p) => p.id).filter((id) => !known.has(id));
  if (!unknown.length) return;
  console.log(`[pls] membership tail: checking ${unknown.length} playlist(s) past the 200 YouTube reports`);
  resolveMembershipTail(
    videoId,
    unknown,
    (id, hit) => { if (!tail.signal.aborted) sheet.setMember(id, hit); },
    6,
    tail.signal,
  ).catch((e) => console.warn('[pls] membership tail failed (non-fatal)', e));
}

console.log('[pls] content script ready on', location.pathname);
