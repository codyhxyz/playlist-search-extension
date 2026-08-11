// Modules imported here are bundled into src/content.bundle.js via esbuild
// (see esbuild.config.mjs). Chrome's MV3 content-script loader cannot resolve
// ES module imports at runtime, so the bundle is what actually gets injected
// — this file is the source entry point, not the loaded artifact.
import {
  MODAL_HOST_SELECTOR,
  MODAL_ROW_SELECTOR,
  PLAYLISTS_GRID_SELECTOR,
  PLAYLISTS_CONTENTS_SELECTOR,
  PLAYLISTS_OUTER_ROW_SELECTOR,
  PLAYLIST_RENDERER_SELECTOR,
  PLAYLISTS_FEED_PATH_RE,
  PLAYLIST_LINK_SELECTOR,
  CHECKBOX_SELECTOR,
  MODAL_RELEVANT_SELECTOR,
  PAGE_RELEVANT_SELECTOR,
  ITEM_TEXT_SELECTOR,
  CHIP_ROW_SELECTORS,
  CHIP_ROW_WRAPPER_CLASS,
} from "./lib/selectors.js";
import {
  parsePlaylistRenderers as parsePlaylistRenderersPure,
} from "./lib/innertube-parse.js";
import {
  getRowPlaylistId,
  isSaveVideoModal,
  extractTitleFromPolymerData,
} from "./lib/dom-parse.js";

