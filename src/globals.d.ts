// Ambient declarations for globals our source files rely on at runtime.
// Kept intentionally permissive (typed as `any`) because the goal of
// tsc --noEmit --checkJs here is to catch our OWN drift, not to enforce strict
// typing against the Chrome / Web APIs.

/** Chrome extension APIs — service worker, welcome page, content script. */
declare const chrome: any;

/**
 * Set by intent-hook.js to make its own installation idempotent. Declared so
 * checkJs doesn't treat the guard as a typo.
 */
interface Window {
  __plsIntentHook?: boolean;
}

/**
 * intent-hook.js stashes the URL from `open()` so `send()` can tell whether the
 * request is one we watch. XHR isn't used for these endpoints today — this is
 * cheap insurance if YouTube's client ever changes transport.
 */
interface XMLHttpRequest {
  __plsUrl?: string;
}
