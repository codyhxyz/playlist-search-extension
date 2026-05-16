// Ambient declarations for globals our source files rely on at runtime.
// Kept intentionally permissive (typed as `any`) because the goal of
// tsc --noEmit --checkJs here is to catch our OWN drift (e.g. ctrl-shape
// regressions), not to enforce strict typing against the Chrome / Web APIs.

/** Chrome extension APIs — service worker, content script, welcome page. */
declare const chrome: any;

/** Service-worker classic-script loader (background.js does this for onboarding-state.js). */
declare function importScripts(...urls: string[]): void;

/** MiniSearch — vendored at src/vendor/minisearch.js, loaded into the page as a classic script. */
declare const MiniSearch: any;

/** Cross-context globalThis singletons — onboarding helpers wire themselves onto globalThis. */
interface globalThis {
  YTPF_onboarding?: {
    YOUTUBE_ORIGIN: string;
    KEYS: { installWelcomeShown: string; permissionGranted: string };
    hasSeen(key: string): Promise<boolean>;
    markSeen(key: string): Promise<void>;
    hasYouTubePermission(): Promise<boolean>;
  };
  __ytpfDiag?: () => unknown;
  __YTPF_TEST__?: (api: Record<string, unknown>) => void;
}
