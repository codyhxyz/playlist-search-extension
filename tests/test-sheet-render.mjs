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
  window.__sheet = createSheet({
    videoId: "dQw4w9WgXcQ",
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

  const $ = (sel) => window.__shadow.querySelector(sel);
  const $$ = (sel) => Array.from(window.__shadow.querySelectorAll(sel));
  const rows = () => $$('[role="option"]');
  const rowByTitle = (t) => rows().find((r) => r.textContent.includes(t));

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
      $('input').focus();
      $('dialog').dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
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
    // Text of a row, normalised — the tri-state comparison hangs off this.
    rowText: (t) => { const r = rowByTitle(t); return r ? r.textContent.replace(/\\s+/g, " ").trim() : null; },
    rowActionable: (t) => {
      const r = rowByTitle(t);
      if (!r) return null;
      return { ariaDisabled: r.getAttribute("aria-disabled"), cursor: getComputedStyle(r).cursor };
    },
    heights: () => rows().slice(0, 12).map((r) => Math.round(r.getBoundingClientRect().height)),
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
        requestedMode: window.__requestedMode,
        hostParentIsDocumentElement: host.parentElement === document.documentElement,
        hostInsideYouTubeApp: !!host.closest("ytd-app"),
        adoptedSheets: window.__shadow.adoptedStyleSheets.length,
        styleTagsInShadow: window.__shadow.querySelectorAll("style, link").length,
      };
    },
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

  // ── 3. Tri-state membership — the one that must not regress ───────────────
  console.log("\nMembership is tri-state");
  await run("return window.h.type('');");
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
  const closed = await run("return window.h.clickOutside();");
  check("clicking outside the dialog closes it and fires onClose exactly once", () =>
    assert.equal(closed.closes, 1));
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
