// Modules imported here are bundled into src/content.bundle.js via esbuild
// (see esbuild.config.mjs). Chrome's MV3 content-script loader cannot resolve
// ES module imports at runtime, so the bundle is what actually gets injected
// — this file is the source entry point, not the loaded artifact.
import {
  PLAYLISTS_FEED_PATH_RE,
  FEED_DOM_ANCHORS,
} from "./lib/selectors.js";
import {
  parseAddToPlaylist,
  parsePlaylistRenderers as parsePlaylistRenderersPure,
} from "./lib/innertube-parse.js";

(() => {
  "use strict";

  /**
   * State for the /feed/playlists surface. There is exactly one — the page
   * has one chip bar and one grid — so this is a singleton, not a Map of
   * per-host controllers. (Pre-1.7 there was a `controllers` Map because we
   * scored multiple candidate grids and filtered whichever one won. We no
   * longer read their grid at all, so there is nothing to score.)
   *
   * Neither this nor the save sheet reads YouTube's rendered playlist cards.
   * Both render from the same InnerTube library snapshot.
   *
   * @typedef {object} FeedState
   * @property {Element | null} mount        Anchor 1: chip-bar tablist we mounted into.
   * @property {HTMLElement | null} grid     Anchor 2: YouTube's grid contents, hidden while we show results.
   * @property {boolean} gridHidden          True while we are holding their grid hidden.
   * @property {string | null} gridDisplay   Grid's original inline `display`, captured before we hid it.
   * @property {string | null} gridStyleAttr Grid's original `style` attribute (null when it had none).
   * @property {HTMLElement | null} chip     Our search chip (light DOM, styled like a native chip).
   * @property {HTMLInputElement | null} input
   * @property {HTMLButtonElement | null} clear
   * @property {HTMLElement | null} panelHost  Shadow host for our owned results list.
   * @property {ShadowRoot | null} panelRoot
   * @property {Playlist[]} playlists        InnerTube library snapshot we render from.
   * @property {MiniSearch | null} index     BM25 index over `playlists`.
   * @property {"idle"|"loading"|"ready"|"error"} status
   * @property {string} statusMessage       Human-readable reason for `error`.
   * @property {string} query
   */

  /** @typedef {{ id: string, title: string, itemCount: number, thumbnail?: string }} Playlist */

  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";
  const DARK_THEME_CLASS = "ytpf-theme-dark";
  const FEED_PANEL_HOST_ID = "ytpf-feed-results-host";
  // Cap on rendered result cards. Accounts with thousands of playlists would
  // otherwise pay a full layout pass per keystroke; the tail is never read.
  const FEED_MAX_RESULTS = 120;
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
    // lags the user's typing. Same value used by yt-page-data-updated path.
    RECONCILE_DEBOUNCE_MS: 120,
    // Default ignore-window for our own DOM writes so the observer doesn't
    // bounce-back on insertions we made ourselves (suppressMutations default).
    SUPPRESS_MUTATIONS_DEFAULT_MS: 120,
    // Used after every query pass on the /feed/playlists surface.
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
    // Grace period before an unresolved anchor is reported as broken. YouTube
    // renders /feed/playlists in two paints (chip bar lands after the shell),
    // so an immediate report would fire on every cold navigation.
    MOUNT_CHECK_DELAY_MS: 2500,
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
  // ── Light-DOM styles: our search chip ────────────────────────────────
  // The chip is the ONE piece of our UI that lives in YouTube's light DOM,
  // because it has to look like a native chip and therefore has to inherit
  // YouTube's theme tokens. Everything else we render lives in a shadow root
  // (the results panel below, and the save sheet further down).
  //
  // Sized to a `chip-view-model` chip 1:1: 32px tall, 8px radius,
  // --yt-spec-badge-chip-background fill. `color-scheme: inherit` carries
  // YouTube's scheme into the <input> so the UA doesn't paint a white field
  // on a dark page. The left margin replaces the native chip wrapper's
  // spacing — we used to borrow YouTube's generated
  // `.ytChipBarViewModelChipWrapper` class for that; owning the number is
  // one less build-generated identifier to break on.
  const CHIP_STYLES = `
    .ytpf-inline.ytpf-chip {
      color-scheme: inherit;
      display: inline-flex;
      align-items: center;
      flex: 0 0 auto;
      margin: 0 0 0 12px;
      padding: 0;
      border: none;
      background: transparent;
      box-sizing: border-box;
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
      cursor: text;
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
    .ytpf-chip.ytpf-theme-dark .ytpf-icon {
      color: var(--yt-spec-text-primary, #f1f1f1);
    }
    .ytpf-chip .ytpf-input-wrap {
      position: relative;
      flex: 1;
      min-width: 0;
      display: flex;
      align-items: center;
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
      box-sizing: border-box;
    }
    .ytpf-chip.ytpf-theme-dark .ytpf-input {
      color: var(--yt-spec-text-primary, #f1f1f1);
    }
    .ytpf-chip .ytpf-input::placeholder {
      color: var(--yt-spec-text-secondary, #606060);
    }
    .ytpf-chip .ytpf-input:focus {
      outline: none;
    }
    .ytpf-chip .ytpf-clear {
      display: none;
      flex: 0 0 18px;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: none;
      border-radius: 50%;
      padding: 0;
      background: transparent;
      color: var(--yt-spec-text-secondary, #606060);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }
    .ytpf-chip .ytpf-clear-visible {
      display: inline-flex;
    }
    .ytpf-chip .ytpf-clear:hover {
      background: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1));
      color: var(--yt-spec-text-primary, #0f0f0f);
    }
    .ytpf-chip.ytpf-theme-dark .ytpf-clear:hover {
      background: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.12));
      color: var(--yt-spec-text-primary, #f1f1f1);
    }
  `;

  const ALL_STYLES = CHIP_STYLES;

  // The single /feed/playlists surface. Everything about that page lives
  // here; there is no per-row WeakMap, no hidden-row bookkeeping, and no
  // controller registry, because we no longer own any of YouTube's nodes.
  /** @type {FeedState} */
  const feed = {
    mount: null,
    grid: null,
    gridHidden: false,
    gridDisplay: null,
    gridStyleAttr: null,
    chip: null,
    input: null,
    clear: null,
    panelHost: null,
    panelRoot: null,
    playlists: [],
    index: null,
    status: "idle",
    statusMessage: "",
    query: "",
  };

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
  // writes (mounting the chip, hiding the grid, input focus). Pre-1.6.13 this
  // was three call paths + a free-floating suppressMutationsUntil timestamp.
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
    setFilterThemeClass(feed.chip, dark);
    feed.panelHost?.toggleAttribute("data-ytpf-dark", dark);
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
  // Used where we're about to cause our own DOM changes that would otherwise
  // re-enter refresh(): applying a query (which mounts/hides), and input
  // focus. Navigate/page-data signals bypass this pause.
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

  /**
   * BM25 index over the InnerTube playlist snapshot. Input is data we
   * already own — no DOM reads, no per-row text extraction, no recycled-node
   * fingerprinting. `ref` is the index into `feed.playlists`.
   *
   * @param {Playlist[]} playlists
   */
  function createPlaylistIndex(playlists) {
    if (typeof MiniSearch !== "function") return null;

    const index = new MiniSearch({
      fields: ["text"],
      storeFields: ["ref"],
      searchOptions: BM25_SEARCH_OPTIONS,
    });

    index.addAll(playlists.map((pl, i) => ({
      id: `pl:${i}`,
      text: normalizeText(pl.title),
      ref: String(i),
    })));
    return index;
  }

  /**
   * @param {string} query Already normalized.
   * @returns {{ playlist: Playlist, score: number, terms: string[] }[]}
   */
  function searchPlaylists(query) {
    // Sub-2-char queries: BM25 tokenization is useless, so fall back to a
    // substring scan ranked by match position (earlier match ranks higher).
    if (!feed.index || query.length < 2) {
      const terms = splitTerms(query);
      return feed.playlists
        .map((playlist) => {
          const at = normalizeText(playlist.title).indexOf(query);
          return at < 0 ? null : { playlist, score: 1000 - at, terms };
        })
        .filter(Boolean);
    }

    const matches = [];
    for (const result of feed.index.search(query, BM25_SEARCH_OPTIONS)) {
      const playlist = feed.playlists[Number(result.ref)];
      if (!playlist) {
        console.warn("[ytpf] BM25 ref pl:%s has no playlist (stale index?)", result.ref);
        continue;
      }
      matches.push({
        playlist,
        score: Number(result.score) || 0,
        terms: Array.isArray(result.terms)
          ? result.terms.map(normalizeText).filter(Boolean)
          : [],
      });
    }
    return matches;
  }

  function composedParent(node) {
    if (node?.parentElement) return node.parentElement;
    const root = node?.getRootNode?.();
    return root instanceof ShadowRoot ? root.host : null;
  }

  function isOurUiNode(node) {
    if (!(node instanceof Element)) return false;
    if (node.id === STYLE_ID || node.id === FEED_PANEL_HOST_ID) return true;
    if (node.classList.contains(FILTER_CLASS)) return true;
    if (node.closest(`.${FILTER_CLASS}, #${FEED_PANEL_HOST_ID}`)) return true;
    return false;
  }

  /**
   * A mutation matters only if it could have created or destroyed one of our
   * two anchors. Notably it does NOT matter that YouTube re-rendered a card
   * inside its grid — we don't read their cards, so their churn is not our
   * problem. Pre-1.7 this also matched every playlist renderer and every node
   * inside the grid, which meant a scroll-triggered page of lockups woke the
   * reconciler dozens of times for nothing.
   */
  function nodeTouchesRelevantSurface(node) {
    if (!(node instanceof Element)) return false;
    if (isOurUiNode(node)) return false;
    if (!isPlaylistsFeedPage()) return false;
    return hasDeepMatch(node, FEED_ANCHOR_UNION_SELECTOR);
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

  // Single source of truth for "text + ranges -> highlighted output".
  // Returns a DocumentFragment of text nodes and <mark class="ytpf-mark"> elements.
  // Using text nodes (not innerHTML) means no HTML escaping is needed. Every
  // title we highlight is one we rendered ourselves a moment earlier, so there
  // is no original markup to preserve and nothing to restore afterwards —
  // that whole labelState / recycled-row apparatus went away with the
  // card-filtering architecture.
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

  function hasDeepMatch(node, selector) {
    if (!node) return false;
    // Self-match: when the outer row IS the renderer (e.g., yt-lockup-view-model
    // on the post-2026 /feed/playlists layout), descendant-only checks miss it.
    if (node.matches?.(selector)) return true;
    if (node.querySelector?.(selector)) return true;
    return Boolean(queryAllDeep(selector, node).length);
  }

  // ══ Owned /feed/playlists search surface ═════════════════════════════
  // We do NOT read, index, filter, hide, or reflow YouTube's playlist cards.
  // We already hold the complete library from InnerTube (`loadAllPlaylists`);
  // re-deriving it from their markup was the source of every 1.6.x feed
  // regression. When a query is active we render our own result list and
  // hide their grid; when it's cleared we put their grid back exactly.
  //
  // Total YouTube DOM coupling for this surface: the two selectors in
  // FEED_DOM_ANCHORS. Nothing else on this page is ours to read.

  const FEED_ANCHOR_BY_ID = new Map(FEED_DOM_ANCHORS.map((a) => [a.id, a]));
  const FEED_ANCHOR_UNION_SELECTOR = FEED_DOM_ANCHORS.map((a) => a.selector).join(", ");

  /**
   * Resolve one enumerated anchor, loudly.
   *
   * NO FALLBACKS: if the selector matches nothing visible we return null and
   * the caller renders nothing. Appearing in an unexpected place is a worse
   * failure than not appearing, and a silent wrong-place mount is exactly the
   * class of bug the pre-1.7 `.ytpf-inline-page` fallback produced.
   *
   * Ambiguity is reported too — more than one match means our scoping
   * assumption broke, and picking "the first one" would be a coin flip.
   *
   * @param {string} id  An id from FEED_DOM_ANCHORS.
   * @returns {Element | null}
   */
  function resolveFeedAnchor(id) {
    const anchor = FEED_ANCHOR_BY_ID.get(id);
    if (!anchor) return null;

    // Light DOM first: both anchors are Polymer light-DOM nodes today, and a
    // full TreeWalker sweep of a /feed/playlists page (thousands of nodes,
    // twice per reconcile) is not free. Fall back to the shadow-piercing walk
    // only when the cheap query comes up empty, so a future YouTube move into
    // a shadow root degrades to "slower", not "broken".
    const shallow = Array.from(document.querySelectorAll(anchor.selector));
    const hits = (shallow.length ? shallow : queryAllDeep(anchor.selector))
      .filter((el) => el?.isConnected);
    const visible = hits.filter(isVisible);
    const chosen = visible[0] || null;

    if (!chosen) {
      recordDiagnostic(`feed_anchor_unresolved:${anchor.id}`, {
        selector: anchor.selector,
        purpose: anchor.purpose,
        matched: hits.length,
        visible: 0,
        path: window.location.pathname,
      });
      return null;
    }
    if (visible.length > 1) {
      recordDiagnostic(`feed_anchor_ambiguous:${anchor.id}`, {
        selector: anchor.selector,
        purpose: anchor.purpose,
        visible: visible.length,
        path: window.location.pathname,
      });
    }
    return chosen;
  }

  // ── Our search chip (light DOM, so it can look like a native chip) ────

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
   * Build the search chip. `<label>` wrapper so a click anywhere in the chip
   * (icon, padding) proxies focus to the nested input via native label
   * semantics — no `for=` and no click handler needed.
   *
   * role="search" on the outer element: our chip lives inside YouTube's
   * `[role='tablist']`, and it is emphatically not a tab. Declaring a landmark
   * role keeps assistive tech from announcing it as one.
   */
  function createSearchChip() {
    const chip = document.createElement("span");
    chip.className = `${FILTER_CLASS} ytpf-chip`;
    chip.setAttribute("role", "search");
    setFilterThemeClass(chip);

    const row = document.createElement("label");
    row.className = "ytpf-row";

    const input = document.createElement("input");
    input.className = "ytpf-input";
    input.type = "text";
    input.placeholder = "Search playlists";
    input.setAttribute("aria-label", "Search your playlists");
    input.autocomplete = "off";
    input.spellcheck = false;

    const clear = document.createElement("button");
    clear.className = "ytpf-clear";
    clear.type = "button";
    clear.textContent = "×";
    clear.setAttribute("aria-label", "Clear search");

    const inputWrap = document.createElement("div");
    inputWrap.className = "ytpf-input-wrap";
    inputWrap.append(input, clear);

    row.append(createSearchIcon(), inputWrap);
    chip.appendChild(row);

    input.addEventListener("input", applyFeedQuery);
    input.addEventListener("focus", () => {
      suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_ON_FOCUS_MS);
      ensurePlaylistsLoaded();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && input.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        applyFeedQuery();
      }
    });
    clear.addEventListener("click", () => {
      input.value = "";
      applyFeedQuery();
      input.focus();
    });

    return { chip, input, clear };
  }

  // ── Our results panel (shadow DOM, fully owned) ───────────────────────
  // Same posture as the save sheet: an open shadow root so YouTube's page
  // styles can't reach in and ours can't leak out. Colors come from
  // YouTube's `--yt-spec-*` custom properties, which DO inherit across the
  // shadow boundary, so light/dark tracks the page for free; the
  // `[data-ytpf-dark]` host attribute only picks the right *fallback* values
  // for the case where those tokens are missing.

  const FEED_PANEL_STYLES = `
    :host {
      display: block;
      margin-top: 8px;
      --ytpf-text: var(--yt-spec-text-primary, #0f0f0f);
      --ytpf-muted: var(--yt-spec-text-secondary, #606060);
      --ytpf-line: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.1));
      --ytpf-tile: var(--yt-spec-badge-chip-background, rgba(0, 0, 0, 0.05));
      --ytpf-hover: var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.05));
      font-family: Roboto, Arial, sans-serif;
      color: var(--ytpf-text);
    }
    :host([data-ytpf-dark]) {
      --ytpf-text: var(--yt-spec-text-primary, #f1f1f1);
      --ytpf-muted: var(--yt-spec-text-secondary, #aaa);
      --ytpf-line: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.12));
      --ytpf-tile: var(--yt-spec-badge-chip-background, rgba(255, 255, 255, 0.1));
      --ytpf-hover: var(--yt-spec-10-percent-layer, rgba(255, 255, 255, 0.08));
    }
    :host([hidden]) { display: none; }
    .meta {
      margin: 0 0 12px;
      font-size: 12px;
      color: var(--ytpf-muted);
      font-variant-numeric: tabular-nums;
    }
    .status, .empty {
      margin: 0;
      padding: 24px 0;
      font-size: 14px;
      color: var(--ytpf-muted);
    }
    .grid {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 210px), 1fr));
      gap: 16px 16px;
    }
    .link {
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-decoration: none;
      color: inherit;
      border-radius: 12px;
      padding: 8px;
      margin: -8px;
    }
    .link:hover { background: var(--ytpf-hover); }
    .link:focus-visible {
      outline: 2px solid var(--yt-spec-call-to-action, #065fd4);
      outline-offset: 2px;
    }
    .thumb {
      position: relative;
      display: block;
      width: 100%;
      aspect-ratio: 16 / 9;
      border-radius: 10px;
      overflow: hidden;
      background: var(--ytpf-tile);
      color: var(--ytpf-muted);
    }
    .thumb img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .glyph {
      position: absolute;
      inset: 0;
      margin: auto;
      width: 34px;
      height: 34px;
      opacity: 0.55;
    }
    .count {
      position: absolute;
      right: 6px;
      bottom: 6px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(0, 0, 0, 0.8);
      color: #fff;
      font-size: 11px;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .title {
      font-size: 14px;
      font-weight: 500;
      line-height: 1.35;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
    }
    .sub {
      font-size: 12px;
      color: var(--ytpf-muted);
    }
    mark.ytpf-mark {
      all: unset;
      display: inline;
      background-color: rgba(255, 213, 0, 0.85);
      color: #0f0f0f;
      border-radius: 2px;
      padding: 0 1px;
    }
  `;

  const ICON_PLAYLIST =
    '<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 6h12v2H3V6zm0 4h12v2H3v-2zm0 4h8v2H3v-2zm13-3v7l6-3.5-6-3.5z"/></svg>';

  function ensureFeedPanel() {
    if (feed.panelHost?.isConnected) return feed.panelHost;

    const host = document.createElement("div");
    host.id = FEED_PANEL_HOST_ID;
    host.hidden = true;
    const root = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = FEED_PANEL_STYLES;

    const section = document.createElement("section");
    section.setAttribute("aria-label", "Playlist search results");

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.setAttribute("aria-live", "polite");

    const status = document.createElement("p");
    status.className = "status";
    status.setAttribute("role", "status");
    status.hidden = true;

    const list = document.createElement("ul");
    list.className = "grid";

    const empty = document.createElement("p");
    empty.className = "empty";
    empty.hidden = true;

    section.append(meta, status, list, empty);
    root.append(style, section);

    feed.panelHost = host;
    feed.panelRoot = root;
    return host;
  }

  function panelPart(selector) {
    return feed.panelRoot?.querySelector(selector) || null;
  }

  /**
   * Build one result card. `/playlist?list=<id>` is YouTube's canonical
   * playlist URL and still redirects to whatever they're serving today —
   * constructing it from the ID we already have beats scraping an href.
   *
   * @param {Playlist} playlist
   * @param {string[]} terms Normalized query terms, for highlighting.
   */
  function createResultCard(playlist, terms) {
    const item = document.createElement("li");

    const link = document.createElement("a");
    link.className = "link";
    link.href = `/playlist?list=${encodeURIComponent(playlist.id)}`;

    const thumb = document.createElement("span");
    thumb.className = "thumb";
    // `thumbnail` is optional on the InnerTube snapshot. When it's absent we
    // draw our own tile rather than scraping YouTube's rendered <img> — that
    // would be a third DOM anchor for a decorative pixel.
    if (playlist.thumbnail) {
      const img = document.createElement("img");
      img.src = playlist.thumbnail;
      img.alt = "";
      img.loading = "lazy";
      thumb.appendChild(img);
    } else {
      thumb.innerHTML = ICON_PLAYLIST;
    }
    if (playlist.itemCount) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(playlist.itemCount);
      thumb.appendChild(count);
    }

    const title = document.createElement("span");
    title.className = "title";
    const ranges = getHighlightRanges(playlist.title, terms);
    title.appendChild(buildHighlightFragment(playlist.title, ranges));

    const sub = document.createElement("span");
    sub.className = "sub";
    sub.textContent = playlist.itemCount
      ? `${playlist.itemCount} ${playlist.itemCount === 1 ? "video" : "videos"}`
      : "Playlist";

    link.append(thumb, title, sub);
    item.appendChild(link);
    return item;
  }

  function renderFeedResults(query) {
    const list = panelPart(".grid");
    const meta = panelPart(".meta");
    const status = panelPart(".status");
    const empty = panelPart(".empty");
    if (!list || !meta || !status || !empty) return false;

    if (feed.status !== "ready") {
      list.replaceChildren();
      empty.hidden = true;
      meta.textContent = "";
      status.hidden = false;
      status.textContent = feed.status === "error"
        ? (feed.statusMessage || "Couldn't load your playlists. Try reloading the page.")
        : "Loading your playlists…";
      return false;
    }

    status.hidden = true;
    const matches = searchPlaylists(query);
    const fallbackTerms = parseQueryTerms(query);
    const shown = matches.slice(0, FEED_MAX_RESULTS);

    list.replaceChildren(
      ...shown.map((m) =>
        createResultCard(m.playlist, m.terms?.length ? m.terms : fallbackTerms),
      ),
    );

    empty.hidden = matches.length > 0;
    if (!matches.length) empty.textContent = `No playlists match “${query}”`;

    meta.textContent = matches.length > shown.length
      ? `${matches.length} of ${feed.playlists.length} playlists · showing first ${shown.length}`
      : `${matches.length} of ${feed.playlists.length} playlists`;

    return true;
  }

  /**
   * Hide / restore YouTube's grid. We capture its original inline `display`
   * before the first hide and put that exact value back on restore, so a
   * cleared query leaves their DOM byte-identical to how we found it.
   */
  function setGridHidden(hidden) {
    const grid = feed.grid;
    if (!grid) return;

    if (hidden) {
      if (!feed.gridHidden) {
        feed.gridDisplay = grid.style.display;            // "" when unset
        feed.gridStyleAttr = grid.getAttribute("style");  // null when absent
        feed.gridHidden = true;
      }
      grid.style.setProperty("display", "none", "important");
      return;
    }

    if (!feed.gridHidden) return;
    grid.style.removeProperty("display");
    if (feed.gridDisplay) grid.style.display = feed.gridDisplay;
    // removeProperty leaves an empty `style=""` behind. If YouTube had no
    // style attribute before we touched it, don't leave one; "restore" means
    // the attribute is byte-identical, not merely equivalent. (We reapply
    // rather than overwrite the whole attribute so anything YouTube added
    // while we were hidden survives.)
    if (feed.gridStyleAttr === null && grid.getAttribute("style") === "") {
      grid.removeAttribute("style");
    }
    feed.gridHidden = false;
    feed.gridDisplay = null;
    feed.gridStyleAttr = null;
  }

  function setPanelVisible(visible) {
    if (feed.panelHost) feed.panelHost.hidden = !visible;
  }

  function updateChipPlaceholder() {
    if (!feed.input) return;
    feed.input.placeholder = feed.status === "ready" && feed.playlists.length
      ? `Search ${feed.playlists.length} playlists`
      : "Search playlists";
  }

  /**
   * The whole query lifecycle. Empty query ⇒ our panel is hidden and their
   * grid is restored. Non-empty ⇒ our results render; their grid is hidden
   * ONLY once we actually have something to show in its place, so a failed
   * or in-flight fetch never leaves the user staring at a blank page.
   */
  function applyFeedQuery() {
    const query = normalizeText(feed.input?.value || "");
    feed.query = query;
    feed.clear?.classList.toggle("ytpf-clear-visible", Boolean(query));
    suppressMutations(TIMINGS.SUPPRESS_MUTATIONS_AFTER_UI_OP_MS);

    if (!query) {
      setPanelVisible(false);
      setGridHidden(false);
      return;
    }

    ensurePlaylistsLoaded();
    setPanelVisible(true);
    const rendered = renderFeedResults(query);
    setGridHidden(rendered);
  }

  function ensurePlaylistsLoaded() {
    if (feed.status === "loading" || feed.status === "ready") return;
    if (!isLoggedIn()) {
      feed.status = "error";
      feed.statusMessage = "Sign in to YouTube to search your playlists.";
      recordDiagnostic("feed_not_signed_in", { path: window.location.pathname });
      return;
    }
    const session = getInnertubeConfig(true);
    if (!session.accountKey) {
      feed.status = "error";
      feed.statusMessage = "Couldn't identify the active YouTube account.";
      recordDiagnostic("feed_no_account_key", { path: window.location.pathname });
      return;
    }

    feed.status = "loading";
    feed.statusMessage = "";
    loadAllPlaylists(session)
      .then((playlists) => {
        feed.playlists = playlists;
        feed.index = createPlaylistIndex(playlists);
        feed.status = "ready";
      })
      .catch((err) => {
        feed.status = "error";
        feed.statusMessage = "Couldn't load your playlists. Try reloading the page.";
        console.warn("[ytpf] Playlist fetch failed:", err);
      })
      .finally(() => {
        updateChipPlaceholder();
        if (feed.query) applyFeedQuery();
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

  /**
   * Detach everything we own and put YouTube's DOM back exactly as we found
   * it. Idempotent — safe to call on every refresh tick, on navigation away,
   * and when an anchor stops resolving.
   */
  function teardownFeed() {
    setGridHidden(false);
    feed.grid = null;
    feed.mount = null;
    feed.chip?.remove();
    feed.panelHost?.remove();
    feed.chip = null;
    feed.input = null;
    feed.clear = null;
    feed.panelHost = null;
    feed.panelRoot = null;
    feed.query = "";
    // Keep `playlists` / `index` / `status`: the library snapshot survives
    // SPA navigation, and re-fetching it on every visit is wasted bandwidth.
  }

  /**
   * Reconcile our two attachments against the two resolved anchors. Both are
   * re-checked every tick because YouTube re-renders the chip bar and swaps
   * the grid wholesale on SPA navigation.
   *
   * @param {Element} mount Anchor 1.
   * @param {HTMLElement} grid  Anchor 2.
   */
  function ensureFeedMounted(mount, grid) {
    // `changed` gates the re-render. refresh() runs on every reconcile tick;
    // repainting the result list when nothing moved is pure waste (and, with
    // our shadow root under the mutation observer, needless churn).
    let changed = false;

    // Anchor 2 changed identity (SPA re-render): un-hide the element we were
    // holding hidden before we forget the reference to it.
    if (feed.grid !== grid) {
      if (feed.grid) setGridHidden(false);
      feed.grid = grid;
      changed = true;
    }
    feed.mount = mount;

    if (!feed.chip?.isConnected) {
      const ui = createSearchChip();
      feed.chip = ui.chip;
      feed.input = ui.input;
      feed.clear = ui.clear;
      changed = true;
    }
    // Append (rightmost): YouTube's leading chips are the primary filter
    // selectors ("Recently added", "Playlists", …) and should keep their spot.
    if (feed.chip.parentElement !== mount) {
      ensureScopedStyles(mount.getRootNode?.() || document);
      mount.appendChild(feed.chip);
      changed = true;
    }

    const panel = ensureFeedPanel();
    if (panel.previousElementSibling !== grid || panel.parentElement !== grid.parentElement) {
      grid.after(panel);
      changed = true;
    }

    syncFilterThemeClasses();
    // Warm the library on mount, not on first keystroke. The user navigated
    // to their playlist page; the fetch is cached for PLAYLIST_CACHE_TTL_MS,
    // and paying for it up front is what lets the chip read
    // "Search 342 playlists" instead of a vague "Search playlists".
    ensurePlaylistsLoaded();
    updateChipPlaceholder();

    // Restore the query across re-mounts so a chip-bar re-render mid-typing
    // doesn't silently drop the user's search.
    if (feed.input.value !== feed.query) {
      feed.input.value = feed.query;
      changed = true;
    }
    if (changed) applyFeedQuery();
  }

  function refresh() {
    syncFilterThemeClasses();

    if (!isPlaylistsFeedPage()) {
      if (feed.chip || feed.panelHost) teardownFeed();
      return;
    }

    const mount = resolveFeedAnchor("search-mount");
    const grid = resolveFeedAnchor("grid");
    if (!mount || !grid) {
      // NO FALLBACK MOUNT. resolveFeedAnchor already recorded which anchor
      // failed; scheduleFeedSurfaceProbe adds the structured post-settle
      // snapshot. Rendering nothing is the correct outcome.
      teardownFeed();
      scheduleFeedSurfaceProbe();
      return;
    }

    ensureFeedMounted(mount, /** @type {HTMLElement} */ (grid));
  }

  // ── Diagnostics ────────────────────────────────────────────────────────────
  // Console-only by design. Playlist and search data must never be persisted
  // or bridged into YouTube's page-readable DOM.
  const _lastDiagAt = new Map();

  function recordDiagnostic(invariant, context = {}) {
    const now = Date.now();
    const prev = _lastDiagAt.get(invariant) || 0;
    if (now - prev < DIAG_THROTTLE_MS) return;
    _lastDiagAt.set(invariant, now);
    console.warn(`[ytpf] diagnostic: ${invariant}`, context);
  }

  // Fired from refresh() when we're on the feed path but at least one anchor
  // didn't resolve. Waits out YouTube's second paint, re-checks, and if the
  // anchor is still missing emits one structured probe per path-load.
  // Keyed by pathname + a cooldown so SPA navigations re-arm but
  // mutation-driven refreshes don't spam.
  const _pageSurfaceProbedAt = new Map();
  function scheduleFeedSurfaceProbe() {
    const path = window.location.pathname;
    const last = _pageSurfaceProbedAt.get(path) || 0;
    const now = Date.now();
    if (now - last < TIMINGS.PAGE_SURFACE_PROBE_COOLDOWN_MS) return;
    _pageSurfaceProbedAt.set(path, now);
    setTimeout(() => {
      if (!isPlaylistsFeedPage()) return;
      const probe = probeFeedSurface();
      // A surface that materialized during the settle window is not a bug.
      if (probe.anchors.every((a) => a.visible > 0)) return;
      recordDiagnostic("feed_surface_missing", probe);
      try { console.warn("[ytpf] feed surface failed to mount", probe); } catch {}
    }, TIMINGS.MOUNT_CHECK_DELAY_MS);
  }

  /**
   * Pure inspection of the current DOM through the complete anchor list.
   * Returns a structured object — never throws, never mutates. Exposed on
   * window.__ytpfDiag for ad-hoc probing from DevTools.
   *
   * Because the anchor list IS the coupling surface, this probe is a total
   * account of what the extension needs from YouTube's DOM on this page.
   */
  function probeFeedSurface() {
    return {
      isFeedPath: isPlaylistsFeedPage(),
      path: window.location.pathname,
      anchors: FEED_DOM_ANCHORS.map((anchor) => {
        const hits = queryAllDeep(anchor.selector).filter((el) => el?.isConnected);
        return {
          id: anchor.id,
          selector: anchor.selector,
          purpose: anchor.purpose,
          matched: hits.length,
          visible: hits.filter(isVisible).length,
        };
      }),
      mounted: {
        chip: Boolean(feed.chip?.isConnected),
        panel: Boolean(feed.panelHost?.isConnected),
        gridHidden: feed.gridHidden,
      },
      library: { status: feed.status, count: feed.playlists.length },
    };
  }

  // Console-accessible debug surface. Lets users (or this assistant in a
  // future session) get an immediate read on why the bar isn't mounting,
  // without paste-the-snippet ceremony.  Idempotent — safe to call any time.
  try {
    Object.defineProperty(window, "__ytpfDiag", {
      configurable: true,
      value: () => probeFeedSurface(),
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
      // A failed library load (signed out, no account key, network) is sticky
      // until something changes. A navigation is that something — re-arm so
      // signing in and coming back doesn't require a full page reload.
      if (feed.status === "error") {
        feed.status = "idle";
        feed.statusMessage = "";
      }
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

  // Inert in the browser; src/test-search.cjs sets __YTPF_TEST__ before eval.
  if (typeof globalThis !== "undefined" && typeof globalThis.__YTPF_TEST__ === "function") {
    globalThis.__YTPF_TEST__({
      buildHighlightFragment,
      getHighlightRanges,
      createPlaylistIndex,
      normalizeText,
      parseQueryTerms,
      BM25_SEARCH_OPTIONS,
      parseAddToPlaylist,
      getCurrentVideoId,
      getInnertubeConfig,
      // Feed-surface probe + the enumerated anchor list. tests/ asserts the
      // anchor budget against the module directly, but exposing it here lets
      // the live-DOM harness confirm the *shipped bundle* carries the same
      // two anchors and nothing more.
      probeFeedSurface,
      FEED_DOM_ANCHORS,
      isPlaylistsFeedPage,
    });
  }
})();
