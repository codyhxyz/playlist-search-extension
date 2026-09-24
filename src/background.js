// Service worker: content-script lifecycle, onboarding, and the single
// intent-resolution path.
//
// L1 — intent, part 2 of 2: resolution. ONE code path, four entrypoints, zero DOM.
// Every signal — wherever it came from — is normalised into a single call to
// `dispatchIntent()`. There is deliberately no per-surface branching anywhere in this
// file: "saving from the home feed" is not a case we handle, it is one of the things
// that happens to produce the same observation as everything else. The decisions all
// live in lib/intent.js, which is pure and tested; this file owns only the effects.
//
// ─── WHY NO `webRequest` ───
// Earlier drafts observed intent with `chrome.webRequest.onBeforeRequest`. It cannot
// work: YouTube uploads these bodies as a **gzip stream**, and Chrome hands streamed
// uploads to webRequest as `requestBody: {error: "Unknown error."}` with no bytes at
// all. Verified on every save surface. So the listener could only ever tell us *that*
// a panel was fetched, never *which* one — and `get_panel` is generic, so firing blind
// on it is exactly how the 1.6.x extension ended up drawing itself inside unrelated
// menus. A permission that buys nothing and costs review scrutiny is not a fallback,
// it is a liability; MAIN-world observation (intent-hook.js) is the only path that
// reads these bodies, and the zero-DOM floor below is the real backstop.

import { YOUTUBE_ORIGIN, hasYouTubePermission, touchesYouTube } from './onboarding-state.js';
import { isAddToPlaylist, resolveVideoId, videoIdFromUrl } from './lib/intent.js';

const DEDUPE_MS = 1500;

/** `${tabId}:${videoId}` -> timestamp, so one click can't open two sheets. */
const recent = new Map();

// ═══════════════════════ content-script registration ═══════════════════════

const HOOK_SCRIPT_ID = 'pls-intent-hook';
const SHEET_SCRIPT_ID = 'pls-save-sheet';

const REGISTRATIONS = [
  {
    // MAIN world, document_start: it must patch `fetch` before YouTube's own app
    // code captures a reference to it. This is the only script we run in the page's
    // world, and it is deliberately dumb — observe, extract four fields, forward.
    id: HOOK_SCRIPT_ID,
    matches: [YOUTUBE_ORIGIN],
    js: ['intent-hook.js'],
    runAt: 'document_start',
    world: 'MAIN',
    allFrames: false,
    persistAcrossSessions: true,
  },
  {
    // content.bundle.js is the esbuild output of src/content.js + src/lib/*.js.
    // Don't reference src/content.js here — it uses ES module imports, which MV3
    // content scripts cannot resolve at load time.
    id: SHEET_SCRIPT_ID,
    matches: [YOUTUBE_ORIGIN],
    js: ['content.bundle.js'],
    runAt: 'document_idle',
    allFrames: false,
    persistAcrossSessions: true,
  },
];

// getRegisteredContentScripts + registerContentScripts is not atomic, so concurrent
// callers both see "not registered" and both try to register — the loser throws
// "Duplicate script ID". Coalesce into one in-flight promise.
let _registrationInFlight = null;

async function unregisterAll() {
  // No id filter, on purpose. Every dynamic registration this extension owns gets
  // swept — including `ytpf-youtube` from 1.6.x, whose `js` list still names
  // `vendor/minisearch.js` and `styles.css`. Those files do not exist in 2.0.0, so a
  // surviving 1.x registration doesn't just run stale code, it fails to inject at all
  // and the extension is silently dead after the update. Upgrades reconcile, they
  // don't skip.
  const existing = await chrome.scripting.getRegisteredContentScripts();
  if (existing.length === 0) return;
  await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
}

async function reconcileContentScripts() {
  if (_registrationInFlight) return _registrationInFlight;
  _registrationInFlight = (async () => {
    try {
      // Unregister first either way: revoked access means nothing may stay injected,
      // and granted access re-registers from a clean slate (see unregisterAll).
      await unregisterAll();
      if (!(await hasYouTubePermission())) return;
      try {
        await chrome.scripting.registerContentScripts(REGISTRATIONS);
      } catch (err) {
        // Most common failure mode for contributors: cloned the repo, ran Load
        // unpacked, but forgot `npm install && npm run build`, so content.bundle.js
        // doesn't exist on disk. We can't fix that from here, but we CAN make it
        // loud instead of Chrome's default silence.
        const message =
          '[pls] Failed to register content scripts. If this is a dev install from ' +
          '`Load unpacked`, run `npm install && npm run build` in the repo root and ' +
          'click the reload icon. Underlying error: ' +
          (err && err.message ? err.message : String(err));
        console.error(message);
        throw err;
      }
    } finally {
      _registrationInFlight = null;
      void refreshActionAffordance();
    }
  })();
  return _registrationInFlight;
}

