#!/usr/bin/env node
/**
 * Contract test for the save sheet — the whole user-facing surface of the extension.
 *
 * Why a real engine instead of jsdom: the sheet is a CLOSED shadow root hosting a
 * `<dialog>` driven by `showModal()`. Top-layer placement, `:modal`, `adoptedStyleSheets`,
 * backdrop hit-testing and `offsetHeight` are the things that actually break, and jsdom
 * models none of them.
 *
 * These assertions are deliberately written against ROLES, ARIA and TEXT rather than
 * class names, so the sheet can be restyled freely without rewriting the test. What is
 * pinned here is behaviour that is load-bearing for correctness, not appearance:
 *
 *   1. The surface is ours: closed shadow root, hosted OUTSIDE YouTube's tree, styled
 *      through adoptedStyleSheets, in the browser's top layer.
 *   2. No string-to-HTML sink anywhere (YouTube enforces Trusted Types).
 *   3. Membership is TRI-STATE. `false` and `undefined` must render identically —
 *      YouTube reports at most 200 playlists, so on a larger library the tail is
 *      unknowable and an unmarked row must not claim "not in this playlist".
 *   4. "Already in" rows are not save targets. YouTube permits duplicate entries, so a
 *      clickable already-saved row silently adds the video twice.
 *   5. Failure is recoverable and legible: a failed save says so and can be retried.
 *   6. Every offered sort orders by what its label claims, membership still groups
 *      first in all of them, and the control is reachable with a real Tab without
 *      taking a single key away from the query field.
 *
 * Run:   node tests/test-sheet-render.mjs
 * Skip:  set YTPF_SKIP_BROWSER_TESTS=1 (CI without agent-browser available)
 */

import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
// Overridable so the sheet can be exercised from a scratch copy during a redesign
// without the suite racing an in-progress edit of the real file.
const SHEET_PATH = process.env.PLS_SHEET_PATH
  ? path.resolve(process.env.PLS_SHEET_PATH)
  : path.join(REPO, "src/lib/sheet.js");

if (process.env.YTPF_SKIP_BROWSER_TESTS) {
  console.log("SKIP: test-sheet-render (YTPF_SKIP_BROWSER_TESTS set)");
  process.exit(0);
}
if (spawnSync("which", ["agent-browser"], { encoding: "utf8" }).status !== 0) {
  console.log("SKIP: test-sheet-render (agent-browser not installed)");
  process.exit(0);
}

// ── Static check: no string-to-HTML sink ────────────────────────────────────
// Runs before the browser so it fails fast and cheap. YouTube sets
// `require-trusted-types-for 'script'`; a single innerHTML assignment throws at
// runtime on the real site, where this test does not run.
const sheetSource = readFileSync(SHEET_PATH, "utf8");
// Comments are stripped first — sheet.js documents the rule in prose ("never
// innerHTML"), and a check that its own warning label trips is a check that trains
// people to delete the warning label.
const scannable = sheetSource
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const sinks = [
  ...scannable.matchAll(/\.(innerHTML|outerHTML)\s*(?:\+?=)(?!=)/g),
  ...scannable.matchAll(/\b(insertAdjacentHTML|document\.write)\s*\(/g),
];
assert.equal(
  sinks.length,
  0,
  `sheet.js must never use a string-to-HTML sink (Trusted Types); found: ${sinks.map((m) => m[1]).join(", ")}`,
);

// ── Fixture ─────────────────────────────────────────────────────────────────
// 260 playlists, because the interesting behaviour only exists above 200: the row
// cap, the "keep typing" hint, and the unknowable membership tail.
const PLAYLISTS = (() => {
  const out = [
    { id: "PLmember0001", title: "Deep Focus Instrumentals", member: true },
    { id: "PLmember0002", title: "Focus — Rain & Thunder", member: true },
    { id: "PLknown00003", title: "Morning Focus", member: false },
    { id: "PLunknown004", title: "Focus (archive)", member: undefined },
    { id: "PLemoji00005", title: "🌊 Ocean sounds 🐋 for very late nights", member: undefined },
    {
      id: "PLlong000006",
      title:
        "An extremely long playlist title that should ellipsis on a single line so that row height stays constant for arrow-key navigation and never reflows the list",
      member: false,
    },
    { id: "PLdupe000007", title: "AGI this", member: false },
    { id: "PLdupe000008", title: "AGI this", member: undefined },
    { id: "PLfail000009", title: "Woodworking Basics", member: false },
  ];
  for (let i = out.length; i < 260; i++) {
    out.push({
      id: `PLfiller${String(i).padStart(4, "0")}`,
      title: `Filler playlist ${i}`,
      member: i % 3 === 0 ? false : undefined,
    });
  }
  return out;
})();

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>save sheet harness</title></head>
<body>
<!-- Stand-in for YouTube's app root. The sheet must NOT mount inside this. -->
<ytd-app><div id="page">youtube content</div></ytd-app>
<script>
  // Classic script, deliberately BEFORE the module: a module that fails to parse or
  // import never runs its own listeners, so the diagnostics have to already exist.
  // Stand-in for YouTube's shortcut handler: document-level, bubble phase, with
  // the usual "ignore this if the user is typing" guard. The guard is defeated by
  // shadow retargeting (the target arrives as the host, not the input), which is
  // exactly why the sheet has to stop these itself.
  window.__hostPageKeys = [];
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    window.__hostPageKeys.push(e.key);
  });

  window.__errors = [];
  window.addEventListener("error", (e) => window.__errors.push(String(e.message || e)));
  window.addEventListener("unhandledrejection", (e) => window.__errors.push(String((e.reason && e.reason.stack) || e.reason)));

  // The sheet uses a CLOSED shadow root on purpose — the page cannot reach in, which
  // is the point. To inspect it we force it open at construction and record what mode
  // the production code ASKED for, so the closed-ness is still asserted.
  window.__shadow = null;
  window.__requestedMode = null;
  const realAttach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function (init) {
    window.__requestedMode = init && init.mode;
    const root = realAttach.call(this, { ...init, mode: "open" });
    window.__shadow = root;
    return root;
  };
