#!/usr/bin/env node
/**
 * Does the file Chrome actually injects survive being evaluated?
 *
 * This is the cheapest test in the suite and it guards the most catastrophic
 * failure mode: a throw at module scope means the content script registers no
 * listeners at all, so every save silently does nothing. There is no error the
 * user can see, no broken UI, no clue — the extension is simply inert. 1.5.4
 * shipped exactly that (`ReferenceError: buildHighlightHtml is not defined`),
 * and during the 2.0.0 rewrite a stray `${...}` inside the sheet's CSS template
 * literal did it again. Both were invisible to every other test in the repo:
 * unit tests import modules individually, and the browser contract test
 * imports `sheet.js` directly rather than the bundle.
 *
 * So this evaluates `src/content.bundle.js` — the real artifact, post-esbuild —
 * in a vm with the smallest DOM/chrome shims that let it reach the end of its
 * own top-level code, and asserts it wired up the handlers it exists to wire up.
 *
 * It is NOT a functional test of the UI; tests/test-sheet-render.mjs does that
 * in a real engine. This one only answers "is it alive at all".
 *
 * Run: node tests/test-bundle-boots.mjs
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(REPO, "src/content.bundle.js");

let source;
try {
  source = readFileSync(BUNDLE, "utf8");
} catch {
  console.error("FATAL: src/content.bundle.js not found. Run `npm run build` first.");
  process.exit(2);
}

// ── Shims ───────────────────────────────────────────────────────────────────
// Deliberately minimal. Every stub here is something the bundle touches at
// module scope; if it starts touching something new, this test fails loudly
// rather than silently skipping the new code.
const record = {
  runtimeListeners: 0,
  documentEvents: [],
  windowEvents: [],
  postedMessages: [],
  logs: [],
  errors: [],
};

const el = () => ({
  setAttribute() {}, removeAttribute() {}, append() {}, remove() {}, focus() {}, blur() {},
  addEventListener() {}, removeEventListener() {}, replaceChildren() {},
  attachShadow: () => ({ adoptedStyleSheets: [], append() {}, querySelector: () => null, querySelectorAll: () => [] }),
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  style: {}, dataset: {}, textContent: "", value: "", hidden: false,
});

const ctx = {
  console: {
    log: (...a) => record.logs.push(a.join(" ")),
    warn: (...a) => record.logs.push(a.join(" ")),
    error: (...a) => record.errors.push(a.join(" ")),
  },
  setTimeout: (fn) => { try { fn(); } catch (e) { record.errors.push(String(e)); } return 0; },
  clearTimeout() {},
  performance: { now: () => 0 },
  location: {
    href: "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    pathname: "/watch",
    search: "?v=jNQXAC9IVRw",
    origin: "https://www.youtube.com",
  },
  chrome: {
    runtime: {
      sendMessage: async () => {},
      onMessage: { addListener: () => { record.runtimeListeners++; } },
    },
  },
  document: {
    addEventListener: (type) => record.documentEvents.push(type),
    documentElement: { append() {} },
    createElement: el,
    createElementNS: el,
    dispatchEvent: () => true,
    scripts: [],
    cookie: "",
  },
  CSSStyleSheet: class { replaceSync() {} },
  KeyboardEvent: class { constructor(type, init) { Object.assign(this, { type }, init); } },
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  TextEncoder,
  crypto: { subtle: { digest: async () => new ArrayBuffer(20) } },
};
ctx.window = ctx;
ctx.globalThis = ctx;
ctx.window.addEventListener = (type) => record.windowEvents.push(type);
ctx.window.postMessage = (msg) => record.postedMessages.push(msg);

// ── The test ────────────────────────────────────────────────────────────────
createContext(ctx);
try {
  runInContext(source, ctx, { filename: "content.bundle.js" });
} catch (err) {
  console.error("✗ src/content.bundle.js THREW at module scope — the extension would install dead.\n");
  console.error(`  ${err.message}`);
  console.error(`\n  ${(err.stack || "").split("\n").slice(1, 4).join("\n  ")}`);
  process.exit(1);
}

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures++;
    console.log(`  ✗ ${name}\n      ${err.message.split("\n").join("\n      ")}`);
  }
}

console.log("content.bundle.js boot contract\n");

check("evaluates without throwing at module scope", () => {
  // Reaching here at all proves it. Asserted explicitly so the check is named.
  assert.ok(source.length > 0);
});

check("registers a chrome.runtime.onMessage listener", () => {
  // Without this the service worker's SAVE_INTENT arrives nowhere and every
  // entry point — native Save, toolbar, right-click, hotkey — does nothing.
  assert.equal(record.runtimeListeners, 1);
});

check("pings the MAIN-world hook", () => {
  // The isolated half loads later than the hook and cannot see its globals, so
  // this handshake is the only way it learns whether intent detection is alive.
  assert.ok(
    record.postedMessages.some((m) => m && m.__pls === "hook-ping"),
    `expected a hook-ping postMessage, saw: ${JSON.stringify(record.postedMessages)}`,
  );
});

check("warns loudly when the hook does not answer", () => {
  // The shims never reply, so the 3s timeout should fire. A silent hook means
  // every native Save button is dead; the user has to be told, not left guessing.
  assert.ok(
    record.errors.some((e) => e.includes("MAIN-world intent hook did not answer")),
    `expected an explicit hook-missing error, saw: ${JSON.stringify(record.errors)}`,
  );
});

check("listens for SPA navigation on both channels", () => {
  // youtube.com never reloads. Missing either of these leaves a sheet from the
  // previous video on screen, and its guard then swallows every later intent.
  assert.ok(record.documentEvents.includes("yt-navigate-finish"), "missing yt-navigate-finish");
  assert.ok(record.windowEvents.includes("popstate"), "missing popstate");
});

check("relays page messages", () => {
  assert.ok(record.windowEvents.includes("message"), "missing window message listener");
});

check("carries no string-to-HTML SINK", () => {
  // Writes only. Reading `documentElement.innerHTML` is legitimate and the
  // InnerTube client does it as a last-resort config scrape — Trusted Types
  // governs assignment and HTML-parsing methods, not reads. Flagging reads
  // would train people to work around the test instead of the hazard.
  const scannable = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const sinks = [
    ...scannable.matchAll(/\.(innerHTML|outerHTML)\s*(?:\+?=)(?!=)/g),
    ...scannable.matchAll(/\b(insertAdjacentHTML|document\.write)\s*\(/g),
  ];
  assert.deepEqual(
    sinks.map((m) => m[1]),
    [],
    "YouTube enforces Trusted Types; assigning a string to innerHTML throws on the real site",
  );
});

console.log(
  failures === 0
    ? "\ntest-bundle-boots: all checks passed"
    : `\ntest-bundle-boots: ${failures} check(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
