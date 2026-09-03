/**
 * Regression tests for the YouTube Playlist Search content script, run
 * against the BUILT bundle inside a vm sandbox.
 * Run: node src/test-search.cjs   (after `npm run build`)
 *
 * Coverage:
 *   1. createPlaylistIndex — BM25 over the InnerTube library snapshot; every
 *      playlist stays findable, including same-titled ones with distinct IDs.
 *   2. Anchor budget, asserted against the bundle — /feed/playlists must
 *      couple to exactly two YouTube DOM anchors, each a single selector and
 *      neither leaning on a build-generated class. The source-level twin is
 *      tests/selectors-anchor-budget.test.mjs; this one catches a bundle
 *      built from a stale tree.
 *   3. Highlight builders — getHighlightRanges and buildHighlightFragment
 *      produce the expected ranges / <mark> structure for the "my favorites"
 *      shape of query (the case you've "fixed a million times before").
 *   4. Identity + account routing — video-id resolution and the InnerTube
 *      session/account key scrape.
 *
 * Loading the bundle at all is itself the reference-integrity check that
 * caught `buildHighlightHtml is not defined` in dist/1.5.4.
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
    this._listeners = new Map();
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
  removeAttribute(k) { delete this.attributes[k]; }
  matches(selector) {
    return String(selector).split(",").some((part) => {
      const value = part.trim();
      if (value.startsWith(".")) return this.classList.contains(value.slice(1));
      return value.toUpperCase() === this.tagName;
    });
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }
  getRootNode() { return this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  getClientRects() { return [{}]; }
  addEventListener(type, listener) {
    const listeners = this._listeners.get(type) || [];
    listeners.push(listener);
    this._listeners.set(type, listeners);
  }
  remove() {
    if (!this.parentNode) return;
    const index = this.parentNode.childNodes.indexOf(this);
    if (index >= 0) this.parentNode.childNodes.splice(index, 1);
    this.parentNode = null;
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

let fakeScripts = [];
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
  getElementsByTagName: (tag) => tag === "script" ? fakeScripts : [],
  querySelector: () => null,
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
// Load content.bundle.js once, capture internal helpers via __YTPF_TEST__
// ---------------------------------------------------------------------------
//
// We exercise the *built* bundle, not the source. src/content.js now uses ES
// module imports that vm.runInContext can't evaluate (it runs Scripts, not
// Modules). The bundle is what Chrome injects, so testing it is what catches
// real-world regressions — the 1.5.4 ReferenceError that motivated this test
// shipped from a bundle, not from raw source.
//
// Build prerequisite: `npm run build`. The CWS zip script runs that as gate
// 1/N; locally, run it after editing src/content.js or src/lib/*.js.

const SRC_PATH = path.join(__dirname, "content.bundle.js");
if (!fs.existsSync(SRC_PATH)) {
  console.error(
    "FATAL: src/content.bundle.js not found. Run `npm run build` first."
  );
  process.exit(2);
}
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
  Element: FakeElement,
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
// Suite 1: createPlaylistIndex — BM25 over the InnerTube library snapshot.
//
// Pre-1.7 this suite indexed YouTube's rendered DOM rows and asserted that
// API playlists weren't deduped away by same-titled rows. That whole problem
// class is gone: there is exactly one source of playlists now (InnerTube), so
// there is nothing to reconcile and nothing to dedup. What remains worth
// pinning is that same-titled playlists with different IDs all stay findable.
// ---------------------------------------------------------------------------

function refsFor(playlists, query) {
  const index = ytpf.createPlaylistIndex(playlists);
  return index.search(query, ytpf.BM25_SEARCH_OPTIONS).map((r) => r.ref);
}

// Every playlist is indexed by its position, including same-title duplicates.
{
  const playlists = [
    { id: "PL_abc", title: "Favorites", itemCount: 3 },
    { id: "PL_xyz", title: "Favorites", itemCount: 9 },
    { id: "PL_other", title: "Rock Favorites Mix", itemCount: 1 },
    { id: "PL_none", title: "Cooking Videos", itemCount: 4 },
  ];
  const refs = refsFor(playlists, "favorites");
  assert(refs.includes("0"), "first 'Favorites' should appear in results");
  assert(refs.includes("1"), "second 'Favorites' (different ID) must not be dropped");
  assert(refs.includes("2"), "'Rock Favorites Mix' should appear");
  assert(!refs.includes("3"), "'Cooking Videos' should not match 'favorites'");
}

// Multi-term query reaches every playlist that carries either term.
{
  const playlists = [
    { id: "PL_a", title: "Favorites", itemCount: 0 },
    { id: "PL_b", title: "My Favorites", itemCount: 0 },
    { id: "PL_c", title: "Gardening", itemCount: 0 },
  ];
  const refs = refsFor(playlists, "my favorites");
  assert(refs.includes("0"), "'Favorites' appears in a 'my favorites' query");
  assert(refs.includes("1"), "'My Favorites' appears in a 'my favorites' query");
  assert(!refs.includes("2"), "'Gardening' should not match 'my favorites'");
}

// Empty library indexes cleanly rather than throwing.
{
  const index = ytpf.createPlaylistIndex([]);
  assert(index !== null, "empty library still produces an index");
  assert(index.search("anything", ytpf.BM25_SEARCH_OPTIONS).length === 0,
    "empty library returns no matches");
}

// ---------------------------------------------------------------------------
// Suite 2: the /feed/playlists anchor budget, asserted against the BUNDLE.
//
// tests/selectors-anchor-budget.test.mjs asserts this against the source
// module. This one asserts it against the artifact Chrome actually injects,
// which is what catches a bundle built from a stale tree.
// ---------------------------------------------------------------------------
{
  const anchors = ytpf.FEED_DOM_ANCHORS;
  assert(Array.isArray(anchors), "bundle exposes FEED_DOM_ANCHORS");
  assert(anchors.length === 2,
    `/feed/playlists must couple to exactly 2 YouTube DOM anchors, bundle has ${anchors.length}`);
  assert(anchors.map((a) => a.id).join(",") === "search-mount,grid",
    "anchor ids should be [search-mount, grid]");
  anchors.forEach((a) => {
    assert(!a.selector.includes(","),
      `anchor "${a.id}" is a selector list ("${a.selector}") — that is N anchors, not one`);
    assert(!/\.yt[A-Z]/.test(a.selector),
      `anchor "${a.id}" leans on a build-generated class ("${a.selector}") — use a role or tag`);
  });
}

// ---------------------------------------------------------------------------
// Suite 3: highlight builders
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
// Suite 4: authoritative identity + account routing
// ---------------------------------------------------------------------------
{
  fakeWindow.location.pathname = "/watch";
  fakeWindow.location.search = "?v=PAGEPAGE001";
  assert(ytpf.getCurrentVideoId() === "PAGEPAGE001",
    "the watch URL is the authoritative video id");

  fakeWindow.location.pathname = "/shorts/SHORTVID001";
  fakeWindow.location.search = "";
  assert(ytpf.getCurrentVideoId() === "SHORTVID001",
    "shorts paths carry the video id in the path");

  fakeWindow.location.pathname = "/feed/subscriptions";
  fakeWindow.location.search = "";
  assert(ytpf.getCurrentVideoId() === "",
    "non-watch pages must not guess a video from arbitrary links");
}

{
  fakeScripts = [{ textContent: '{"INNERTUBE_API_KEY":"key","INNERTUBE_CLIENT_VERSION":"1","SESSION_INDEX":"2","DELEGATED_SESSION_ID":"brand","DATASYNC_ID":"user-a"}' }];
  const session = ytpf.getInnertubeConfig(true);
  assert(session.authUser === "2", "active SESSION_INDEX should route InnerTube requests");
  assert(session.pageId === "brand", "delegated channel should supply X-Goog-PageId");
  assert(session.accountKey.includes("brand"), "cache identity should include delegated channel");
  fakeScripts.push({ textContent: '{"SESSION_INDEX":"2","DELEGATED_SESSION_ID":null}' });
  const primarySession = ytpf.getInnertubeConfig(true);
  assert(primarySession.pageId === null, "a later primary-account config should clear delegated channel state");
  assert(!primarySession.accountKey.includes("brand"), "primary and delegated caches must have different identities");
  fakeScripts = [{ textContent: '{"SESSION_INDEX":"0"}' }];
  assert(ytpf.getInnertubeConfig(true).accountKey === null,
    "API search should fail safe when no stable account identifier exists");
  fakeScripts = [];
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
