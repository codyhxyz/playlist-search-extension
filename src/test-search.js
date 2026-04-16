/**
 * Regression tests for the YouTube Playlist Search content script.
 * Run: node src/test-search.js
 *
 * Coverage:
 *   1. createUnifiedIndex dedup — API "Favorites" is NOT dropped when
 *      a DOM row shares the same normalized title (only dedup by ID).
 *   2. Reference integrity — every callable reachable by typing in the
 *      modal resolves at runtime. Catches bugs like the one that shipped
 *      in dist/1.5.4: `buildHighlightHtml is not defined`, which slipped
 *      in because nothing ever loaded + exercised content.js end-to-end.
 *   3. Highlight builders — getHighlightRanges and buildHighlightFragment
 *      produce the expected ranges / <mark> structure for the "my favorites"
 *      shape of query (the case you've "fixed a million times before").
 */

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const MiniSearch = require("./vendor/minisearch.js");

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`FAIL: ${msg}`); }
}

// ---------------------------------------------------------------------------
// DOM stub — the minimum surface that content.js touches when we exercise
// buildHighlightFragment, applyHighlight, and renderSynthRows. If a method
// here isn't called by those, it doesn't belong here.
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const DOCUMENT_FRAGMENT_NODE = 11;
const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

class FakeTextNode {
  constructor(text) {
    this.nodeType = TEXT_NODE;
    this.nodeValue = text == null ? "" : String(text);
    this.parentNode = null;
  }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = v == null ? "" : String(v); }
}

class FakeFragment {
  constructor() {
    this.nodeType = DOCUMENT_FRAGMENT_NODE;
    this._isFragment = true;
    this.childNodes = [];
    this.parentNode = null;
  }
  appendChild(child) { return appendChildImpl(this, child); }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE); }
}

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...xs) { xs.forEach((x) => this._set.add(x)); }
  remove(...xs) { xs.forEach((x) => this._set.delete(x)); }
  contains(x) { return this._set.has(x); }
  toggle(x, force) {
    const has = this._set.has(x);
    const want = force === undefined ? !has : Boolean(force);
    if (want) this._set.add(x); else this._set.delete(x);
    return want;
  }
  get length() { return this._set.size; }
}

class FakeElement {
  constructor(tag) {
    this.nodeType = ELEMENT_NODE;
    this.tagName = String(tag).toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = {};
    this._connected = false;
  }
  get className() { return Array.from(this.classList._set).join(" "); }
  set className(v) {
    this.classList._set = new Set(String(v || "").split(/\s+/).filter(Boolean));
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === ELEMENT_NODE); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get parentElement() { return this.parentNode; }
  get isConnected() { return this._connected; }
  set isConnected(v) { this._connected = Boolean(v); }
  appendChild(child) { return appendChildImpl(this, child); }
  replaceChild(newChild, oldChild) {
    const idx = this.childNodes.indexOf(oldChild);
    if (idx < 0) throw new Error("oldChild not in parent");
    oldChild.parentNode = null;
    if (newChild && newChild._isFragment) {
      const kids = newChild.childNodes.slice();
      newChild.childNodes = [];
      kids.forEach((k) => { k.parentNode = this; });
      this.childNodes.splice(idx, 1, ...kids);
    } else {
      if (newChild.parentNode) {
        const i2 = newChild.parentNode.childNodes.indexOf(newChild);
        if (i2 >= 0) newChild.parentNode.childNodes.splice(i2, 1);
      }
      newChild.parentNode = this;
      this.childNodes[idx] = newChild;
    }
    return oldChild;
  }
  replaceChildren(...nodes) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    nodes.forEach((n) => this.appendChild(n));
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getClientRects() { return [{}]; }
  addEventListener() {}
  get textContent() {
    return this.childNodes.map((c) => c.textContent == null ? "" : c.textContent).join("");
  }
  set textContent(v) {
    this.childNodes.forEach((c) => { c.parentNode = null; });
    this.childNodes = [];
    if (v != null && v !== "") this.appendChild(new FakeTextNode(String(v)));
  }
  get innerHTML() { return this.textContent; }
  set innerHTML(v) { this.textContent = v; }
}

function appendChildImpl(parent, child) {
  if (child && child._isFragment) {
    const kids = child.childNodes.slice();
    child.childNodes = [];
    kids.forEach((k) => { k.parentNode = parent; parent.childNodes.push(k); });
    return child;
  }
  if (child.parentNode) {
    const i = child.parentNode.childNodes.indexOf(child);
    if (i >= 0) child.parentNode.childNodes.splice(i, 1);
  }
  child.parentNode = parent;
  parent.childNodes.push(child);
  return child;
}