(() => {
  "use strict";

  /**
   * Per-host controller. One per active modal/page surface. Lives in the
   * `controllers` Map, keyed by host element. Disposed by teardownHost().
   *
   * Adding a field? Initialize it in attachHost(). Reading a field? Trust
   * that attachHost set it — if tsc says otherwise, attachHost missed an
   * init path.
   *
   * @typedef {object} Ctrl
   * @property {Element} host                Outer host element (modal sheet / page grid contents).
   * @property {"modal" | "page"} surface    Where this controller lives.
   * @property {Element[]} rows              Current DOM rows being filtered.
   * @property {MiniSearch | null} bm25      MiniSearch index over rows + API playlists.
   * @property {Playlist[] | null} apiPlaylists  Account-scoped API snapshot used by this index.
   * @property {string | null} apiAccountKey Account identity for apiPlaylists.
   * @property {string | null} apiPendingAccountKey Account currently being fetched.
   * @property {string} targetVideoId        Modal-owned video target; never guessed from unrelated links.
   * @property {string[]} rowFingerprints    Row-content snapshot for recycled DOM detection.
   * @property {Element} root                Our injected filter-bar UI root.
   * @property {HTMLInputElement} input      The search input.
   * @property {HTMLButtonElement} clear     The clear (×) button.
   * @property {HTMLElement} meta            The "N of M" meta element (page surface only).
   * @property {Element | null} parent       Row container — where synth rows get appended.
   * @property {boolean} sortResults         Whether matched rows reorder to the top.
   * @property {Element[]} synthRows         API-only synthetic rows we injected.
   * @property {number} apiToken             Counter that invalidates late API responses on teardown.
   * @property {Element | null | undefined} scrollContainer  Cached scroll target (modal only).
   * @property {((e: Event) => void) | null} modalClickGuard  Keep-dialog-open listener to remove on teardown.
   * @property {string} lastQuery            Previous query string (for empty→non-empty transitions).
   */

  /** @typedef {{ id: string, title: string, itemCount: number }} Playlist */

  const HIDDEN_CLASS = "ytpf-hidden";
  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";
  const MODAL_EXPANDED_CLASS = "ytpf-modal-expanded";
  const MODAL_INLINE_CLASS = "ytpf-inline-modal";
  const DARK_THEME_CLASS = "ytpf-theme-dark";
  const MODAL_API_RESULTS_LIMIT = 24;
  const ROW_MATCH_CLASS = "ytpf-row-match";
  const SYNTH_DONE_CLASS = "ytpf-synth-done";
  // Material "playlist_add" — the same glyph YouTube uses for its own
  // Save-to-playlist affordance across the watch page action bar. Keeps the
  // synth-row action button visually consistent with native YouTube UI without
  // mimicking the row's checkbox metaphor (which would lie about behavior:
  // synth rows can't reflect membership state without an extra API roundtrip).
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
    // Used after every applyFilter / save / state-flip in the modal: long
    // enough to cover YouTube's reactive paint of the row we just touched.
    SUPPRESS_MUTATIONS_AFTER_UI_OP_MS: 160,
    // On input focus we suppress for a longer window: the user is about to
    // type, mutations from our own re-renders shouldn't steal focus back.
    SUPPRESS_MUTATIONS_ON_FOCUS_MS: 300,
    // After yt-navigate-finish, wait for YouTube to settle its SPA render
    // before re-running refresh(). Empirically 250ms covers /feed/* mounts.
    NAVIGATE_SETTLE_MS: 250,
    // How long to wait after attach before we conclude the filter bar / page
    // surface failed to mount and we should record a diagnostic.
    MOUNT_CHECK_DELAY_MS: 2500,
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

  const MODAL_STYLES = `
    .ytpf-inline-modal {
      /* The modal control is mounted before YouTube's list container, not as
         another list item. Keep it in normal flow so it reserves its own row
         instead of sharing the first playlist's grid slot. */
      position: static;
      top: auto;
      z-index: auto;
      box-sizing: border-box;
      width: 100%;
      flex: 0 0 auto;
      padding: 6px 12px 8px;
      border-bottom-color: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.08));
    }
    .ytpf-inline-modal .ytpf-row {
      gap: 6px;
    }
    .ytpf-inline-modal .ytpf-input {
      height: 32px;
      border-radius: 16px;
      padding: 0 28px 0 10px;
      font-size: 13px;
    }
    .ytpf-inline-modal .ytpf-meta {
      display: none;
    }
  `;

  const MODAL_EXPANDED_STYLES = `
    .ytpf-modal-expanded #playlists,
    .ytpf-modal-expanded #contents,
    .ytpf-modal-expanded yt-checkbox-list-renderer,
    .ytpf-modal-expanded yt-list-view-model,
    .ytpf-modal-expanded [role='listbox'] {
      max-height: min(68vh, 720px) !important;
      overflow-y: auto !important;
    }
    .ytpf-modal-expanded tp-yt-paper-dialog,
    .ytpf-modal-expanded.yt-contextual-sheet-layout,
    yt-contextual-sheet-layout.ytpf-modal-expanded {
      max-height: min(84vh, 860px) !important;
    }
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

  const SYNTH_STYLES = `
    .ytpf-synth-row {
      display: flex;
      align-items: center;
      padding: 6px 16px 6px 20px;
      min-height: 40px;
      cursor: pointer;
    }
    .ytpf-synth-row:hover {
      background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.05));
    }
    .ytpf-synth-row:has(.ytpf-synth-done) {
      cursor: default;
    }
    .ytpf-synth-action {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      border: none;
      background: transparent;
      cursor: pointer;
      border-radius: 50%;
      color: var(--yt-spec-text-secondary, #606060);
      padding: 0;
    }
    .ytpf-synth-action:hover {
      color: var(--yt-spec-text-primary, #0f0f0f);
    }
    .ytpf-synth-action svg {
      width: 20px;
      height: 20px;
    }
    .ytpf-synth-action:disabled {
      opacity: 0.4;
      cursor: default;
    }
    .ytpf-synth-action.ytpf-synth-done {
      color: var(--yt-spec-call-to-action, #065fd4);
      cursor: default;
    }
    .ytpf-synth-title {
      flex: 1;
      min-width: 0;
      color: var(--yt-spec-text-primary, #0f0f0f);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      line-height: 20px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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

  const ALL_STYLES = [FILTER_BASE_STYLES, MODAL_STYLES, MODAL_EXPANDED_STYLES, PAGE_STYLES, SYNTH_STYLES, CHIP_STYLES].join("\n");

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
  let _lifecycleObserver = null;
  let _themeObserver = null;
  let _onThemeMediaChange = null;
  let _onNavigateFinish = null;
  let _onPageDataUpdated = null;
  const _observedMutationRoots = new WeakSet();
  const invalidatedModalSessions = new WeakSet();
  const ROOT_MUTATION_OPTIONS = { childList: true, subtree: true };
  const LIFECYCLE_MUTATION_OPTIONS = {
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["hidden", "aria-hidden", "open", "opened", "style", "class"],
  };
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

  function createUnifiedIndex(rows, apiPlaylists) {
    if (typeof MiniSearch !== "function") return null;

    const index = new MiniSearch({
      fields: ["text"],
      storeFields: ["source", "ref"],
      searchOptions: BM25_SEARCH_OPTIONS,
    });

    const docs = [];

    rows.forEach((row, i) => {
      docs.push({
        id: `dom:${i}`,
        text: getItemText(row),
        source: "dom",
        ref: String(i),
      });
    });

    if (Array.isArray(apiPlaylists) && apiPlaylists.length) {
      const domIds = new Set();
      const anonymousTitleCounts = new Map();
      rows.forEach((row) => {
        const id = getRowPlaylistId(row);
        if (id) {
          domIds.add(id);
          return;
        }
        const title = getItemText(row);
        if (title) anonymousTitleCounts.set(title, (anonymousTitleCounts.get(title) || 0) + 1);
      });

      apiPlaylists.forEach((pl) => {
        if (domIds.has(pl.id)) return;
        const t = normalizeText(pl.title || "");
        const anonymousMatches = anonymousTitleCounts.get(t) || 0;
        if (t && anonymousMatches > 0) {
          // ponytail: ID-less view-model rows can only be reconciled by stable
          // title order; replace this with IDs if YouTube exposes them again.
          anonymousTitleCounts.set(t, anonymousMatches - 1);
          return;
        }
        docs.push({
          id: `api:${pl.id}`,
          text: t,
          source: "api",
          ref: pl.id,
        });
      });
    }

    index.addAll(docs);
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
          return {
            source: "dom",
            row,
            score: 1000 - at,
            terms: query.split(" ").filter(Boolean),
          };
        })
        .filter(Boolean);
    }

    const results = ctrl.bm25.search(query, BM25_SEARCH_OPTIONS);
    const matches = [];
    const seen = new Set();
    const apiMap = buildApiPlaylistMap(ctrl.apiPlaylists);

    results.forEach((result) => {
      const key = `${result.source}:${result.ref}`;
      if (seen.has(key)) return;
      seen.add(key);

      const terms = Array.isArray(result.terms)
        ? result.terms.map(normalizeText).filter(Boolean)
        : [];

      if (result.source === "dom") {
        const row = ctrl.rows[Number(result.ref)];
        if (!row) {
          console.warn("[ytpf] BM25 ref dom:%s has no matching row (stale index?)", result.ref);
          return;
        }
        matches.push({ source: "dom", row, score: Number(result.score) || 0, terms });
      } else {
        const playlist = apiMap.get(result.ref);
        if (!playlist) {
          console.warn("[ytpf] BM25 API ref was not present in the account snapshot");
          return;
        }
        matches.push({ source: "api", playlist, score: Number(result.score) || 0, terms });
      }
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

  function fingerprintRows(rows) {
    return rows.map((row) => getRowTextFingerprint(row, getRawItemText(row)));
  }

  function sameValues(a, b) {
    return a.length === b.length && a.every((value, i) => value === b[i]);
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

  function refreshLifecycleObservation(hosts) {
    if (!_lifecycleObserver) return;
    _lifecycleObserver.disconnect();
    const seen = new Set();
    for (const host of hosts) {
      for (let node = host; node && node !== document.body; node = composedParent(node)) {
        if (seen.has(node)) continue;
        seen.add(node);
        _lifecycleObserver.observe(node, LIFECYCLE_MUTATION_OPTIONS);
      }
    }
  }

  function isOurUiNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === STYLE_ID) return true;
    if (node.classList.contains(FILTER_CLASS)) return true;
    if (node.closest(`.${FILTER_CLASS}`)) return true;
    if (node.classList.contains("ytpf-synth-row")) return true;
    if (node.closest(".ytpf-synth-row")) return true;
    return false;
  }

  function nativeModalRowForEvent(event, ctrl) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
    const trackedRows = new Set(ctrl.rows);
    for (const node of path) {
      if (!(node instanceof Element)) continue;
      if (!trackedRows.has(node) && !node.matches(MODAL_ROW_SELECTOR)) continue;
      if (isOurUiNode(node) || node.classList.contains("ytpf-synth-row")) return null;
      return node;
    }
    return null;
  }

  function nodeTouchesRelevantSurface(node) {
    if (!(node instanceof Element)) return false;
    if (isOurUiNode(node)) return false;

    for (const host of controllers.keys()) {
      if (composedContains(host, node)) return true;
    }

    if (node.matches(MODAL_RELEVANT_SELECTOR)) return true;
    if (hasDeepMatch(node, MODAL_RELEVANT_SELECTOR)) return true;
    if (closestComposed(node, MODAL_HOST_SELECTOR)) return true;

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

  function lifecycleMutationInvalidates(mutation) {
    if (mutation.type !== "attributes") return false;
    const target = mutationElement(mutation.target);
    if (!target) return false;
    const name = mutation.attributeName;
    const lifecycleAttribute = ["hidden", "aria-hidden", "open", "opened"].includes(name);
    const looksHidden = (value) => /display\s*:\s*none|visibility\s*:\s*hidden/i.test(value || "");
    const hiddenStyleChanged = name === "style" &&
      looksHidden(mutation.oldValue) !== looksHidden(target.getAttribute("style"));
    const oldClasses = new Set((mutation.oldValue || "").split(/\s+/).filter(Boolean));
    const newClasses = new Set((target.getAttribute("class") || "").split(/\s+/).filter(Boolean));
    const lifecycleClassChanged = name === "class" &&
      ["iron-overlay-opened", "opening", "closing", "hidden"].some(
        (token) => oldClasses.has(token) !== newClasses.has(token),
      );
    if (!lifecycleAttribute && !hiddenStyleChanged && !lifecycleClassChanged) return false;

    let invalidated = false;
    for (const [host, ctrl] of controllers) {
      if (ctrl.surface === "modal" && composedContains(target, host)) {
        invalidatedModalSessions.add(host);
        invalidated = true;
      }
    }
    return invalidated;
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

  function findLikelyRow(checkbox, host) {
    const explicit = closestComposed(checkbox, MODAL_ROW_SELECTOR);
    if (explicit && composedContains(host, explicit)) return explicit;

    let node = checkbox;
    for (let depth = 0; depth < 10 && node; depth += 1) {
      const parent = node.parentElement;
      if (!parent || parent === document.body) break;

      const siblings = Array.from(parent.children);
      const siblingRows = siblings.filter((sibling) =>
        sibling.querySelector(CHECKBOX_SELECTOR),
      );

      if (siblingRows.length >= 2) {
        return node;
      }

      if (parent === host) break;
      node = parent;
    }

    return checkbox.parentElement || null;
  }

  function collectRows(host) {
    // Drop any row that is a descendant of another matched row. The new save
    // modal nests yt-list-item-view-model inside toggleable-list-item-view-model
    // and both match MODAL_ROW_SELECTOR; keeping the outer wrapper means
    // hideRow() actually collapses the visible row instead of leaving an empty
    // shell behind.
    const dropNested = (rows) =>
      rows.filter((row) => !rows.some((other) => other !== row && composedContains(other, row)));

    const directRows = dropNested(unique(queryAllDeep(MODAL_ROW_SELECTOR, host))).filter(
      (row) =>
        (isVisible(row) || isRowHidden(row)) && getItemText(row).length > 0,
    );

    if (directRows.length) return directRows;

    const checkboxes = queryAllDeep(CHECKBOX_SELECTOR, host);
    if (!checkboxes.length) return [];

    const genericRows = unique(
      checkboxes
        .map((checkbox) => findLikelyRow(checkbox, host))
        .filter((row) => row && (isVisible(row) || isRowHidden(row))),
    ).filter((row) => {
      const text = getItemText(row);
      return text.length >= 1 && text.length <= 300;
    });

    if (genericRows.length < 2) return [];
    return genericRows;
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

  function findMountPoint(rows, host, surface) {
    if (surface === "page") {
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
    }

    if (surface === "modal" && rows[0]?.parentElement) {
      const rowParent = rows[0].parentElement;
      const listContainer = closestComposed(
        rows[0],
        "#playlists, #contents, yt-checkbox-list-renderer, yt-list-view-model, [role='listbox']",
      );

      // Modern Save sheets lay playlist rows in a grid. Injecting our section
      // as the grid's first child can place it in the same visual slot as the
      // first playlist (search/title/thumbnail overlap). Mount immediately
      // before the list instead, so the sheet's normal block/flex flow reserves
      // a dedicated row. Retain the old insertion point for legacy hosts where
      // there is no distinct list wrapper.
      if (listContainer?.parentElement && listContainer !== host) {
        return {
          parent: listContainer.parentElement,
          before: listContainer,
        };
      }

      return {
        parent: rowParent,
        before: rows[0],
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

  /**
   * Magnifying-glass icon for the chip variant. Inline SVG (16x16) sized to
   * match the chip-view-model icon slot. Stroke uses currentColor so it
   * picks up the chip's text color in both light and dark themes.
   */
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
   * @param {"modal" | "page"} surface
   * @param {"modal" | "grid" | "chip"} [variant]
   */
  function createInlineFilterUi(surface, variant) {
    const resolvedVariant = variant || (surface === "modal" ? "modal" : "grid");

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
    } else if (surface === "page") {
      inline.classList.add("ytpf-inline-page");
    } else {
      inline.classList.add(MODAL_INLINE_CLASS);
    }
    setFilterThemeClass(inline);

    // Chip variant uses <label> so clicks anywhere in the chip (icon, padding)
    // proxy focus to the wrapped input via native label semantics — no for=
    // needed when the input is nested. Other variants keep <div> to preserve
    // historical behavior (modal/page rows don't want padding-click focus).
    const row = document.createElement(resolvedVariant === "chip" ? "label" : "div");
    row.className = "ytpf-row";

    const input = document.createElement("input");
    input.className = "ytpf-input";
    input.type = "text";
    const label = surface === "page" ? "Filter playlists" : "Search playlists";
    input.placeholder = label;
    input.setAttribute("aria-label", label);
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
    if (surface !== "modal" && resolvedVariant !== "chip") {
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

  function guardModalUiInteractions(ui, surface) {
    if (surface !== "modal") return;

    const stop = (event) => {
      event.stopPropagation();
    };

    [
      "click",
      "mousedown",
      "mouseup",
      "pointerdown",
      "pointerup",
      "touchstart",
      "touchend",
      "dblclick",
      "auxclick",
      "contextmenu",
      "tap",
      "keydown",
      "keyup",
      "keypress",
      "focus",
      "focusin",
    ].forEach((type) => {
      ui.root.addEventListener(type, stop);
    });
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

  async function innertubeSaveVideo(playlistId, videoId, session) {
    const data = await innertubeRequest("browse/edit_playlist", {
      playlistId,
      actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: videoId }],
    }, session);
    if (data?.status !== "STATUS_SUCCEEDED") {
      throw new Error("Failed to save video to playlist");
    }
    return data;
  }

  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  const validVideoId = (value) => VIDEO_ID_RE.test(String(value || "")) ? String(value) : "";

  function getCurrentVideoId(host) {
    const data = host?.data || host?.__data;
    const fromModal = validVideoId(data?.videoId || data?.data?.videoId);
    if (fromModal) return fromModal;

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

  // accountKey -> videoId -> playlistId -> shared operation
  const synthSaveOperations = new Map();

  function getSynthSaveOperation(accountKey, videoId, playlistId) {
    return synthSaveOperations.get(accountKey)?.get(videoId)?.get(playlistId) || null;
  }

  function beginSynthSave(accountKey, videoId, playlistId, save) {
    let byVideo = synthSaveOperations.get(accountKey);
    if (!byVideo) synthSaveOperations.set(accountKey, byVideo = new Map());
    let byPlaylist = byVideo.get(videoId);
    if (!byPlaylist) byVideo.set(videoId, byPlaylist = new Map());
    const existing = byPlaylist.get(playlistId);
    if (existing) return existing;

    const removeOperation = () => {
      if (byPlaylist.get(playlistId) === operation) byPlaylist.delete(playlistId);
      if (!byPlaylist.size) byVideo.delete(videoId);
      if (!byVideo.size) synthSaveOperations.delete(accountKey);
    };
    const operation = { status: "pending", promise: Promise.resolve() };
    byPlaylist.set(playlistId, operation);
    try {
      operation.promise = Promise.resolve(save()).then(() => {
        operation.status = "done";
        const hasLiveOwner = [...controllers.values()].some(
          (ctrl) => ctrl.apiAccountKey === accountKey && ctrl.targetVideoId === videoId,
        );
        if (!hasLiveOwner) removeOperation();
      }, (error) => {
        removeOperation();
        throw error;
      });
    } catch (error) {
      removeOperation();
      operation.promise = Promise.reject(error);
    }
    return operation;
  }

  function paintSynthAction(action, operation) {
    const pending = operation?.status === "pending";
    const done = operation?.status === "done";
    action.disabled = Boolean(pending || done);
    action.classList.toggle(SYNTH_DONE_CLASS, Boolean(done));
    action.innerHTML = done ? ICON_CHECK : ICON_PLUS;
    if (pending) action.setAttribute("aria-busy", "true");
    else action.removeAttribute("aria-busy");
  }

  function clearCompletedSynthOperations(ctrl) {
    const byVideo = synthSaveOperations.get(ctrl.apiAccountKey);
    const byPlaylist = byVideo?.get(ctrl.targetVideoId);
    if (!byPlaylist) return;
    for (const [playlistId, operation] of byPlaylist) {
      if (operation.status === "done") byPlaylist.delete(playlistId);
    }
    if (!byPlaylist.size) byVideo.delete(ctrl.targetVideoId);
    if (!byVideo.size) synthSaveOperations.delete(ctrl.apiAccountKey);
  }

  function clearSynthRows(ctrl) {
    ctrl.synthRows.forEach((el) => el.remove());
    ctrl.synthRows = [];
  }

  function renderSynthRows(ctrl, apiMatches, query) {
    if (ctrl.surface !== "modal") return;

    clearSynthRows(ctrl);

    if (!query || !apiMatches.length) return;
    if (!ctrl.parent?.isConnected) {
      recordDiagnostic("synth_parent_disconnected", { apiMatches: apiMatches.length });
      return;
    }

    const limited = apiMatches.slice(0, MODAL_API_RESULTS_LIMIT);
    const synthTerms = parseQueryTerms(query);

    limited.forEach((match) => {
      try {
        const playlist = match.playlist;
        const label = playlist.title || "Untitled";

        const row = document.createElement("div");
        row.className = "ytpf-synth-row";

        const action = document.createElement("button");
        action.type = "button";
        action.className = "ytpf-synth-action";
        action.setAttribute("aria-label", `Save video to ${label}`);

        const title = document.createElement("span");
        title.className = "ytpf-synth-title";

        const paintTitle = () => {
          const rs = getHighlightRanges(label, synthTerms);
          if (rs.length) title.replaceChildren(buildHighlightFragment(label, rs));
          else title.textContent = label;
        };
        paintTitle();

        const videoId = ctrl.targetVideoId || getCurrentVideoId(ctrl.host);
        if (videoId && !ctrl.targetVideoId) ctrl.targetVideoId = videoId;
        let operation = ctrl.apiAccountKey && videoId
          ? getSynthSaveOperation(ctrl.apiAccountKey, videoId, playlist.id)
          : null;
        paintSynthAction(action, operation);
        if (!videoId || !ctrl.apiAccountKey) action.disabled = true;

        const repaint = () => {
          if (action.isConnected) paintSynthAction(action, operation);
        };
        if (operation?.status === "pending") {
          operation.promise.then(repaint, () => {
            operation = null;
            repaint();
          });
        }

        const handleSave = () => {
          const session = getInnertubeConfig(true);
          const targetVideoId = ctrl.targetVideoId || getCurrentVideoId(ctrl.host);
          if (!targetVideoId || !ctrl.apiAccountKey || session.accountKey !== ctrl.apiAccountKey) {
            console.warn("[ytpf] Refusing synthetic save with stale account or video identity");
            bootstrapModalApi(ctrl);
            return;
          }

          ctrl.targetVideoId = targetVideoId;
          suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);
          operation = beginSynthSave(
            ctrl.apiAccountKey,
            targetVideoId,
            playlist.id,
            () => innertubeSaveVideo(playlist.id, targetVideoId, session),
          );
          paintSynthAction(action, operation);
          operation.promise.then(() => {
            suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);
            repaint();
          }).catch((err) => {
            console.warn("[ytpf] Save to playlist failed:", err);
            suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);
            operation = null;
            repaint();
          });
        };

        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");

        row.addEventListener("click", (e) => {
          e.stopPropagation();
          if (!action.classList.contains(SYNTH_DONE_CLASS) && !action.disabled) handleSave();
        });
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            if (!action.classList.contains(SYNTH_DONE_CLASS) && !action.disabled) handleSave();
          }
        });

        row.appendChild(action);
        row.appendChild(title);
        if (!ctrl.parent?.isConnected) return;
        ctrl.parent.appendChild(row);
        ctrl.synthRows.push(row);
      } catch (err) {
        console.warn("[ytpf] synth row failed", err);
      }
    });

    if (limited.length > 0 && ctrl.synthRows.length === 0) {
      recordDiagnostic("synth_rows_none_rendered", { attempted: limited.length });
    }
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

  async function bootstrapModalApi(ctrl) {
    if (ctrl.surface !== "modal" || !isLoggedIn()) return;
    const session = getInnertubeConfig(true);
    if (!session.accountKey || ctrl.apiPendingAccountKey === session.accountKey) return;
    const token = (ctrl.apiToken || 0) + 1;
    ctrl.apiToken = token;
    ctrl.apiPendingAccountKey = session.accountKey;

    try {
      const playlists = await loadAllPlaylists(session);
      if (
        ctrl.apiToken === token &&
        controllers.get(ctrl.host) === ctrl &&
        getInnertubeConfig(true).accountKey === session.accountKey
      ) {
        ctrl.apiPlaylists = playlists;
        ctrl.apiAccountKey = session.accountKey;
        ctrl.bm25 = createUnifiedIndex(ctrl.rows, playlists);
        applyFilter(ctrl);
      }
    } catch (err) {
      if (ctrl.apiToken === token) console.warn("[ytpf] Playlist fetch failed:", err);
    } finally {
      if (ctrl.apiToken === token && ctrl.apiPendingAccountKey === session.accountKey) {
        ctrl.apiPendingAccountKey = null;
      }
    }
  }

  function findModalScrollContainer(ctrl) {
    const seen = new Set();
    const candidates = [];

    function add(node) {
      if (node instanceof Element && composedContains(ctrl.host, node) && !seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    }

    add(ctrl.rows[0]?.parentElement);
    add(ctrl.rows[0]);
    for (const el of queryAllDeep("#playlists, #contents, [role='listbox'], yt-checkbox-list-renderer, yt-list-view-model", ctrl.host)) {
      add(el);
    }
    add(ctrl.host);

    // Walk up to 5 levels above ctrl.host before giving up. The new view-model
    // save modal scrolls at yt-sheet-view-model (the host's parent), so a
    // host-bounded walk would always return null and we'd lose the scroll-to-
    // top-on-first-keystroke behavior — leaving users staring at the bottom
    // of the list with their matches reordered out of sight at the top.
    // 5 levels is enough to cross the sheet wrapper without escaping into
    // page chrome (where returning <body> would scroll the whole page).
    const ABOVE_HOST_LIMIT = 5;
    for (const candidate of candidates) {
      let node = candidate;
      let stepsAboveHost = 0;
      let pastHost = false;
      while (node && node instanceof Element && node !== document.body) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY || "";
        if (node.scrollHeight - node.clientHeight > 12 && (overflowY === "auto" || overflowY === "scroll")) {
          return node;
        }
        if (pastHost && ++stepsAboveHost > ABOVE_HOST_LIMIT) break;
        if (node === ctrl.host) pastHost = true;
        node = composedParent(node);
      }
    }

    return null;
  }

  function teardownHost(host) {
    const ctrl = controllers.get(host);
    if (!ctrl) return;

    ctrl.apiToken = (ctrl.apiToken || 0) + 1;
    clearSynthRows(ctrl);
    clearCompletedSynthOperations(ctrl);

    ctrl.rows.forEach((row) => {
      showRow(row);
      restoreHighlight(row);
    });
    if (ctrl.surface === "modal") {
      ctrl.host.classList.remove(MODAL_EXPANDED_CLASS);
      if (ctrl.modalClickGuard) {
        ctrl.host.removeEventListener("click", ctrl.modalClickGuard);
      }
    }
    ctrl.root.remove();

    controllers.delete(host);
    _filterBarMountChecked.delete(host);

    // Keep the global observers alive even when the last current controller is
    // gone. YouTube modals are transient; disconnecting here would make the
    // extension miss the next Save-to-playlist open in the same tab.
  }

  function applyFilter(ctrl) {
    const query = normalizeText(ctrl.input.value);
    const isModal = ctrl.surface === "modal";

    if (isModal && ctrl.host?.isConnected) {
      const freshRows = collectRows(ctrl.host).filter(
        (row) => closestComposed(row, MODAL_HOST_SELECTOR) === ctrl.host,
      );
      const fingerprints = fingerprintRows(freshRows);
      if (
        freshRows.length &&
        (!sameRows(freshRows, ctrl.rows) || !sameValues(fingerprints, ctrl.rowFingerprints))
      ) {
        const nextSet = new Set(freshRows);
        ctrl.rows.forEach((row) => {
          if (!nextSet.has(row)) {
            showRow(row);
            restoreHighlight(row);
          }
        });
        ctrl.rows = freshRows;
        ctrl.rowFingerprints = fingerprints;
        ctrl.bm25 = createUnifiedIndex(freshRows, ctrl.apiPlaylists);
        ctrl.parent = freshRows[0]?.parentElement || ctrl.parent;
        ctrl.scrollContainer = findModalScrollContainer(ctrl);
      }
    }

    const fullSet = ctrl.rows;

    suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);

    const allMatches = query
      ? searchUnified(ctrl, query)
      : fullSet.map((row) => ({ source: "dom", row, score: 0, terms: [] }));

    const domMatches = allMatches.filter((m) => m.source === "dom");
    const apiMatches = allMatches.filter((m) => m.source === "api");

    const domMatchSet = new Set(domMatches.map((m) => m.row));
    fullSet.forEach((row) => {
      if (domMatchSet.has(row)) {
        showRow(row);
      } else {
        hideRow(row);
        restoreHighlight(row);
      }
    });

    const scrollContainer = isModal ? (ctrl.scrollContainer ?? null) : null;

    if (query && ctrl.sortResults && ctrl.parent?.isConnected) {
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

      const matchedRows = domMatches.map((m) => m.row);
      const matchedSet = new Set(matchedRows);
      const orderedRows = [
        ...matchedRows,
        ...fullSet.filter((row) => !matchedSet.has(row)),
      ];
      orderedRows.forEach((row) => {
        if (row.parentElement === ctrl.parent) {
          ctrl.parent.appendChild(row);
        }
      });

      if (scrollContainer) {
        scrollContainer.scrollTop = scrollTop;
      }
    }

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
    if (ctrl.surface === "page" && ctrl.host?.classList) {
      const filtering = Boolean(query);
      const hostChildren = Array.from(ctrl.host.children || []);
      const hasRichGridRows = hostChildren.some((child) => child.matches?.("ytd-rich-grid-row"));
      const hasDirectPlaylistLockups = hostChildren.some((child) =>
        child.matches?.("ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model"),
      );
      const enoughRoomForSafeCards = window.innerWidth >= 760;
      ctrl.host.classList.toggle("ytpf-page-filtering", filtering);
      ctrl.host.classList.toggle(
        "ytpf-page-filtering-rows",
        filtering && hasRichGridRows && !hasDirectPlaylistLockups && enoughRoomForSafeCards,
      );
    }

    // Only snap to top on the empty -> non-empty transition (the user just
    // started searching). Snapping on every keystroke masks the visible
    // reranking of matches — they move to the top, but the scroll reset
    // makes it look like nothing is changing.
    if (query && scrollContainer && !ctrl.lastQuery) {
      scrollContainer.scrollTop = 0;
    }
    ctrl.lastQuery = query;

    if (ctrl.surface === "page") {
      const safeTotal = Math.max(0, ctrl.rows.length);
      const safeVisible = Math.max(0, domMatches.length);
      ctrl.input.placeholder = `Filter ${safeTotal} playlists`;
      ctrl.meta.textContent = query ? `${safeVisible} of ${safeTotal}` : "";
    }

    if (isModal) renderSynthRows(ctrl, apiMatches, query);
  }

  /**
   * @param {Element} host
   * @param {Element[]} rows
   * @param {"modal" | "page"} [surface]
   */
  function attachHost(host, rows, surface = "modal") {
    /** @type {{parent: Element, before?: Element|null, after?: Element|null} | null} */
    let mount = null;
    /** @type {"modal" | "grid" | "chip"} */
    let variant;

    if (surface === "page") {
      // Prefer the native chip-bar mount: looks like a YouTube control, takes
      // zero extra vertical space, inherits chip spacing for free. Falls back
      // to the historic full-width grid mount when no chip bar is present
      // (channel pages we don't target today, or future YT redesigns that
      // drop the chip bar entirely). The grid mount is the failsafe; do NOT
      // remove it until both rollouts are universal AND we have telemetry
      // confirming the chip bar is always present.
      //
      // We APPEND (rightmost) rather than prepend: native YT chips on the left
      // are the primary navigation/filter selectors ("All", "Music", …). Mounting
      // our search at the trailing edge reads as a refinement on top of whatever
      // chip the user picked, not as competing primary navigation.
      const chipRow = findChipRow();
      if (chipRow) {
        mount = { parent: chipRow, before: null };
        variant = "chip";
      } else {
        mount = findMountPoint(rows, host, "page");
        variant = "grid";
      }
    } else {
      mount = findMountPoint(rows, host, surface);
      variant = "modal";
    }

    if (!mount) return;
    ensureScopedStyles(mount.parent.getRootNode?.() || document);

    const ui = createInlineFilterUi(surface, variant);
    guardModalUiInteractions(ui, surface);
    /** @type {((e: Event) => void) | null} */
    let modalClickGuard = null;
    if (surface === "modal") {
      host.classList.add(MODAL_EXPANDED_CLASS);

      // Keep-dialog-open is unconditional: this is a power-user extension and
      // YouTube's Oct-2025 auto-close-on-select breaks multi-select, which is
      // the entire point of having a search bar over the playlist list. The
      // dialog closes only when the user clicks outside it (YouTube's normal
      // backdrop dismissal). Do NOT add a setting for this — it's a taste call,
      // documented in README.md "Behavior" and CHANGELOG. Synth rows (our own
      // API results) are excluded because they handle saving without closing.
      modalClickGuard = (e) => {
        const current = controllers.get(host);
        if (current?.surface !== "modal" || !nativeModalRowForEvent(e, current)) return;
        // Bubble phase: YouTube's native row toggle runs first; only the
        // ancestor sheet-close handler is blocked.
        // ponytail: propagation cannot split handlers if YouTube moves both
        // actions onto this same host; the fixture test must catch that change.
        e.stopPropagation();
      };
      host.addEventListener("click", modalClickGuard);
    }

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
      surface,
      rows,
      bm25: createUnifiedIndex(rows, null),
      apiPlaylists: null,
      apiAccountKey: null,
      apiPendingAccountKey: null,
      targetVideoId: surface === "modal" ? getCurrentVideoId(host) : "",
      rowFingerprints: fingerprintRows(rows),
      root: ui.root,
      input: ui.input,
      clear: ui.clear,
      meta: ui.meta,
      parent: rows[0]?.parentElement || null,
      sortResults: surface === "modal",
      synthRows: [],
      apiToken: 0,
      scrollContainer: undefined,
      modalClickGuard,
      lastQuery: "",
    };

    if (surface === "modal") {
      ctrl.scrollContainer = findModalScrollContainer(ctrl);
    }

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

    if (surface === "modal") {
      const liveCtrl = controllers.get(host);
      if (liveCtrl) bootstrapModalApi(liveCtrl);

      // Opening Save is an explicit search intent: put the caret in the filter
      // without requiring a second click. Two animation frames let YouTube
      // finish mounting/focusing its sheet before we claim focus; the final
      // microtask makes our focus the last action in that render turn.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          queueMicrotask(() => {
            const current = controllers.get(host);
            if (current?.root === ui.root && ui.input.isConnected && isVisible(host)) {
              ui.input.focus({ preventScroll: true });
            }
          });
        });
      });
    }
  }

  /**
   * @param {Element} host
   * @param {Element[]} rows
   * @param {"modal" | "page"} [surface]
   */
  function upsertHost(host, rows, surface = "modal") {
    if (!rows.length) return;
    const existing = controllers.get(host);

    if (!existing) {
      attachHost(host, rows, surface);
      return;
    }

    if (!existing.root.isConnected) {
      teardownHost(host);
      attachHost(host, rows, surface);
      return;
    }

    if (existing.surface !== surface) {
      teardownHost(host);
      attachHost(host, rows, surface);
      return;
    }

    const targetVideoId = surface === "modal" ? getCurrentVideoId(host) : "";
    if (existing.targetVideoId && targetVideoId && existing.targetVideoId !== targetVideoId) {
      teardownHost(host);
      attachHost(host, rows, surface);
      return;
    }
    if (!existing.targetVideoId && targetVideoId) existing.targetVideoId = targetVideoId;

    let accountChanged = false;
    if (surface === "modal" && existing.apiAccountKey) {
      const accountKey = getInnertubeConfig().accountKey;
      if (accountKey !== existing.apiAccountKey) {
        existing.apiToken += 1;
        clearCompletedSynthOperations(existing);
        existing.apiPlaylists = null;
        existing.apiAccountKey = null;
        existing.apiPendingAccountKey = null;
        existing.bm25 = createUnifiedIndex(existing.rows, null);
        clearSynthRows(existing);
        accountChanged = true;
      }
    }

    const fingerprints = fingerprintRows(rows);
    if (sameRows(existing.rows, rows) && sameValues(existing.rowFingerprints, fingerprints)) {
      if (accountChanged) applyFilter(existing);
      if (surface === "modal" && !existing.apiPlaylists) bootstrapModalApi(existing);
      return;
    }

    const nextSet = new Set(rows);
    existing.rows.forEach((row) => {
      if (!nextSet.has(row)) {
        showRow(row);
        restoreHighlight(row);
      }
    });
    existing.rows = rows;
    existing.rowFingerprints = fingerprints;
    existing.bm25 = createUnifiedIndex(rows, existing.apiPlaylists);
    existing.parent = rows[0]?.parentElement || existing.parent;
    existing.sortResults = surface === "modal";
    applyFilter(existing);
    if (surface === "modal" && !existing.apiPlaylists) bootstrapModalApi(existing);
  }

  // Safety net for the "filter bar gone, cards still hidden" lock-in.
  // If a controller ever gets dropped without its teardown showing all rows
  // (cached SPA navigation, racing re-renders), .ytpf-hidden nodes can
  // outlive their controller. Each refresh tick, unhide any tagged row that
  // no active controller still claims, and clear stale page-filtering
  // classes on any element that isn't a live page-surface host.
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

  // Returns false for old-style Polymer renderers that are serving a bulk
  // playlist operation ("Add all to…") rather than a single-video save.
  // Those renderers have no data.videoId; legitimate video-save invocations
  // always carry one.  Defaults to true for new-style view-model sheets
  // (guarded structurally by the yt-collection-thumbnail-view-model selector).
  // isSaveVideoModal now lives in src/lib/dom-parse.js — imported at top.

  function refresh() {
    // A close/open transition can reuse the exact same host and row objects.
    // Teardown is the session reset; discovery below reattaches if already open.
    for (const [host, ctrl] of [...controllers]) {
      if (ctrl.surface === "modal" && invalidatedModalSessions.has(host)) {
        invalidatedModalSessions.delete(host);
        teardownHost(host);
      }
    }

    syncFilterThemeClasses();
    sweepOrphanedHidden();

    const modalCandidates = queryAllDeep(MODAL_HOST_SELECTOR);
    refreshLifecycleObservation(modalCandidates);
    const modalHosts = modalCandidates.filter(isVisible).filter(isSaveVideoModal);
    modalHosts.forEach((host) => {
      const allRows = collectRows(host);
      if (!allRows.length) return;
      // One physical dialog can match nested generic hosts. Its rows belong to
      // the nearest composed host, so only that host gets a controller/bar.
      const rows = allRows.filter((row) => closestComposed(row, MODAL_HOST_SELECTOR) === host);
      if (!rows.length) {
        teardownHost(host);
        return;
      }
      upsertHost(host, rows, "modal");
      scheduleFilterBarMountCheck(host);
    });

    const pageSurface = collectFeedPageSurface();
    if (pageSurface) {
      upsertHost(pageSurface.host, pageSurface.rows, "page");
    } else if (isPlaylistsFeedPage()) {
      schedulePageSurfaceProbe();
    }

    for (const [host, ctrl] of [...controllers]) {
      if (!host.isConnected) {
        teardownHost(host);
        continue;
      }
      if (ctrl.surface === "page") {
        if (!pageSurface || pageSurface.host !== host || !isVisible(host)) teardownHost(host);
        continue;
      }

      // YouTube reuses contextual-sheet elements for unrelated menus.
      const stillSaveModal =
        isVisible(host) &&
        host.matches(MODAL_HOST_SELECTOR) &&
        isSaveVideoModal(host) &&
        modalHosts.includes(host);
      if (!stillSaveModal) teardownHost(host);
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

  const _filterBarMountChecked = new WeakSet();
  function scheduleFilterBarMountCheck(host) {
    if (_filterBarMountChecked.has(host)) return;
    _filterBarMountChecked.add(host);
    setTimeout(() => {
      if (!host.isConnected) return;
      const mounted =
        host.querySelector?.(`.${FILTER_CLASS}`) ||
        queryAllDeep(`.${FILTER_CLASS}`, host).length > 0;
      if (mounted) return;
      recordDiagnostic("filter_bar_missing", {
        host: host.tagName?.toLowerCase() || "unknown",
        rowCount: collectRows(host).length,
      });
    }, TIMINGS.MOUNT_CHECK_DELAY_MS);
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
    _lifecycleObserver = new MutationObserver((mutations) => {
      let invalidated = false;
      for (const mutation of mutations) {
        invalidated = lifecycleMutationInvalidates(mutation) || invalidated;
      }
      if (invalidated || shouldRefreshFromMutations(mutations)) {
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
  }

  start();

  // Inert in the browser; src/test-search.js sets __YTPF_TEST__ before eval.
  if (typeof globalThis !== "undefined" && typeof globalThis.__YTPF_TEST__ === "function") {
    globalThis.__YTPF_TEST__({
      buildHighlightFragment,
      getHighlightRanges,
      createUnifiedIndex,
      renderSynthRows,
      applyHighlight,
      normalizeText,
      parseQueryTerms,
      BM25_SEARCH_OPTIONS,
      MODAL_HOST_SELECTOR,
      getCurrentVideoId,
      getInnertubeConfig,
      beginSynthSave,
      getSynthSaveOperation,
      nativeModalRowForEvent,
      // Page-surface probes — exposed so tests/test-feed-page-mount.js can
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
