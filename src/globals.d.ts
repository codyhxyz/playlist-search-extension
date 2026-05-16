// Ambient declarations for globals our source files rely on at runtime.
// Kept intentionally permissive (typed as `any`) because the goal of
// tsc --noEmit --checkJs here is to catch our OWN drift (e.g. ctrl-shape
// regressions), not to enforce strict typing against the Chrome / Web APIs.

/** Chrome extension APIs — service worker, content script, welcome page. */
declare const chrome: any;

/** Service-worker classic-script loader (background.js does this for onboarding-state.js). */
declare function importScripts(...urls: string[]): void;

/**
 * MiniSearch — vendored at src/vendor/minisearch.js, loaded into the page as
 * a classic script. We only use a tiny slice of its API; declaring it as a
 * class (not `any`) so Ctrl.bm25 can be typed `MiniSearch | null` and tsc
 * catches "ctrl.bm25 = wrong-type" drift.
 */
declare class MiniSearch {
  constructor(opts: {
    fields: string[];
    storeFields?: string[];
    searchOptions?: Record<string, unknown>;
  });
  addAll(docs: Array<Record<string, unknown>>): void;
  search(
    query: string,
    opts?: Record<string, unknown>,
  ): Array<{
    id: string;
    source: string;
    ref: string;
    score?: number;
    terms?: string[];
    [k: string]: unknown;
  }>;
}

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