// ═══════════════════════ onboarding / welcome page ═══════════════════════

/**
 * Say out loud, on the toolbar icon, that the extension is not armed yet.
 *
 * youtube.com is an OPTIONAL host permission, so until it is granted this
 * extension does exactly nothing: no content scripts, no Save interception, no
 * sheet. That is the right privacy default, but the failure mode it produces is
 * the worst one available — a freshly-installed extension that is silently inert
 * and indistinguishable from broken. It has already been mistaken for a bug
 * twice during development, by the person who wrote it.
 *
 * A badge costs nothing and converts "nothing happens" into "something is
 * obviously waiting for me". Clicking the icon in this state opens the welcome
 * page (see onActionClicked), so the badge points at its own fix.
 */
async function refreshActionAffordance() {
  try {
    const granted = await hasYouTubePermission();
    if (granted) {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'Save this video to a playlist' });
      return;
    }
    // A quiet dot, not an alarm. "Unfinished setup" is not an error, and the
    // red is reserved for a save that actually failed.
    await chrome.action.setBadgeText({ text: '•' });
    await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' });
    await chrome.action.setTitle({
      title: 'YouTube Playlist Search — click to finish setup.\nIt needs access to youtube.com before it can do anything.',
    });
  } catch (err) {
    // Badge APIs are cosmetic; never let them take the worker down.
    console.warn('[pls][sw] could not update the toolbar badge —', err?.message ?? err);
  }
}

function welcomeUrl() {
  return chrome.runtime.getURL('welcome.html');
}

async function openOrFocusWelcome() {
  const url = welcomeUrl();
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['TAB'],
      documentUrls: [url],
    });
    const existing = contexts.find((c) => c.tabId !== undefined);
    if (existing) {
      await chrome.tabs.update(existing.tabId, { active: true });
      if (existing.windowId !== undefined) {
        await chrome.windows.update(existing.windowId, { focused: true });
      }
      return;
    }
  }
  await chrome.tabs.create({ url });
}

// ═══════════════════════ the one resolution path ═══════════════════════

/**
 * @param {object} intent
 * @param {number} [intent.tabId]
 * @param {string} intent.source   how we came to believe a save was requested
 * @param {string} [intent.path]   request path, when the signal was a request
 * @param {any} [intent.body]      request body, when the signal was a request
 * @param {string} [intent.linkUrl]
 * @param {string} [intent.srcUrl]
 * @param {string} [intent.tabUrl]
 */
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
      { path, source, tabUrl, linkUrl, srcUrl, bodyKeys: Object.keys(body), tried: r.tried }
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

/**
 * Open the finder — the same sheet, searching every playlist, where a pick opens the
 * playlist. For the entrypoints that have no video to save: the toolbar icon or
 * Alt+S on a YouTube page without one, and the dedicated Alt+P anywhere on YouTube.
 * @param {{id?: number} | undefined} tab
 * @param {string} source
 */
function dispatchFind(tab, source) {
  if (typeof tab?.id !== 'number') return;
  console.log(`[pls][sw] FIND_INTENT — source=${source}`);
  chrome.tabs
    .sendMessage(tab.id, { type: 'FIND_INTENT', source })
    .catch((e) => console.warn(`[pls][sw] the tab has no content script to open the finder (reload it?) — ${e.message}`));
}

const isYouTube = (url) => typeof url === 'string' && url.startsWith('https://www.youtube.com/');

// ═══════════════ entrypoint 1: the MAIN-world hook, relayed by content.js ═══════════
// Primary. This is the only path that can read YouTube's request bodies.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // — welcome page —
  if (msg?.type === 'permissionGranted') {
    // Always answer. reconcileContentScripts() rethrows on a registration
    // failure, and an un-caught rejection here leaves the welcome page's
    // sendMessage hanging on a closed port with no error and no reply — the
    // user clicks "Grant access" and the page just sits there.
    reconcileContentScripts().then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err?.message ?? String(err) }),
    );
    return true;
  }
  if (msg?.type === 'getPermissionState') {
    hasYouTubePermission().then((granted) => sendResponse({ granted }));
    return true;
  }

  // — intent relay —
  if (msg?.type === 'HOOK_READY') return false;
  if (msg?.type === 'PANEL_REQUEST') {
    if (!isAddToPlaylist(msg.path, msg.body)) {
      // get_panel is generic — the Ask/YouChat panel uses it too. Rejecting these is
      // correct behaviour, not a miss, so it stays quiet at log level.
      console.log('[pls][sw] panel request seen but it is not add-to-playlist, ignoring', {
        path: msg.path,
        panelId: msg.body?.panelId ?? '(none)',
      });
      return false;
    }
    void dispatchIntent({
      tabId: sender.tab?.id,
      source: 'hook',
      path: msg.path,
      body: msg.body,
      tabUrl: sender.tab?.url,
    });
    return false;
  }
  return false;
});

