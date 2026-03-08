(() => {
  "use strict";

  const HIDDEN_CLASS = "ytpf-hidden";
  const FILTER_CLASS = "ytpf-inline";
  const STYLE_ID = "ytpf-inline-style";

  const HOST_SELECTOR =
    "ytd-add-to-playlist-renderer, yt-add-to-playlist-renderer, yt-contextual-sheet-layout, tp-yt-paper-dialog, [role='dialog']";

  const DIRECT_ROW_SELECTOR =
    "ytd-playlist-add-to-option-renderer, yt-playlist-add-to-option-renderer, yt-checkbox-list-entry-renderer, yt-list-item-view-model, yt-collection-item-view-model";

  const CHECKBOX_SELECTOR =
    "tp-yt-paper-checkbox, [role='checkbox'], input[type='checkbox']";
  const RELEVANT_SELECTOR = `${HOST_SELECTOR}, ${DIRECT_ROW_SELECTOR}, ${CHECKBOX_SELECTOR}`;

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
    .ytpf-input {
      flex: 1;
      min-width: 0;
      height: 36px;
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.2));
      border-radius: 18px;
      padding: 0 12px;
      background: transparent;
      color: var(--yt-spec-text-primary, #0f0f0f);
      font-family: Roboto, Arial, sans-serif;
      font-size: 14px;
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
      align-items: center;
      justify-content: center;
      height: 36px;
      border: 1px solid var(--yt-spec-10-percent-layer, rgba(0, 0, 0, 0.2));
      border-radius: 18px;
      padding: 0 12px;
      background: transparent;
      color: var(--yt-spec-text-secondary, #606060);
      font-family: Roboto, Arial, sans-serif;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
    }
    .ytpf-clear-visible {
      display: inline-flex;
    }
    .ytpf-clear:hover {
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
  `;

  const textCache = new WeakMap();
  const hiddenRows = new WeakMap();
  const labelHtmlCache = new WeakMap();
  const controllerHosts = new Set();
  const controllers = new WeakMap();
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

  function suppressMutations(ms = 120) {
    suppressMutationsUntil = Math.max(suppressMutationsUntil, nowMs() + ms);
  }

  function normalizeText(value) {
    return (value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
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
    if (!ctrl.bm25) {
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
    if (node.matches(RELEVANT_SELECTOR)) return true;
    if (node.querySelector(RELEVANT_SELECTOR)) return true;
    return Boolean(node.closest(HOST_SELECTOR));
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
    const explicit = checkbox.closest(DIRECT_ROW_SELECTOR);
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
    const directRows = unique(queryAllDeep(DIRECT_ROW_SELECTOR, host)).filter(
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

  function findMountPoint(rows, host) {
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

  function createInlineFilterUi() {
    const root = document.createElement("section");
    root.className = FILTER_CLASS;

    const row = document.createElement("div");
    row.className = "ytpf-row";

    const input = document.createElement("input");
    input.className = "ytpf-input";
    input.type = "text";
    input.placeholder = "Search playlists";
    input.setAttribute("aria-label", "Search playlists");
    input.autocomplete = "off";
    input.spellcheck = false;

    const clear = document.createElement("button");
    clear.className = "ytpf-clear";
    clear.type = "button";
    clear.textContent = "Clear";
    clear.setAttribute("aria-label", "Clear search");

    row.appendChild(input);
    row.appendChild(clear);

    const meta = document.createElement("p");
    meta.className = "ytpf-meta";
    meta.setAttribute("aria-live", "polite");

    root.appendChild(row);
    root.appendChild(meta);

    return { root, input, clear, meta };
  }

  function teardownHost(host) {
    const ctrl = controllers.get(host);
    if (!ctrl) return;

    ctrl.rows.forEach((row) => {
      showRow(row);
      restoreHighlight(row);
    });
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

    if (ctrl.parent?.isConnected) {
      const orderedRows = query ? matches.map((m) => m.row) : [...fullSet];
      orderedRows.forEach((row) => {
        if (row.parentElement === ctrl.parent) {
          ctrl.parent.appendChild(row);
        }
      });
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

    const safeTotal = Math.max(0, ctrl.rows.length);
    const safeVisible = Math.max(0, matches.length);

    if (!query) {
      ctrl.meta.textContent = `${safeTotal} playlists`;
      return;
    }

    ctrl.meta.textContent = `${safeVisible} of ${safeTotal} playlists`;
  }

  function attachHost(host, rows) {
    const mount = findMountPoint(rows, host);
    if (!mount) return;
    ensureScopedStyles(mount.parent.getRootNode?.() || document);

    const ui = createInlineFilterUi();

    if (mount.after) {
      mount.after.after(ui.root);
    } else if (mount.before) {
      mount.parent.insertBefore(ui.root, mount.before);
    } else {
      mount.parent.appendChild(ui.root);
    }

    const ctrl = {
      host,
      rows,
      bm25: createBm25Index(rows),
      root: ui.root,
      input: ui.input,
      clear: ui.clear,
      meta: ui.meta,
      parent: rows[0]?.parentElement || null,
    };

    ui.input.addEventListener("input", () => applyFilter(ctrl));
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
      if (ui.input.isConnected) ui.input.focus();
    });
  }

  function upsertHost(host, rows) {
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
    applyFilter(existing);
  }

  function refresh() {
    const activeHosts = new Set();

    queryAllDeep(HOST_SELECTOR)
      .filter(isVisible)
      .forEach((host) => {
        const { rows } = collectRows(host);
        if (!rows.length) return;

        activeHosts.add(host);
        upsertHost(host, rows);
      });

    for (const host of [...controllerHosts]) {
      if (!activeHosts.has(host) || !host.isConnected) {
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
