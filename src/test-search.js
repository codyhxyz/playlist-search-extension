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

const BM25_SEARCH_OPTIONS = {
  prefix: true,
  fuzzy: 0.2,
  combineWith: "OR",
  weights: { fuzzy: 0.1, prefix: 0.75 },
};

function normalizeText(value) {
  return (value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Suite 1: createUnifiedIndex dedup (the original "Favorites" regression)
// ---------------------------------------------------------------------------

/** Mimics createUnifiedIndex from content.js */
function createUnifiedIndexMock(domRows, apiPlaylists) {
  const index = new MiniSearch({
    fields: ["text"],
    storeFields: ["source", "ref"],
    searchOptions: BM25_SEARCH_OPTIONS,
  });

  const docs = [];

  domRows.forEach((row, i) => {
    docs.push({ id: `dom:${i}`, text: normalizeText(row.title), source: "dom", ref: String(i) });
  });

  if (apiPlaylists?.length) {
    const domIds = new Set(domRows.map((r) => r.id).filter(Boolean));
    apiPlaylists.forEach((pl) => {
      if (domIds.has(pl.id)) return;
      docs.push({ id: `api:${pl.id}`, text: normalizeText(pl.title), source: "api", ref: pl.id });
    });
  }

  index.addAll(docs);
  return index;
}

// exact-match API playlist must NOT be dropped when DOM row shares the title
{
  const dom = [{ id: "PL_abc", title: "Favorites" }];
  const api = [
    { id: "PL_abc", title: "Favorites" },      // same ID -> dedup
    { id: "PL_xyz", title: "Favorites" },      // different ID, same title -> keep
    { id: "PL_other", title: "Rock Favorites Mix" },
  ];

  const idx = createUnifiedIndexMock(dom, api);
  const refs = idx.search("favorites", BM25_SEARCH_OPTIONS).map((r) => r.ref);

  assert(refs.includes("0"), "DOM 'Favorites' row should appear in results");
  assert(refs.includes("PL_xyz"), "API 'Favorites' with different ID must not be deduped");
  assert(!refs.includes("PL_abc"), "API playlist with same ID as DOM should be deduped");
  assert(refs.includes("PL_other"), "API 'Rock Favorites Mix' should appear");
}

// API-only "Favorites" appears when not in DOM at all
{
  const dom = [{ id: "PL_111", title: "Cooking Videos" }];
  const api = [{ id: "PL_222", title: "Favorites" }];
  const idx = createUnifiedIndexMock(dom, api);
  const results = idx.search("favorites", BM25_SEARCH_OPTIONS);
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
  const idx = createUnifiedIndexMock(dom, api);
  const refs = idx.search("my favorites", BM25_SEARCH_OPTIONS).map((r) => r.ref);
  assert(refs.includes("0"), "DOM 'Favorites' appears in 'my favorites' query");
  assert(refs.includes("PL_b"), "API 'My Favorites' appears in 'my favorites' query");
  assert(refs.includes("PL_c"), "second API 'Favorites' appears in 'my favorites' query");
}

// ---------------------------------------------------------------------------
// Suite 2+3: load content.js in a sandbox and exercise it
// ---------------------------------------------------------------------------

const SHOW_TEXT = 4; // NodeFilter.SHOW_TEXT

class FakeTextNode {
  constructor(text) {
    this.nodeType = 3;
    this.nodeValue = text == null ? "" : String(text);
    this.parentNode = null;
  }
  get textContent() { return this.nodeValue; }
  set textContent(v) { this.nodeValue = v == null ? "" : String(v); }
}

class FakeFragment {
  constructor() {
    this.nodeType = 11;
    this._isFragment = true;
    this.childNodes = [];
    this.parentNode = null;
  }
  appendChild(child) { return appendChildImpl(this, child); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
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
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.classList = new FakeClassList();
    this.style = {};
    this.attributes = {};
    this._connected = false;
  }
  get className() {
    return Array.from(this.classList._set).join(" ");
  }
  set className(v) {
    this.classList._set = new Set(String(v || "").split(/\s+/).filter(Boolean));
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
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
  matches() { return false; }
  closest() { return null; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getRootNode() { return fakeDocument; }
  getClientRects() { return [{}]; }
  addEventListener() {}
  removeEventListener() {}
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.childNodes.indexOf(this);
      if (i >= 0) this.parentNode.childNodes.splice(i, 1);
      this.parentNode = null;
    }
  }
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
      const type = n.nodeType;
      if (filter & SHOW_TEXT && type === 3) collected.push(n);
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
  removeEventListener() {},
  getComputedStyle() { return { display: "block", visibility: "visible" }; },
};

// Load content.js in a vm context, capture exports via __YTPF_TEST__.
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
  requestAnimationFrame: (fn) => 0, // start() bails to this when body is null; we want to bail
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

// ---- Suite 2: highlight builders ----

// getHighlightRanges on the canonical "my favorites" case
{
  const r = ytpf.getHighlightRanges("my favorites", ["my", "favorites"]);
  assert(r.length === 2, `expected 2 ranges for 'my favorites', got ${r.length}`);
  if (r.length === 2) {
    assert(r[0].from === 0 && r[0].to === 2, `first range should be (0,2), got (${r[0].from},${r[0].to})`);
    assert(r[1].from === 3 && r[1].to === 12, `second range should be (3,12), got (${r[1].from},${r[1].to})`);
  }
}

// getHighlightRanges against a case where BM25 would match via prefix but no substring exists
// ("favs" fuzzy-matches "favorites" in BM25, but we can't find "favorites" as substring of "favs")
{
  const r = ytpf.getHighlightRanges("favs", ["favorites"]);
  assert(r.length === 0, "no ranges when BM25-matched term is not a substring of the text");
}

// buildHighlightFragment produces the right structure
{
  const frag = ytpf.buildHighlightFragment("My Favorites", [{ from: 0, to: 2 }, { from: 3, to: 12 }]);
  const marks = frag.childNodes.filter((c) => c.nodeType === 1 && c.tagName === "MARK");
  const texts = frag.childNodes.filter((c) => c.nodeType === 3);
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
  assert(frag.childNodes[0].nodeType === 3, "that single child is a text node");
  assert(frag.childNodes[0].nodeValue === "Untouched", "text content preserved");
}

// ---- Suite 3: reference integrity via renderSynthRows ----
// This is the check that would have caught "buildHighlightHtml is not defined"
// before it shipped. We fabricate a ctrl + apiMatches shaped like what
// applyFilter would produce for a "my favorites" keystroke, then call
// renderSynthRows. Any undefined-function reference in that hot path throws.
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

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