// ═══════════════ entrypoints 2–4: the zero-DOM floor ══════════════════════════════
// URL structure only. These must keep working if YouTube changes everything, and they
// are the *only* coverage for Shorts, which has no native save affordance at all.

async function onActionClicked(tab) {
  // Before access is granted there is nothing to save into — send them to the page
  // that explains why and asks for it.
  if (!(await hasYouTubePermission())) {
    await openOrFocusWelcome();
    return;
  }
  // No video in the URL. On YouTube, there is still something to do: find a
  // playlist. Anywhere else, the welcome page is the honest answer; doing nothing
  // would read as a broken extension.
  if (!videoIdFromUrl(tab?.url)) {
    if (isYouTube(tab?.url)) dispatchFind(tab, 'toolbar');
    else await openOrFocusWelcome();
    return;
  }
  await dispatchIntent({ tabId: tab.id, source: 'toolbar', tabUrl: tab.url });
}

chrome.action.onClicked.addListener((tab) => {
  void onActionClicked(tab);
});

const MENU_ID = 'pls-save-here';

function installMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: 'Save to playlist (search all playlists)',
        contexts: ['link', 'video', 'page'],
        documentUrlPatterns: [YOUTUBE_ORIGIN],
      },
      () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn('[pls][sw] context-menu entrypoint NOT installed —', err.message);
      }
    );
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  void dispatchIntent({
    tabId: tab?.id,
    source: 'context-menu',
    linkUrl: info.linkUrl,
    srcUrl: info.srcUrl,
    tabUrl: info.pageUrl ?? tab?.url,
  });
});

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'open-save-sheet' && command !== 'find-playlist') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  if (command === 'find-playlist' || (!videoIdFromUrl(tab.url) && isYouTube(tab.url))) {
    if (isYouTube(tab.url)) dispatchFind(tab, 'hotkey');
    return;
  }
  // The accelerator is global, so it fires on tabs with no video — and on tabs
  // that aren't YouTube at all. That is not a coverage gap, and routing it into
  // dispatchIntent would log one, poisoning the single signal reserved for real
  // holes. Same reasoning as onActionClicked().
  if (!videoIdFromUrl(tab.url)) {
    console.log('[pls][sw] hotkey pressed with no video in the URL — nothing to save here');
    return;
  }
  void dispatchIntent({ tabId: tab.id, source: 'hotkey', tabUrl: tab.url });
});

// ═══════════════════════ lifecycle ═══════════════════════

chrome.runtime.onInstalled.addListener(async (details) => {
  // Pre-2.0 versions could persist modal HTML and playlist identifiers in these
  // records. Purge them even when YouTube access is revoked.
  // The last three were written by earlier versions but never read by anything.
  await chrome.storage.local.remove([
    'ytpfDiagnostics',
    'ytpf_registration_error',
    'onboarding.installWelcomeShown',
    'onboarding.permissionGranted',
    'pls_registration_error',
  ]);
  installMenu();
  if (details.reason === 'install') {
    await openOrFocusWelcome();
  }
  await reconcileContentScripts().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  installMenu();
  void reconcileContentScripts().catch(() => {});
});

chrome.permissions.onAdded.addListener((permissions) => {
  if (touchesYouTube(permissions)) void reconcileContentScripts().catch(() => {});
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (touchesYouTube(permissions)) {
    void unregisterAll().then(() => refreshActionAffordance());
  }
});

chrome.tabs.onRemoved.addListener((id) => {
  for (const key of recent.keys()) if (key.startsWith(id + ':')) recent.delete(key);
});

// The content script keeps the last playlist library in storage.session so the
// sheet opens instantly in any tab. That area is RAM-only and cleared when the
// browser quits, and content scripts may only reach it once the worker says so.
chrome.storage.session
  .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' })
  .catch((e) => console.warn('[pls][sw] session storage not shared with content scripts — the sheet will load uncached', e));

void reconcileContentScripts().catch(() => {});
void refreshActionAffordance();

console.log(`[pls][sw] v${chrome.runtime.getManifest().version} — listeners registered (hook + toolbar + context menu + hotkey)`);
