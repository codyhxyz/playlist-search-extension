(() => {
  "use strict";

  const HIDDEN_CLASS = "ytpf-hidden";
  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";
  const MODAL_EXPANDED_CLASS = "ytpf-modal-expanded";
  const MODAL_INLINE_CLASS = "ytpf-inline-modal";
  const MODAL_HYDRATE_TIMEOUT_MS = 1000;
  const MODAL_HYDRATE_IDLE_MS = 70;
  const MODAL_HYDRATE_MAX_PASSES = 24;
  const MODAL_HYDRATE_STABLE_ROUNDS = 2;
  const MODAL_API_RESULTS_LIMIT = 24;
  const MODAL_API_CAP_THRESHOLD = 200;
  const MODAL_API_TOOLTIP_TEXT =
    "YouTube caps at 200 playlists. Authorize to load all of them.";

  const MODAL_HOST_SELECTOR =
    "ytd-add-to-playlist-renderer, yt-add-to-playlist-renderer, yt-contextual-sheet-layout, tp-yt-paper-dialog, [role='dialog']";

  const MODAL_ROW_SELECTOR =
    "ytd-playlist-add-to-option-renderer, yt-playlist-add-to-option-renderer, yt-checkbox-list-entry-renderer, yt-list-item-view-model, yt-collection-item-view-model";
  const PLAYLISTS_GRID_SELECTOR = "ytd-rich-grid-renderer";
  const PLAYLISTS_CONTENTS_SELECTOR = ":scope > #contents";
  const PLAYLISTS_OUTER_ROW_SELECTOR = "ytd-rich-item-renderer, ytd-rich-grid-media";
  const PLAYLIST_RENDERER_SELECTOR =
    "ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model, yt-collection-item-view-model";
  const PLAYLISTS_FEED_PATH_RE = /^\/feed\/playlists\/?$/;
  const PLAYLIST_LINK_SELECTOR =
    "a[href*='/playlist?list='], a[href*='youtube.com/playlist?list=']";

  const CHECKBOX_SELECTOR =
    "tp-yt-paper-checkbox, [role='checkbox'], input[type='checkbox']";
  const MODAL_RELEVANT_SELECTOR = `${MODAL_HOST_SELECTOR}, ${MODAL_ROW_SELECTOR}, ${CHECKBOX_SELECTOR}`;
  const PAGE_RELEVANT_SELECTOR = `${PLAYLISTS_GRID_SELECTOR}, ${PLAYLISTS_OUTER_ROW_SELECTOR}, ${PLAYLIST_RENDERER_SELECTOR}`;

  const ITEM_TEXT_SELECTOR =
    "#label, #video-title, .playlist-title, yt-formatted-string[id='label'], yt-formatted-string, span#label, a#video-title, h3";
  const INLINE_STYLE_TEXT = `
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
    .ytpf-mark {
      background: rgba(255, 214, 10, 0.35);
      color: inherit;
      border-radius: 3px;
      padding: 0 1px;
    }
    .ytpf-connect-bar {
      margin-top: 6px;
      text-align: center;
    }
    .ytpf-connect-bar button {
      height: 26px;
      border: 1px solid rgba(240, 180, 0, 0.5);
      border-radius: 13px;
      padding: 0 12px;
      background: transparent;
      color: #7a5900;
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
    }
    .ytpf-connect-bar button:hover {
      background: rgba(240, 180, 0, 0.15);
    }
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
    .ytpf-synth-row {
      display: flex;
      align-items: center;
      padding: 8px 16px;
      gap: 12px;
      min-height: 48px;
      cursor: default;
    }
    .ytpf-synth-title {
      flex: 1;
      min-width: 0;
      color: var(--yt-spec-text-primary, #0f0f0f);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
      line-height: 1.3;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .ytpf-synth-add {
      height: 28px;
      border: 1px solid rgba(6, 95, 212, 0.42);
      border-radius: 14px;
      padding: 0 12px;
      background: transparent;
      color: var(--yt-spec-call-to-action, #065fd4);
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .ytpf-synth-add:hover {
      background: rgba(6, 95, 212, 0.08);
    }
    .ytpf-synth-add:disabled {
      opacity: 0.5;
      cursor: default;
    }
    .ytpf-synth-saved {
      color: var(--yt-spec-text-secondary, #606060);
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
      flex-shrink: 0;
    }
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

  const textCache = new WeakMap();
  const hiddenRows = new WeakMap();
  const labelHtmlCache = new WeakMap();
  const controllerHosts = new Set();
  const controllers = new WeakMap();
  const modalSessionCache = {
    hydrated: false,
    maxRowsSeen: 0,
    lastHydratedAtMs: 0,
  };
  const apiSessionCache = {
    authStatus: null,
    playlists: null,
    fetchedAt: 0,
    loadingAuth: null,
    loadingPlaylists: null,
    error: "",
  };
  let suppressMutationsUntil = 0;

  function ensureScopedStyles(rootNode) {
    if (!rootNode) return;
    if (rootNode.getElementById?.(STYLE_ID)) return;
    if (rootNode.querySelector?.(`#${STYLE_ID}`)) return;

    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = INLINE_STYLE_TEXT;

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
    const previousDisplay = hiddenRows.get(row);
    if (previousDisplay === undefined) {
      row.style.removeProperty("display");
    } else if (previousDisplay) {
      row.style.display = previousDisplay;
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
    if (window.performance?.now) return window.performance.now();
    return Date.now();
  }

  function waitMs(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
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

  function createBm25Index(rows) {
    if (typeof MiniSearch !== "function") return null;

    const bm25 = new MiniSearch({
      fields: ["text"],
      storeFields: ["rowId"],
      searchOptions: {
        prefix: true,
        fuzzy: 0.2,
        combineWith: "OR",
      },
    });

    const docs = rows.map((row, index) => ({
      id: String(index),
      rowId: String(index),
      text: getItemText(row),
    }));

    bm25.addAll(docs);
    return bm25;
  }

  function searchWithBm25(ctrl, query) {
    const useLiteralMatch = query.length < 2;

    if (!ctrl.bm25 || useLiteralMatch) {
      return ctrl.rows
        .map((row) => {
          const text = getItemText(row);
          const at = text.indexOf(query);
          if (at < 0) return null;
          return {
            row,
            score: 1000 - at,
            terms: query.split(" ").filter(Boolean),
          };
        })
        .filter(Boolean);
    }
    const results = ctrl.bm25.search(query, {
      prefix: true,
      fuzzy: 0.2,
      combineWith: "OR",
    });

    const matches = [];
    const seenRows = new Set();

    results.forEach((result) => {
      const rowIndex = Number(result.id ?? result.rowId);
      const row = ctrl.rows[rowIndex];
      if (!row || seenRows.has(row)) return;
      seenRows.add(row);

      const terms = Array.isArray(result.terms)
        ? result.terms.map(normalizeText).filter(Boolean)
        : [];

      matches.push({
        row,
        score: Number(result.score) || 0,
        terms,
      });
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
    return Boolean(node.closest(`.${FILTER_CLASS}`));
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

    let checked = 0;
    for (const child of el.children) {
      if (checked > 10) break;
      checked += 1;
      if (child.getClientRects().length > 0) return true;
    }

    return false;
  }

  function getItemText(row) {
    if (textCache.has(row)) return textCache.get(row);

    const label = row.querySelector(ITEM_TEXT_SELECTOR);
    const rawText = (
      label?.textContent ||
      row.getAttribute("aria-label") ||
      row.getAttribute("title") ||
      row.textContent ||
      ""
    );
    const text = normalizeText(rawText);

    textCache.set(row, text);
    return text;
  }

  function getLabelElement(row) {
    return row.querySelector(ITEM_TEXT_SELECTOR);
  }

  function escapeHtml(input) {
    return input
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function ensureOriginalLabelHtml(label) {
    if (!labelHtmlCache.has(label)) {
      labelHtmlCache.set(label, label.innerHTML);
    }
  }

  function restoreHighlight(row) {
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

  function applyHighlight(row, terms) {
    const label = getLabelElement(row);
    if (!label) return;

    ensureOriginalLabelHtml(label);
    const rawText = label.textContent || "";
    if (!rawText) return;

    const highlightTerms = terms.map(normalizeText).filter(Boolean);
    const ranges = getHighlightRanges(rawText, highlightTerms);
    if (!ranges.length) {
      restoreHighlight(row);
      return;
    }

    let cursor = 0;
    let html = "";
    ranges.forEach((range) => {
      if (range.from > cursor) {
        html += escapeHtml(rawText.slice(cursor, range.from));
      }
      html += `<mark class="ytpf-mark">${escapeHtml(
        rawText.slice(range.from, range.to),
      )}</mark>`;
      cursor = range.to;
    });
    if (cursor < rawText.length) {
      html += escapeHtml(rawText.slice(cursor));
    }
    label.innerHTML = html;
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

    if (directRows.length) {
      return { rows: directRows, source: "direct" };
    }

    const checkboxes = queryAllDeep(CHECKBOX_SELECTOR, host);
    if (checkboxes.length < 2) {
      return { rows: [], source: null };
    }

    const genericRows = unique(
      checkboxes
        .map((checkbox) => findLikelyRow(checkbox, host))
        .filter((row) => row && (isVisible(row) || hiddenRows.has(row))),
    ).filter((row) => {
      const text = getItemText(row);
      return text.length >= 2 && text.length <= 200;
    });

    if (genericRows.length < 3) {
      return { rows: [], source: null };
    }

    return { rows: genericRows, source: "generic" };
  }

  function isPlaylistsFeedPage() {
    return PLAYLISTS_FEED_PATH_RE.test(window.location.pathname);
  }

  function getGridContents(grid) {
    if (!grid) return null;
    const direct = grid.querySelector(PLAYLISTS_CONTENTS_SELECTOR);
    if (direct) return direct;
    return Array.from(grid.children).find((child) => child.id === "contents") || null;
  }

  function hasPlaylistLink(node) {
    if (!node) return false;
    if (node.querySelector?.(PLAYLIST_LINK_SELECTOR)) return true;
    return Boolean(queryAllDeep(PLAYLIST_LINK_SELECTOR, node).length);
  }

  function hasPlaylistRenderer(node) {
    if (!node) return false;
    if (node.querySelector?.(PLAYLIST_RENDERER_SELECTOR)) return true;
    return Boolean(queryAllDeep(PLAYLIST_RENDERER_SELECTOR, node).length);
  }

  function toOuterPlaylistRow(node, contents) {
    if (!node || !contents) return null;
    const outer = closestComposed(node, PLAYLISTS_OUTER_ROW_SELECTOR);
    if (outer && contents.contains(outer)) return outer;
    if (node.matches?.(PLAYLISTS_OUTER_ROW_SELECTOR) && contents.contains(node)) {
      return node;
    }
    return null;
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

      const outerRowsFromRenderers = unique(
        queryAllDeep(PLAYLIST_RENDERER_SELECTOR, contents)
          .filter(hasPlaylistLink)
          .map((renderer) => toOuterPlaylistRow(renderer, contents))
          .filter(Boolean),
      ).filter((row) => !row.classList.contains(FILTER_CLASS));

      const outerRowsFromLinks = unique(
        queryAllDeep(PLAYLIST_LINK_SELECTOR, contents)
          .map((link) => toOuterPlaylistRow(link, contents))
          .filter(Boolean),
      ).filter((row) => !row.classList.contains(FILTER_CLASS));

      const rows = (
        outerRowsFromRenderers.length
          ? outerRowsFromRenderers
          : outerRowsFromLinks.length
            ? outerRowsFromLinks
            : unique(queryAllDeep(PLAYLISTS_OUTER_ROW_SELECTOR, contents))
      ).filter(
        (row) =>
          !row.classList.contains(FILTER_CLASS) &&
          hasPlaylistRenderer(row) &&
          (hasPlaylistLink(row) || hiddenRows.has(row)),
      );

      if (!rows.length) return;

      const visibleRows = rows.filter((row) => isVisible(row) || hiddenRows.has(row));
      const candidate = {
        contents,
        rows,
        score: [
          isVisible(contents) ? 1 : 0,
          visibleRows.length,
          rows.length,
        ],
      };

      if (!best) {
        best = candidate;
        return;
      }

      const [a0, a1, a2] = candidate.score;
      const [b0, b1, b2] = best.score;
      if (a0 > b0 || (a0 === b0 && (a1 > b1 || (a1 === b1 && a2 > b2)))) {
        best = candidate;
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
    input.placeholder =
      surface === "page"
        ? "Filter this page"
        : "Search playlists";
    input.setAttribute("aria-label", "Search playlists");
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

    if (surface === "modal") {
      root.appendChild(row);
    } else {
      root.appendChild(row);
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

  function findModalScrollContainer(ctrl) {
    const candidates = [];
    const seen = new Set();

    function maybeAdd(node) {
      if (!(node instanceof Element)) return;
      if (!ctrl.host.contains(node)) return;
      if (seen.has(node)) return;
      seen.add(node);
      candidates.push(node);
    }

    maybeAdd(ctrl.rows[0]?.parentElement);
    maybeAdd(ctrl.rows[0]);
    maybeAdd(ctrl.host.querySelector("#playlists"));
    maybeAdd(ctrl.host.querySelector("#contents"));
    maybeAdd(ctrl.host.querySelector("[role='listbox']"));
    maybeAdd(ctrl.host.querySelector("yt-checkbox-list-renderer"));
    maybeAdd(ctrl.host);

    for (const candidate of candidates) {
      let node = candidate;
      while (node && node !== document.body) {
        if (!(node instanceof Element)) break;
        if (!ctrl.host.contains(node)) break;

        const style = window.getComputedStyle(node);
        const overflowY = style.overflowY || "";
        const canScroll = node.scrollHeight - node.clientHeight > 12;
        if (canScroll && (overflowY === "auto" || overflowY === "scroll")) {
          return node;
        }

        if (node === ctrl.host) break;
        node = node.parentElement;
      }
    }

    return ctrl.host.querySelector("#playlists, #contents, [role='listbox']") || null;
  }

  function shouldHydrateModal(ctrl) {
    if (ctrl.surface !== "modal") return false;
    if (Array.isArray(apiSessionCache.playlists) && apiSessionCache.playlists.length > 0) return false;
    if (ctrl.hydrationRunning) return false;
    if (!ctrl.host.isConnected) return false;

    const known = modalSessionCache.maxRowsSeen || 0;
    if (!known) return true;
    if (!modalSessionCache.hydrated) return true;
    return ctrl.rows.length + 1 < known;
  }

  async function hydrateModalRows(ctrl) {
    if (!shouldHydrateModal(ctrl)) return;

    const container = findModalScrollContainer(ctrl);
    if (!container) return;

    ctrl.hydrationRunning = true;
    ctrl.hydrationToken = (ctrl.hydrationToken || 0) + 1;
    const runToken = ctrl.hydrationToken;
    const startedAt = nowMs();

    let passes = 0;
    let stableRounds = 0;
    let lastCount = ctrl.rows.length;
    let lastScrollHeight = container.scrollHeight;

    try {
      while (
        passes < MODAL_HYDRATE_MAX_PASSES &&
        nowMs() - startedAt < MODAL_HYDRATE_TIMEOUT_MS
      ) {
        const liveCtrl = controllers.get(ctrl.host);
        if (!liveCtrl || liveCtrl !== ctrl) break;
        if (!ctrl.host.isConnected) break;
        if (ctrl.hydrationToken !== runToken) break;

        container.scrollTop = container.scrollHeight;
        await waitMs(MODAL_HYDRATE_IDLE_MS);

        const afterWaitCtrl = controllers.get(ctrl.host);
        if (!afterWaitCtrl || afterWaitCtrl !== ctrl) break;
        if (!ctrl.host.isConnected) break;
        if (ctrl.hydrationToken !== runToken) break;

        const nextRows = collectRows(ctrl.host).rows;
        if (nextRows.length && !sameRows(ctrl.rows, nextRows)) {
          upsertHost(ctrl.host, nextRows, "modal");
        }

        const activeCtrl = controllers.get(ctrl.host);
        if (!activeCtrl || activeCtrl !== ctrl) break;

        const count = activeCtrl.rows.length;
        const nextScrollHeight = container.scrollHeight;
        if (count === lastCount && nextScrollHeight === lastScrollHeight) {
          stableRounds += 1;
        } else {
          stableRounds = 0;
        }

        lastCount = count;
        lastScrollHeight = nextScrollHeight;
        passes += 1;

        if (stableRounds >= MODAL_HYDRATE_STABLE_ROUNDS) {
          break;
        }
      }

      const finalCtrl = controllers.get(ctrl.host);
      const finalCount = finalCtrl?.rows.length ?? lastCount;
      modalSessionCache.maxRowsSeen = Math.max(modalSessionCache.maxRowsSeen, finalCount);
      if (stableRounds >= MODAL_HYDRATE_STABLE_ROUNDS) {
        modalSessionCache.hydrated = true;
        modalSessionCache.lastHydratedAtMs = Date.now();
      }

      if (finalCtrl === ctrl) {
        applyFilter(ctrl);
      }
    } finally {
      ctrl.hydrationRunning = false;
    }
  }

  function maybeStartModalHydration(ctrl) {
    if (!shouldHydrateModal(ctrl)) return;
    if (ctrl.hydrationPromise) return;

    const run = hydrateModalRows(ctrl).finally(() => {
      if (ctrl.hydrationPromise === run) {
        ctrl.hydrationPromise = null;
      }
    });
    ctrl.hydrationPromise = run;
  }

  function runtimeMessage(message) {
    return new Promise((resolve, reject) => {
      if (
        typeof chrome === "undefined" ||
        !chrome.runtime ||
        typeof chrome.runtime.sendMessage !== "function"
      ) {
        reject(new Error("Extension context unavailable. Reload the page and try again."));
        return;
      }
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message || "Extension messaging failed"));
          return;
        }
        if (!response) {
          reject(new Error("No response from extension service worker"));
          return;
        }
        if (!response.ok) {
          reject(new Error(response.error || "Request failed"));
          return;
        }
        resolve(response);
      });
    });
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



  function searchApiPlaylists(playlists, query) {
    if (!query) return [];
    const normalizedQuery = normalizeText(query);
    if (!normalizedQuery) return [];

    const terms = normalizedQuery.split(" ").filter(Boolean);
    return playlists
      .map((playlist) => {
        const text = normalizeText(playlist.title);
        if (!text) return null;
        const at = text.indexOf(normalizedQuery);
        if (at >= 0) {
          return { playlist, score: 1000 - at };
        }
        if (terms.length > 1 && terms.every((term) => text.includes(term))) {
          const minAt = Math.min(...terms.map((term) => text.indexOf(term)));
          return { playlist, score: 700 - Math.max(minAt, 0) };
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, MODAL_API_RESULTS_LIMIT)
      .map((match) => match.playlist);
  }

  function modalAppearsCapped(ctrl) {
    return Math.max(0, ctrl?.rows?.length || 0) >= MODAL_API_CAP_THRESHOLD;
  }

  function connectApi(ctrl, options = {}) {
    if (!ctrl || ctrl.apiBusy || ctrl.apiSaving) return;
    const forceReauth = Boolean(options.forceReauth);
    if (forceReauth) {
      apiSessionCache.playlists = null;
      apiSessionCache.fetchedAt = 0;
    }

    ctrl.apiBusy = true;
    ctrl.apiNotice = "";
    renderModalApiUi(ctrl, normalizeText(ctrl.input.value));

    runtimeMessage({ type: "YTPF_CONNECT", forceReauth })
      .then((response) => {
        apiSessionCache.authStatus = response.status;
        return loadAllPlaylistsFromApi(ctrl, {
          forceRefresh: true,
          interactive: false,
        });
      })
      .then((playlists) => {
        if (!Array.isArray(playlists) || playlists.length === 0) {
          ctrl.apiNotice =
            "No playlists found \u2014 try a different account?";
          return;
        }
      })
      .catch((error) => {
        ctrl.apiNotice = formatConnectError(error, apiSessionCache.authStatus);
      })
      .finally(() => {
        ctrl.apiBusy = false;
        renderModalApiUi(ctrl, normalizeText(ctrl.input.value));
      });
  }

  function getModalApiPromptState(ctrl) {
    const auth = apiSessionCache.authStatus || {};
    const hasToken = Boolean(auth.tokenValid || auth.hasRefreshToken);
    const hasApiLibrary =
      Array.isArray(apiSessionCache.playlists) && apiSessionCache.playlists.length > 0;
    const cappedAtYoutubeLimit = modalAppearsCapped(ctrl);
    const needsPrompt = cappedAtYoutubeLimit && (!hasToken || !hasApiLibrary);
    return {
      cappedAtYoutubeLimit,
      hasToken,
      hasApiLibrary,
      needsPrompt,
    };
  }

  function clearSynthRows(ctrl) {
    ctrl.synthRows.forEach((el) => el.remove());
    ctrl.synthRows = [];
  }

  function renderModalApiUi(ctrl, query) {
    if (ctrl.surface !== "modal") return;

    clearSynthRows(ctrl);

    const { hasApiLibrary } = getModalApiPromptState(ctrl);
    const hasPlaylists = Array.isArray(apiSessionCache.playlists);
    const hasQuery = Boolean(query);

    if (!hasQuery || !hasPlaylists || !hasApiLibrary) return;
    if (!ctrl.parent?.isConnected) return;

    // Only show API playlists not already in YouTube's list
    const ytTitles = new Set();
    ctrl.rows.forEach((row) => {
      const t = getItemText(row);
      if (t) ytTitles.add(t);
    });

    const results = searchApiPlaylists(apiSessionCache.playlists, query)
      .filter((p) => !ytTitles.has(normalizeText(p.title || "")));

    if (!results.length) return;

    results.forEach((playlist) => {
      const row = document.createElement("div");
      row.className = "ytpf-synth-row";

      const title = document.createElement("span");
      title.className = "ytpf-synth-title";
      title.textContent = playlist.title || "Untitled";

      const add = document.createElement("button");
      add.type = "button";
      add.className = "ytpf-synth-add";
      add.textContent = "Save";
      add.addEventListener("click", () => {
        const videoId = getCurrentVideoId(ctrl.host);
        if (!videoId) return;

        add.disabled = true;
        add.textContent = "Saving\u2026";
        runtimeMessage({
          type: "YTPF_SAVE_VIDEO",
          playlistId: playlist.id,
          videoId,
          interactive: true,
        })
          .then(() => {
            add.replaceWith(Object.assign(document.createElement("span"), {
              className: "ytpf-synth-saved",
              textContent: "Saved",
            }));
          })
          .catch(() => {
            add.disabled = false;
            add.textContent = "Retry";
          });
      });

      row.appendChild(title);
      row.appendChild(add);
      ctrl.parent.appendChild(row);
      ctrl.synthRows.push(row);
    });
  }

  function normalizeErrorMessage(error) {
    if (!error) return "Unknown error";
    const message = typeof error === "string" ? error : error.message || String(error);
    return message.replace(/^Error:\\s*/i, "");
  }

  function formatConnectError(error, authStatus) {
    const message = normalizeErrorMessage(error);
    if (!/redirect_uri_mismatch/i.test(message)) {
      return message;
    }
    const uris = Array.isArray(authStatus?.redirectUris)
      ? authStatus.redirectUris.filter(Boolean)
      : authStatus?.redirectUri
        ? [authStatus.redirectUri]
        : [];
    if (!uris.length) {
      return "OAuth redirect URI mismatch. Add this extension redirect URI to your Google OAuth client and retry.";
    }
    return `OAuth redirect URI mismatch. Add one of these URIs to your Google OAuth client: ${uris.join(" , ")}`;
  }

  async function loadAllPlaylistsFromApi(ctrl, options = {}) {
    const forceRefresh = Boolean(options.forceRefresh);
    const interactive = Boolean(options.interactive);
    const response = await runtimeMessage({
      type: "YTPF_GET_PLAYLISTS",
      interactive,
      forceRefresh,
    });

    apiSessionCache.playlists = Array.isArray(response.playlists)
      ? response.playlists
      : [];
    apiSessionCache.fetchedAt = Number(response.fetchedAt || 0);
    return apiSessionCache.playlists;
  }

  async function bootstrapModalApi(ctrl) {
    if (ctrl.surface !== "modal") return;
    const token = (ctrl.apiToken || 0) + 1;
    ctrl.apiToken = token;
    ctrl.apiBusy = true;
    ctrl.apiNotice = "";
    renderModalApiUi(ctrl, normalizeText(ctrl.input.value));

    try {
      if (!apiSessionCache.authStatus) {
        const authResponse = await runtimeMessage({ type: "YTPF_GET_AUTH_STATUS" });
        apiSessionCache.authStatus = authResponse.status;
      }

      const auth = apiSessionCache.authStatus || {};
      const canLoad = Boolean(auth.hasClientId) && Boolean(auth.tokenValid || auth.hasRefreshToken);

      if (canLoad && !apiSessionCache.playlists) {
        await loadAllPlaylistsFromApi(ctrl, {
          forceRefresh: false,
          interactive: false,
        });
      }
    } catch (error) {
      ctrl.apiNotice = normalizeErrorMessage(error);
    } finally {
      if (ctrl.apiToken === token) {
        ctrl.apiBusy = false;
        renderModalApiUi(ctrl, normalizeText(ctrl.input.value));
        maybeShowConnectBar(ctrl);
      }
    }
  }

  function maybeShowConnectBar(ctrl) {
    if (ctrl.surface !== "modal") return;
    if (ctrl.root.querySelector(".ytpf-connect-bar")) return;

    const auth = apiSessionCache.authStatus || {};
    if (!auth.hasClientId) return;

    const { needsPrompt } = getModalApiPromptState(ctrl);
    if (!needsPrompt) return;

    const bar = document.createElement("div");
    bar.className = "ytpf-connect-bar";
    bar.title = "YouTube only loads 200 playlists. Connect to search all of them.";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Load all playlists";
    btn.addEventListener("click", () => {
      bar.remove();
      connectApi(ctrl);
    });

    bar.appendChild(btn);
    ctrl.root.appendChild(bar);
  }

  function teardownHost(host) {
    const ctrl = controllers.get(host);
    if (!ctrl) return;

    ctrl.hydrationToken = (ctrl.hydrationToken || 0) + 1;
    ctrl.hydrationRunning = false;
    ctrl.hydrationPromise = null;
    ctrl.apiToken = (ctrl.apiToken || 0) + 1;
    ctrl.apiBusy = false;
    ctrl.apiSaving = false;
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
  }

  function applyFilter(ctrl) {
    const query = normalizeText(ctrl.input.value);
    const fullSet = ctrl.rows;
    let matches = [];

    suppressMutations(160);

    if (!query) {
      matches = fullSet.map((row) => ({ row, score: 0, terms: [] }));
    } else {
      matches = searchWithBm25(ctrl, query);
    }

    const matchSet = new Set(matches.map((m) => m.row));
    fullSet.forEach((row) => {
      if (matchSet.has(row)) {
        showRow(row);
      } else {
        hideRow(row);
        restoreHighlight(row);
      }
    });

    if (query && ctrl.sortResults && ctrl.parent?.isConnected) {
      const scrollContainer = findModalScrollContainer(ctrl);
      const scrollTop = scrollContainer ? scrollContainer.scrollTop : 0;

      const matchedRows = matches.map((m) => m.row);
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
      matches.forEach((m) => {
        const fallbackTerms = query.split(" ").filter(Boolean);
        const terms = m.terms?.length ? m.terms : fallbackTerms;
        applyHighlight(m.row, terms);
      });
    } else {
      fullSet.forEach(restoreHighlight);
    }

    ctrl.clear.classList.toggle("ytpf-clear-visible", Boolean(query));

    if (query && ctrl.surface === "modal") {
      const sc = findModalScrollContainer(ctrl);
      if (sc) sc.scrollTop = 0;
    }

    const safeTotal = Math.max(0, ctrl.rows.length);
    const safeVisible = Math.max(0, matches.length);

    if (ctrl.surface === "page") {
      ctrl.meta.textContent = query
        ? `${safeVisible} of ${safeTotal} playlists on this page`
        : `${safeTotal} playlists on this page`;
    }

    if (ctrl.surface === "modal") {
      renderModalApiUi(ctrl, query);
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
      bm25: createBm25Index(rows),
      root: ui.root,
      input: ui.input,
      clear: ui.clear,
      meta: ui.meta,
      parent: rows[0]?.parentElement || null,
      sortResults: surface === "modal",
      synthRows: [],
      hydrationToken: 0,
      hydrationRunning: false,
      hydrationPromise: null,
      apiToken: 0,
      apiBusy: false,
      apiSaving: false,
      apiNotice: "",
    };

    ui.input.addEventListener("input", () => {
      applyFilter(ctrl);
      maybeStartModalHydration(ctrl);
    });
    ui.input.addEventListener("focus", () => {
      suppressMutations(300);
      maybeStartModalHydration(ctrl);
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
      }, 0);
    }
  }

  function upsertHost(host, rows, surface = "modal") {
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
    existing.bm25 = createBm25Index(rows);
    existing.parent = rows[0]?.parentElement || existing.parent;
    existing.sortResults = surface === "modal";
    applyFilter(existing);
    if (surface === "modal") {
      maybeStartModalHydration(existing);
      if (!apiSessionCache.playlists && !existing.apiBusy) {
        bootstrapModalApi(existing);
      }
    }
  }

  function refresh() {
    const activeHosts = new Set();

    queryAllDeep(MODAL_HOST_SELECTOR)
      .filter(isVisible)
      .forEach((host) => {
        const { rows } = collectRows(host);
        if (!rows.length) return;

        activeHosts.add(host);
        upsertHost(host, rows, "modal");
      });

    const pageSurface = collectFeedPageSurface();
    if (pageSurface) {
      activeHosts.add(pageSurface.host);
      upsertHost(pageSurface.host, pageSurface.rows, "page");
    }

    for (const host of [...controllerHosts]) {
      if (!activeHosts.has(host) || !host.isConnected) {
        const ctrl = controllers.get(host);
        if (ctrl && ctrl.root.contains(document.activeElement)) {
          continue;
        }
        teardownHost(host);
      }
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

    const observer = new MutationObserver((mutations) => {
      if (shouldRefreshFromMutations(mutations)) {
        scheduleRefresh();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    refresh();

    window.addEventListener("yt-navigate-finish", () => {
      setTimeout(refresh, 250);
    });

    window.addEventListener("yt-page-data-updated", scheduleRefresh);
  }

  start();
})();
