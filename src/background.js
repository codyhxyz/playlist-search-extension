"use strict";

importScripts("onboarding-state.js");

const { YOUTUBE_ORIGIN, KEYS, hasSeen, markSeen, hasYouTubePermission } =
  globalThis.YTPF_onboarding;

const CONTENT_SCRIPT_ID = "ytpf-youtube";

const CONTENT_SCRIPT_REGISTRATION = {
  id: CONTENT_SCRIPT_ID,
  matches: [YOUTUBE_ORIGIN],
  // content.bundle.js is the esbuild output of src/content.js + src/lib/*.js.
  // Don't reference src/content.js here directly — it uses ES module imports
  // which MV3 content scripts cannot resolve at load time.
  js: ["onboarding-state.js", "vendor/minisearch.js", "content.bundle.js"],
  css: ["styles.css"],
  runAt: "document_start",
  persistAcrossSessions: true,
};

// The service worker hits ensureContentScriptRegistered() from five entry
// points (module load, onInstalled, onStartup, permissions.onAdded, message
// handler). getRegisteredContentScripts + registerContentScripts is not
// atomic, so concurrent calls both see "not registered" and both try to
// register — the loser throws "Duplicate script ID". Coalesce into one
// in-flight promise so only one registration actually runs.
let _registrationInFlight = null;

async function ensureContentScriptRegistered() {
  if (_registrationInFlight) return _registrationInFlight;
  _registrationInFlight = (async () => {
    try {
      if (!(await hasYouTubePermission())) return;
      const existing = await chrome.scripting.getRegisteredContentScripts({
        ids: [CONTENT_SCRIPT_ID],
      });
      if (existing.length === 0) {
        await chrome.scripting.registerContentScripts([CONTENT_SCRIPT_REGISTRATION]);
      }
      await markSeen(KEYS.permissionGranted);
    } finally {
      _registrationInFlight = null;
    }
  })();
  return _registrationInFlight;
}

async function ensureContentScriptUnregistered() {
  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [CONTENT_SCRIPT_ID],
  });
  if (existing.length > 0) {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  }
  await chrome.storage.local.set({ [KEYS.permissionGranted]: false });
}

function welcomeUrl() {
  return chrome.runtime.getURL("welcome.html");
}

async function openOrFocusWelcome() {
  const url = welcomeUrl();
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["TAB"],
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

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await openOrFocusWelcome();
    await markSeen(KEYS.installWelcomeShown);
  }
  await ensureContentScriptRegistered();
});

chrome.runtime.onStartup.addListener(() => {
  ensureContentScriptRegistered();
});

chrome.action.onClicked.addListener(() => openOrFocusWelcome());

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions?.origins?.includes(YOUTUBE_ORIGIN)) {
    ensureContentScriptRegistered();
  }
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions?.origins?.includes(YOUTUBE_ORIGIN)) {
    ensureContentScriptUnregistered();
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "permissionGranted") {
    ensureContentScriptRegistered().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === "getPermissionState") {
    hasYouTubePermission().then((granted) => sendResponse({ granted }));
    return true;
  }
  return false;
});

ensureContentScriptRegistered();
