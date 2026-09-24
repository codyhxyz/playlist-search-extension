// L3 — session. Created on intent, destroyed on close, nothing survives.
// Also the isolated-world half of L1: it relays what intent-hook.js sees in the MAIN
// world to the service worker, which owns the single intent-resolution path.
//
// This is the esbuild entry point. Chrome injects src/content.bundle.js, not this
// file — see esbuild.config.mjs.

import { createSheet } from './lib/sheet.js';
import {
  addVideo,
  removeVideo,
  createPlaylist,
  fetchAllPlaylists,
  fetchMembership,
  fetchVideoTitle,
  resetConfigCache,
  resolveMembershipTail,
} from './lib/innertube.js';

// The open sheet and the video it was opened for, or null. One slot, so the two can
// never disagree about which sheet is current.
/** @type {{ sheet: ReturnType<typeof createSheet>, videoId: string } | null} */
let plsCurrent = null;
// Two display preferences, remembered across page loads: the sort order and the
// privacy new playlists are created with. They are the ONLY things this extension
// persists about how you use it — two enum strings, no playlist ids, titles or
// queries — and PRIVACY.md lists them by name. (A sort preference, unlike a
// playlist cache, cannot go stale wrongly: the sheet re-derives every order from
// the rows it was just handed.) Read once at startup; a sheet opened in the few
// milliseconds before the read lands just gets the defaults.
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
      console.log('[pls] sheet already open for this video, ignoring duplicate intent', { videoId, source });
      return;
    }
    // A different video: replace rather than silently drop. Dropping is how a user
    // ends up clicking Save and getting nothing.
    console.log(`[pls] intent for ${videoId} while ${plsCurrent.videoId} was open — replacing`);
    plsDestroyCurrent();
  }

  console.log(`[pls] SAVE_INTENT ${videoId} via ${source}`);

  // Aborts the >200 membership walk below. That walk can be a hundred-odd requests;
  // a closed sheet must not keep spending them, so onClose — which every teardown
  // path reaches, including plsDestroyCurrent() — aborts it.
  const tail = new AbortController();
  const sheet = createSheet({
    videoId,
    sort: plsPrefs.sort,
    onSort: (mode) => plsSavePref('sort', mode),
    privacy: plsPrefs.privacy,
    onPrivacy: (privacy) => plsSavePref('privacy', privacy),
    onPick: (p) => addVideo(p.id, videoId),
    onRemove: (p) => removeVideo(p.id, videoId),
    onCreate: (title, privacy) => createPlaylist(title, privacy || 'PRIVATE', videoId),
    // A new tab, like any link: the sheet stays open for the next save.
    onOpen: (p) => window.open(
      `https://www.youtube.com/playlist?list=${encodeURIComponent(p.id)}`, '_blank', 'noopener',
    ),
    onClose: () => {
      tail.abort();
      if (plsCurrent?.sheet === sheet) plsCurrent = null;
      console.log('[pls] sheet destroyed, no state retained');
    },
  });
  plsCurrent = { sheet, videoId };
  sheet.setStatus('Loading your playlists…');

  // Deliberately NOT awaited and not part of the Promise.all below: the sheet is
  // already on screen and typing must work immediately. The name arrives when it
  // arrives, and if it never does the header simply stays empty — a label is not
  // worth delaying the thing the user actually came to do.
  fetchVideoTitle(videoId).then((t) => {
    if (t && !sheet.dead && plsCurrent?.sheet === sheet) sheet.setTitle(t);
  });

  try {
    // The full list is the point; membership is an enhancement, so it is allowed to
    // fail on its own without taking the sheet down with it.
    const [list, membership] = await Promise.all([
      fetchAllPlaylists(),
      fetchMembership(videoId).catch((e) => {
        console.warn('[pls] membership hints failed (non-fatal)', e);
        return new Map();
      }),
    ]);
    if (sheet.dead) return;

    // `member` is deliberately tri-state: true / false / undefined ("we don't know").
    // get_add_to_playlist reports at most 200 playlists — a hard server cap, the same
    // 200 for every video — so on a larger library the tail is genuinely unknowable
    // and YouTube's own picker is equally blind there. Absence must stay `undefined`;
    // claiming `false` would be inventing an answer.
    // Handed over in the order the server returned them, unsorted. Ordering is the
    // sheet's job now that the user can change it — a session layer that pre-sorted
    // would just be an order the UI had to undo. Recent preserves this order;
    // its recency meaning remains unverified (live verification waived for 2.0.1).
    const rows = list.map((p) => ({
      ...p,
      member: membership.has(p.id) ? membership.get(p.id) : undefined,
    }));
    sheet.setData(rows);
    sheet.setStatus('');

    // Past the 200 that get_add_to_playlist reports, membership is unknown. Settle
    // it in the background by walking those playlists' own contents — correct but
    // slow (~9 s for 56 playlists), so it never blocks the sheet: rows gain their
    // "Already in" mark as answers arrive, and the sheet keeps its cursor on the
    // same playlist while they move. Skipped when the fast path failed outright,
    // or answered with <=1 row (the missing-delegation canary in fetchMembership):
    // then nearly EVERY row is unknown, and walking a whole library is not a
    // refinement, it is a crawl.
    const unknown = rows.filter((r) => r.member === undefined).map((r) => r.id);
    if (membership.size > 1 && unknown.length && !tail.signal.aborted) {
      console.log(`[pls] membership tail: checking ${unknown.length} playlist(s) past the 200 YouTube reports`);
      resolveMembershipTail(
        videoId,
        unknown,
        (id, hit) => { if (!tail.signal.aborted) sheet.setMember(id, hit); },
        6,
        tail.signal,
      ).catch((e) => console.warn('[pls] membership tail failed (non-fatal)', e));
    }
  } catch (e) {
    console.error('[pls] load failed — failing closed, no DOM fallback', e);
    if (sheet.dead) return;
    // setData BEFORE setStatus. Without it the sheet is still in its loading
    // state, so it shows shimmering skeletons under a footer that already says
    // the load failed — two contradictory claims at once, and the list never
    // resolves. An empty result is the honest render for "we have nothing".
    sheet.setData([]);
    // The data layer attaches a plain-language reason (offline, signed out…)
    // when it can tell; otherwise the raw message is still better than nothing.
    sheet.setStatus('Couldn’t load your playlists. ' + (e?.userMessage ?? e?.message ?? String(e)));
  }
}

console.log('[pls] content script ready on', location.pathname);
