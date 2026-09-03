// L3 — session. Created on intent, destroyed on close, nothing survives.
// Also the isolated-world half of L1: it relays what intent-hook.js sees in the MAIN
// world to the service worker, which owns the single intent-resolution path.
//
// This is the esbuild entry point. Chrome injects src/content.bundle.js, not this
// file — see esbuild.config.mjs.

import { createSheet } from './lib/sheet.js';
import {
  addVideo,
  fetchAllPlaylists,
  fetchMembership,
  resetConfigCache,
} from './lib/innertube.js';

let plsCurrent = null;
let plsCurrentVideoId = null;

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
    console.log(`[pls] ${reason}: destroying the sheet for ${plsCurrentVideoId}, it belonged to the previous page`);
    plsDestroyCurrent();
  }
}

function plsDestroyCurrent() {
  const s = plsCurrent;
  plsCurrent = null;
  plsCurrentVideoId = null;
  if (!s) return;
  if (typeof s.destroy !== 'function') {
    console.warn('[pls] the sheet has no destroy() — the old sheet may linger on screen');
    return;
  }
  try {
    s.destroy();
  } catch (e) {
    console.warn('[pls] sheet.destroy() threw', e);
  }
}

document.addEventListener('yt-navigate-finish', () => plsOnNavigation('SPA navigation'));
window.addEventListener('popstate', () => plsOnNavigation('history navigation'));

// Zero-selector dismissal of YouTube's own dialog. Our <dialog>.showModal() already
// lands in the top layer and inerts the page, so theirs cannot be interacted with
// either way; this just clears it from view. If it stops working the failure is
// cosmetic: their dialog sits behind ours, inert, under the backdrop.
function plsDismissHostDialog() {
  const ev = new KeyboardEvent('keydown', {
    key: 'Escape', code: 'Escape', keyCode: 27, which: 27,
    bubbles: true, cancelable: true,
  });
  const notCancelled = document.dispatchEvent(ev);
  console.log(
    `[pls] dispatched synthetic Escape on document — defaultPrevented=${!notCancelled} ` +
      `(weak signal only; look at the page to see if YouTube's dialog actually closed)`
  );
}

async function plsHandleIntent(videoId, source) {
  // Catch up on any navigation whose event we missed before deciding what's stale.
  plsOnNavigation('late-detected navigation');

  if (plsCurrent?.dead) {
    // The sheet closed without telling us. Don't let a corpse block every future save.
    console.warn('[pls] previous sheet was dead but still referenced — clearing');
    plsDestroyCurrent();
  }
  if (plsCurrent) {
    if (plsCurrentVideoId === videoId) {
      console.log('[pls] sheet already open for this video, ignoring duplicate intent', { videoId, source });
      return;
    }
    // A different video: replace rather than silently drop. Dropping is how a user
    // ends up clicking Save and getting nothing.
    console.log(`[pls] intent for ${videoId} while ${plsCurrentVideoId} was open — replacing`);
    plsDestroyCurrent();
  }

  console.log(`[pls] SAVE_INTENT ${videoId} via ${source}`);
  plsDismissHostDialog();

  const sheet = createSheet({
    videoId,
    onPick: (p) => addVideo(p.id, videoId),
    onClose: () => {
      if (plsCurrent === sheet) {
        plsCurrent = null;
        plsCurrentVideoId = null;
      }
      console.log('[pls] sheet destroyed, no state retained');
    },
  });
  plsCurrent = sheet;
  plsCurrentVideoId = videoId;
  sheet.setStatus('Loading your playlists…');

  const t0 = performance.now();
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
    const rows = list
      .map((p) => ({ ...p, member: membership.has(p.id) ? membership.get(p.id) : undefined }))
      .sort(
        (a, b) => Number(b.member === true) - Number(a.member === true) ||
          a.title.localeCompare(b.title)
      );
    sheet.setData(rows);

    const already = rows.filter((p) => p.member === true).length;
    const unknown = rows.filter((p) => p.member === undefined).length;
    sheet.setStatus(
      `${list.length} playlists · ${Math.round(performance.now() - t0)}ms` +
        (already ? ` · ${already} already saved` : '') +
        // Say the quiet part out loud rather than letting blank rows imply "not in".
        (unknown ? ` · ${unknown} YouTube won’t report on` : '')
    );
  } catch (e) {
    console.error('[pls] load failed — failing closed, no DOM fallback', e);
    if (sheet.dead) return;
    // setData BEFORE setStatus. Without it the sheet is still in its loading
    // state, so it shows shimmering skeletons under a footer that already says
    // the load failed — two contradictory claims at once, and the list never
    // resolves. An empty result is the honest render for "we have nothing".
    sheet.setData([]);
    sheet.setStatus('Couldn’t load your playlists: ' + (e?.message ?? String(e)));
  }
}

console.log('[pls] content script ready on', location.pathname);