const fakeDocument = {
  createElement: (tag) => new FakeElement(tag),
  createTextNode: (text) => new FakeTextNode(text),
  createDocumentFragment: () => new FakeFragment(),
  createTreeWalker(root, filter /* bitmask */) {
    const collected = [];
    function walk(n) {
      if (!n) return;
      if (filter & SHOW_TEXT && n.nodeType === TEXT_NODE) collected.push(n);
      (n.childNodes || []).forEach(walk);
    }
    walk(root);
    let i = -1;
    return {
      currentNode: root,
      nextNode() { i += 1; return collected[i] || null; },
    };
  },
  getElementsByTagName: () => [],
  body: null,
  head: null,
  documentElement: null,
};

class NoopMutationObserver {
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
}

const fakeWindow = {
  location: { search: "", pathname: "/", origin: "https://www.youtube.com" },
  addEventListener() {},
  getComputedStyle() { return { display: "block", visibility: "visible" }; },
};

// ---------------------------------------------------------------------------
// Load content.js once, capture internal helpers via __YTPF_TEST__
// ---------------------------------------------------------------------------

const SRC_PATH = path.join(__dirname, "content.js");
const contentSrc = fs.readFileSync(SRC_PATH, "utf8");
let ytpf = null;

const sandbox = {
  globalThis: null,
  window: fakeWindow,
  document: fakeDocument,
  MiniSearch,
  MutationObserver: NoopMutationObserver,
  NodeFilter: { SHOW_TEXT, SHOW_ELEMENT: 1 },
  ShadowRoot: class ShadowRoot {},
  URL,
  URLSearchParams,
  performance: { now: () => Date.now() },
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  // start() bails to rAF when document.body is null; no-op stub keeps the IIFE quiet.
  requestAnimationFrame: () => 0,
  cancelAnimationFrame: () => {},
  console,
  __YTPF_TEST__: (exports) => { ytpf = exports; },
};
sandbox.globalThis = sandbox;
Object.assign(fakeWindow, {
  document: fakeDocument,
  MutationObserver: NoopMutationObserver,
});

vm.createContext(sandbox);
try {
  vm.runInContext(contentSrc, sandbox, { filename: "src/content.js" });
} catch (err) {
  console.error("FATAL: src/content.js failed to evaluate in sandbox");
  console.error(err);
  process.exit(1);
}

