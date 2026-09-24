// Onboarding state helpers, shared by the service worker and the welcome page.
//
// ES module: background.js is a `"type": "module"` service worker and welcome.html
// loads welcome.js with `type="module"`, so both `import` from here directly. (Before
// 2.0.0 this was a classic script hanging a global off `globalThis`, because the
// content script loaded it too — the v2 content script has no onboarding concerns.)

export const YOUTUBE_ORIGIN = 'https://www.youtube.com/*';

export async function hasYouTubePermission() {
  return chrome.permissions.contains({ origins: [YOUTUBE_ORIGIN] });
}

/**
 * Does a permissions delta (from `chrome.permissions.onAdded` / `onRemoved`) include
 * youtube.com? The events carry whatever changed, so every listener checks for ours.
 * @param {{ origins?: string[] } | undefined} permissions
 */
export function touchesYouTube(permissions) {
  return permissions?.origins?.includes(YOUTUBE_ORIGIN) ?? false;
}
