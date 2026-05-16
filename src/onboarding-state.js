// DRY onboarding state helpers — loaded in three contexts (service worker,
// welcome page, content script), so this file uses classic-script globals
// rather than ES module exports.

(() => {
  "use strict";

  const YOUTUBE_ORIGIN = "https://www.youtube.com/*";

  const ONBOARDING_KEYS = Object.freeze({
    installWelcomeShown: "onboarding.installWelcomeShown",
    permissionGranted: "onboarding.permissionGranted",
  });

  async function hasSeenOnboarding(key) {
    const { [key]: value } = await chrome.storage.local.get(key);
    return value === true;
  }

  async function markOnboardingSeen(key) {
    await chrome.storage.local.set({ [key]: true });
  }

  async function hasYouTubePermission() {
    return chrome.permissions.contains({ origins: [YOUTUBE_ORIGIN] });
  }

  globalThis.YTPF_onboarding = {
    YOUTUBE_ORIGIN,
    KEYS: ONBOARDING_KEYS,
    hasSeen: hasSeenOnboarding,
    markSeen: markOnboardingSeen,
    hasYouTubePermission,
  };
})();
