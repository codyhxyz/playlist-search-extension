#!/usr/bin/env node
/**
 * Live-DOM regression test for /feed/playlists mounting.
 *
 * Loads a captured YouTube playlists DOM fixture into a real Chromium tab
 * via vercel-labs/agent-browser, runs our actual src/content.bundle.js
 * against it (with chrome.* stubs), and asserts that the page-surface mount
 * path finds playlist rows. No mocks of selectors, querySelectorAll, :scope,
 * :has, or shadow DOM — the same engine that ships on real YouTube evaluates
 * them. We exercise the *bundle* not the source so the test hits the same
 * IIFE that Chrome injects in production.
 *
 * Why a Chromium harness instead of jsdom: our selectors use :scope and
 * :has(), our row collection uses queryAllDeep that pierces shadow roots,
 * and the post-2026 lockup-view-model layout is exactly the surface that
 * keeps drifting on us.  Anything less than a real browser engine misses
 * the regressions we actually ship.
 *
 * Fixture provenance: tests/fixtures/channel-playlists-lockup-2026.html
 * was captured live from youtube.com/@MrBeast/playlists on 2026-05-13 via
 * agent-browser eval. The DOM shape — yt-lockup-view-model nested in
 * ytd-item-section-renderer > ytd-grid-renderer — matches /feed/playlists's
 * post-2026 layout 1:1.  We host the fixture at http://127.0.0.1:PORT/feed/
 * playlists so isPlaylistsFeedPage() returns true without any test-only
 * branch in production code.
 *
 * Run:   node tests/test-feed-page-mount.mjs
 * Skip:  set YTPF_SKIP_BROWSER_TESTS=1 (CI without agent-browser available)
 */

import { execFile, execFileSync, spawnSync } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

if (process.env.YTPF_SKIP_BROWSER_TESTS) {
  console.log("SKIP: test-feed-page-mount (YTPF_SKIP_BROWSER_TESTS set)");
  process.exit(0);
}

const which = spawnSync("which", ["agent-browser"], { encoding: "utf8" });
if (which.status !== 0) {
  console.log("SKIP: test-feed-page-mount (agent-browser not installed)");
  console.log("       see ~/.claude/CLAUDE.md for install pointers");
  process.exit(0);
}