if (!ytpf) {
  console.error("FATAL: __YTPF_TEST__ hook did not fire. Is the export block at the bottom of src/content.js still present?");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Suite 1: createUnifiedIndex dedup (the "Favorites" regression)
// Runs the real implementation via the vm-exported helpers — no mock.
// ---------------------------------------------------------------------------

function buildIndex(domRows, apiPlaylists) {
  // The real createUnifiedIndex takes DOM row elements; here we fabricate
  // minimal row-shaped objects with a `data.title.simpleText` field, which
  // is the first fallback path getItemText checks.
  const rows = domRows.map((r) => {
    const el = fakeDocument.createElement("div");
    el.data = {
      title: { simpleText: r.title },
      playlistId: r.id,
    };
    return el;
  });
  return ytpf.createUnifiedIndex(rows, apiPlaylists);
}

// exact-match API playlist must NOT be dropped when DOM row shares the title
{
  const dom = [{ id: "PL_abc", title: "Favorites" }];
  const api = [
    { id: "PL_abc", title: "Favorites" },      // same ID -> dedup
    { id: "PL_xyz", title: "Favorites" },      // different ID, same title -> keep
    { id: "PL_other", title: "Rock Favorites Mix" },
  ];

  const idx = buildIndex(dom, api);
  const refs = idx.search("favorites", ytpf.BM25_SEARCH_OPTIONS).map((r) => r.ref);

  assert(refs.includes("0"), "DOM 'Favorites' row should appear in results");
  assert(refs.includes("PL_xyz"), "API 'Favorites' with different ID must not be deduped");
  assert(!refs.includes("PL_abc"), "API playlist with same ID as DOM should be deduped");
  assert(refs.includes("PL_other"), "API 'Rock Favorites Mix' should appear");
}

// API-only "Favorites" appears when not in DOM at all
{
  const dom = [{ id: "PL_111", title: "Cooking Videos" }];
  const api = [{ id: "PL_222", title: "Favorites" }];
  const idx = buildIndex(dom, api);
  const results = idx.search("favorites", ytpf.BM25_SEARCH_OPTIONS);
  assert(results.some((r) => r.ref === "PL_222"), "API-only 'Favorites' must appear in results");
  assert(!results.some((r) => r.ref === "0"), "'Cooking Videos' should not match 'favorites'");
}

// "my favorites" query returns both a DOM "Favorites" and an API "My Favorites"
{
  const dom = [{ id: "PL_a", title: "Favorites" }];
  const api = [
    { id: "PL_b", title: "My Favorites" },
    { id: "PL_c", title: "Favorites" },       // second "Favorites" by ID
  ];
  const idx = buildIndex(dom, api);
  const refs = idx.search("my favorites", ytpf.BM25_SEARCH_OPTIONS).map((r) => r.ref);
  assert(refs.includes("0"), "DOM 'Favorites' appears in 'my favorites' query");
  assert(refs.includes("PL_b"), "API 'My Favorites' appears in 'my favorites' query");
  assert(refs.includes("PL_c"), "second API 'Favorites' appears in 'my favorites' query");
}

// ---------------------------------------------------------------------------
// Suite 1.5: MODAL_HOST_SELECTOR must not silently broaden.
// Generic dialog components (tp-yt-paper-dialog, yt-contextual-sheet-layout)
// are used across YouTube for many non-playlist surfaces — most visibly the
// video upload Visibility step. They may only appear in MODAL_HOST_SELECTOR
// when guarded by :has(toggleable-list-item-view-model) (the playlist-row
// marker for the post-rollout view-model save modal). A bare reference would
// re-introduce the regression that commit d652799 fixed.
// ---------------------------------------------------------------------------
{
  const sel = ytpf.MODAL_HOST_SELECTOR;
  assert(typeof sel === "string" && sel.length > 0, "MODAL_HOST_SELECTOR should be a non-empty string");
  assert(sel.includes("ytd-add-to-playlist-renderer"), "MODAL_HOST_SELECTOR must still match ytd-add-to-playlist-renderer");

  const requiresHasGuard = (tag) => {
    const re = new RegExp(`${tag}(?!:has\\()`, "g");
    const matches = sel.match(re) || [];
    assert(
      matches.length === 0,
      `MODAL_HOST_SELECTOR must only reference ${tag} when guarded by :has(toggleable-list-item-view-model) — bare match catches non-playlist surfaces (e.g. upload Visibility)`,
    );
  };
  requiresHasGuard("tp-yt-paper-dialog");
  requiresHasGuard("yt-contextual-sheet-layout");
}

// ---------------------------------------------------------------------------
// Suite 2: highlight builders
// ---------------------------------------------------------------------------

// getHighlightRanges on the canonical "my favorites" case
{
  const r = ytpf.getHighlightRanges("my favorites", ["my", "favorites"]);
  assert(r.length === 2, `expected 2 ranges for 'my favorites', got ${r.length}`);
  if (r.length === 2) {
    assert(r[0].from === 0 && r[0].to === 2, `first range should be (0,2), got (${r[0].from},${r[0].to})`);
    assert(r[1].from === 3 && r[1].to === 12, `second range should be (3,12), got (${r[1].from},${r[1].to})`);
  }
}

// BM25 can match via prefix/fuzzy but substring highlight can't
{
  const r = ytpf.getHighlightRanges("favs", ["favorites"]);
  assert(r.length === 0, "no ranges when BM25-matched term is not a substring of the text");
}

// buildHighlightFragment produces the right structure
{
  const frag = ytpf.buildHighlightFragment("My Favorites", [{ from: 0, to: 2 }, { from: 3, to: 12 }]);
  const marks = frag.childNodes.filter((c) => c.nodeType === ELEMENT_NODE && c.tagName === "MARK");
  const texts = frag.childNodes.filter((c) => c.nodeType === TEXT_NODE);
  assert(marks.length === 2, `expected 2 <mark>, got ${marks.length}`);
  assert(texts.length === 1, `expected 1 text node (the space between), got ${texts.length}`);
  if (marks.length === 2) {
    assert(marks[0].textContent === "My", `first mark text should be 'My', got '${marks[0].textContent}'`);
    assert(marks[1].textContent === "Favorites", `second mark text should be 'Favorites', got '${marks[1].textContent}'`);
    assert(marks[0].classList.contains("ytpf-mark"), "mark should have ytpf-mark class");
  }
  if (texts.length === 1) {
    assert(texts[0].nodeValue === " ", `separator text node should be a single space, got '${texts[0].nodeValue}'`);
  }
}

// buildHighlightFragment with empty ranges returns a fragment containing only text
{
  const frag = ytpf.buildHighlightFragment("Untouched", []);
  assert(frag.childNodes.length === 1, "empty ranges yields a fragment with a single text node");
  assert(frag.childNodes[0].nodeType === TEXT_NODE, "that single child is a text node");
  assert(frag.childNodes[0].nodeValue === "Untouched", "text content preserved");
}

// ---------------------------------------------------------------------------
// Suite 3: reference integrity via renderSynthRows
// Would have caught "buildHighlightHtml is not defined" before it shipped.
// ---------------------------------------------------------------------------
{
  const parent = fakeDocument.createElement("div");
  parent._connected = true;
  const host = fakeDocument.createElement("div");
  host._connected = true;

  const ctrl = {
    surface: "modal",
    parent,
    host,
    synthRows: [],
    rows: [],
    bm25: null,
  };

  const apiMatches = [
    { source: "api", playlist: { id: "PL_a", title: "My Favorites" }, terms: ["my", "favorites"], score: 2.5 },
    { source: "api", playlist: { id: "PL_b", title: "Jazz Favorites" }, terms: ["favorites"], score: 0.9 },
    { source: "api", playlist: { id: "PL_c", title: "Cooking" }, terms: [], score: 0.3 },
  ];

  let threw = null;
  try {
    ytpf.renderSynthRows(ctrl, apiMatches, "my favorites");
  } catch (err) {
    threw = err;
  }
  assert(!threw, `renderSynthRows threw: ${threw && threw.message}`);
  assert(ctrl.synthRows.length === 3, `expected 3 synth rows, got ${ctrl.synthRows.length}`);
  assert(parent.children.length === 3, "synth rows were appended to parent");

  // Sanity: the row with highlighting should contain a <mark>
  const firstRow = ctrl.synthRows[0];
  const titleSpan = firstRow && firstRow.childNodes.find((c) => c.tagName === "SPAN");
  const marksInTitle = (titleSpan?.childNodes || []).filter((c) => c.tagName === "MARK");
  assert(marksInTitle.length >= 1, "synth row for 'My Favorites' should contain at least one <mark>");
}

// ---------------------------------------------------------------------------
// Suite 4: diagnostic ring buffer (self-only regression reporter)
// The ring is the load-bearing part of the "captured-on-failure" telemetry —
// if it grows unbounded, chrome.storage.local fills up; if it mutates its
// input, concurrent reads of prior state blow up. Keep it pure and bounded.
// ---------------------------------------------------------------------------
{
  const cap = ytpf.DIAG_RING_SIZE;
  assert(typeof cap === "number" && cap >= 5, "DIAG_RING_SIZE should be a sensible positive integer");

  // empty start: appends cleanly, doesn't mutate undefined
  const r1 = ytpf.appendToRing(undefined, { invariant: "a", ts: 1 }, cap);
  assert(Array.isArray(r1) && r1.length === 1, "append to empty yields [entry]");
  assert(r1[0].invariant === "a", "entry preserved");

  // doesn't mutate the input array
  const prior = [{ invariant: "x", ts: 0 }];
  const r2 = ytpf.appendToRing(prior, { invariant: "y", ts: 1 }, cap);
  assert(prior.length === 1 && prior[0].invariant === "x", "input array not mutated");
  assert(r2.length === 2 && r2[1].invariant === "y", "new array has appended entry");

  // caps at DIAG_RING_SIZE, oldest dropped first
  let ring = [];
  for (let i = 0; i < cap + 5; i += 1) {
    ring = ytpf.appendToRing(ring, { invariant: "e", ts: i }, cap);
  }
  assert(ring.length === cap, `ring caps at ${cap}, got ${ring.length}`);
  assert(ring[0].ts === 5, "oldest entries dropped (FIFO)");
  assert(ring[ring.length - 1].ts === cap + 4, "newest entry at tail");

  // non-array ring defends against corrupt storage values
  const r3 = ytpf.appendToRing("garbage", { invariant: "z", ts: 9 }, cap);
  assert(Array.isArray(r3) && r3.length === 1 && r3[0].invariant === "z",
    "non-array prior value is treated as empty");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
