// Onboarding state helpers, shared by the service worker and the welcome page.
//
// ES module: background.js is a `"type": "module"` service worker and welcome.html
// loads welcome.js with `type="module"`, so both `import` from here directly. (Before
// 2.0.0 this was a classic script hanging a global off `globalThis`, because the
// content script loaded it too — the v2 content script has no onboarding concerns.)

export const YOUTUBE_ORIGIN = 'https://www.youtube.com/*';

export const KEYS = Object.freeze({
  installWelcomeShown: 'onboarding.installWelcomeShown',
  permissionGranted: 'onboarding.permissionGranted',
});

/** @param {string} key */
export async function hasSeen(key) {
  const { [key]: value } = await chrome.storage.local.get(key);
  return value === true;
}

/** @param {string} key */
export async function markSeen(key) {
  await chrome.storage.local.set({ [key]: true });
}

export async function hasYouTubePermission() {
  return chrome.permissions.contains({ origins: [YOUTUBE_ORIGIN] });
}
