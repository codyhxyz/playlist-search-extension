// Modules imported here are bundled into src/content.bundle.js via esbuild
// (see esbuild.config.mjs). Chrome's MV3 content-script loader cannot resolve
// ES module imports at runtime, so the bundle is what actually gets injected
// — this file is the source entry point, not the loaded artifact.
import {
  PLAYLISTS_GRID_SELECTOR,
  PLAYLISTS_CONTENTS_SELECTOR,
  PLAYLISTS_OUTER_ROW_SELECTOR,
  PLAYLIST_RENDERER_SELECTOR,
  PLAYLISTS_FEED_PATH_RE,
  PLAYLIST_LINK_SELECTOR,
  PAGE_RELEVANT_SELECTOR,
  ITEM_TEXT_SELECTOR,
  CHIP_ROW_SELECTORS,
  CHIP_ROW_WRAPPER_CLASS,
} from "./lib/selectors.js";
import {
  parseAddToPlaylist,
  parsePlaylistRenderers as parsePlaylistRenderersPure,
} from "./lib/innertube-parse.js";
import {
  getRowPlaylistId,
  extractTitleFromPolymerData,
} from "./lib/dom-parse.js";

(() => {
  "use strict";

  /**
   * Per-host controller for the /feed/playlists page surface. One per grid.
   * Lives in the `controllers` Map, keyed by host element. Disposed by
   * teardownHost(). (The Save-to-playlist sheet is NOT a controller — it is
   * a fully owned shadow-DOM surface with zero YouTube DOM coupling; see
   * the "Owned save sheet" section.)
   *
   * @typedef {object} Ctrl
   * @property {Element} host                Page grid contents element.
   * @property {Element[]} rows              Current DOM rows being filtered.
   * @property {MiniSearch | null} bm25      MiniSearch index over rows.
   * @property {Element} root                Our injected filter-bar UI root.
   * @property {HTMLInputElement} input      The search input.
   * @property {HTMLButtonElement} clear     The clear (×) button.
   * @property {HTMLElement} meta            The "N of M" meta element.
   * @property {Element | null} parent       Row container.
   * @property {string} lastQuery            Previous query string (for empty→non-empty transitions).
   */

  /** @typedef {{ id: string, title: string, itemCount: number }} Playlist */

  const HIDDEN_CLASS = "ytpf-hidden";
  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";
  const DARK_THEME_CLASS = "ytpf-theme-dark";
  const ROW_MATCH_CLASS = "ytpf-row-match";
  // Material glyphs reused by the owned save sheet's row toggle buttons.
  const ICON_PLUS = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M14 10H2v2h12v-2zm0-4H2v2h12V6zm4 8v-4h-2v4h-4v2h4v4h2v-4h4v-2h-4zM2 16h8v-2H2v2z"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

  const INNERTUBE_API_KEY_FALLBACK = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const INNERTUBE_CLIENT_VERSION_FALLBACK = "2.20260206.01.00";
  const PLAYLIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  // ── Tunable timings ──────────────────────────────────────────────────────
  // Every magic millisecond value in this file lives here. Each entry is an
  // unwritten assumption about YouTube's animation, debounce, or render
  // budget — naming them makes the tuning surface grep-able when YouTube
  // changes their own timings (and they do; see the 1.6.0–1.6.12 churn in
  // CHANGELOG).
  const TIMINGS = {
    // Default mutation-driven reconcile debounce; below ~80ms YouTube's own
    // re-renders still generate churn, above ~200ms the search bar visibly
    // lags the modal open. Same value used by yt-page-data-updated path.
    RECONCILE_DEBOUNCE_MS: 120,
    // Default ignore-window for our own DOM writes so the observer doesn't
    // bounce-back on insertions we made ourselves (suppressMutations default).
    SUPPRESS_MUTATIONS_DEFAULT_MS: 120,
    // Used after every applyFilter pass on the page surface.
    SUPPRESS_MUTATIONS_AFTER_UI_OP_MS: 160,
    // On input focus we suppress for a longer window: the user is about to
    // type, mutations from our own re-renders shouldn't steal focus back.
    SUPPRESS_MUTATIONS_ON_FOCUS_MS: 300,
    // After yt-navigate-finish, wait for YouTube to settle its SPA render
    // before re-running refresh(). Empirically 250ms covers /feed/* mounts.
    NAVIGATE_SETTLE_MS: 250,
    // Cooldown between page-surface probes per pathname, so SPA navigations
    // re-arm but mutation-driven refreshes don't spam the console.
    PAGE_SURFACE_PROBE_COOLDOWN_MS: 4000,
  };

  // Diagnostics are console-only. This key exists only to purge unsafe rings
  // written by older releases.
  const DIAG_STORAGE_KEY = "ytpfDiagnostics";
  const DIAG_THROTTLE_MS = 30_000;

  function readLastConfigValue(text, key) {
    const pattern = new RegExp(`"${key}"\\s*:\\s*(?:"([^"]*)"|(-?\\d+)|null)`, "g");
    let value;
    for (let match; (match = pattern.exec(text));) {
      value = match[1] ?? match[2] ?? null;
    }
    return value;
  }

  let _innertubeConfigCache = null;
  function getInnertubeConfig(force = false) {
    if (!force && _innertubeConfigCache) return _innertubeConfigCache;
    let apiKey;
    let clientVersion;
    let sessionIndex;
    let delegatedSessionId;
    let datasyncId;

    // Navigation/page-data/config-script signals clear this cache. Authenticated
    // operations force a rescan. Later ytcfg blocks win.
    for (const script of document.getElementsByTagName("script")) {
      const text = script.textContent || "";
      if (text.length > 500000) continue;
      const nextApiKey = readLastConfigValue(text, "INNERTUBE_API_KEY");
      const nextClientVersion =
        readLastConfigValue(text, "INNERTUBE_CLIENT_VERSION") ??
        readLastConfigValue(text, "INNERTUBE_CONTEXT_CLIENT_VERSION");
      const nextSessionIndex = readLastConfigValue(text, "SESSION_INDEX");
      const nextDelegatedSessionId = readLastConfigValue(text, "DELEGATED_SESSION_ID");
      const nextDatasyncId = readLastConfigValue(text, "DATASYNC_ID");
      if (nextApiKey !== undefined) apiKey = nextApiKey;
      if (nextClientVersion !== undefined) clientVersion = nextClientVersion;
      if (nextSessionIndex !== undefined) sessionIndex = nextSessionIndex;
      if (nextDelegatedSessionId !== undefined) delegatedSessionId = nextDelegatedSessionId;
      if (nextDatasyncId !== undefined) datasyncId = nextDatasyncId;
    }

    const authUser = sessionIndex == null ? null : String(sessionIndex);
    const pageId = delegatedSessionId || null;
    const stableAccountId = pageId || datasyncId || null;
    const accountKey = authUser == null || stableAccountId == null
      ? null
      : JSON.stringify([authUser, pageId || "", datasyncId || ""]);

    _innertubeConfigCache = {
      apiKey: apiKey || INNERTUBE_API_KEY_FALLBACK,
      clientVersion: clientVersion || INNERTUBE_CLIENT_VERSION_FALLBACK,
      authUser,
      pageId,
      accountKey,
    };
    return _innertubeConfigCache;
  }

  const BM25_SEARCH_OPTIONS = {
    prefix: true,
    fuzzy: 0.2,
    combineWith: "OR",
    weights: { fuzzy: 0.1, prefix: 0.75 },
  };

  // Selectors and URL patterns now live in src/lib/selectors.js (imported at
  // the top of this file). The OLD/NEW renderer reference notes that used
  // to be here moved with them — see that file for the maintenance context.
  const FILTER_BASE_STYLES = `
    .ytpf-inline {
      /* Inherit YouTube's color-scheme so descendant <input> form controls render
         dark on html[dark] (avoids UA-painted light input on a dark modal). */
      color-scheme: inherit;
      position: sticky;
      top: 0;
      z-index: 1;
      margin: 0;
      padding: 10px 16px 8px;
      border-bottom: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1));
      background: var(--yt-spec-menu-background, var(--yt-spec-base-background, #fff));
    }
    .ytpf-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .ytpf-input-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
    }
    .ytpf-input {
      width: 100%;
      height: 36px;
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.2));
      border-radius: 18px;
      padding: 0 32px 0 12px;
      background: transparent;
      color: var(--yt-spec-text-primary, #0f0f0f);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      box-sizing: border-box;
    }
    .ytpf-input::placeholder {
      color: var(--yt-spec-text-secondary, #606060);
    }
    .ytpf-input:focus {
      outline: 2px solid rgba(6, 95, 212, 0.28);
      outline-offset: 0;
      border-color: rgba(6, 95, 212, 0.55);
    }
    .ytpf-inline.ytpf-theme-dark {
      color-scheme: dark;
      border-bottom-color: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.12));
      background: var(--yt-spec-menu-background, var(--yt-spec-raised-background, #212121));
    }
    .ytpf-theme-dark .ytpf-input {
      border-color: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.24));
      background: rgba(255, 255, 255, 0.06);
      color: var(--yt-spec-text-primary, #f1f1f1);
    }
    .ytpf-theme-dark .ytpf-input::placeholder,
    .ytpf-theme-dark .ytpf-clear,
    .ytpf-theme-dark .ytpf-meta {
      color: var(--yt-spec-text-secondary, #aaa);
    }
    .ytpf-theme-dark .ytpf-clear:hover {
      background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.12));
      color: var(--yt-spec-text-primary, #f1f1f1);
    }
    .ytpf-clear {
      display: none;
      position: absolute;
      right: 6px;
      top: 50%;
      transform: translateY(-50%);
      width: 22px;
      height: 22px;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 50%;
      padding: 0;
      background: transparent;
      color: var(--yt-spec-text-secondary, #606060);
      font-size: 16px;
      line-height: 1;
      cursor: pointer;
    }
    .ytpf-clear-visible {
      display: inline-flex;
    }
    .ytpf-clear:hover {
      background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1));
      color: var(--yt-spec-text-primary, #0f0f0f);
    }
    .ytpf-meta {
      margin: 6px 2px 0;
      color: var(--yt-spec-text-secondary, #606060);
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    mark.ytpf-mark {
      all: unset;
      display: inline !important;
      /* Punchy yellow + forced dark text. Single rule that's legible on
         YouTube's light AND dark themes — the previous rgba(255,255,0,0.4)
         + color:inherit produced unreadable light-on-muddy-yellow in dark
         mode. Dark text on a saturated yellow always passes contrast. */
      background-color: rgba(255, 213, 0, 0.85) !important;
      color: #0f0f0f !important;
      border-radius: 2px;
      padding: 0 1px;
    }
    .ytpf-row-match {}
  `;

  

  

  const PAGE_STYLES = `
    .ytpf-inline-page {
      position: static;
      top: auto;
      z-index: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      width: 100%;
      margin: 0 0 16px;
      padding: 0;
      background: transparent;
      border-bottom: none;
      grid-column: 1 / -1;
    }
    .ytpf-inline-page .ytpf-row {
      width: min(100%, 640px);
      padding: 4px;
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.12));
      border-radius: 999px;
      background: var(--yt-spec-base-background, #fff);
    }
    .ytpf-inline-page.ytpf-theme-dark .ytpf-row {
      border-color: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.16));
      background: var(--yt-spec-base-background, #0f0f0f);
    }
    .ytpf-inline-page .ytpf-input {
      height: 34px;
      border: none;
      border-radius: 999px;
      padding: 0 32px 0 14px;
    }
    .ytpf-inline-page .ytpf-input:focus {
      outline: none;
      border-color: transparent;
    }
    .ytpf-inline-page .ytpf-meta {
      margin: 0 12px;
      font-size: 11px;
    }
    /*
     * Class-only hide. Was inline display:none — switched to a class so a)
     * a single CSS sweep can restore orphaned rows if the controller gets
     * lost mid-filter, and b) we can scope the rule with !important to win
     * against YouTube's own inline styles on lockups.
     */
    .ytpf-hidden {
      display: none !important;
    }
    /*
     * Reflow fix for /feed/playlists during an active filter. YouTube wraps
     * lockups inside ytd-rich-grid-row slots; hiding individual lockups
     * leaves those slots half-empty, producing the "floating cards with
     * giant gaps" layout. While filtering, collapse the row wrappers with
     * display: contents and re-grid #contents directly so visible lockups
     * pack tight. Scoped to the filtering state, so the native layout is
     * untouched when no query is active.
     */
    .ytpf-page-filtering-rows {
      display: grid !important;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)) !important;
      gap: 16px !important;
      justify-items: stretch !important;
      align-items: start !important;
    }
    .ytpf-page-filtering-rows > ytd-rich-grid-row,
    .ytpf-page-filtering-rows > ytd-rich-grid-row > #contents {
      display: contents !important;
    }
    .ytpf-page-filtering-rows > ytd-rich-grid-row > #contents > ytd-rich-item-renderer,
    .ytpf-page-filtering-rows > ytd-rich-grid-row > #contents > ytd-rich-grid-media,
    .ytpf-page-filtering-rows > ytd-rich-grid-row > #contents > yt-lockup-view-model {
      min-width: 0 !important;
      width: 100% !important;
      max-width: none !important;
    }
    .ytpf-page-filtering-rows #video-title,
    .ytpf-page-filtering-rows .playlist-title,
    .ytpf-page-filtering-rows .yt-lockup-metadata-view-model-wiz__title,
    .ytpf-page-filtering-rows [class*='LockupMetadataViewModelTitle'] {
      white-space: normal !important;
      word-break: normal !important;
      overflow-wrap: break-word !important;
    }
  `;

  

  // Chip-variant styles for the /feed/playlists native chip-bar mount.
  // Sized + colored to match a `chip-view-model` chip 1:1: 32px tall, 8px
  // border-radius, --yt-spec-badge-chip-background fill. Width is fit-content
  // with a clamp so "Filter 9999 playlists" doesn't push the native chips
  // offscreen on narrow viewports. color-scheme: inherit carries forward the
  // dark-mode fix so the <input> doesn't get UA-painted light.
  const CHIP_STYLES = `
    .ytpf-inline.ytpf-chip {
      /* Override base .ytpf-inline rules — chips don't need sticky/border. */
      position: static;
      top: auto;
      z-index: auto;
      margin: 0;
      padding: 0;
      border: none;
      border-bottom: none;
      background: transparent;
      display: inline-flex;
      align-items: center;
      box-sizing: border-box;
      color-scheme: inherit;
    }
    .ytpf-chip .ytpf-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 32px;
      padding: 0 12px;
      border-radius: 8px;
      background: var(--yt-spec-badge-chip-background, var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.05)));
      width: clamp(220px, 24vw, 320px);
      box-sizing: border-box;
    }
    .ytpf-chip.ytpf-theme-dark .ytpf-row {
      background: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.10));
    }
    .ytpf-chip .ytpf-row:hover {
      background: var(--yt-spec-button-chip-background-hover, var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.08)));
    }
    .ytpf-chip.ytpf-theme-dark .ytpf-row:hover {
      background: var(--yt-spec-button-chip-background-hover, rgba(255, 255, 255, 0.14));
    }
    .ytpf-chip .ytpf-icon {
      flex: 0 0 16px;
      width: 16px;
      height: 16px;
      opacity: 0.85;
      color: var(--yt-spec-text-primary, #0f0f0f);
    }
    .ytpf-chip .ytpf-input-wrap {
      flex: 1;
      min-width: 0;
      position: static;
    }
    .ytpf-chip .ytpf-input {
      width: 100%;
      height: 24px;
      border: none;
      border-radius: 0;
      padding: 0;
      background: transparent;
      color: var(--yt-spec-text-primary, #0f0f0f);
      font-family: "YouTube Sans", Roboto, Arial, sans-serif;
      font-weight: 500;
      font-size: 14px;
    }
    .ytpf-chip .ytpf-input:focus {
      outline: none;
      border-color: transparent;
    }
    .ytpf-chip .ytpf-clear {
      position: static;
      transform: none;
      width: 18px;
      height: 18px;
      font-size: 14px;
    }
    .ytpf-chip .ytpf-meta { display: none; }
  `;

  const ALL_STYLES = [FILTER_BASE_STYLES, PAGE_STYLES, CHIP_STYLES].join("\n");

  // Per-row state, keyed on the row element. Held weakly so GC reclaims when
  // YouTube tears down its DOM. Previously these were two separate WeakMaps
  // (textCache, hiddenRows); collapsed to reduce top-level surface.
  // labelState keys on LABEL elements, which can have a different lifetime
  // from their rows.
  const rowState = new WeakMap(); // row → { text?: string, textFingerprint?: string, hidden?: boolean }
  const labelState = new WeakMap(); // label → { html: string, text: string }

  function rowStateFor(row) {
    let s = rowState.get(row);
    if (!s) { s = {}; rowState.set(row, s); }
    return s;
  }
  function isRowHidden(row) {
    return rowState.get(row)?.hidden === true;
  }
  // controllers: plain Map so it's iterable. Disposal is explicit via
  // teardownHost(), so we don't need WeakMap GC behavior. Pre-1.6.13 this
  // was `controllers: WeakMap + controllerHosts: Set` — the Set existed
  // only because WeakMap isn't iterable, and forgetting to keep the two
  // in sync was the 1.6.11 bug that swallowed every refresh tick on
  // /feed/playlists. Collapsed to remove the foot-gun.
  /** @type {Map<Element, Ctrl>} */
  const controllers = new Map();
  let _bodyObserver = null;
  let _themeObserver = null;
  let _onThemeMediaChange = null;
  let _onNavigateFinish = null;
  let _onPageDataUpdated = null;
  const _observedMutationRoots = new WeakSet();
  const ROOT_MUTATION_OPTIONS = { childList: true, subtree: true };
  // One independent cache per active Google account / delegated channel.
  const apiSessionCaches = new Map();

  // Reconciler: one debounced channel for "re-evaluate hosts" intents.
  // All signal sources (MutationObserver, yt-navigate-finish,
  // yt-page-data-updated) feed enqueueReconcile(); pre-mutation gating sets
  // pauseUntil so observer-driven enqueues don't re-enter from our own DOM
  // writes (synth row insert, filter pass, input focus). Pre-1.6.13 this was
  // three call paths + a free-floating suppressMutationsUntil timestamp.
  const reconciler = {
    flushTimer: null,
    scheduledAt: 0,   // performance.now() value at which flush will fire
    pauseUntil: 0,    // suppress mutation-driven enqueues until this time
    pendingReason: null, // newest "reason" string — diagnostics only
  };

  function ensureScopedStyles(rootNode) {
    if (!rootNode) return;
    if (rootNode.getElementById?.(STYLE_ID)) return;
    if (rootNode.querySelector?.(`#${STYLE_ID}`)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = ALL_STYLES;

    if (rootNode instanceof ShadowRoot) {
      rootNode.appendChild(style);
      return;
    }

    const target = rootNode.head || rootNode.documentElement || rootNode.body;
    target?.appendChild(style);
  }

  function hideRow(row) {
    if (!row || !row.isConnected) return;
    rowStateFor(row).hidden = true;
    row.classList.add(HIDDEN_CLASS);
  }

  function showRow(row) {
    if (!row) return;
    const s = rowState.get(row);
    if (s) s.hidden = false;
    row.classList.remove(HIDDEN_CLASS);
    // Defensive: prior versions of the extension set inline display:none.
    // Strip it if it's still hanging around from a cached DOM. Cheap, idempotent.
    if (row.style && row.style.display === "none") {
      row.style.removeProperty("display");
    }
  }

  function observeMutationRoot(root) {
    if (!_bodyObserver || !root || _observedMutationRoots.has(root)) return;
    _observedMutationRoots.add(root);
    _bodyObserver.observe(root, ROOT_MUTATION_OPTIONS);
  }

  /** @param {Document | Element | ShadowRoot} [root] */
  function queryAllDeep(selector, root = document) {
    const results = [];
    const seen = new Set();

    function addResult(el) {
      if (!seen.has(el)) {
        seen.add(el);
        results.push(el);
      }
    }

    function walk(nodeRoot) {
      if (!nodeRoot?.querySelectorAll) return;
      if (nodeRoot instanceof ShadowRoot) observeMutationRoot(nodeRoot);

      nodeRoot.querySelectorAll(selector).forEach(addResult);

      const walker = document.createTreeWalker(nodeRoot, NodeFilter.SHOW_ELEMENT);
      let node = /** @type {Element | null} */ (walker.currentNode);

      while (node) {
        if (node.shadowRoot) {
          walk(node.shadowRoot);
        }
        node = /** @type {Element | null} */ (walker.nextNode());
      }
    }

    walk(root);
    return results;
  }

  function unique(items) {
    return [...new Set(items)];
  }

  function nowMs() {
    return performance.now();
  }

  function colorValueLooksDark(value) {
    if (!value) return false;
    const text = String(value).trim();
    let r;
    let g;
    let b;

    const hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const raw = hex[1].length === 3
        ? hex[1].split("").map((ch) => ch + ch).join("")
        : hex[1];
      r = parseInt(raw.slice(0, 2), 16);
      g = parseInt(raw.slice(2, 4), 16);
      b = parseInt(raw.slice(4, 6), 16);
    } else {
      const rgb = text.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);
      if (!rgb) return false;
      r = Number(rgb[1]);
      g = Number(rgb[2]);
      b = Number(rgb[3]);
    }

    if (![r, g, b].every(Number.isFinite)) return false;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  }

  function isYouTubeDarkTheme() {
    const root = document.documentElement;
    const body = document.body;
    if (root?.hasAttribute("dark") || body?.hasAttribute("dark")) return true;
    if (root?.classList?.contains("dark") || body?.classList?.contains("dark")) return true;
    if (document.querySelector("ytd-app[dark], ytd-popup-container[dark], tp-yt-paper-dialog[dark]")) return true;

    try {
      const rootStyle = window.getComputedStyle(root);
      const ytBase = rootStyle.getPropertyValue("--yt-spec-base-background").trim();
      if (ytBase && /^(#|rgba?\()/i.test(ytBase)) return colorValueLooksDark(ytBase);

      const docBg = rootStyle.backgroundColor;
      if (docBg && docBg !== "transparent" && docBg !== "rgba(0, 0, 0, 0)") {
        return colorValueLooksDark(docBg);
      }
    } catch { /* computed style is best-effort only */ }

    return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  }

  function getFilterInlineRoot(root) {
    if (!root) return null;
    if (root.classList?.contains(FILTER_CLASS)) return root;
    return root.querySelector?.(`.${FILTER_CLASS}`) || null;
  }

  function setFilterThemeClass(root, dark = isYouTubeDarkTheme()) {
    const inline = getFilterInlineRoot(root);
    if (!inline) return;
    inline.classList.toggle(DARK_THEME_CLASS, dark);
  }

  function syncFilterThemeClasses() {
    const dark = isYouTubeDarkTheme();
    for (const ctrl of controllers.values()) setFilterThemeClass(ctrl.root, dark);
  }

  function startThemeObserver() {
    if (_themeObserver) return;

    const scheduleSync = () => requestAnimationFrame(syncFilterThemeClasses);
    const options = {
      attributes: true,
      attributeFilter: ["dark", "class", "style", "data-theme"],
    };

    _themeObserver = new MutationObserver(scheduleSync);
    _themeObserver.observe(document.documentElement, options);
    if (document.body) _themeObserver.observe(document.body, options);

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (media?.addEventListener) {
      _onThemeMediaChange = scheduleSync;
      media.addEventListener("change", _onThemeMediaChange);
    }
  }

  // Pause the reconciler from acting on mutation-driven enqueues for `ms`.
  // Used at five sites where we're about to cause our own DOM changes that
  // would otherwise re-enter refresh(): synth row insert, save success/fail,
  // filter pass, input focus. Navigate/page-data signals bypass this pause.
  function suppressMutations(ms = TIMINGS.SUPPRESS_MUTATIONS_DEFAULT_MS) {
    reconciler.pauseUntil = Math.max(reconciler.pauseUntil, nowMs() + ms);
  }

  function enqueueReconcile(reason, debounceMs = TIMINGS.RECONCILE_DEBOUNCE_MS) {
    // Never drop a real YouTube mutation. During our own paint window, defer
    // one trailing reconciliation until the window closes.
    const now = nowMs();
    const delay = reason === "mutation"
      ? Math.max(debounceMs, reconciler.pauseUntil - now)
      : debounceMs;
    const fireAt = now + Math.max(0, delay);
    if (reconciler.flushTimer && reconciler.scheduledAt >= fireAt) {
      // A longer-or-equal-wait flush is already pending — let it ride.
      // Critical for the navigate signal: yt-navigate-finish enqueues a
      // 250ms wait specifically to let YouTube's SPA settle. A mutation
      // arriving 50ms in must NOT cancel the navigate flush and fire
      // 80ms early — that was the 1.6.4 regression. "Never shorten."
      reconciler.pendingReason = reason;
      return;
    }
    // Either no flush pending, or fireAt is strictly later (new mutation
    // burst extends the debounce window — standard debounce behavior).
    if (reconciler.flushTimer) clearTimeout(reconciler.flushTimer);
    reconciler.scheduledAt = fireAt;
    reconciler.pendingReason = reason;
    reconciler.flushTimer = setTimeout(() => {
      reconciler.flushTimer = null;
      reconciler.scheduledAt = 0;
      reconciler.pendingReason = null;
      refresh();
    }, Math.max(0, fireAt - nowMs()));
  }

  function normalizeText(value) {
    return (value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitTerms(query) {
    return (query || "").split(" ").filter(Boolean);
  }

  function parseQueryTerms(query) {
    return splitTerms(query).map(normalizeText).filter(Boolean);
  }

  function closestComposed(node, selector) {
    for (let current = node; current; current = composedParent(current)) {
      if (current.matches?.(selector)) return current;
    }
    return null;
  }

  function createUnifiedIndex(rows) {
  if (typeof MiniSearch !== "function") return null;

  const index = new MiniSearch({
    fields: ["text"],
    storeFields: ["ref"],
    searchOptions: BM25_SEARCH_OPTIONS,
  });

  index.addAll(rows.map((row, i) => ({
    id: `dom:${i}`,
    text: getItemText(row),
    ref: String(i),
  })));
  return index;
}

function buildApiPlaylistMap(playlists) {
    const map = new Map();
    (playlists || []).forEach((pl) => map.set(pl.id, pl));
    return map;
  }

  function searchUnified(ctrl, query) {
  if (!ctrl.bm25 || query.length < 2) {
    return ctrl.rows
      .map((row) => {
        const text = getItemText(row);
        const at = text.indexOf(query);
        if (at < 0) return null;
        return { row, score: 1000 - at, terms: query.split(" ").filter(Boolean) };
      })
      .filter(Boolean);
  }

  const matches = [];
  const results = ctrl.bm25.search(query, BM25_SEARCH_OPTIONS);
  results.forEach((result) => {
    if (result.source !== "dom") return;
    const row = ctrl.rows[Number(result.ref)];
    if (!row) {
      console.warn("[ytpf] BM25 ref dom:%s has no matching row (stale index?)", result.ref);
      return;
    }
    const terms = Array.isArray(result.terms)
      ? result.terms.map(normalizeText).filter(Boolean)
      : [];
    matches.push({ row, score: Number(result.score) || 0, terms });
  });
  return matches;
}

function sameRows(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

  function composedParent(node) {
    if (node?.parentElement) return node.parentElement;
    const root = node?.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function composedContains(ancestor, node) {
    for (let current = node; current; current = composedParent(current)) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function isOurUiNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === STYLE_ID) return true;
    if (node.classList.contains(FILTER_CLASS)) return true;
    if (node.closest(`.${FILTER_CLASS}`)) return true;
    return false;
  }

  function nodeTouchesRelevantSurface(node) {
    if (!(node instanceof Element)) return false;
    if (isOurUiNode(node)) return false;

    if (!isPlaylistsFeedPage()) return false;
    if (node.matches(PAGE_RELEVANT_SELECTOR)) return true;
    if (hasDeepMatch(node, PAGE_RELEVANT_SELECTOR)) return true;
    if (closestComposed(node, PLAYLISTS_GRID_SELECTOR)) return true;
    return false;
  }

  function mutationElement(node) {
    if (node instanceof Element) return node;
    if (node instanceof ShadowRoot) return node.host;
    return node?.parentElement || null;
  }

  function shouldRefreshFromMutations(mutations) {
    for (const mutation of mutations) {
      if (nodeTouchesRelevantSurface(mutationElement(mutation.target))) return true;
      for (const node of mutation.addedNodes) {
        if (nodeTouchesRelevantSurface(mutationElement(node))) return true;
      }
      for (const node of mutation.removedNodes) {
        if (nodeTouchesRelevantSurface(mutationElement(node))) return true;
      }
    }
    return false;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (closestComposed(el, "[hidden], [aria-hidden='true']")) return false;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;

    if (el.getClientRects().length > 0) return true;

    const children = el.children;
    for (let i = 0; i < Math.min(children.length, 10); i++) {
      if (children[i].getClientRects().length > 0) return true;
    }

    return false;
  }

  function getRawItemText(row) {
    // Polymer-data branch — see extractTitleFromPolymerData in dom-parse.js
    // for the full list of shapes we know about. When YouTube ships a new
    // title shape, that's the function to update + add a test for.
    const dataTitle = extractTitleFromPolymerData(row.data || row.__data);
    if (dataTitle) return dataTitle;

    const label = row.querySelector(ITEM_TEXT_SELECTOR);
    return (
      label?.textContent ||
      row.getAttribute("aria-label") ||
      row.getAttribute("title") ||
      ""
    );
  }

  function getRowTextFingerprint(row, rawText) {
    // YouTube reuses save-sheet row elements across opens. A WeakMap keyed by
    // row alone can therefore pair an old title/highlight with a new thumbnail
    // and click target. Fold every cheap row identity signal into the cache
    // key so recycled rows self-invalidate before we read or restore labels.
    return [
      getRowPlaylistId(row) || "",
      rawText || "",
      row.getAttribute?.("aria-label") || "",
      row.getAttribute?.("title") || "",
    ].join("\n");
  }

  function getItemText(row) {
    const rawText = getRawItemText(row);
    const fingerprint = getRowTextFingerprint(row, rawText);
    const s = rowStateFor(row);
    if (typeof s.text === "string" && s.textFingerprint === fingerprint) return s.text;

    const text = normalizeText(rawText);
    s.text = text;
    s.textFingerprint = fingerprint;
    return text;
  }

  function getLabelElement(row) {
    const el = row.querySelector(ITEM_TEXT_SELECTOR) ||
      queryAllDeep(ITEM_TEXT_SELECTOR, row)[0] || null;
    if (el) {
      const root = el.getRootNode();
      if (root instanceof ShadowRoot) ensureScopedStyles(root);
      return el;
    }

    // YouTube sometimes nests label text in elements that don't match
    // ITEM_TEXT_SELECTOR. Walk down single-child chains to find the innermost
    // text-bearing element so we can inject <mark> highlights.
    const rowText = (row.textContent || "").trim();
    if (!rowText) return null;

    let candidate = row;
    while (candidate) {
      const children = Array.from(candidate.children).filter(
        (child) => (child.textContent || "").trim().length > 0,
      );
      if (children.length !== 1) break;
      candidate = children[0];
    }

    if (candidate !== row && (candidate.textContent || "").trim() === rowText) {
      const root = candidate.getRootNode();
      if (root instanceof ShadowRoot) ensureScopedStyles(root);
      return candidate;
    }

    return null;
  }

  // getRowPlaylistId now lives in src/lib/dom-parse.js — imported at top.

  // Single source of truth for "text + ranges -> highlighted output".
  // Returns a DocumentFragment of text nodes and <mark class="ytpf-mark"> elements.
  // Using text nodes (not innerHTML) means no HTML escaping is needed, and
  // there's only one implementation for both DOM-row highlighting and synth-row
  // highlighting to drift out of sync.
  function buildHighlightFragment(text, ranges) {
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const { from, to } of ranges) {
      if (from > cursor) {
        frag.appendChild(document.createTextNode(text.slice(cursor, from)));
      }
      const mark = document.createElement("mark");
      mark.className = "ytpf-mark";
      mark.textContent = text.slice(from, to);
      frag.appendChild(mark);
      cursor = to;
    }
    if (cursor < text.length) {
      frag.appendChild(document.createTextNode(text.slice(cursor)));
    }
    return frag;
  }

  function ensureOriginalLabelHtml(label) {
    const currentText = label.textContent || "";
    if (labelState.get(label)?.text !== currentText) {
      labelState.set(label, { html: label.innerHTML, text: currentText });
    }
  }

  function restoreHighlight(row) {
    row.classList.remove(ROW_MATCH_CLASS);
    const label = getLabelElement(row);
    if (!label) return;
    const original = labelState.get(label);
    if (!original) return;

    // Never restore HTML from a playlist that previously used this label node.
    if ((label.textContent || "") !== original.text) {
      labelState.delete(label);
      return;
    }

    if (label.innerHTML !== original.html) label.innerHTML = original.html;
  }

  function getHighlightRanges(rawText, terms) {
    if (!rawText || !terms.length) return [];
    const lower = rawText.toLowerCase();
    const ranges = [];

    terms.forEach((term) => {
      if (!term) return;
      let from = 0;
      while (from < lower.length) {
        const at = lower.indexOf(term, from);
        if (at < 0) break;
        ranges.push({ from: at, to: at + term.length });
        from = at + term.length;
      }
    });

    if (!ranges.length) return [];

    ranges.sort((a, b) => a.from - b.from || b.to - a.to);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i += 1) {
      const cur = ranges[i];
      const last = merged[merged.length - 1];
      if (cur.from <= last.to) {
        last.to = Math.max(last.to, cur.to);
      } else {
        merged.push(cur);
      }
    }

    return merged;
  }

  function getTextNodes(el) {
    const nodes = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    return nodes;
  }

  function applyHighlight(row, normalizedTerms) {
    const label = getLabelElement(row);
    if (!label) {
      row.classList.add(ROW_MATCH_CLASS);
      return;
    }

    ensureOriginalLabelHtml(label);

    // Restore first so we work from clean DOM each time.
    const original = labelState.get(label)?.html;
    if (original !== undefined && label.innerHTML !== original) label.innerHTML = original;

    const textNodes = getTextNodes(label);
    if (!textNodes.length) return;

    let didHighlight = false;

    textNodes.forEach((textNode) => {
      const rawText = textNode.nodeValue || "";
      const ranges = getHighlightRanges(rawText, normalizedTerms);
      if (!ranges.length) return;

      didHighlight = true;
      textNode.parentNode.replaceChild(
        buildHighlightFragment(rawText, ranges),
        textNode,
      );
    });

    if (!didHighlight) {
      restoreHighlight(row);
    }
  }

  let _feedPageCachePath = "";
  let _feedPageCacheResult = false;
  function isPlaylistsFeedPage() {
    const path = window.location.pathname;
    if (path !== _feedPageCachePath) {
      _feedPageCachePath = path;
      _feedPageCacheResult = PLAYLISTS_FEED_PATH_RE.test(path);
    }
    return _feedPageCacheResult;
  }

  function getGridContents(grid) {
    if (!grid) return null;
    const direct = grid.querySelector(PLAYLISTS_CONTENTS_SELECTOR);
    if (direct) return direct;
    return Array.from(grid.children).find((child) => child.id === "contents") || null;
  }

  function hasDeepMatch(node, selector) {
    if (!node) return false;
    // Self-match: when the outer row IS the renderer (e.g., yt-lockup-view-model
    // on the post-2026 /feed/playlists layout), descendant-only checks miss it.
    if (node.matches?.(selector)) return true;
    if (node.querySelector?.(selector)) return true;
    return Boolean(queryAllDeep(selector, node).length);
  }

  const hasPlaylistLink = (node) => hasDeepMatch(node, PLAYLIST_LINK_SELECTOR);
  const hasPlaylistRenderer = (node) => hasDeepMatch(node, PLAYLIST_RENDERER_SELECTOR);

  function toOuterPlaylistRow(node, contents) {
    if (!node || !contents) return null;
    const outer = closestComposed(node, PLAYLISTS_OUTER_ROW_SELECTOR);
    if (outer && composedContains(contents, outer)) return outer;
    if (node.matches?.(PLAYLISTS_OUTER_ROW_SELECTOR) && composedContains(contents, node)) {
      return node;
    }
    return null;
  }

  function collectGridRows(contents) {
    const isNotFilter = (row) => !row.classList.contains(FILTER_CLASS);

    const fromRenderers = unique(
      queryAllDeep(PLAYLIST_RENDERER_SELECTOR, contents)
        .filter(hasPlaylistLink)
        .map((r) => toOuterPlaylistRow(r, contents))
        .filter(Boolean),
    ).filter(isNotFilter);

    if (fromRenderers.length) return fromRenderers;

    const fromLinks = unique(
      queryAllDeep(PLAYLIST_LINK_SELECTOR, contents)
        .map((link) => toOuterPlaylistRow(link, contents))
        .filter(Boolean),
    ).filter(isNotFilter);

    if (fromLinks.length) return fromLinks;

    return unique(queryAllDeep(PLAYLISTS_OUTER_ROW_SELECTOR, contents));
  }

  function scoreCandidate(contents, rows) {
    const visibleRows = rows.filter((row) => isVisible(row) || isRowHidden(row));
    return [isVisible(contents) ? 1 : 0, visibleRows.length, rows.length];
  }

  function compareCandidateScores(a, b) {
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  }

  /**
   * Find the native filter-chip row on /feed/playlists, if present. Returns
   * the inner scroll container (where chip wrappers live), so callers can
   * `prepend` a sibling chip directly. We probe all selectors in order and
   * return the first hit — view-model is preferred over legacy Polymer.
   *
   * Returns null when no chip bar is on the page (channel pages, video
   * pages, mid-rollout users on a stripped UI). Callers fall back to the
   * full-width `.ytpf-inline-page` mount in that case.
   */
  function findChipRow() {
    if (!isPlaylistsFeedPage()) return null;
    for (const selector of CHIP_ROW_SELECTORS) {
      const hits = queryAllDeep(selector).filter((el) => el && el.isConnected && isVisible(el));
      if (hits.length) return hits[0];
    }
    return null;
  }

  function collectFeedPageSurface() {
    if (!isPlaylistsFeedPage()) return null;

    const grids = unique(queryAllDeep(PLAYLISTS_GRID_SELECTOR)).filter(
      (grid) => grid && grid.isConnected,
    );
    if (!grids.length) return null;

    /** @type {{ contents: Element, rows: Element[], score: number[] } | null} */
    let best = null;

    grids.forEach((grid) => {
      const contents = getGridContents(grid);
      if (!contents) return;

      const rows = collectGridRows(contents).filter(
        (row) =>
          !row.classList.contains(FILTER_CLASS) &&
          hasPlaylistRenderer(row) &&
          (hasPlaylistLink(row) || isRowHidden(row)),
      );

      if (!rows.length) return;

      const score = scoreCandidate(contents, rows);
      if (!best || compareCandidateScores(score, best.score) > 0) {
        best = { contents, rows, score };
      }
    });

    if (!best) return null;
    // Prefer the grid `#contents` as host so the search bar mounts at the top
    // of the grid (grid-column: 1 / -1 spans it across all columns). When the
    // outer row is nested inside an inner wrapper (post-2026 layout where
    // `yt-lockup-view-model` lives under `ytd-rich-grid-row`), using rows[0]'s
    // parentElement would drop the bar into a single grid cell next to the
    // first card — visually broken.
    return {
      host: best.contents || best.rows[0]?.parentElement,
      rows: best.rows,
    };
  }

  function findMountPoint(rows, host) {
    // Climb from rows[0] up to host, pinning the bar at the top-level
    // grid-child ancestor. With grid-column: 1 / -1 this spans the bar
    // across the full grid width regardless of how deeply nested the row is
    // (handles both the old ytd-rich-item-renderer layout and the post-2026
    // ytd-rich-grid-row > yt-lockup-view-model layout).
    let topLevel = rows[0];
    while (topLevel && topLevel.parentElement && topLevel.parentElement !== host) {
      topLevel = topLevel.parentElement;
    }
    if (topLevel && topLevel.parentElement === host) {
      return {
        parent: host,
        before: topLevel,
      };
    }

    const header =
      host.querySelector("#header, [slot='header'], .header") ||
      host.querySelector("#title, .title");
    if (header && header.parentElement) {
      return {
        parent: header.parentElement,
        after: header,
      };
    }

    const first = rows[0];
    if (first?.parentElement) {
      return {
        parent: first.parentElement,
        before: first,
      };
    }

    if (host.firstElementChild) {
      return {
        parent: host,
        before: host.firstElementChild,
      };
    }

    return {
      parent: host,
      before: null,
    };
  }

  function createSearchIcon() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ytpf-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.innerHTML = '<path fill="currentColor" d="M20.87 20.17l-5.59-5.59C16.35 13.35 17 11.75 17 10c0-3.87-3.13-7-7-7s-7 3.13-7 7 3.13 7 7 7c1.75 0 3.35-.65 4.58-1.71l5.59 5.59.7-.71zM10 16c-3.31 0-6-2.69-6-6s2.69-6 6-6 6 2.69 6 6-2.69 6-6 6z"/>';
    return svg;
  }

  /**
   * @param {"grid" | "chip"} [variant]
   */
  function createInlineFilterUi(variant) {
    const resolvedVariant = variant || "grid";

    // For the chip variant we render INSIDE a `.ytChipBarViewModelChipWrapper`
    // wrapper so the chip inherits native chip-bar spacing margins for free.
    // ui.root is the wrapper (the node that gets inserted/removed); the
    // inner `.ytpf-inline.ytpf-chip` carries the FILTER_CLASS so the rest
    // of the controller (querySelector, orphan sweep) finds it.
    const wrapper = resolvedVariant === "chip"
      ? document.createElement("div")
      : null;
    if (wrapper) wrapper.className = CHIP_ROW_WRAPPER_CLASS;

    const inline = document.createElement(resolvedVariant === "chip" ? "span" : "section");
    inline.className = FILTER_CLASS;
    if (resolvedVariant === "chip") {
      inline.classList.add("ytpf-chip");
    } else {
      inline.classList.add("ytpf-inline-page");
    }
    setFilterThemeClass(inline);

    // Chip variant uses <label> so clicks anywhere in the chip (icon, padding)
    // proxy focus to the wrapped input via native label semantics — no for=
    // needed when the input is nested. Grid variant keeps <div>.
    const row = document.createElement(resolvedVariant === "chip" ? "label" : "div");
    row.className = "ytpf-row";

    const input = document.createElement("input");
    input.className = "ytpf-input";
    input.type = "text";
    input.placeholder = "Filter playlists";
    input.setAttribute("aria-label", "Filter playlists");
    input.autocomplete = "off";
    input.spellcheck = false;

    const clear = document.createElement("button");
    clear.className = "ytpf-clear";
    clear.type = "button";
    clear.textContent = "\u00d7";
    clear.setAttribute("aria-label", "Clear search");

    const inputWrap = document.createElement("div");
    inputWrap.className = "ytpf-input-wrap";
    inputWrap.appendChild(input);
    inputWrap.appendChild(clear);

    if (resolvedVariant === "chip") {
      row.appendChild(createSearchIcon());
    }
    row.appendChild(inputWrap);

    const meta = document.createElement("span");
    meta.className = "ytpf-meta";
    meta.setAttribute("aria-live", "polite");

    inline.appendChild(row);
    if (resolvedVariant !== "chip") {
      inline.appendChild(meta);
    }

    if (wrapper) wrapper.appendChild(inline);

    return {
      root: wrapper || inline,
      input,
      clear,
      meta,
      variant: resolvedVariant,
    };
  }

  function getSapisid() {
    const match = document.cookie.match(/SAPISID=([^;]+)/);
    return match ? match[1] : null;
  }

  function isLoggedIn() {
    return Boolean(getSapisid());
  }

  async function getSapisidHash() {
    const sapisid = getSapisid();
    if (!sapisid) return null;
    const timestamp = Math.floor(Date.now() / 1000);
    const input = `${timestamp} ${sapisid} https://www.youtube.com`;
    const buffer = await crypto.subtle.digest(
      "SHA-1",
      new TextEncoder().encode(input),
    );
    const hash = Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `SAPISIDHASH ${timestamp}_${hash}`;
  }

  async function innertubeRequest(endpoint, body, session = getInnertubeConfig()) {
    const auth = await getSapisidHash();
    if (!auth) {
      recordDiagnostic("innertube_no_sapisid", { endpoint });
      throw new Error("Not signed in to YouTube");
    }
    if (!session.accountKey || session.authUser == null) {
      throw new Error("Could not determine the active YouTube account");
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: auth,
      "X-Goog-AuthUser": session.authUser,
      "X-Origin": "https://www.youtube.com",
    };
    if (session.pageId) headers["X-Goog-PageId"] = session.pageId;

    let response;
    try {
      response = await fetch(
        `https://www.youtube.com/youtubei/v1/${endpoint}?key=${session.apiKey}&prettyPrint=false`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            context: {
              client: {
                clientName: "WEB",
                clientVersion: session.clientVersion,
                hl: document.documentElement.lang || "en",
              },
            },
            ...body,
          }),
        },
      );
    } catch (err) {
      recordDiagnostic("innertube_network_error", { endpoint });
      throw err;
    }

    if (!response.ok) {
      // 401/403 typically mean SAPISID rotated or the cookie expired; 429 is
      // rate-limit; 5xx is YouTube-side. All three are silent UX failures the
      // user has no way to debug without a paper trail.
      recordDiagnostic("innertube_http_error", {
        endpoint,
        status: response.status,
      });
      throw new Error(`YouTube request failed (HTTP ${response.status})`);
    }

    return response.json();
  }

  // parsePlaylistRenderers + rendererTitle now live in src/lib/innertube-parse.js
  // as pure functions (JSON in, normalized {id,title,itemCount}[] out). This
  // wrapper sends shape-only canary details to the local console; it never
  // persists playlist data.
  //
  // The diagnostic invariant key encodes the sorted unknown-keys so distinct
  // migrations get their own throttled entries instead of one suppressing
  // the other (the keys are pre-sorted in innertube-parse.js).
  function parsePlaylistRenderers(data) {
    return parsePlaylistRenderersPure(data, (info) => {
      const keySignature = info.unknownItemKeys.join(",") || "<empty>";
      recordDiagnostic(`innertube_shape_unknown:${keySignature}`, info);
      try {
        const partial = info.playlistsExtracted > 0
          ? ` (PARTIAL: ${info.playlistsExtracted} known playlists also returned — mid-rollout)`
          : "";
        console.warn(
          `[ytpf] InnerTube response contained renderer key(s) we don't handle: [${keySignature}]${partial}. Likely a YouTube migration. Diag:`,
          info,
        );
      } catch {}
    });
  }

  async function innertubeLoadPlaylists(session) {
    const byId = new Map();
    let token = null;

    let data = await innertubeRequest("browse", {
      browseId: "FEplaylist_aggregation",
    }, session);

    for (let page = 0; page < 50; page += 1) {
      const { playlists, continuation } = parsePlaylistRenderers(data);
      for (const pl of playlists) {
        if (!byId.has(pl.id)) byId.set(pl.id, pl);
      }
      token = continuation;
      if (!token) break;
      data = await innertubeRequest("browse", { continuation: token }, session);
    }

    return [...byId.values()];
  }

  async function innertubeSaveVideo(playlistId, videoId, session, add = true) {
    const data = await innertubeRequest("browse/edit_playlist", {
      playlistId,
      actions: [{ action: add ? "ACTION_ADD_VIDEO" : "ACTION_REMOVE_VIDEO", addedVideoId: videoId }],
    }, session);
    if (data?.status !== "STATUS_SUCCEEDED") {
      throw new Error("Failed to save video to playlist");
    }
    return data;
  }

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const validVideoId = (value) => VIDEO_ID_RE.test(String(value || "")) ? String(value) : "";

  function getCurrentVideoId() {
    if (window.location.pathname === "/watch") {
      const fromUrl = validVideoId(new URLSearchParams(window.location.search).get("v"));
      if (fromUrl) return fromUrl;
      return validVideoId(
        document.querySelector("ytd-watch-flexy[video-id]")?.getAttribute("video-id"),
      );
    }

    const shortsMatch = window.location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})(?:\/|$)/);
    return shortsMatch?.[1] || "";
  }

  function trimApiCaches(keepKey) {
    const now = Date.now();
    for (const [key, cache] of apiSessionCaches) {
      if (
        key !== keepKey &&
        !cache.inFlight &&
        (apiSessionCaches.size > 2 || (cache.fetchedAt && now - cache.fetchedAt >= PLAYLIST_CACHE_TTL_MS))
      ) {
        apiSessionCaches.delete(key);
      }
    }
  }

  async function loadAllPlaylists(session) {
    if (!session.accountKey) throw new Error("Could not determine the active YouTube account");
    let cache = apiSessionCaches.get(session.accountKey);
    if (!cache) {
      cache = { playlists: null, fetchedAt: 0, inFlight: null };
      apiSessionCaches.set(session.accountKey, cache);
      trimApiCaches(session.accountKey);
    }

    const now = Date.now();
    if (cache.playlists !== null && now - cache.fetchedAt < PLAYLIST_CACHE_TTL_MS) return cache.playlists;
    if (cache.inFlight) return cache.inFlight;

    const promise = innertubeLoadPlaylists(session).then((playlists) => {
      cache.playlists = playlists;
      cache.fetchedAt = Date.now();
      return playlists;
    }).finally(() => {
      if (cache.inFlight === promise) cache.inFlight = null;
      trimApiCaches(session.accountKey);
    });
    cache.inFlight = promise;
    return promise;
  }

  function teardownHost(host) {
    const ctrl = controllers.get(host);
    if (!ctrl) return;

    ctrl.rows.forEach((row) => {
      showRow(row);
      restoreHighlight(row);
    });
    if (ctrl.host?.classList) {
      ctrl.host.classList.remove("ytpf-page-filtering");
      ctrl.host.classList.remove("ytpf-page-filtering-rows");
    }
    ctrl.root.remove();

    controllers.delete(host);

    // Keep the global observers alive even when the last controller is gone.
    // SPA navigations are transient; disconnecting here would make the
    // extension miss the next /feed/playlists mount in the same tab.
  }

  function applyFilter(ctrl) {
    const query = normalizeText(ctrl.input.value);
    const fullSet = ctrl.rows;

    suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);

    const domMatches = query
      ? searchUnified(ctrl, query)
      : fullSet.map((row) => ({ row, score: 0, terms: [] }));

    const domMatchSet = new Set(domMatches.map((m) => m.row));
    fullSet.forEach((row) => {
      if (domMatchSet.has(row)) {
        showRow(row);
      } else {
        hideRow(row);
        restoreHighlight(row);
      }
    });

    if (query) {
      const fallbackTerms = parseQueryTerms(query);
      domMatches.forEach((m) => {
        applyHighlight(m.row, m.terms?.length ? m.terms : fallbackTerms);
      });
    } else {
      fullSet.forEach(restoreHighlight);
    }

    ctrl.clear.classList.toggle("ytpf-clear-visible", Boolean(query));

    // Page surface: while filtering, collapse YouTube's ytd-rich-grid-row
    // wrappers via CSS so the remaining lockups reflow into a tight grid
    // instead of floating inside their original row slots. Only do this when
    // those row wrappers are actually direct children; direct-lockup grids
    // already reflow natively, and forcing our generic grid there squashes
    // YouTube's 2026 chip/feed layout into tiny cards.
    if (ctrl.host?.classList) {
      const filtering = Boolean(query);
      const children = Array.from(ctrl.host.children || []);
      const hasRichGridRows = children.some((child) => child.matches?.("ytd-rich-grid-row"));
      const hasDirectPlaylistLockups = children.some((child) =>
        child.matches?.("ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model"),
      );
      const enoughRoomForSafeCards = window.innerWidth >= 760;
      ctrl.host.classList.toggle("ytpf-page-filtering", filtering);
      ctrl.host.classList.toggle(
        "ytpf-page-filtering-rows",
        filtering && hasRichGridRows && !hasDirectPlaylistLockups && enoughRoomForSafeCards,
      );
    }

    ctrl.input.placeholder = `Filter ${fullSet.length} playlists`;
    ctrl.meta.textContent = query ? `${domMatches.length} of ${fullSet.length}` : "";
    ctrl.lastQuery = query;
  }

  /**
   * @param {Element} host
   * @param {Element[]} rows
   */
  function attachHost(host, rows) {
    // Prefer the native chip-bar mount: looks like a YouTube control, takes
    // zero extra vertical space, inherits chip spacing for free. Falls back
    // to the historic full-width grid mount when no chip bar is present.
    // The grid mount is the failsafe; do NOT remove it until both rollouts
    // are universal AND we have telemetry confirming the chip bar is always
    // present.
    //
    // We APPEND (rightmost) rather than prepend: native YT chips on the left
    // are the primary navigation/filter selectors ("All", "Music", …).
    let mount;
    /** @type {"grid" | "chip"} */
    let variant;
    const chipRow = findChipRow();
    if (chipRow) {
      mount = { parent: chipRow, before: null };
      variant = "chip";
    } else {
      mount = findMountPoint(rows, host);
      variant = "grid";
    }

    ensureScopedStyles(mount.parent.getRootNode?.() || document);

    const ui = createInlineFilterUi(variant);

    if (mount.after) {
      mount.after.after(ui.root);
    } else if (mount.before) {
      mount.parent.insertBefore(ui.root, mount.before);
    } else {
      mount.parent.appendChild(ui.root);
    }

    /** @type {Ctrl} */
    const ctrl = {
      host,
      rows,
      bm25: createUnifiedIndex(rows),
      root: ui.root,
      input: ui.input,
      clear: ui.clear,
      meta: ui.meta,
      parent: rows[0]?.parentElement || null,
      lastQuery: "",
    };

    ui.input.addEventListener("input", () => {
      applyFilter(ctrl);
    });
    ui.input.addEventListener("focus", () => {
      suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_ON_FOCUS_MS);
    });
    ui.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && ui.input.value) {
        event.preventDefault();
        event.stopPropagation();
        ui.input.value = "";
        applyFilter(ctrl);
      }
    });

    ui.clear.addEventListener("click", () => {
      ui.input.value = "";
      applyFilter(ctrl);
      ui.input.focus();
    });

    controllers.set(host, ctrl);

    applyFilter(ctrl);
    requestAnimationFrame(() => {
      const liveCtrl = controllers.get(host);
      if (!liveCtrl || liveCtrl.root !== ui.root) return;
      if (ui.root.isConnected && ui.root.getClientRects().length === 0) {
        host.insertBefore(ui.root, host.firstElementChild || null);
      }
    });
  }

  /**
   * @param {Element} host
   * @param {Element[]} rows
   */
  function upsertHost(host, rows) {
    if (!rows.length) return;
    const existing = controllers.get(host);

    if (!existing) {
      attachHost(host, rows);
      return;
    }

    if (!existing.root.isConnected) {
      teardownHost(host);
      attachHost(host, rows);
      return;
    }

    if (sameRows(existing.rows, rows)) {
      return;
    }

    existing.rows.forEach((row) => {
      if (!rows.includes(row)) {
        showRow(row);
        restoreHighlight(row);
      }
    });
    existing.rows = rows;
    existing.bm25 = createUnifiedIndex(rows);
    existing.parent = rows[0]?.parentElement || existing.parent;
    applyFilter(existing);
  }

  function sweepOrphanedHidden() {
    const tracked = new WeakSet();
    const liveHosts = new WeakSet();
    for (const ctrl of controllers.values()) {
      if (ctrl.host) liveHosts.add(ctrl.host);
      for (const row of ctrl.rows) tracked.add(row);
    }
    queryAllDeep(`.${HIDDEN_CLASS}`).forEach((el) => {
      if (!tracked.has(el)) showRow(el);
    });
    queryAllDeep(".ytpf-page-filtering, .ytpf-page-filtering-rows").forEach((el) => {
      if (!liveHosts.has(el)) {
        el.classList.remove("ytpf-page-filtering");
        el.classList.remove("ytpf-page-filtering-rows");
      }
    });
  }

  function refresh() {
    syncFilterThemeClasses();
    sweepOrphanedHidden();

    const pageSurface = collectFeedPageSurface();
    if (pageSurface) {
      upsertHost(pageSurface.host, pageSurface.rows);
    } else if (isPlaylistsFeedPage()) {
      schedulePageSurfaceProbe();
    }

    for (const [host] of [...controllers]) {
      if (!host.isConnected) {
        teardownHost(host);
        continue;
      }
      if (!pageSurface || pageSurface.host !== host || !isVisible(host)) teardownHost(host);
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Console-only by design. Playlist/search/modal data must never be persisted
  // or bridged into YouTube's page-readable DOM.
  const _lastDiagAt = new Map();

  function recordDiagnostic(invariant, context = {}) {
    const now = Date.now();
    const prev = _lastDiagAt.get(invariant) || 0;
    if (now - prev < DIAG_THROTTLE_MS) return;
    _lastDiagAt.set(invariant, now);
    console.warn(`[ytpf] diagnostic: ${invariant}`, context);
  }

  // Page-surface mirror of scheduleFilterBarMountCheck. Triggered from
  // refresh() when isPlaylistsFeedPage() is true but collectFeedPageSurface()
  // returned null — meaning some gate (grid selector, contents selector,
  // renderer selector, link selector) didn't match the current DOM.
  // Captures one structured probe per path-load and surfaces it both to the
  // console. Keyed by pathname + a 4s cooldown so SPA navigations re-arm but
  // mutation-driven refreshes don't spam.
  const _pageSurfaceProbedAt = new Map();
  function schedulePageSurfaceProbe() {
    const path = window.location.pathname;
    const last = _pageSurfaceProbedAt.get(path) || 0;
    const now = Date.now();
    if (now - last < TIMINGS.PAGE_SURFACE_PROBE_COOLDOWN_MS) return;
    _pageSurfaceProbedAt.set(path, now);
    setTimeout(() => {
      if (!isPlaylistsFeedPage()) return;
      // Re-check: if a surface materialized in the interim (slow render), bail.
      if (collectFeedPageSurface()) return;
      const probe = probePageSurface();
      recordDiagnostic("page_surface_missing", probe);
      try { console.warn("[ytpf] page surface failed to mount", probe); } catch {}
    }, TIMINGS.MOUNT_CHECK_DELAY_MS);
  }

  // Pure inspection of the current DOM through every selector that
  // collectFeedPageSurface relies on. Returns a structured object — never
  // throws, never mutates. Exposed on window.__ytpfDiag for ad-hoc probing.
  function probePageSurface() {
    const grids = unique(queryAllDeep(PLAYLISTS_GRID_SELECTOR)).filter(
      (g) => g && g.isConnected,
    );
    const candidates = grids.map((grid) => {
      const contents = getGridContents(grid);
      const rawRows = contents ? collectGridRows(contents) : [];
      const filtered = rawRows.filter(
        (row) =>
          !row.classList.contains(FILTER_CLASS) &&
          hasPlaylistRenderer(row) &&
          (hasPlaylistLink(row) || isRowHidden(row)),
      );
      return {
        gridTag: grid.tagName?.toLowerCase(),
        contentsId: contents?.id || null,
        contentsExists: !!contents,
        rawRowCount: rawRows.length,
        filteredRowCount: filtered.length,
        firstFilteredRowTag: filtered[0]?.tagName?.toLowerCase() || null,
      };
    });
    return {
      isFeedPath: isPlaylistsFeedPage(),
      gridCount: grids.length,
      candidates,
    };
  }

  // Console-accessible debug surface. Lets users (or this assistant in a
  // future session) get an immediate read on why the bar isn't mounting,
  // without paste-the-snippet ceremony.  Idempotent — safe to call any time.
  try {
    Object.defineProperty(window, "__ytpfDiag", {
      configurable: true,
      value: () => probePageSurface(),
    });
  } catch { /* CSP or already defined — non-fatal */ }


  // ══ Owned save sheet ═════════════════════════════════════════════════
  // We do NOT inject into YouTube's "Save to playlist" modal. That DOM has
  // migrated repeatedly (CHANGELOG 1.6.6–1.6.18) and each migration broke
  // the extension silently. Instead we intercept the action-bar Save click,
  // keep YouTube's modal closed, and render our own shadow-DOM sheet backed
  // entirely by InnerTube. The only YouTube coupling left is one button.

  const SHEET_MAX_ROWS = 100;
  const SHEET_HOST_ID = "ytpf-save-sheet-host";

  let activeSheet = null;

  /**
   * Pure-ish extraction of {id,title,itemCount,containsVideo}[] from the
   * add-to-playlist panel payload. ALL shape knowledge for that panel lives
   * here — when YouTube migrates it, update this + the fixture test only.
   * Handles the long-lived addToPlaylistRenderer family (the payload behind
   * ytd-add-to-playlist-renderer): playlists[] / contents[] items carrying
   * playlistId, a title blob, optional videoCount text, and an optional
   * boolean marking whether the target video is already in the playlist
   * (`selected` on some shapes; absent ⇒ false).
   */
  async function fetchSaveSheetItems(videoId) {
    void videoId; // membership state arrives via the panel payload; see parseAddToPlaylist
    const session = getInnertubeConfig(true);
    // ponytail: FEplaylist_aggregation only, rows render unchecked — the
    // add-to-playlist panel request (which carries per-video selected state)
    // gets wired through parseAddToPlaylist once its real request/response
    // capture lands in tests/fixtures/innertube/. Fallback is the same
    // browse call this extension has shipped for years.
    const playlists = await loadAllPlaylists(session);
    return playlists.map((p) => ({ ...p, containsVideo: false }));
  }

  function findSaveTriggerTarget(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    for (const node of path) {
      if (!(node instanceof Element)) continue;

      // Direct watch-page action-bar button: aria-label "Save" / "Save to …".
      const label = node.getAttribute?.("aria-label") || "";
      if (
        /^Save( to|$)/i.test(label) &&
        (node.closest("ytd-watch-flexy") || node.closest("ytd-shorts"))
      ) {
        return { kind: "save-button", node };
      }

      // "More actions" overflow menu: intercept the plain "Save" menu item
      // before YouTube opens its own modal from it.
      if (/^More actions$/i.test(label)) {
        return { kind: "more-actions", node };
      }
    }
    return null;
  }

  function isOverflowSaveItem(node) {
    const el = node instanceof Element ? node : null;
    if (!el) return false;
    if (!el.closest("tp-yt-paper-listbox, ytd-menu-popup-renderer, tp-yt-iron-dropdown")) return false;
    const text = (el.textContent || "").trim();
    return text === "Save" || /^Save( to\b|$)/i.test(text);
  }

  function closeSheet() {
    if (!activeSheet) return;
    const { host, onKeyDown } = activeSheet;
    document.removeEventListener("keydown", onKeyDown, true);
    host.remove();
    activeSheet = null;
  }

  function renderSheetRows() {
    const sheet = activeSheet;
    if (!sheet) return;
    const query = normalizeText(sheet.input.value);
    const terms = parseQueryTerms(query);
    const filtered = query
      ? sheet.items.filter((item) => terms.every((term) => normalizeText(item.title).includes(term)))
      : sheet.items;
    const limited = filtered.slice(0, SHEET_MAX_ROWS);

    sheet.metaEl.textContent = query
      ? `${filtered.length} of ${sheet.items.length}`
      : `${sheet.items.length} playlists`;
    sheet.emptyEl.style.display = limited.length ? "none" : "";
    sheet.listEl.replaceChildren(...limited.map((item) => {
      const row = document.createElement("div");
      row.className = "ytpf-sheet-row";
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      const toggle = document.createElement("span");
      toggle.className = "ytpf-sheet-toggle" + (item.containsVideo ? " ytpf-sheet-on" : "");
      toggle.innerHTML = item.containsVideo ? ICON_CHECK : ICON_PLUS;

      const title = document.createElement("span");
      title.className = "ytpf-sheet-title";
      title.textContent = item.title;

      const count = document.createElement("span");
      count.className = "ytpf-sheet-count";
      count.textContent = item.itemCount ? `${item.itemCount}` : "";

      row.append(toggle, title, count);

      const activate = () => {
        if (item.pending) return;
        item.pending = true;
        const wasOn = item.containsVideo;
        // Optimistic flip; revert on failure.
        item.containsVideo = !wasOn;
        paintRow(toggle, item);
        innertubeSaveVideo(item.id, sheet.videoId, getInnertubeConfig(true), !wasOn)
          .catch(() => {
            item.containsVideo = wasOn;
            console.warn("[ytpf] Playlist update failed:", item.title);
          })
          .finally(() => {
            item.pending = false;
            paintRow(toggle, item);
          });
      };
      row.addEventListener("click", activate);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activate();
        }
      });
      row.dataset.playlistId = item.id;
      return row;
    }));
    if (filtered.length > SHEET_MAX_ROWS) {
      sheet.metaEl.textContent += ` (showing first ${SHEET_MAX_ROWS})`;
    }
  }

  function paintRow(toggle, item) {
    toggle.classList.toggle("ytpf-sheet-on", item.containsVideo);
    toggle.innerHTML = item.containsVideo ? ICON_CHECK : ICON_PLUS;
    toggle.parentElement.style.opacity = item.pending ? "0.5" : "";
  }

  async function openSheet(videoId) {
    closeSheet();

    const session = getInnertubeConfig(true);
    if (!session.accountKey) return;

    const host = document.createElement("div");
    host.id = SHEET_HOST_ID;
    const root = host.attachShadow({ mode: "open" });

    const dark = isYouTubeDarkTheme();
    root.innerHTML = `
      <style>
        :host {
          all: initial;
          font-family: Roboto, Arial, sans-serif;
        }
        .backdrop {
          position: fixed;
          inset: 0;
          z-index: 2147483646;
          background: rgba(0,0,0,0.5);
          display: flex;
          align-items: flex-start;
          justify-content: center;
        }
        .panel {
          margin-top: 10vh;
          width: min(360px, calc(100vw - 32px));
          max-height: 70vh;
          display: flex;
          flex-direction: column;
          border-radius: 12px;
          overflow: hidden;
          background: ${dark ? "#212121" : "#fff"};
          color: ${dark ? "#f1f1f1" : "#0f0f0f"};
          box-shadow: 0 8px 30px rgba(0,0,0,.4);
        }
        .head { padding: 12px 12px 8px; border-bottom: 1px solid ${dark ? "rgba(255,255,255,.12)" : "rgba(0,0,0,.08)"}; }
        input {
          box-sizing: border-box;
          width: 100%;
          height: 34px;
          border-radius: 17px;
          border: 1px solid ${dark ? "rgba(255,255,255,.24)" : "rgba(0,0,0,.2)"};
          background: transparent;
          color: inherit;
          padding: 0 12px;
          font-size: 14px;
          outline: none;
        }
        input:focus { border-color: rgba(6,95,212,.55); }
        .meta {
          padding: 6px 14px 2px;
          font-size: 11px;
          color: ${dark ? "#aaa" : "#606060"};
          font-variant-numeric: tabular-nums;
        }
        .list { overflow-y: auto; padding-bottom: 8px; }
        .row {
          display: flex;
          align-items: center;
          gap: 10px;
          min-height: 44px;
          padding: 4px 14px;
          cursor: pointer;
        }
        .row:hover { background: ${dark ? "rgba(255,255,255,.08)" : "rgba(0,0,0,.05)"}; }
        .toggle {
          flex: 0 0 auto;
          width: 22px; height: 22px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border: 2px solid ${dark ? "#909090" : "#606060"};
          color: ${dark ? "#909090" : "#606060"};
        }
        .toggle svg { width: 16px; height: 16px; display: none; }
        .on { border-color: #065fd4; color: #065fd4; }
        .on svg { display: block; }
        .title {
          flex: 1; min-width: 0;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          font-size: 14px;
        }
        .count { font-size: 11px; color: ${dark ? "#aaa" : "#606060"}; }
        .empty { padding: 18px 14px; text-align: center; font-size: 13px; color: ${dark ? "#aaa" : "#606060"}; }
        .status { padding: 10px 14px; font-size: 13px; color: ${dark ? "#aaa" : "#606060"}; }
      </style>
      <div class="backdrop">
        <div class="panel" role="dialog" aria-label="Save to playlist">
          <div class="head"><input type="text" placeholder="Search playlists" aria-label="Search playlists"></div>
          <div class="meta"></div>
          <div class="list"></div>
          <div class="empty" style="display:none">No matching playlists</div>
          <div class="status"></div>
        </div>
      </div>
    `;
    document.documentElement.appendChild(host);

    const backdrop = root.querySelector(".backdrop");
    const input = root.querySelector("input");
    const listEl = root.querySelector(".list");
    const metaEl = root.querySelector(".meta");
    const emptyEl = root.querySelector(".empty");
    const statusEl = root.querySelector(".status");

    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeSheet();
      }
    };

    activeSheet = {
      host, root, input, listEl, metaEl, emptyEl, statusEl,
      videoId, items: [], onKeyDown,
    };
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) closeSheet();
    });
    document.addEventListener("keydown", onKeyDown, true);
    input.addEventListener("input", renderSheetRows);
    input.focus({ preventScroll: true });

    statusEl.textContent = "Loading playlists…";
    try {
      activeSheet.items = await fetchSaveSheetItems(videoId);
      if (activeSheet) {
        statusEl.textContent = "";
        renderSheetRows();
      }
    } catch (err) {
      if (activeSheet) {
        statusEl.textContent = "Couldn't load playlists. Try again later.";
        console.warn("[ytpf] Playlist fetch failed:", err);
      }
    }
  }

  function installSaveInterceptor() {
    document.addEventListener(
      "click",
      (event) => {
        // Only own clicks while a sheet isn't already open.
        const hit = activeSheet ? null : findSaveTriggerTarget(event);
        if (!hit) return;

        if (hit.kind === "more-actions") {
          // Don't block the menu opening; arm a one-shot capture listener so
          // the overflow menu's plain "Save" item routes to our sheet.
          const swallow = (e) => {
            const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
            const item = path.find((n) => n instanceof Element && isOverflowSaveItem(n));
            document.removeEventListener("click", swallow, true);
            if (!item) return;
            if (!isLoggedIn()) return; // signed-out: native sign-in flow
            const videoId = getCurrentVideoId();
            if (!videoId) return;
            e.preventDefault();
            e.stopPropagation();
            openSheet(videoId);
          };
          document.addEventListener("click", swallow, true);
          setTimeout(() => document.removeEventListener("click", swallow, true), 15_000);
          return;
        }

        if (!isLoggedIn()) return; // signed-out: let YouTube show its sign-in flow
        const videoId = getCurrentVideoId();
        if (!videoId) return;
        event.preventDefault();
        event.stopPropagation();
        openSheet(videoId);
      },
      true,
    );
  }

  function start() {
    if (!document.body) {
      requestAnimationFrame(start);
      return;
    }

    _bodyObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          const element = mutationElement(node);
          if (!element) continue;
          queryAllDeep("#__ytpf_observe_only__", element);
          if (element.matches?.("script") || element.querySelector?.("script")) {
            _innertubeConfigCache = null;
          }
        }
      }
      if (shouldRefreshFromMutations(mutations)) {
        enqueueReconcile("mutation", TIMINGS.RECONCILE_DEBOUNCE_MS);
      }
    });
    observeMutationRoot(document.body);
    queryAllDeep("#__ytpf_observe_only__", document.body);
    startThemeObserver();

    // Purge legacy diagnostics that could contain playlist titles/IDs/HTML.
    document.documentElement.removeAttribute("data-ytpf-diag");
    try { chrome?.storage?.local?.remove(DIAG_STORAGE_KEY); } catch {}

    refresh();

    _onNavigateFinish = () => {
      _innertubeConfigCache = null;
      enqueueReconcile("navigate", TIMINGS.NAVIGATE_SETTLE_MS);
    };
    _onPageDataUpdated = () => {
      _innertubeConfigCache = null;
      enqueueReconcile("page-data", TIMINGS.RECONCILE_DEBOUNCE_MS);
    };

    window.addEventListener("yt-navigate-finish", _onNavigateFinish);
    window.addEventListener("yt-page-data-updated", _onPageDataUpdated);

    installSaveInterceptor();
  }

  start();

  // Inert in the browser; src/test-search.js sets __YTPF_TEST__ before eval.
  if (typeof globalThis !== "undefined" && typeof globalThis.__YTPF_TEST__ === "function") {
    globalThis.__YTPF_TEST__({
      buildHighlightFragment,
      getHighlightRanges,
      createUnifiedIndex,
      applyHighlight,
      normalizeText,
      parseQueryTerms,
      BM25_SEARCH_OPTIONS,
      parseAddToPlaylist,
      getCurrentVideoId,
      getInnertubeConfig,
      // Page-surface probes — exposed so tests/test-feed-page-mount.mjs can
      // assert that collectFeedPageSurface returns a non-empty surface on a
      // captured /feed/playlists DOM. This is the regression coverage that
      // would have caught the post-2026 lockup-view-model selector drift.
      collectFeedPageSurface,
      findMountPoint,
      probePageSurface,
      isPlaylistsFeedPage,
    });
  }
})();