// Strip external resources from the fixture: real YouTube CDN URLs would
// stall Chromium's "load" event for the open() command, blocking the test
// behind a 60s timeout. We only care about DOM structure, not images.
const fixtureHtml = readFileSync(
  path.join(REPO, "tests/fixtures/channel-playlists-lockup-2026.html"),
  "utf8",
)
  // Keep relative hrefs intact (PLAYLIST_LINK_SELECTOR needs them) — only
  // strip src/srcset on <img>/<source> which point to YouTube CDN.
  .replace(/\s(src|srcset)=("[^"]*"|'[^']*')/gi, " data-orig-$1=$2");
// Load the BUILT bundle, not the source. src/content.js uses ES module
// imports that the page can't resolve; the bundle is a single IIFE.
const BUNDLE_PATH = path.join(REPO, "src/content.bundle.js");
const contentJs = (() => {
  try {
    return readFileSync(BUNDLE_PATH, "utf8");
  } catch {
    console.error(
      "FATAL: src/content.bundle.js not found. Run `npm run build` first.",
    );
    process.exit(2);
  }
})();
const minisearchJs = readFileSync(
  path.join(REPO, "src/vendor/minisearch.js"),
  "utf8",
);
const stylesCss = readFileSync(path.join(REPO, "src/styles.css"), "utf8");

// Inject a fake native chip-bar above the fixture content so the
// post-1.6.15 chip-mount path activates. The fixture is from a channel
// page (no chip bar of its own); the harness re-hosts it at /feed/playlists
// so isPlaylistsFeedPage() returns true, which makes the chip mount the
// expected target. Without this synthetic chip bar the test would only
// exercise the grid-mount fallback and chip-path regressions would slip.
const fakeChipBar = `
<chip-bar-view-model class="ytChipBarViewModelHost">
  <div class="ytChipBarViewModelChipBarScrollContainer" role="tablist">
    <div class="ytChipBarViewModelChipWrapper"><chip-view-model>Recently added</chip-view-model></div>
    <div class="ytChipBarViewModelChipWrapper"><chip-view-model>Playlists</chip-view-model></div>
  </div>
</chip-bar-view-model>`;

const harness = `<!doctype html>
<html><head><meta charset="utf-8"><title>ytpf mount harness</title>
<style>${stylesCss}</style>
</head>
<body>
${fakeChipBar}
${fixtureHtml}
<script>
  // Minimal chrome.* shim. content.js uses storage.sync/local and runtime;
  // none of the storage calls matter for the mount path, they just need to
  // not throw.  Resolving with empty objects keeps the IIFE quiet.
  window.__ytpfErrors = [];
  window.addEventListener("error", (e) => { window.__ytpfErrors.push({ msg: e.message, src: e.filename, line: e.lineno, col: e.colno, err: String(e.error && e.error.stack || e.error || "") }); });
  window.addEventListener("unhandledrejection", (e) => { window.__ytpfErrors.push({ reason: String(e.reason && e.reason.stack || e.reason || "") }); });
  window.chrome = {
    storage: {
      sync: { get: async () => ({}), set: async () => {}, onChanged: { addListener() {} } },
      local: { get: async () => ({}), set: async () => {} },
      onChanged: { addListener() {} },
    },
    runtime: { getManifest: () => ({ version: "test" }), onMessage: { addListener() {} } },
  };
</script>
<script>${minisearchJs}</script>
<script>${contentJs}</script>
<script>
  // Give the MutationObserver + initial refresh a tick to settle, then
  // expose the probe result for the test runner to read.
  setTimeout(() => {
    try {
      const anyBar = document.querySelector(".ytpf-inline");
      const debug = {};
      const grid = document.querySelector("ytd-item-section-renderer");
      if (grid) {
        const c = grid.querySelector(":scope > #contents");
        debug.itemSectionContents = c ? Array.from(c.children).map((e) => ({ tag: e.tagName.toLowerCase(), cls: e.className || null })) : null;
      }
      const chipBar = document.querySelector(".ytpf-chip");
      const chipRow = document.querySelector(".ytChipBarViewModelChipBarScrollContainer");
      window.__ytpfResult = {
        ok: true,
        diag: window.__ytpfDiag ? window.__ytpfDiag() : null,
        barMounted: !!(chipBar || document.querySelector(".ytpf-inline-page")),
        chipMounted: !!chipBar,
        chipInsideChipRow: !!(chipBar && chipRow && chipRow.contains(chipBar)),
        barCount: document.querySelectorAll(".ytpf-inline").length,
        anyBarHtml: anyBar ? anyBar.outerHTML.slice(0, 300) : null,
        errors: window.__ytpfErrors,
        debug,
      };
    } catch (e) {
      window.__ytpfResult = { ok: false, error: String(e && e.stack || e) };
    }
  }, 800);
</script>
</body></html>`;

// Tiny local server. Routes /feed/playlists to the harness so
// isPlaylistsFeedPage()'s regex match succeeds against window.location.
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/feed/playlists")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(harness);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/feed/playlists`;

const SESSION = "ytpf-mount-test";
// Async wrapper — critical so Node's event loop can serve HTTP requests
// from Chromium concurrently. execFileSync would block the loop and Chromium
// would hang forever waiting on /feed/playlists.
async function ab(...args) {
  const { stdout } = await execFileP(
    "agent-browser",
    ["--session-name", SESSION, ...args],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let exitCode = 0;
try {
  spawnSync("agent-browser", ["close", "--all"], { encoding: "utf8" });
  await ab("open", url);

  // Poll up to ~6s for the harness to set window.__ytpfResult.
  let result = null;
  for (let i = 0; i < 40; i++) {
    const raw = (await ab("eval", "JSON.stringify(window.__ytpfResult || null)")).trim();
    const stripped = raw.startsWith('"') ? JSON.parse(raw) : raw;
    if (stripped && stripped !== "null") {
      result = JSON.parse(stripped);
      break;
    }
    await sleep(150);
  }

  if (!result) {
    console.error("FAIL: harness never set window.__ytpfResult");
    exitCode = 1;
  } else if (!result.ok) {
    console.error("FAIL: harness threw:", result.error);
    exitCode = 1;
  } else {
    const diag = result.diag;
    const passed = [];
    const failed = [];
    const check = (cond, msg) => (cond ? passed : failed).push(msg);

    check(diag != null, "probePageSurface() returned (window.__ytpfDiag exists)");
    check(diag?.isFeedPath === true, `isPlaylistsFeedPage() === true (path: ${diag?.path})`);
    check((diag?.gridCount || 0) > 0, `gridCount > 0 (got ${diag?.gridCount})`);
    const goodCandidate = (diag?.candidates || []).find((c) => c.filteredRowCount > 0);
    check(!!goodCandidate, "at least one grid has filteredRowCount > 0");
    check(result.barMounted, ".ytpf-chip or .ytpf-inline-page actually rendered into the DOM");
    // Chip-path regression guard: when a chip-bar is present in the page
    // (the harness injects one above), the bar MUST mount as a chip child
    // of that chip bar — never as the grid-span fallback. Catches:
    //   - findChipRow() failing to discover the chip-bar-view-model
    //   - attachHost choosing the wrong variant despite chip-row presence
    //   - the chip wrapper rendering OUTSIDE the chip-bar-view-model
    check(result.chipMounted, "chip variant mounted (a chip-bar was present, chip path should win)");
    check(result.chipInsideChipRow, "chip mounted INSIDE .ytChipBarViewModelChipBarScrollContainer");

    // Regression guard for the screenshot-class failure: on direct-lockup
    // grids (no direct ytd-rich-grid-row wrappers), typing a filter must NOT
    // force our generic re-grid CSS. Native YouTube layout already packs
    // direct children correctly; overriding it makes tiny/squashed cards.
    const probeRaw = (await ab("eval", `(async () => {
      const input = document.querySelector(".ytpf-chip input, .ytpf-inline-page input");
      if (!input) return JSON.stringify({ ok: false, reason: "no input" });
      input.value = "zzzqqqzzz";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 350));
      const host = Array.from(document.querySelectorAll("#items, #contents"))
        .find((el) => el.classList.contains("ytpf-page-filtering"));
      const hasDirectRichGridRows = !!host && Array.from(host.children || [])
        .some((child) => child.matches?.("ytd-rich-grid-row"));
      const out = {
        ok: !!host,
        hostTag: host?.tagName?.toLowerCase() || null,
        hostId: host?.id || null,
        hasDirectRichGridRows,
        rowReflowClass: !!host?.classList.contains("ytpf-page-filtering-rows"),
        display: host ? getComputedStyle(host).display : null,
      };
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return JSON.stringify(out);
    })()`)).trim();
    const probeStr = probeRaw.startsWith('"') ? JSON.parse(probeRaw) : probeRaw;
    const filterProbe = JSON.parse(probeStr);
    check(filterProbe.ok, "filter probe found the active page host");
    check(filterProbe.hasDirectRichGridRows === false, "fixture uses direct lockup grid (no ytd-rich-grid-row wrappers)");
    check(filterProbe.rowReflowClass === false, "direct lockup grid does not get row-reflow class while filtering");
    check(filterProbe.display !== "grid", `direct lockup grid was not force-regridded (display: ${filterProbe.display})`);

    console.log(`feed-page-mount: ${passed.length} passed, ${failed.length} failed`);
    passed.forEach((m) => console.log("  ok   " + m));
    failed.forEach((m) => console.log("  FAIL " + m));
    if (failed.length) {
      console.log("\nFull result:", JSON.stringify(result, null, 2));
      exitCode = 1;
    }
  }
} catch (err) {
  console.error("FAIL: test-feed-page-mount threw");
  console.error(err);
  exitCode = 1;
} finally {
  spawnSync("agent-browser", ["close", "--all"], { encoding: "utf8" });
  server.close();
}
process.exit(exitCode);
