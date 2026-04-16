(() => {
  "use strict";

  const HIDDEN_CLASS = "ytpf-hidden";
  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";
  const MODAL_EXPANDED_CLASS = "ytpf-modal-expanded";
  const MODAL_INLINE_CLASS = "ytpf-inline-modal";
  const MODAL_API_RESULTS_LIMIT = 24;
  const ROW_MATCH_CLASS = "ytpf-row-match";
  const SYNTH_DONE_CLASS = "ytpf-synth-done";
  const ICON_PLUS = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>';
  const ICON_CHECK = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';

  const INNERTUBE_API_KEY_FALLBACK = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
  const INNERTUBE_CLIENT_VERSION_FALLBACK = "2.20260206.01.00";
  const PLAYLIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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

  const MODAL_HOST_SELECTOR =
    "ytd-add-to-playlist-renderer, yt-add-to-playlist-renderer, yt-contextual-sheet-layout, tp-yt-paper-dialog";

  const MODAL_ROW_SELECTOR =
    "ytd-playlist-add-to-option-renderer, yt-playlist-add-to-option-renderer, yt-checkbox-list-entry-renderer, yt-list-item-view-model, yt-collection-item-view-model";
  const PLAYLISTS_GRID_SELECTOR = "ytd-rich-grid-renderer";
  const PLAYLISTS_CONTENTS_SELECTOR = ":scope > #contents";
  const PLAYLISTS_OUTER_ROW_SELECTOR = "ytd-rich-item-renderer, ytd-rich-grid-media";
  const PLAYLIST_RENDERER_SELECTOR =
    "ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model, yt-collection-item-view-model";
  const PLAYLISTS_FEED_PATH_RE = /^\/feed\/(playlists|library)\/?(\?.*)?$/;
  const PLAYLIST_LINK_SELECTOR =
    "a[href*='/playlist?list='], a[href*='youtube.com/playlist?list=']";

  const CHECKBOX_SELECTOR =
    "tp-yt-paper-checkbox, [role='checkbox'], input[type='checkbox']";
  const MODAL_RELEVANT_SELECTOR = `${MODAL_HOST_SELECTOR}, ${MODAL_ROW_SELECTOR}, ${CHECKBOX_SELECTOR}`;
  const PAGE_RELEVANT_SELECTOR = `${PLAYLISTS_GRID_SELECTOR}, ${PLAYLISTS_OUTER_ROW_SELECTOR}, ${PLAYLIST_RENDERER_SELECTOR}`;

  const ITEM_TEXT_SELECTOR =
    "#label, #video-title, .playlist-title, yt-formatted-string[id='label'], yt-formatted-string, span#label, a#video-title";
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
      border: 1px solid var(--yt-spec-text-secondary, rgba(0, 0, 0, 0.2));
      border-radius: 18px;
      padding: 0 32px 0 12px;
      background: var(--yt-spec-general-background-a, rgba(255, 255, 255, 0.08));
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
    .ytpf-modal-expanded [role='listbox'] {
      max-height: min(68vh, 720px) !important;
      overflow-y: auto !important;
    }
    .ytpf-modal-expanded tp-yt-paper-dialog {
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

  const textCache = new WeakMap();
  const hiddenRows = new WeakMap();
  const labelHtmlCache = new WeakMap();
  const controllerHosts = new Set();
  const controllers = new WeakMap();
  let _bodyObserver = null;
  let _onNavigateFinish = null;
  let _onPageDataUpdated = null;
  const apiSessionCache = {
    playlists: null,
    fetchedAt: 0,
  };
  let suppressMutationsUntil = 0;

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
    if (!hiddenRows.has(row)) {
      hiddenRows.set(row, row.style.display);
    }
    row.style.display = "none";
    row.classList.add(HIDDEN_CLASS);
  }

  function showRow(row) {
    if (!row) return;
    const prev = hiddenRows.get(row);
    if (prev) {
      row.style.display = prev;
    } else {
      row.style.removeProperty("display");
    }
    hiddenRows.delete(row);
    row.classList.remove(HIDDEN_CLASS);
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
      let node = walker.currentNode;

      while (node) {
        if (node.shadowRoot) {
          walk(node.shadowRoot);
        }
        node = walker.nextNode();
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

  function suppressMutations(ms = 120) {
    suppressMutationsUntil = Math.max(suppressMutationsUntil, nowMs() + ms);
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
    if (nowMs() < suppressMutationsUntil) return false;
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
    if (textCache.has(row)) return textCache.get(row);

    const data = row.data || row.__data;
    if (data) {
      const dataTitle =
        data.title?.simpleText ||
        data.title?.runs?.[0]?.text ||
        (typeof data.title === "string" ? data.title : null) ||
        data.label?.simpleText ||
        data.label?.runs?.[0]?.text ||
        (typeof data.label === "string" ? data.label : null) ||
        null;
      if (dataTitle) {
        const text = normalizeText(dataTitle);
        textCache.set(row, text);
        return text;
      }
    }

    const label = row.querySelector(ITEM_TEXT_SELECTOR);
    const rawText = (
      label?.textContent ||
      row.getAttribute("aria-label") ||
      row.getAttribute("title") ||
      ""
    );
    const text = normalizeText(rawText);

    textCache.set(row, text);
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

  function getRowPlaylistId(row) {
    const data = row.data || row.__data;
    if (data?.playlistId) return data.playlistId;
    const onTap = data?.onTap || data?.data?.onTap;
    const cmd = onTap?.addToPlaylistCommand || onTap?.toggledServiceEndpoint;
    if (cmd?.playlistId) return cmd.playlistId;
    return null;
  }

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
    const directRows = unique(queryAllDeep(MODAL_ROW_SELECTOR, host)).filter(
      (row) =>
        (isVisible(row) || hiddenRows.has(row)) && getItemText(row).length > 0,
    );

    if (directRows.length) return directRows;

    const checkboxes = queryAllDeep(CHECKBOX_SELECTOR, host);
    if (!checkboxes.length) return [];

    const genericRows = unique(
      checkboxes
        .map((checkbox) => findLikelyRow(checkbox, host))
        .filter((row) => row && (isVisible(row) || hiddenRows.has(row))),
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
    const visibleRows = rows.filter((row) => isVisible(row) || hiddenRows.has(row));
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

    let best = null;

    grids.forEach((grid) => {
      const contents = getGridContents(grid);
      if (!contents) return;

      const rows = collectGridRows(contents).filter(
        (row) =>
          !row.classList.contains(FILTER_CLASS) &&
          hasPlaylistRenderer(row) &&
          (hasPlaylistLink(row) || hiddenRows.has(row)),
      );

      if (!rows.length) return;

      const score = scoreCandidate(contents, rows);
      if (!best || compareCandidateScores(score, best.score) > 0) {
        best = { contents, rows, score };
      }
    });

    if (!best) return null;
    return {
      host: best.rows[0]?.parentElement || best.contents,
      rows: best.rows,
    };
  }

  function findMountPoint(rows, host, surface) {
    if (surface === "page") {
      if (rows[0]?.parentElement === host) {
        return {
          parent: host,
          before: rows[0],
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
    if (!auth) throw new Error("Not signed in to YouTube");

    const { apiKey, clientVersion } = getInnertubeConfig();

    const response = await fetch(
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

    if (!response.ok) {
      throw new Error(`YouTube request failed (HTTP ${response.status})`);
    }

    return response.json();
  }

  function rendererTitle(r) {
    return r.title?.runs?.[0]?.text || r.title?.simpleText || "Untitled";
  }

  function parsePlaylistRenderers(data) {
    const playlists = [];
    let continuation = null;

    function visitItems(items) {
      if (!Array.isArray(items)) return;
      for (const item of items) {
        const gpr = item.gridPlaylistRenderer;
        if (gpr?.playlistId) {
          playlists.push({
            id: gpr.playlistId,
            title: rendererTitle(gpr),
            itemCount:
              parseInt(
                gpr.videoCountShortText?.simpleText ||
                  gpr.thumbnailText?.runs?.[0]?.text ||
                  "0",
                10,
              ) || 0,
          });
          continue;
        }

        const pr = item.playlistRenderer;
        if (pr?.playlistId) {
          playlists.push({
            id: pr.playlistId,
            title: rendererTitle(pr),
            itemCount: parseInt(pr.videoCount || "0", 10) || 0,
          });
          continue;
        }

        const rich = item.richItemRenderer?.content;
        if (rich) visitItems([rich]);

        const cont =
          item.continuationItemRenderer?.continuationEndpoint
            ?.continuationCommand?.token;
        if (cont) continuation = cont;
      }
    }

    const tabs =
      data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
    for (const tab of tabs) {
      const content = tab?.tabRenderer?.content;
      const sections =
        content?.sectionListRenderer?.contents || [];
      for (const section of sections) {
        const grid =
          section?.itemSectionRenderer?.contents?.[0]?.gridRenderer;
        if (grid) {
          visitItems(grid.items);
          const gc = grid.continuations?.[0]?.nextContinuationData?.continuation;
          if (gc) continuation = gc;
        }
        const shelf = section?.shelfRenderer?.content?.gridRenderer;
        if (shelf) {
          visitItems(shelf.items);
        }
      }
      const richGrid = content?.richGridRenderer?.contents;
      if (richGrid) visitItems(richGrid);
    }

    const actions = data?.onResponseReceivedActions || [];
    for (const action of actions) {
      visitItems(
        action?.appendContinuationItemsAction?.continuationItems ||
          action?.reloadContinuationItemsCommand?.continuationItems ||
          [],
      );
    }

    return { playlists, continuation };
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
    if (!ctrl.parent?.isConnected) return;

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
            }, 2000);
            return;
          }

          suppressMutations(160);
          action.disabled = true;
          innertubeSaveVideo(playlist.id, videoId)
            .then(() => {
              suppressMutations(160);
              action.disabled = false;
              action.innerHTML = ICON_CHECK;
              action.classList.add(SYNTH_DONE_CLASS);
            })
            .catch((err) => {
              console.warn("[ytpf] Save to playlist failed:", err);
              suppressMutations(160);
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
  }

  async function loadAllPlaylists() {
    const now = Date.now();
    if (
      apiSessionCache.playlists &&
      now - apiSessionCache.fetchedAt < PLAYLIST_CACHE_TTL_MS
    ) {
      return apiSessionCache.playlists;
    }
    const playlists = await innertubeLoadPlaylists();
    apiSessionCache.playlists = playlists;
    apiSessionCache.fetchedAt = Date.now();
    return playlists;
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

    for (const candidate of candidates) {
      let node = candidate;
      while (node && node instanceof Element) {
        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY || "";
        if (node.scrollHeight - node.clientHeight > 12 && (overflowY === "auto" || overflowY === "scroll")) {
          return node;
        }
        if (node === ctrl.host) break;
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
    controllerHosts.delete(host);

    if (controllerHosts.size === 0) {
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

    suppressMutations(160);

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
    }
  }

  function attachHost(host, rows, surface = "modal") {
    const mount = findMountPoint(rows, host, surface);
    if (!mount) return;
    ensureScopedStyles(mount.parent.getRootNode?.() || document);

    const ui = createInlineFilterUi(surface);
    guardModalUiInteractions(ui, surface);
    if (surface === "modal") {
      host.classList.add(MODAL_EXPANDED_CLASS);
    }

    if (mount.after) {
      mount.after.after(ui.root);
    } else if (mount.before) {
      mount.parent.insertBefore(ui.root, mount.before);
    } else {
      mount.parent.appendChild(ui.root);
    }

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
      suppressMutations(300);
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
    controllerHosts.add(host);

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

  function refresh() {
    queryAllDeep(MODAL_HOST_SELECTOR)
      .filter(isVisible)
      .forEach((host) => {
        const rows = collectRows(host);
        if (!rows.length) return;
        upsertHost(host, rows, "modal");
      });

    const pageSurface = collectFeedPageSurface();
    if (pageSurface) {
      upsertHost(pageSurface.host, pageSurface.rows, "page");
    }

    // Only tear down controllers whose host element is actually gone.
    // YouTube frequently re-renders the modal's inner list, making collectRows
    // momentarily return empty; if we tore down on that, the filter bar would
    // disappear mid-use with no error (exactly the bug we kept shipping). If
    // the host is still attached, rows will come back on the next refresh —
    // we don't need to rebuild the UI in the meantime. If ui.root itself gets
    // detached, upsertHost's !existing.root.isConnected branch re-attaches it.
    for (const host of [...controllerHosts]) {
      if (host.isConnected) continue;
      const ctrl = controllers.get(host);
      if (ctrl && ctrl.root.contains(document.activeElement)) continue;
      teardownHost(host);
    }
  }

  function debounce(fn, waitMs) {
    let timerId;
    return () => {
      clearTimeout(timerId);
      timerId = setTimeout(fn, waitMs);
    };
  }

  const scheduleRefresh = debounce(refresh, 120);

  function start() {
    if (!document.body) {
      requestAnimationFrame(start);
      return;
    }

    _bodyObserver = new MutationObserver((mutations) => {
      if (shouldRefreshFromMutations(mutations)) {
        scheduleRefresh();
      }
    });
    _bodyObserver.observe(document.body, { childList: true, subtree: true });

    refresh();

    _onNavigateFinish = () => {
      setTimeout(refresh, 250);
    };
    _onPageDataUpdated = scheduleRefresh;

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
    });
  }
})();