</script>
<script type="module">
  let createSheet;
  try {
    ({ createSheet } = await import("/lib/sheet.js"));
  } catch (e) {
    window.__errors.push("import failed: " + ((e && e.stack) || e));
    throw e;
  }

  const PLAYLISTS = ${JSON.stringify(PLAYLISTS)};
  // JSON drops \`undefined\`, so restore the third state explicitly — it is the
  // single most important value in this fixture.
  for (const p of PLAYLISTS) if (!("member" in p)) p.member = undefined;

  window.__picks = [];
  window.__closes = 0;
  const makeSheet = () => createSheet({
    videoId: "dQw4w9WgXcQ",
    videoTitle: "Never Gonna Give You Up (Official Video)",
    onPick: (p) => {
      window.__picks.push(p.id);
      // One playlist always fails, so the error path is exercised for real.
      if (p.id === "PLfail000009" && window.__picks.filter((x) => x === p.id).length === 1) {
        return Promise.reject(new Error("simulated 500"));
      }
      return new Promise((r) => setTimeout(r, 30));
    },
    onClose: () => { window.__closes++; },
  });
  window.__sheet = makeSheet();

  const $ = (sel) => window.__shadow.querySelector(sel);
  const $$ = (sel) => Array.from(window.__shadow.querySelectorAll(sel));
  const rows = () => $$('[role="option"]');
  const rowByTitle = (t) => rows().find((r) => r.textContent.includes(t));
  // Found by its accessible name, not its class — the sort control is allowed to be
  // restyled or renamed in the markup, but it must always say what it does.
  const sortBtn = () => $('[aria-label^="Sort order"]');
  // A row's own title, with any state word ("Already in", "Saved") stripped, so an
  // order assertion compares titles rather than titles-plus-whatever-happened-to-them.
  const rowTitle = (r) => (r.getAttribute("title") || r.textContent).trim();

  window.h = {
    ready: () => !!window.__shadow,
    load: () => { window.__sheet.setData(PLAYLISTS); },
    status: (t) => window.__sheet.setStatus(t),
    async type(v) {
      const input = $('input');
      input.value = v;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
      return this.snapshot();
    },
    async key(k) {
      // Dispatch from the INPUT, not the dialog. A real keystroke starts at the
      // focused input and travels input -> dialog -> shadow root -> host -> page,
      // and the containment fix lives at the last hop. Firing straight at the
      // dialog skips the very path under test — which is how a broken Escape
      // passed here while failing in a browser.
      const input = $('input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 60));
      return this.snapshot();
    },
    async clickTitle(t) {
      const row = rowByTitle(t);
      if (!row) return { clicked: false };
      row.click();
      await new Promise((r) => setTimeout(r, 220));
      return { clicked: true, ...this.snapshot() };
    },
    async clickOutside() {
      const dlg = $('dialog');
      // A modal dialog reports backdrop clicks as its own target, so aim well
      // outside its box — this is exactly the case the sheet has to disambiguate.
      dlg.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 4, clientY: 4 }));
      await new Promise((r) => setTimeout(r, 60));
      return { hostConnected: window.__shadow.host.isConnected, closes: window.__closes };
    },
    async typeKeys(keys) {
      const input = $('input');
      input.focus();
      for (const k of keys) {
        input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }));
      }
      await new Promise((r) => setTimeout(r, 60));
      return { escaped: window.__hostPageKeys.slice() };
    },
    // Text of a row, normalised — the tri-state comparison hangs off this.
    rowText: (t) => { const r = rowByTitle(t); return r ? r.textContent.replace(/\\s+/g, " ").trim() : null; },
    rowActionable: (t) => {
      const r = rowByTitle(t);
      if (!r) return null;
      return { ariaDisabled: r.getAttribute("aria-disabled"), cursor: getComputedStyle(r).cursor };
    },
    heights: () => rows().slice(0, 12).map((r) => Math.round(r.getBoundingClientRect().height)),

    // ── ordering ──────────────────────────────────────────────────────────
    titles: (n) => rows().slice(0, n == null ? rows().length : n).map(rowTitle),
    sortControl() {
      const b = sortBtn();
      if (!b) return { present: false };
      const cs = getComputedStyle(b);
      return {
        present: true,
        tag: b.tagName,
        label: b.getAttribute("aria-label"),
        tooltip: b.getAttribute("title"),
        text: b.textContent.replace(/\\s+/g, " ").trim(),
        ariaHidden: b.closest("[aria-hidden='true']") !== null,
        tabIndex: b.tabIndex,
        disabled: b.disabled,
        display: cs.display,
        // Every focusable node inside the dialog, in tab order, so "reachable by
        // Tab" is asserted rather than assumed.
        focusOrder: Array.from(
          $('dialog').querySelectorAll(
            'input:not([tabindex="-1"]), button:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
          ),
        ).map((n) => n.getAttribute("aria-label") || n.tagName),
      };
    },
    async cycleSort(times = 1) {
      for (let i = 0; i < times; i++) sortBtn().click();
      await new Promise((r) => setTimeout(r, 60));
      return { label: sortBtn().getAttribute("aria-label"), ...this.snapshot() };
    },
    // Which row the cursor rests on. Members are not save targets, so opening the
    // cursor on one means Enter silently does nothing.
    activeIndex() {
      const id = $('input').getAttribute("aria-activedescendant");
      return rows().findIndex((r) => r.id === id);
    },
    focusedInSheet() {
      const a = window.__shadow.activeElement;
      return a ? { tag: a.tagName, label: a.getAttribute("aria-label"), type: a.type || null } : null;
    },
    focusSort() { sortBtn().focus(); return this.focusedInSheet(); },
    // Dispatch a key AT the sort button, the way a real keystroke would arrive
    // once focus is there.
    async sortKey(k) {
      const b = sortBtn();
      b.focus();
      const notCancelled = b.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 60));
      return {
        notCancelled,
        label: sortBtn().getAttribute("aria-label"),
        query: $('input').value,
        focused: this.focusedInSheet(),
        picks: window.__picks.slice(),
      };
    },
    async closeKey(k) {
      const b = $('[aria-label="Close"]');
      b.focus();
      const notCancelled = b.dispatchEvent(
        new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 60));
      return { notCancelled, picks: window.__picks.slice(), open: !!$('dialog').open };
    },
    focusInput() { $('input').focus(); return this.focusedInSheet(); },
    snapshot() {
      const dlg = $('dialog');
      const active = $('input') ? $('input').getAttribute("aria-activedescendant") : null;
      const listText = window.__shadow.textContent.replace(/\\s+/g, " ");
      return {
        rowCount: rows().length,
        activeId: active,
        activeIsRealRow: !!(active && window.__shadow.getElementById(active)),
        selectedCount: rows().filter((r) => r.getAttribute("aria-selected") === "true").length,
        dialogOpen: !!(dlg && dlg.open),
        isModal: !!(dlg && dlg.matches(":modal")),
        statusText: ($('[role="status"]') || {}).textContent || "",
        listText,
        picks: window.__picks.slice(),
        closes: window.__closes,
        errors: window.__errors.slice(),
      };
    },
    environment() {
      const host = window.__shadow.host;
      return {
        sheetText: window.__shadow.textContent.replace(/\s+/g, " "),
        hostVideoIdAttr: host.getAttribute("data-video-id"),
        requestedMode: window.__requestedMode,
        hostParentIsDocumentElement: host.parentElement === document.documentElement,
        hostInsideYouTubeApp: !!host.closest("ytd-app"),
        adoptedSheets: window.__shadow.adoptedStyleSheets.length,
        styleTagsInShadow: window.__shadow.querySelectorAll("style, link").length,
      };
    },
  };
  // Dismissal is tested twice (Escape, then outside-click) and each needs a live
  // sheet, so the harness can build a fresh one on demand.
  window.__reopen = () => {
    window.__sheet = makeSheet();
    window.__sheet.setData(PLAYLISTS);
  };
  window.__booted = true;
