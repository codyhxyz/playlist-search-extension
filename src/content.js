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
   * @property {Element} root                Our injected filter-bar UI root.
   * @property {HTMLInputElement} input      The search input.
   * @property {HTMLButtonElement} clear     The clear (×) button.
   * @property {HTMLElement} meta            The "N of M" meta element (page surface only).
   * @property {Element | null} parent       Row container — where synth rows get appended.
   * @property {boolean} sortResults         Whether matched rows reorder to the top.
   * @property {Element[]} synthRows         API-only synthetic rows we injected.
   * @property {number} apiToken             Counter that invalidates late API responses on teardown.
   * @property {Element | null | undefined} scrollContainer  Cached scroll target (modal only).
   * @property {string} lastQuery            Previous query string (for empty→non-empty transitions).
   */

  /** @typedef {{ id: string, title: string, itemCount: number }} Playlist */

  const HIDDEN_CLASS = "ytpf-hidden";
  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";
  const MODAL_EXPANDED_CLASS = "ytpf-modal-expanded";
  const MODAL_INLINE_CLASS = "ytpf-inline-modal";
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
    // Synth-row error message visibility before reverting to the +/check icon.
    SYNTH_ERROR_FADEOUT_MS: 2000,
    // How long to wait after attach before we conclude the filter bar / page
    // surface failed to mount and we should record a diagnostic.
    MOUNT_CHECK_DELAY_MS: 2500,
    // Cooldown between page-surface probes per pathname, so SPA navigations
    // re-arm but mutation-driven refresh churn doesn't spam the ring.
    PAGE_SURFACE_PROBE_COOLDOWN_MS: 4000,
  };

  // Self-only diagnostics: when an in-product invariant fails we console.warn
  // it live and append a short entry to a bounded ring buffer in
  // chrome.storage.local for later inspection. Nothing leaves the machine.
  // To read the ring in the devtools console (from a youtube.com tab):
  //   chrome.storage.local.get("ytpfDiagnostics", (v) => console.table(v.ytpfDiagnostics))
  const DIAG_STORAGE_KEY = "ytpfDiagnostics";
  const DIAG_RING_SIZE = 20;
  const DIAG_THROTTLE_MS = 30_000;
  const DIAG_HTML_SNAPSHOT_MAX = 10_000;

  let _innertubeConfig = null;
  function getInnertubeConfig() {
    if (_innertubeConfig) return _innertubeConfig;
    for (const script of document.getElementsByTagName("script")) {
      const text = script.textContent;
      if (text.length > 500000 || !text.includes("INNERTUBE_API_KEY")) continue;
      const keyMatch = text.match(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/);
      const verMatch = text.match(/"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/);
      if (keyMatch) {
        _innertubeConfig = {
          apiKey: keyMatch[1],
          clientVersion: verMatch?.[1] || INNERTUBE_CLIENT_VERSION_FALLBACK,
        };
        return _innertubeConfig;
      }
    }
    return { apiKey: INNERTUBE_API_KEY_FALLBACK, clientVersion: INNERTUBE_CLIENT_VERSION_FALLBACK };
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
      background-color: rgba(255, 255, 0, 0.4) !important;
      color: inherit !important;
      border-radius: 2px;
      padding: 0 1px;
    }
    .ytpf-row-match {}
  `;

  const MODAL_STYLES = `
    .ytpf-inline-modal {
      padding: 6px 12px 4px;
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
    .ytpf-page-filtering {
      display: grid !important;
      grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)) !important;
      gap: 16px !important;
    }
    .ytpf-page-filtering > ytd-rich-grid-row,
    .ytpf-page-filtering > ytd-rich-grid-row > #contents {
      display: contents !important;
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

  const ALL_STYLES = [FILTER_BASE_STYLES, MODAL_STYLES, MODAL_EXPANDED_STYLES, PAGE_STYLES, SYNTH_STYLES].join("\n");

  // Per-row state, keyed on the row element. Held weakly so GC reclaims when
  // YouTube tears down its DOM. Previously these were two separate WeakMaps
  // (textCache, hiddenRows); collapsed to reduce top-level surface.
  // labelHtmlCache stays separate because it keys on LABEL elements, which
  // have a different lifetime from rows (a row can swap its label).
  const rowState = new WeakMap(); // row → { text?: string, hidden?: boolean }
  const labelHtmlCache = new WeakMap();

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
  let _onNavigateFinish = null;
  let _onPageDataUpdated = null;
  const apiSessionCache = {
    playlists: null,
    fetchedAt: 0,
    inFlight: null, // Promise<Playlist[]> | null — set while a fetch is mid-air
  };

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

  // Pause the reconciler from acting on mutation-driven enqueues for `ms`.
  // Used at five sites where we're about to cause our own DOM changes that
  // would otherwise re-enter refresh(): synth row insert, save success/fail,
  // filter pass, input focus. Navigate/page-data signals bypass this pause.
  function suppressMutations(ms = TIMINGS.SUPPRESS_MUTATIONS_DEFAULT_MS) {
    reconciler.pauseUntil = Math.max(reconciler.pauseUntil, nowMs() + ms);
  }

  function enqueueReconcile(reason, debounceMs = TIMINGS.RECONCILE_DEBOUNCE_MS) {
    // Mutation-driven enqueues respect the suppression window. Other reasons
    // (navigate, page-data) are user-intent signals — bypass.
    if (reason === "mutation" && nowMs() < reconciler.pauseUntil) return;

    const fireAt = nowMs() + debounceMs;
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
    }, debounceMs);
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
    let cur = node;
    while (cur) {
      if (cur.matches?.(selector)) return cur;
      if (cur.parentElement) {
        cur = cur.parentElement;
        continue;
      }
      const root = cur.getRootNode?.();
      cur = root instanceof ShadowRoot ? root.host : null;
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
      rows.forEach((row) => {
        const id = getRowPlaylistId(row);
        if (id) domIds.add(id);
      });
      // Only dedup by playlist ID, never by title. Title-based dedup caused
      // exact-match playlists (e.g. "Favorites") to be silently excluded
      // when a DOM row shared the same normalized text.
      apiPlaylists.forEach((pl) => {
        if (domIds.has(pl.id)) return;
        const t = normalizeText(pl.title || "");
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

  function buildApiPlaylistMap() {
    const map = new Map();
    (apiSessionCache.playlists || []).forEach((pl) => map.set(pl.id, pl));
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
    const apiMap = buildApiPlaylistMap();

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
          console.warn("[ytpf] BM25 ref api:%s not in playlist cache", result.ref);
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

  function isOurUiNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === STYLE_ID) return true;
    if (node.classList.contains(FILTER_CLASS)) return true;
    if (node.closest(`.${FILTER_CLASS}`)) return true;
    if (node.classList.contains("ytpf-synth-row")) return true;
    if (node.closest(".ytpf-synth-row")) return true;
    return false;
  }

  function nodeTouchesRelevantSurface(node) {
    if (!(node instanceof Element)) return false;
    if (isOurUiNode(node)) return false;

    if (node.matches(MODAL_RELEVANT_SELECTOR)) return true;
    if (node.querySelector(MODAL_RELEVANT_SELECTOR)) return true;
    if (node.closest(MODAL_HOST_SELECTOR)) return true;

    if (!isPlaylistsFeedPage()) return false;
    if (node.matches(PAGE_RELEVANT_SELECTOR)) return true;
    if (node.querySelector(PAGE_RELEVANT_SELECTOR)) return true;
    if (node.closest(PLAYLISTS_GRID_SELECTOR)) return true;
    return false;
  }

  function shouldRefreshFromMutations(mutations) {
    // Suppression is now checked inside enqueueReconcile(reason="mutation"),
    // not here — this filter is purely "is the mutation relevant?".
    for (const mutation of mutations) {
      if (nodeTouchesRelevantSurface(mutation.target)) return true;
      for (const node of mutation.addedNodes) {
        if (nodeTouchesRelevantSurface(node)) return true;
      }
      for (const node of mutation.removedNodes) {
        if (nodeTouchesRelevantSurface(node)) return true;
      }
    }
    return false;
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest("[hidden], [aria-hidden='true']")) return false;

    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;

    if (el.getClientRects().length > 0) return true;

    const children = el.children;
    for (let i = 0; i < Math.min(children.length, 10); i++) {
      if (children[i].getClientRects().length > 0) return true;
    }

    return false;
  }

  function getItemText(row) {
    const s = rowStateFor(row);
    if (typeof s.text === "string") return s.text;

    // Polymer-data branch — see extractTitleFromPolymerData in dom-parse.js
    // for the full list of shapes we know about. When YouTube ships a new
    // title shape, that's the function to update + add a test for.
    const dataTitle = extractTitleFromPolymerData(row.data || row.__data);
    if (dataTitle) {
      const text = normalizeText(dataTitle);
      s.text = text;
      return text;
    }

    const label = row.querySelector(ITEM_TEXT_SELECTOR);
    const rawText = (
      label?.textContent ||
      row.getAttribute("aria-label") ||
      row.getAttribute("title") ||
      ""
    );
    const text = normalizeText(rawText);

    s.text = text;
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
    if (!labelHtmlCache.has(label)) {
      labelHtmlCache.set(label, label.innerHTML);
    }
  }

  function restoreHighlight(row) {
    row.classList.remove(ROW_MATCH_CLASS);
    const label = getLabelElement(row);
    if (!label) return;
    const original = labelHtmlCache.get(label);
    if (original === undefined) return;
    if (label.innerHTML !== original) {
      label.innerHTML = original;
    }
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

    // Restore first so we work from clean DOM each time
    const original = labelHtmlCache.get(label);
    if (original !== undefined && label.innerHTML !== original) {
      label.innerHTML = original;
    }

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
    const explicit = checkbox.closest(MODAL_ROW_SELECTOR);
    if (explicit && host.contains(explicit)) return explicit;

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
      rows.filter((row) => !rows.some((other) => other !== row && other.contains(row)));

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
    if (outer && contents.contains(outer)) return outer;
    if (node.matches?.(PLAYLISTS_OUTER_ROW_SELECTOR) && contents.contains(node)) {
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
      return {
        parent: rows[0].parentElement,
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

  function createInlineFilterUi(surface) {
    const root = document.createElement("section");
    root.className = FILTER_CLASS;
    if (surface === "page") {
      root.classList.add("ytpf-inline-page");
    } else {
      root.classList.add(MODAL_INLINE_CLASS);
    }

    const row = document.createElement("div");
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
    row.appendChild(inputWrap);

    const meta = document.createElement("span");
    meta.className = "ytpf-meta";
    meta.setAttribute("aria-live", "polite");

    root.appendChild(row);
    if (surface !== "modal") {
      root.appendChild(meta);
    }

    return {
      root,
      input,
      clear,
      meta,
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

  async function innertubeRequest(endpoint, body) {
    const auth = await getSapisidHash();
    if (!auth) {
      recordDiagnostic("innertube_no_sapisid", { endpoint });
      throw new Error("Not signed in to YouTube");
    }

    const { apiKey, clientVersion } = getInnertubeConfig();

    let response;
    try {
      response = await fetch(
        `https://www.youtube.com/youtubei/v1/${endpoint}?key=${apiKey}&prettyPrint=false`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: auth,
            "X-Goog-AuthUser": "0",
            "X-Origin": "https://www.youtube.com",
          },
          body: JSON.stringify({
            context: {
              client: {
                clientName: "WEB",
                clientVersion,
                hl: document.documentElement.lang || "en",
              },
            },
            ...body,
          }),
        },
      );
    } catch (err) {
      // Network-level failure (offline, DNS, CORS shim, etc.). Distinct from
      // HTTP-level failure handled below.
      recordDiagnostic("innertube_network_error", {
        endpoint,
        message: String(err?.message || err).slice(0, 200),
      });
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
  // wrapper threads the shape-canary callback into recordDiagnostic so any new
  // renderer YouTube ships surfaces in chrome.storage.local.ytpfDiagnostics
  // the FIRST time it appears in the wild — even on mid-rollouts where SOME
  // items still parse via known shapes. That's the 1.6.9 regression class the
  // canary's "fire on unknown keys" trigger is sized to catch.
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

  async function innertubeLoadPlaylists() {
    const byId = new Map();
    let token = null;

    let data = await innertubeRequest("browse", {
      browseId: "FEplaylist_aggregation",
    });

    for (let page = 0; page < 50; page += 1) {
      const { playlists, continuation } = parsePlaylistRenderers(data);
      for (const pl of playlists) {
        if (!byId.has(pl.id)) byId.set(pl.id, pl);
      }
      token = continuation;
      if (!token) break;
      data = await innertubeRequest("browse", { continuation: token });
    }

    return [...byId.values()];
  }

  async function innertubeSaveVideo(playlistId, videoId) {
    const data = await innertubeRequest("browse/edit_playlist", {
      playlistId,
      actions: [{ action: "ACTION_ADD_VIDEO", addedVideoId: videoId }],
    });
    if (data?.status !== "STATUS_SUCCEEDED") {
      throw new Error("Failed to save video to playlist");
    }
    return data;
  }

  function getCurrentVideoId(host) {
    const fromWatch = new URLSearchParams(window.location.search).get("v");
    if (fromWatch) return fromWatch;

    const shortsMatch = window.location.pathname.match(/^\/shorts\/([a-zA-Z0-9_-]{6,})/);
    if (shortsMatch?.[1]) return shortsMatch[1];

    const watchFlexy = document.querySelector("ytd-watch-flexy[video-id]");
    const fromWatchFlexy = watchFlexy?.getAttribute("video-id");
    if (fromWatchFlexy) return fromWatchFlexy;

    const fromHost = host?.querySelector?.("[video-id]")?.getAttribute?.("video-id");
    if (fromHost) return fromHost;

    const watchLink = host?.querySelector?.("a[href*='/watch?v=']") ||
      document.querySelector("a[href*='/watch?v=']");
    if (watchLink?.href) {
      try {
        const parsed = new URL(watchLink.href, window.location.origin);
        const value = parsed.searchParams.get("v");
        if (value) return value;
      } catch {
        // ignore malformed links
      }
    }

    return "";
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
      recordDiagnostic("synth_parent_disconnected", {
        apiMatches: apiMatches.length,
        query,
      });
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
        action.innerHTML = ICON_PLUS;
        action.setAttribute("aria-label", `Save video to ${label}`);

        const title = document.createElement("span");
        title.className = "ytpf-synth-title";

        const paintTitle = () => {
          const rs = getHighlightRanges(label, synthTerms);
          if (rs.length) title.replaceChildren(buildHighlightFragment(label, rs));
          else title.textContent = label;
        };
        paintTitle();

        const handleSave = () => {
          const videoId = getCurrentVideoId(ctrl.host);
          if (!videoId) {
            console.warn("[ytpf] Could not determine video ID for save action");
            action.innerHTML = ICON_PLUS;
            title.style.color = "var(--yt-spec-text-secondary, #aaa)";
            title.textContent = "Could not find video ID";
            setTimeout(() => {
              title.style.color = "";
              paintTitle();
            }, TIMINGS.SYNTH_ERROR_FADEOUT_MS);
            return;
          }

          suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);
          action.disabled = true;
          innertubeSaveVideo(playlist.id, videoId)
            .then(() => {
              suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);
              action.disabled = false;
              action.innerHTML = ICON_CHECK;
              action.classList.add(SYNTH_DONE_CLASS);
            })
            .catch((err) => {
              console.warn("[ytpf] Save to playlist failed:", err);
              suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);
              action.disabled = false;
              action.innerHTML = ICON_PLUS;
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
        console.warn("[ytpf] synth row failed", match?.playlist?.id, err);
      }
    });

    if (limited.length > 0 && ctrl.synthRows.length === 0) {
      recordDiagnostic("synth_rows_none_rendered", {
        attempted: limited.length,
        query,
      });
    }
  }

  async function loadAllPlaylists() {
    const now = Date.now();
    if (
      apiSessionCache.playlists &&
      now - apiSessionCache.fetchedAt < PLAYLIST_CACHE_TTL_MS
    ) {
      return apiSessionCache.playlists;
    }
    // Promise-singleton: if a fetch is already mid-air, join it instead of
    // kicking off a duplicate 50-page InnerTube walk. Two simultaneous modal
    // hosts (or a modal-open during page-load) used to double-fetch.
    if (apiSessionCache.inFlight) {
      return apiSessionCache.inFlight;
    }
    const promise = (async () => {
      try {
        const playlists = await innertubeLoadPlaylists();
        apiSessionCache.playlists = playlists;
        apiSessionCache.fetchedAt = Date.now();
        return playlists;
      } finally {
        apiSessionCache.inFlight = null;
      }
    })();
    apiSessionCache.inFlight = promise;
    return promise;
  }

  async function bootstrapModalApi(ctrl) {
    if (ctrl.surface !== "modal") return;
    if (!isLoggedIn()) return;
    const token = (ctrl.apiToken || 0) + 1;
    ctrl.apiToken = token;

    try {
      await loadAllPlaylists();
    } catch (err) {
      console.warn("[ytpf] Playlist fetch failed:", err);
    } finally {
      if (ctrl.apiToken === token) {
        ctrl.bm25 = createUnifiedIndex(ctrl.rows, apiSessionCache.playlists);
        applyFilter(ctrl);
      }
    }
  }

  function findModalScrollContainer(ctrl) {
    const seen = new Set();
    const candidates = [];

    function add(node) {
      if (node instanceof Element && ctrl.host.contains(node) && !seen.has(node)) {
        seen.add(node);
        candidates.push(node);
      }
    }

    add(ctrl.rows[0]?.parentElement);
    add(ctrl.rows[0]);
    for (const el of ctrl.host.querySelectorAll("#playlists, #contents, [role='listbox'], yt-checkbox-list-renderer")) {
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
        node = node.parentElement;
      }
    }

    return null;
  }

  function teardownHost(host) {
    const ctrl = controllers.get(host);
    if (!ctrl) return;

    ctrl.apiToken = (ctrl.apiToken || 0) + 1;
    clearSynthRows(ctrl);

    ctrl.rows.forEach((row) => {
      showRow(row);
      restoreHighlight(row);
    });
    if (ctrl.surface === "modal") {
      ctrl.host.classList.remove(MODAL_EXPANDED_CLASS);
    }
    ctrl.root.remove();

    controllers.delete(host);

    if (controllers.size === 0) {
      if (_bodyObserver) {
        _bodyObserver.disconnect();
        _bodyObserver = null;
      }
      if (_onNavigateFinish) {
        window.removeEventListener("yt-navigate-finish", _onNavigateFinish);
        _onNavigateFinish = null;
      }
      if (_onPageDataUpdated) {
        window.removeEventListener("yt-page-data-updated", _onPageDataUpdated);
        _onPageDataUpdated = null;
      }
    }
  }

  function applyFilter(ctrl) {
    const query = normalizeText(ctrl.input.value);
    const isModal = ctrl.surface === "modal";

    if (isModal && ctrl.host?.isConnected) {
      const freshRows = collectRows(ctrl.host);
      if (freshRows.length > ctrl.rows.length) {
        const nextSet = new Set(freshRows);
        ctrl.rows.forEach((row) => {
          if (!nextSet.has(row)) {
            showRow(row);
            restoreHighlight(row);
          }
        });
        ctrl.rows = freshRows;
        ctrl.bm25 = createUnifiedIndex(freshRows, isModal ? apiSessionCache.playlists : null);
        ctrl.parent = freshRows[0]?.parentElement || ctrl.parent;
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
    // instead of floating inside their original row slots.
    if (ctrl.surface === "page" && ctrl.host?.classList) {
      ctrl.host.classList.toggle("ytpf-page-filtering", Boolean(query));
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

    if (isModal) {
      renderSynthRows(ctrl, apiMatches, query);
      checkForVisibleDuplicates(ctrl);
    }
  }

  /**
   * @param {Element} host
   * @param {Element[]} rows
   * @param {"modal" | "page"} [surface]
   */
  function attachHost(host, rows, surface = "modal") {
    const mount = findMountPoint(rows, host, surface);
    if (!mount) return;
    ensureScopedStyles(mount.parent.getRootNode?.() || document);

    const ui = createInlineFilterUi(surface);
    guardModalUiInteractions(ui, surface);
    if (surface === "modal") {
      host.classList.add(MODAL_EXPANDED_CLASS);

      // Keep-dialog-open is unconditional: this is a power-user extension and
      // YouTube's Oct-2025 auto-close-on-select breaks multi-select, which is
      // the entire point of having a search bar over the playlist list. The
      // dialog closes only when the user clicks outside it (YouTube's normal
      // backdrop dismissal). Do NOT add a setting for this — it's a taste call,
      // documented in README.md "Behavior" and CHANGELOG. Synth rows (our own
      // API results) are excluded because they handle saving without closing.
      host.addEventListener("click", (e) => {
        const target = /** @type {Element | null} */ (e.target);
        const row = target?.closest?.(
          "toggleable-list-item-view-model, ytd-playlist-add-to-option-renderer, yt-playlist-add-to-option-renderer"
        );
        if (!row || isOurUiNode(row) || row.classList.contains("ytpf-synth-row")) return;
        e.stopPropagation();
      });
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
      bm25: createUnifiedIndex(rows, surface === "modal" ? apiSessionCache.playlists : null),
      root: ui.root,
      input: ui.input,
      clear: ui.clear,
      meta: ui.meta,
      parent: rows[0]?.parentElement || null,
      sortResults: surface === "modal",
      synthRows: [],
      apiToken: 0,
      scrollContainer: undefined,
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
      setTimeout(() => {
        const liveCtrl = controllers.get(host);
        if (liveCtrl) {
          bootstrapModalApi(liveCtrl);
        }
        ui.input.focus({ preventScroll: true });
      }, 0);
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

    if (sameRows(existing.rows, rows)) {
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
    existing.bm25 = createUnifiedIndex(rows, existing.surface === "modal" ? apiSessionCache.playlists : null);
    existing.parent = rows[0]?.parentElement || existing.parent;
    existing.sortResults = surface === "modal";
    applyFilter(existing);
    if (surface === "modal") {
      if (!apiSessionCache.playlists) {
        bootstrapModalApi(existing);
      }
    }
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
    document.querySelectorAll(`.${HIDDEN_CLASS}`).forEach((el) => {
      if (!tracked.has(el)) showRow(el);
    });
    document.querySelectorAll(".ytpf-page-filtering").forEach((el) => {
      if (!liveHosts.has(el)) el.classList.remove("ytpf-page-filtering");
    });
  }

  // Returns false for old-style Polymer renderers that are serving a bulk
  // playlist operation ("Add all to…") rather than a single-video save.
  // Those renderers have no data.videoId; legitimate video-save invocations
  // always carry one.  Defaults to true for new-style view-model sheets
  // (guarded structurally by the yt-collection-thumbnail-view-model selector).
  // isSaveVideoModal now lives in src/lib/dom-parse.js — imported at top.

  function refresh() {
    sweepOrphanedHidden();

    queryAllDeep(MODAL_HOST_SELECTOR)
      .filter(isVisible)
      .filter(isSaveVideoModal)
      .forEach((host) => {
        const rows = collectRows(host);
        if (!rows.length) return;
        upsertHost(host, rows, "modal");
        scheduleFilterBarMountCheck(host);
      });

    const pageSurface = collectFeedPageSurface();
    if (pageSurface) {
      upsertHost(pageSurface.host, pageSurface.rows, "page");
    } else if (isPlaylistsFeedPage()) {
      // Page surface failed to assemble on a path that should host it. Log a
      // self-diagnostic so the next selector drift doesn't ship silently.
      // Modal had scheduleFilterBarMountCheck for years; the page surface
      // never did, which is exactly how we kept shipping invisible-bar bugs
      // on /feed/playlists. See tests/test-feed-page-mount.js for the
      // jsdom regression coverage that backs this up.
      schedulePageSurfaceProbe();
    }

    // Only tear down controllers whose host element is actually gone.
    // YouTube frequently re-renders the modal's inner list, making collectRows
    // momentarily return empty; if we tore down on that, the filter bar would
    // disappear mid-use with no error (exactly the bug we kept shipping). If
    // the host is still attached, rows will come back on the next refresh —
    // we don't need to rebuild the UI in the meantime. If ui.root itself gets
    // detached, upsertHost's !existing.root.isConnected branch re-attaches it.
    for (const [host, ctrl] of [...controllers]) {
      if (host.isConnected) continue;
      if (ctrl && ctrl.root.contains(document.activeElement)) continue;
      teardownHost(host);
    }
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Pure ring-buffer tail. Extracted so test-search.js can exercise it without
  // a chrome.storage fake. Returns a new array — never mutates the input.
  function appendToRing(ring, entry, maxSize) {
    const next = Array.isArray(ring) ? ring.slice() : [];
    next.push(entry);
    while (next.length > maxSize) next.shift();
    return next;
  }

  const _lastDiagAt = new Map();

  async function recordDiagnostic(invariant, context = {}) {
    try {
      const now = Date.now();
      const prev = _lastDiagAt.get(invariant) || 0;
      if (now - prev < DIAG_THROTTLE_MS) return;
      _lastDiagAt.set(invariant, now);

      let version = "unknown";
      let clientVersion = "unknown";
      try { version = chrome?.runtime?.getManifest?.()?.version || "unknown"; } catch {}
      try { clientVersion = getInnertubeConfig().clientVersion; } catch {}

      const entry = {
        invariant,
        context,
        path: (typeof location !== "undefined" && location.pathname) || "",
        version,
        clientVersion,
        ts: now,
      };
      console.warn(`[ytpf] diagnostic: ${invariant}`, entry);

      if (typeof chrome === "undefined" || !chrome?.storage?.local) return;
      const stored = await chrome.storage.local.get(DIAG_STORAGE_KEY);
      const nextRing = appendToRing(stored[DIAG_STORAGE_KEY], entry, DIAG_RING_SIZE);
      await chrome.storage.local.set({ [DIAG_STORAGE_KEY]: nextRing });
      // Also mirror the latest ring to a DOM dataset attribute so the e2e
      // harness can read it from page-world eval (chrome.storage.local lives
      // in the isolated world, invisible to scripts running in the page).
      // Bounded by DIAG_RING_SIZE * entry-size so dataset stays small.
      try {
        document.documentElement.dataset.ytpfDiag = JSON.stringify(nextRing);
      } catch { /* dataset write must not break recording */ }
    } catch {
      // Recording must never break the extension.
    }
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
      const html = (host.outerHTML || "").slice(0, DIAG_HTML_SNAPSHOT_MAX);
      recordDiagnostic("filter_bar_missing", {
        host: host.tagName?.toLowerCase() || "unknown",
        rowCount: collectRows(host).length,
        htmlTruncated: html.length >= DIAG_HTML_SNAPSHOT_MAX,
        html,
      });
    }, TIMINGS.MOUNT_CHECK_DELAY_MS);
  }

  // Page-surface mirror of scheduleFilterBarMountCheck. Triggered from
  // refresh() when isPlaylistsFeedPage() is true but collectFeedPageSurface()
  // returned null — meaning some gate (grid selector, contents selector,
  // renderer selector, link selector) didn't match the current DOM.
  // Captures one structured probe per path-load and surfaces it both to the
  // console and the diagnostics ring. Keyed by pathname + a 4s cooldown so
  // SPA navigations re-arm but mutation-driven refreshes don't spam.
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
      const sampleHrefs = filtered
        .slice(0, 3)
        .flatMap((r) => Array.from(r.querySelectorAll?.("a[href]") || []))
        .map((a) => a.getAttribute("href"))
        .slice(0, 6);
      return {
        gridTag: grid.tagName?.toLowerCase(),
        contentsId: contents?.id || null,
        contentsExists: !!contents,
        rawRowCount: rawRows.length,
        filteredRowCount: filtered.length,
        firstFilteredRowTag: filtered[0]?.tagName?.toLowerCase() || null,
        sampleHrefs,
      };
    });
    return {
      path: window.location.pathname,
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

  function checkForVisibleDuplicates(ctrl) {
    if (ctrl.surface !== "modal") return;

    const domTitles = new Set();
    ctrl.rows.forEach((row) => {
      if (row.classList?.contains(HIDDEN_CLASS)) return;
      const t = getItemText(row);
      if (t) domTitles.add(t);
    });

    const synthCounts = new Map();
    const collisions = [];
    ctrl.synthRows.forEach((row) => {
      const t = normalizeText(row.textContent || "");
      if (!t) return;
      synthCounts.set(t, (synthCounts.get(t) || 0) + 1);
      if (domTitles.has(t)) collisions.push(t);
    });
    const synthDupes = [...synthCounts.entries()].filter(([, c]) => c > 1);

    if (collisions.length) {
      recordDiagnostic("dom_synth_title_collision", {
        count: collisions.length,
        query: ctrl.lastQuery || "",
        samples: collisions.slice(0, 3),
      });
    }
    if (synthDupes.length) {
      recordDiagnostic("synth_row_duplicates", {
        count: synthDupes.length,
        query: ctrl.lastQuery || "",
        samples: synthDupes.slice(0, 3).map(([title, c]) => ({ title, count: c })),
      });
    }
  }

  function start() {
    if (!document.body) {
      requestAnimationFrame(start);
      return;
    }

    _bodyObserver = new MutationObserver((mutations) => {
      if (shouldRefreshFromMutations(mutations)) {
        enqueueReconcile("mutation", TIMINGS.RECONCILE_DEBOUNCE_MS);
      }
    });
    _bodyObserver.observe(document.body, { childList: true, subtree: true });

    refresh();

    _onNavigateFinish = () => enqueueReconcile("navigate", TIMINGS.NAVIGATE_SETTLE_MS);
    _onPageDataUpdated = () => enqueueReconcile("page-data", TIMINGS.RECONCILE_DEBOUNCE_MS);

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
      appendToRing,
      DIAG_RING_SIZE,
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