</script>
</body></html>`;

// Debug hatch: `PLS_DUMP_PAGE=/tmp/p.html node tests/test-sheet-render.mjs` writes the
// generated harness so it can be opened by hand when a boot failure has no stack.
if (process.env.PLS_DUMP_PAGE) {
  (await import("node:fs")).writeFileSync(process.env.PLS_DUMP_PAGE, PAGE);
  console.log(`wrote ${process.env.PLS_DUMP_PAGE}`);
  process.exit(0);
}

// ── Server ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === "/lib/sheet.js") {
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    res.end(readFileSync(SHEET_PATH, "utf8"));
    return;
  }
  if (req.url.startsWith("/sheet")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const SESSION = "pls-sheet-test";

// Async wrapper — critical so Node's event loop can serve HTTP requests from
// Chromium concurrently. A sync spawn would deadlock the page load.
async function ab(...args) {
  const { stdout } = await execFileP("agent-browser", ["--session", SESSION, ...args], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}
// agent-browser awaits a returned promise and prints the result JSON-encoded, so one
// helper covers both sync and async page code.
async function run(expr) {
  const out = await ab("eval", `(async () => { ${expr} })().then((v) => JSON.stringify(v === undefined ? null : v))`);
  return JSON.parse(JSON.parse(out));
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

try {
  // Closing tears the daemon down asynchronously, so an immediate open can race the
  // dying socket and land on about:blank. One short-fuse retry absorbs it — the same
  // dance tests/e2e/run.sh does for the same reason.
  const url = `http://127.0.0.1:${port}/sheet`;
  await ab("close").catch(() => {});
  try {
    await ab("open", url);
  } catch {
    await new Promise((r) => setTimeout(r, 1500));
    await ab("open", url);
  }

  // Poll rather than sleep a fixed amount: the very first Chromium launch of a run
  // is far slower than the rest, and a fixed wait that is generous enough for a cold
  // start is dead time on every subsequent one.
  let booted = { booted: false, errors: [], href: "?" };
  for (let attempt = 0; attempt < 25 && !booted.booted; attempt++) {
    booted = await run(
      "return { booted: !!window.__booted, errors: window.__errors || [], href: location.href, state: document.readyState };",
    );
    // Landed on about:blank because open raced the daemon — navigate again.
    if (!booted.booted && !booted.href.includes(String(port))) await ab("open", url);
    else if (!booted.booted) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(
    booted.booted,
    `sheet module failed to boot at ${booted.href} (${booted.state}): ${JSON.stringify(booted.errors)}`,
  );

  // ── 1. The surface is ours ────────────────────────────────────────────────
  console.log("\nA surface we own outright");
  const env = await run("return window.h.environment();");
  check("shadow root is requested CLOSED", () => assert.equal(env.requestedMode, "closed"));
  check("host is attached to <html>, outside YouTube's tree", () => {
    assert.equal(env.hostParentIsDocumentElement, true);
    assert.equal(env.hostInsideYouTubeApp, false);
  });
  check("names the video rather than printing its id", () => {
    // The id is accurate and useless — it reads as a leaked debug field to
    // anyone who isn't us. The name is the thing the user recognises.
    assert.match(env.sheetText, /Never Gonna Give You Up/);
    assert.doesNotMatch(
      env.sheetText,
      /dQw4w9WgXcQ/,
      "the raw video id must not be rendered anywhere in the sheet",
    );
  });

  check("keeps the video id reachable for diagnostics, off-screen", () => {
    // Still needed by the console and by tests/e2e/specs/intent-chain.sh, which
    // uses it to prove the worker decoded the protobuf. Attribute, not pixels.
    assert.equal(env.hostVideoIdAttr, "dQw4w9WgXcQ");
  });

  check("styles arrive via adoptedStyleSheets, not injected <style> tags", () => {
    assert.ok(env.adoptedSheets >= 1, "expected at least one adopted stylesheet");
    assert.equal(env.styleTagsInShadow, 0);
  });

  const initial = await run("return window.h.snapshot();");
  check("dialog is open and in the browser's top layer", () => {
    assert.equal(initial.dialogOpen, true);
    assert.equal(initial.isModal, true, "dialog must be opened with showModal(), not show()");
  });

  // ── 2. Loading and the 200-row cap ────────────────────────────────────────
  console.log("\nList, filtering, and the row cap");
  await ab("eval", "window.h.load()");
  await ab("wait", "150");
  const loaded = await run("return window.h.snapshot();");
  check("renders at most 200 rows from a 260-playlist library", () =>
    assert.equal(loaded.rowCount, 200));
  check("says how many it is not showing rather than truncating silently", () =>
    assert.match(loaded.listText, /60 more/));

  const focus = await run("return window.h.type('focus');");
  check("typing narrows to matching playlists only", () => {
    assert.equal(focus.rowCount, 4, `expected the 4 'Focus' playlists, got ${focus.rowCount}`);
    assert.doesNotMatch(focus.listText, /Woodworking/);
  });
  check("filtering is case-insensitive and substring-based", () =>
    assert.match(focus.listText, /Deep Focus Instrumentals/));

  const none = await run("return window.h.type('zzzqqq');");
  check("no-match state echoes the query back", () => {
    assert.equal(none.rowCount, 0);
    assert.match(none.listText, /zzzqqq/);
  });

  // ── 2b. Ordering ──────────────────────────────────────────────────────────
  // The rule for this whole section: a sort mode is a CLAIM, and each check below
  // is that claim tested against an order the fixture makes unambiguous. A mode
  // that quietly orders by something other than its label is the specific bug
  // architecture/coverage.md exists to prevent, and it is invisible by eye.
  console.log("\nOrdering");
  await run("return window.h.type('');");
  const ctl = await run("return window.h.sortControl();");
  check("there is a sort control, and it names the current order out loud", () => {
    assert.equal(ctl.present, true, "no element with an aria-label starting 'Sort order'");
    assert.equal(ctl.tag, "BUTTON", "it must be a real button, not a div with a click handler");
    assert.match(ctl.label, /Sort order:/);
    assert.equal(ctl.ariaHidden, false, "the control must not sit inside an aria-hidden subtree");
  });
  check("the control is in the tab order, after the field it must not compete with", () => {
    assert.ok(ctl.tabIndex >= 0, `tabIndex ${ctl.tabIndex} would take it out of the tab order`);
    assert.equal(ctl.disabled, false);
    const i = ctl.focusOrder.findIndex((n) => /^Sort order/.test(n));
    const q = ctl.focusOrder.findIndex((n) => n === "Search playlists");
    assert.ok(i > q && q > -1, `sort must follow the query field in tab order: ${ctl.focusOrder}`);
    // Rows are <button>s. If they are left in the tab order the sort control is 200
    // presses away, which is the same as unreachable.
    assert.ok(
      ctl.focusOrder.length <= 4,
      `only the field and the sheet's own controls may be tab stops, saw ${ctl.focusOrder.length}`,
    );
  });

  // 'focus' matches exactly four playlists — two members and two not — so the whole
  // rendered list can be pinned title-for-title with no row cap in the way.
  const MEMBERS = ["Deep Focus Instrumentals", "Focus — Rain & Thunder"];
  const bestFocus = await run("return window.h.type('focus');");
  const bestTitles = await run("return { t: window.h.titles() };");
  check("Best match ranks by where the query lands in the title", () => {
    // "Focus — Rain & Thunder" starts with the query; "Deep Focus Instrumentals"
    // has it at index 5. Alphabetically the pair is the other way round, so this
    // ordering can only come from the match position.
    assert.deepEqual(bestTitles.t, [
      "Focus — Rain & Thunder",
      "Deep Focus Instrumentals",
      "Focus (archive)",
      "Morning Focus",
    ]);
  });
  check("Best match is the default", () =>
    assert.match(ctl.label, /best match/i));

  const az = await run("return window.h.cycleSort();");
  const azTitles = await run("return { t: window.h.titles(), label: window.h.sortControl().label };");
  check("A → Z orders by title ascending, in every group", () => {
    assert.match(azTitles.label, /A to Z/);
    assert.deepEqual(azTitles.t, [
      "Deep Focus Instrumentals",
      "Focus — Rain & Thunder",
      "Focus (archive)",
      "Morning Focus",
    ]);
  });

  const zaTitles = await run(
    "await window.h.cycleSort(); return { t: window.h.titles(), label: window.h.sortControl().label };",
  );
  check("Z → A is the exact reverse, within each group", () => {
    assert.match(zaTitles.label, /Z to A/);
    assert.deepEqual(zaTitles.t, [
      "Focus — Rain & Thunder",
      "Deep Focus Instrumentals",
      "Morning Focus",
      "Focus (archive)",
    ]);
  });
  check("membership groups first no matter which sort is on", () => {
    // The one thing that must survive every ordering: a `member === true` row is
    // not a save target, so it is a partition, not a peer to be sorted among.
    for (const [name, t] of [["best", bestTitles.t], ["az", azTitles.t], ["za", zaTitles.t]]) {
      assert.deepEqual([...t.slice(0, 2)].sort(), [...MEMBERS].sort(), `${name} broke the grouping`);
    }
  });
  check("member:false and member:undefined stay in the SAME group under every sort", () => {
    // The tri-state promise has to survive sorting too. 'Morning Focus' is false and
    // 'Focus (archive)' is undefined; if sorting ever split them into different
    // groups, an unmarked row would start implying "not in this playlist".
    for (const t of [bestTitles.t, azTitles.t, zaTitles.t]) {
      const a = t.indexOf("Morning Focus");
      const b = t.indexOf("Focus (archive)");
      assert.equal(Math.abs(a - b), 1, `they must be adjacent, got ${a} and ${b}`);
      assert.ok(Math.min(a, b) === 2, "both belong below the member group");
    }
  });
  check("changing the sort does not close the sheet or lose the query", () =>
    assert.equal(az.closes, bestFocus.closes));

  // 'playlist' sits at index 7 in every "Filler playlist N" and at index 18 in the
  // long title, while alphabetically the long title ("An…") comes first. The two
  // orders therefore disagree about row 0 — which is the point.
  const matchP = await run("await window.h.cycleSort(); return window.h.type('playlist');");
  const matchTop = await run("return { t: window.h.titles(3), all: window.h.snapshot().listText };");
  check("Best match beats alphabetical on an ordering they disagree about", () => {
    assert.match(matchTop.t[0], /^Filler playlist/, `row 0 was "${matchTop.t[0]}"`);
    assert.equal(matchTop.t[0], "Filler playlist 9", "shortest title breaks a position tie");
  });
  check("ordering happens BEFORE the 200-row cap", () => {
    // The long title is the worst match of the 252, so under Best match it falls
    // past the cap and must not be rendered at all. If the cap were applied first
    // this row would survive and the mode would be sorting a truncated list.
    assert.doesNotMatch(matchTop.all, /An extremely long playlist/);
  });
  const azP = await run("await window.h.cycleSort(); return { t: window.h.titles(3), all: window.h.snapshot().listText };");
  check("A → Z on the same query puts the alphabetically-first row on top", () => {
    assert.match(azP.t[0], /^An extremely long playlist/, `row 0 was "${azP.t[0]}"`);
    assert.match(azP.all, /An extremely long playlist/);
  });
  // Back to Best match for everything below.
  await run("await window.h.cycleSort(2); return null;");

  // ── 2c. The cursor opens on a row Enter can act on ────────────────────────
  await run("return window.h.type('focus');");
  const cursor = await run("return { i: window.h.activeIndex(), t: window.h.titles() };");
  check("the cursor opens below the member group, on the first real target", () => {
    // Members are not save targets — pick() returns early on them. Resting the
    // cursor on row 0 meant that for any video already in a playlist, opening the
    // sheet and pressing Enter did nothing whatsoever, and said nothing about it.
    assert.equal(cursor.i, 2, `cursor sat on "${cursor.t[cursor.i]}", which cannot be saved to`);
  });

  // ── 2d. The control costs the query field nothing ─────────────────────────
  const typed = await run("return window.h.sortKey('z');");
  check("typing while the sort control has focus lands in the query, not on the floor", () => {
    assert.equal(typed.query, "focusz", `query was "${typed.query}"`);
    assert.equal(typed.focused.type, "text", "focus must return to the query field");
  });
  const enterOnSort = await run("return window.h.sortKey('Enter');");
  check("Enter on the sort control does not save a playlist", () => {
    // The sheet's Enter handler lives on the dialog, so without an explicit guard
    // it fires for a focused button too — and its preventDefault() then swallows
    // the button's own activation. Both halves of that are wrong.
    assert.deepEqual(enterOnSort.picks, [], "Enter on the sort control saved something");
    assert.equal(enterOnSort.notCancelled, true, "preventDefault would swallow the button's click");
  });
  const enterOnClose = await run("return window.h.closeKey('Enter');");
  check("Enter on the close button closes rather than saving", () => {
    assert.deepEqual(enterOnClose.picks, []);
    assert.equal(enterOnClose.notCancelled, true, "preventDefault would stop the close button working");
  });
  const arrowOnSort = await run("return window.h.sortKey('ArrowRight');");
  check("arrow keys cycle the order while the control has focus", () => {
    assert.match(arrowOnSort.label, /A to Z/);
    assert.equal(arrowOnSort.notCancelled, false, "the arrow must be consumed, not left to scroll");
  });
  await run("return window.h.sortKey('ArrowLeft');");

  // A REAL Tab, not a synthesised one: synthetic key events never move focus, so a
  // dispatched Tab would assert nothing about whether this is actually reachable.
  // Deliberately with the FULL list showing: Chrome turns an overflowing scroller
  // into a tab stop, so with a short list this passes while the real sheet — which
  // almost always overflows — puts an extra stop in the way.
  await run("await window.h.type(''); return window.h.focusInput();");
  await ab("press", "Tab");
  await ab("press", "Tab");
  const tabbed = await run("return window.h.focusedInSheet();");
  check("two real Tabs from the query field reach the sort control", () =>
    assert.match(tabbed?.label ?? "(nothing focused)", /^Sort order/));
  const beforeRealEnter = (await run("return { n: window.__picks.length };")).n;
  await ab("press", "Enter");
  const realEnter = await run(
    "return { label: window.h.sortControl().label, picks: window.__picks.length, open: window.h.snapshot().dialogOpen };",
  );
  check("a real Enter there changes the order — and only the order", () => {
    assert.match(realEnter.label, /A to Z/, "Enter did not activate the control");
    assert.equal(realEnter.picks, beforeRealEnter, "Enter on the control saved a playlist");
    assert.equal(realEnter.open, true, "the sheet must not close");
  });
  await run("await window.h.cycleSort(2); window.h.focusInput(); return null;");

  // ── 3. Tri-state membership — the one that must not regress ───────────────
  console.log("\nMembership is tri-state");
  // Under the default order this 260-playlist fixture pushes 'Morning Focus' and
  // 'Focus (archive)' past the 200-row cap, exactly as production would. Narrowing
  // first is the real path to those rows, and the comparison below is unchanged.
  await run("return window.h.type('focus');");
  const tri = await run(`return {
    memberTrue: window.h.rowText('Deep Focus Instrumentals'),
    memberFalse: window.h.rowText('Morning Focus'),
    memberUnknown: window.h.rowText('Focus (archive)'),
  };`);
  check("member:true is marked", () =>
    assert.notEqual(tri.memberTrue, "Deep Focus Instrumentals", "an already-saved row must carry a visible mark"));
  check("member:false and member:undefined render IDENTICALLY", () => {
    // The whole tri-state argument in one assertion. YouTube reports at most 200
    // playlists — the same 200 for every video — so beyond that we genuinely do not
    // know. A bare row must claim nothing; anything that distinguishes "not in" from
    // "unknown" is an answer we do not have.
    assert.equal(tri.memberFalse, "Morning Focus");
    assert.equal(tri.memberUnknown, "Focus (archive)");
  });

  // ── 4. Already-saved rows are not save targets ────────────────────────────
  console.log("\nAlready-saved rows are not targets");
  const memberClick = await run("return window.h.clickTitle('Deep Focus Instrumentals');");
  check("clicking an 'already in' row does not add the video again", () =>
    assert.deepEqual(memberClick.picks, [], "YouTube allows duplicate entries — this would silently double-add"));

  // ── 5. Saving ─────────────────────────────────────────────────────────────
  console.log("\nSaving");
  // Measured as a delta, so a regression in the previous section fails only the
  // check that owns it instead of cascading down the rest of the file.
  await run("return window.h.type('');");
  const beforeSave = (await run("return { n: window.__picks.length };")).n;
  const saved = await run("return window.h.clickTitle('Filler playlist 20');");
  check("clicking an unsaved row calls onPick exactly once", () =>
    assert.equal(saved.picks.length, beforeSave + 1));
  const savedRow = await run("return { text: window.h.rowText('Filler playlist 20') };");
  check("a saved row reports its new state in text, not colour alone", () =>
    assert.notEqual(savedRow.text, "Filler playlist 20"));
  const reclick = await run("return window.h.clickTitle('Filler playlist 20');");
  check("a saved row is inert to further clicks", () =>
    assert.equal(reclick.picks.length, beforeSave + 1));

  // ── 6. Failure is legible and recoverable ─────────────────────────────────
  console.log("\nFailure");
  // Narrow to it first: 'Woodworking Basics' sorts last of 260, so like production
  // it lives past the 200-row cap until the query brings it into view.
  await run("return window.h.type('wood');");
  const failed = await run("return window.h.clickTitle('Woodworking Basics');");
  check("a failed save says so in the row", () => {
    const t = failed.listText;
    assert.match(t, /fail|Fail|couldn|Couldn|retry|Retry|again/, "the failure must be stated, not just coloured");
  });
  const retried = await run("return window.h.clickTitle('Woodworking Basics');");
  check("a failed row can be retried", () =>
    assert.equal(retried.picks.filter((p) => p === "PLfail000009").length, 2));

  // ── 7. Keyboard ───────────────────────────────────────────────────────────
  console.log("\nKeyboard");
  await run("return window.h.type('filler');");
  const down = await run("return window.h.key('ArrowDown');");
  check("aria-activedescendant points at a real row", () => {
    assert.ok(down.activeId, "expected aria-activedescendant to be set");
    assert.equal(down.activeIsRealRow, true);
  });
  check("exactly one row is aria-selected at a time", () =>
    assert.equal(down.selectedCount, 1));
  const before = down.picks.length;
  const entered = await run("return window.h.key('Enter');");
  check("Enter saves the active row", () =>
    assert.equal(entered.picks.length, before + 1));

  // ── The sheet owns the keyboard while it is open ─────────────────────────
  const leak = await run(
    "return window.h.typeKeys(['f','k','m','t','j','l','c','i','0','5',' ','ArrowLeft','ArrowRight']);",
  );
  check("no keystroke reaches the host page's shortcut handler", () => {
    // f fullscreen, k play/pause, m mute, t theater, j/l seek, c captions,
    // i miniplayer, digits scrub, space play/pause, arrows seek+volume. Every
    // one of these is a single key on YouTube, and every one of them would fire
    // mid-query without this. Measured before the fix: f/k/m/t all got through.
    assert.deepEqual(
      leak.escaped,
      [],
      "keys typed into the search field escaped to a document-level listener",
    );
  });

  const stillWorks = await run("return window.h.key('ArrowDown');");
  check("blocking the page does not block our own navigation", () => {
    // The fix stops events at the host, ABOVE our handlers. If it ever moves
    // below them it would silence the sheet's own keyboard instead.
    assert.ok(stillWorks.activeId, "arrow keys must still move the cursor");
    assert.equal(stillWorks.selectedCount, 1);
  });

  // ── 8. Layout invariants ──────────────────────────────────────────────────
  console.log("\nLayout");
  await run("return window.h.type('');");
  const heights = await run("return { h: window.h.heights() };");
  check("row height is constant despite long titles and emoji", () => {
    const uniq = [...new Set(heights.h)];
    assert.equal(uniq.length, 1, `arrow-key navigation needs a constant row height; saw ${uniq.join(", ")}px`);
  });

  // ── 9. Status line ────────────────────────────────────────────────────────
  console.log("\nStatus");
  await ab("eval", "window.h.status('260 playlists · 809ms · 2 already saved')");
  const status = await run("return window.h.snapshot();");
  check("setStatus lands in a polite live region", () =>
    assert.match(status.statusText, /260 playlists/));

  // ── 10. Dismissal ─────────────────────────────────────────────────────────
  console.log("\nDismissal");
  // Escape had no test, which is how stopping key events at the host silently
  // broke it — the containment fix also cut off the UA's close watcher. A live
  // spec caught it two steps later, by which point the cause was not obvious.
  const esc = await run("return window.h.key('Escape');");
  check("Escape closes the sheet", () => {
    assert.equal(esc.dialogOpen, false, "Escape must close the dialog");
    assert.equal(esc.closes, 1, "onClose fires exactly once");
  });
  // Reopen for the outside-click check below.
  await run("window.__reopen(); return null;");
  // Delta, not absolute: Escape already closed one sheet above, so a running
  // total would make this assert the previous test's outcome instead of its own.
  const beforeClose = (await run("return { n: window.__closes };")).n;
  const closed = await run("return window.h.clickOutside();");
  check("clicking outside the dialog closes it and fires onClose exactly once", () =>
    assert.equal(closed.closes, beforeClose + 1));
  const after = await run("return { hostConnected: window.__shadow.host.isConnected, closes: window.__closes };");
  check("closing removes the host element — no state outlives the sheet", () =>
    assert.equal(after.hostConnected, false));

  // ── 11. Nothing threw along the way ───────────────────────────────────────
  const final = await run("return { errors: window.__errors };");
  check("no uncaught errors or rejections during the whole session", () =>
    assert.deepEqual(final.errors, []));

  console.log(
    failures === 0
      ? "\ntest-sheet-render: all checks passed"
      : `\ntest-sheet-render: ${failures} check(s) FAILED`,
  );
} finally {
  await ab("close").catch(() => {});
  server.close();
}

process.exit(failures === 0 ? 0 : 1);
