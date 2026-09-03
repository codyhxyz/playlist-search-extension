#!/usr/bin/env node
/**
 * Live-DOM contract test for the owned /feed/playlists surface.
 *
 * Since v1.7 this page does NOT filter YouTube's rendered cards. It renders
 * our own result list from the InnerTube library snapshot and hides YouTube's
 * grid while those results are showing. The contract this test pins:
 *
 *   1. Our search chip mounts inside YouTube's chip bar — and ONLY there.
 *   2. Typing renders OUR cards (title + count + /playlist?list= link).
 *   3. YouTube's grid container is hidden while our results show.
 *   4. Clearing the query restores their grid EXACTLY (same inline style).
 *   5. NO FALLBACK MOUNT: with the chip bar absent, we render nothing at all.
 *   6. The shipped bundle carries exactly two YouTube DOM anchors.
 *
 * Why a Chromium harness instead of jsdom: the anchors use `>` combinators
 * and role selectors, `queryAllDeep` pierces shadow roots, our results panel
 * IS a shadow root, and visibility gating calls getClientRects(). Anything
 * less than a real engine misses the regressions we actually ship.
 *
 * Fixture provenance: tests/fixtures/channel-playlists-lockup-2026.html was
 * captured live from youtube.com/@MrBeast/playlists on 2026-05-13. We no
 * longer parse anything inside it — it is here as a realistic *payload* for
 * the container we hide, and because it contains two decoy `[role='tablist']`
 * elements (the channel tab bar) that our `chip-bar-view-model`-scoped mount
 * anchor must refuse to mount into.
 *
 * InnerTube is stubbed at `window.fetch` with a canned browse response, so
 * the real path runs end to end — config scrape, SAPISIDHASH, request,
 * parsePlaylistRenderers, index, render — with no auth and no network.
 *
 * Run:   node tests/test-feed-page-mount.mjs
 * Skip:  set YTPF_SKIP_BROWSER_TESTS=1 (CI without agent-browser available)
 */

import { execFile, spawnSync } from "node:child_process";
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
).replace(/\s(src|srcset)=("[^"]*"|'[^']*')/gi, " data-orig-$1=$2");

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

// ── Synthetic page shell ────────────────────────────────────────────────
// Models the real /feed/playlists shape that the two anchors target:
//   ytd-rich-grid-renderer > #header > chip-bar-view-model > [role=tablist]
//   ytd-rich-grid-renderer > #contents
// The captured channel DOM goes inside #contents as realistic payload.
const CHIPS = `
    <chip-bar-view-model class="ytChipBarViewModelHost">
      <div class="ytChipBarViewModelChipBarScrollContainer" role="tablist">
        <div class="ytChipBarViewModelChipWrapper"><chip-view-model>Recently added</chip-view-model></div>
        <div class="ytChipBarViewModelChipWrapper"><chip-view-model>Playlists</chip-view-model></div>
      </div>
    </chip-bar-view-model>`;

// A canned FEplaylist_aggregation response. Titles are chosen so one query
// ("focus") hits a subset and another ("zzzqqq") hits nothing.
const PLAYLIST_TITLES = [
  "Deep Focus Instrumentals",
  "Focus Mode",
  "Morning Focus",
  "Woodworking Basics",
  "Bread Baking",
  "Live Coding Sessions",
  "Rust Talks",
  "Old Movie Trailers",
];
const innertubeResponse = {
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    itemSectionRenderer: {
                      contents: [
                        {
                          gridRenderer: {
                            items: PLAYLIST_TITLES.map((title, i) => ({
                              gridPlaylistRenderer: {
                                playlistId: `PLTEST${String(i).padStart(4, "0")}`,
                                title: { runs: [{ text: title }] },
                                videoCountShortText: { simpleText: String(10 + i) },
                              },
                            })),
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

function harnessHtml({ withChipBar }) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>ytpf feed harness</title>
<style>${stylesCss}</style>
<style>
  ytd-rich-grid-renderer, ytd-rich-grid-renderer > #header, ytd-rich-grid-renderer > #contents { display: block; }
  .ytChipBarViewModelChipBarScrollContainer { display: flex; gap: 12px; min-height: 32px; }
</style>
</head>
<body>
<ytd-rich-grid-renderer>
  <div id="header">${withChipBar ? CHIPS : "<!-- no chip bar on this variant -->"}</div>
  <div id="contents">
${fixtureHtml}
  </div>
</ytd-rich-grid-renderer>
<script>{"INNERTUBE_API_KEY":"AIzaTESTKEY","INNERTUBE_CLIENT_VERSION":"2.20260828.00.00","SESSION_INDEX":"0","DATASYNC_ID":"ytpf-test-user","DELEGATED_SESSION_ID":null}</script>
<script>
  window.__ytpfErrors = [];
  window.addEventListener("error", (e) => { window.__ytpfErrors.push({ msg: e.message, line: e.lineno, err: String((e.error && e.error.stack) || e.error || "") }); });
  window.addEventListener("unhandledrejection", (e) => { window.__ytpfErrors.push({ reason: String((e.reason && e.reason.stack) || e.reason || "") }); });

  // Signed-in session, faked at the only two places content.js looks.
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => "SAPISID=ytpf_test_sapisid; SID=x",
    set: () => {},
  });

  // InnerTube stub. Exercises the real request path (SAPISIDHASH, headers,
  // parsePlaylistRenderers) without auth or network.
  window.__ytpfFetches = [];
  const INNERTUBE_RESPONSE = ${JSON.stringify(innertubeResponse)};
  window.fetch = async (url, init) => {
    window.__ytpfFetches.push(String(url));
    if (String(url).includes("/youtubei/v1/browse")) {
      return new Response(JSON.stringify(INNERTUBE_RESPONSE), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  };

  // Capture the bundle's test exports so we can assert on the SHIPPED
  // anchor list, not just the module the unit test imports.
  window.__ytpfExports = null;
  window.__YTPF_TEST__ = (exports) => { window.__ytpfExports = exports; };

  window.chrome = {
    storage: {
      sync: { get: async () => ({}), set: async () => {}, onChanged: { addListener() {} } },
      local: { get: async () => ({}), set: async () => {}, remove() {} },
      onChanged: { addListener() {} },
    },
    runtime: { getManifest: () => ({ version: "test" }), onMessage: { addListener() {} } },
  };
</script>
<script>${minisearchJs}</script>
<script>${contentJs}</script>
<script>
  // Helpers the runner drives. Kept in the page so each agent-browser eval
  // stays a one-liner.
  window.__ytpfHelpers = {
    grid: () => document.querySelector("ytd-rich-grid-renderer > #contents"),
    panel: () => document.getElementById("ytpf-feed-results-host"),
    chip: () => document.querySelector(".ytpf-inline"),
    input: () => document.querySelector(".ytpf-inline input"),
    cards() {
      const root = this.panel() && this.panel().shadowRoot;
      return root ? Array.from(root.querySelectorAll("li .link")) : [];
    },
    async type(value) {
      const input = this.input();
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
    },
    snapshot() {
      const grid = this.grid();
      const panel = this.panel();
      const cards = this.cards();
      const root = panel && panel.shadowRoot;
      return {
        gridDisplay: grid ? getComputedStyle(grid).display : null,
        gridInlineStyle: grid ? grid.getAttribute("style") : null,
        panelPresent: !!panel,
        panelHidden: panel ? panel.hidden : null,
        cardCount: cards.length,
        firstCardHref: cards[0] ? cards[0].getAttribute("href") : null,
        firstCardTitle: cards[0] ? (cards[0].querySelector(".title") || {}).textContent : null,
        marks: root ? root.querySelectorAll("mark.ytpf-mark").length : 0,
        meta: root ? (root.querySelector(".meta") || {}).textContent : null,
        emptyShown: root ? !(root.querySelector(".empty") || {}).hidden : null,
      };
    },
  };

  setTimeout(() => {
    try {
      const h = window.__ytpfHelpers;
      const chip = h.chip();
      const tablist = document.querySelector("chip-bar-view-model [role='tablist']");
      const decoyTablists = Array.from(document.querySelectorAll("[role='tablist']"))
        .filter((el) => !el.closest("chip-bar-view-model"));
      window.__ytpfReady = {
        ok: true,
        diag: window.__ytpfDiag ? window.__ytpfDiag() : null,
        anchorCount: window.__ytpfExports
          ? window.__ytpfExports.FEED_DOM_ANCHORS.length
          : null,
        anchorIds: window.__ytpfExports
          ? window.__ytpfExports.FEED_DOM_ANCHORS.map((a) => a.id)
          : null,
        chipMounted: !!chip,
        chipCount: document.querySelectorAll(".ytpf-inline").length,
        chipInsideTablist: !!(chip && tablist && tablist.contains(chip)),
        legacyFallbackPresent: !!document.querySelector(".ytpf-inline-page"),
        decoyTablistCount: decoyTablists.length,
        chipInsideDecoy: decoyTablists.some((el) => chip && el.contains(chip)),
        hiddenRowsPresent: document.querySelectorAll(".ytpf-hidden").length,
        errors: window.__ytpfErrors,
      };
    } catch (e) {
      window.__ytpfReady = { ok: false, error: String((e && e.stack) || e) };
    }
  }, 900);
</script>
</body></html>`;
}

const pageWithChips = harnessHtml({ withChipBar: true });
const pageWithoutChips = harnessHtml({ withChipBar: false });

const server = http.createServer((req, res) => {
  if (req.url.startsWith("/feed/playlists")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url.includes("nochip") ? pageWithoutChips : pageWithChips);
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/feed/playlists`;

const SESSION = "ytpf-mount-test";
// Async wrapper — critical so Node's event loop can serve HTTP requests from
// Chromium concurrently. execFileSync would block the loop and Chromium would
// hang forever waiting on /feed/playlists.
async function ab(...args) {
  const { stdout } = await execFileP(
    "agent-browser",
    ["--session-name", SESSION, ...args],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** agent-browser prints results JSON-encoded; unwrap one level if quoted. */
function unwrap(raw) {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith('"') ? JSON.parse(trimmed) : trimmed;
  return stripped && stripped !== "null" ? JSON.parse(stripped) : null;
}

async function evalJson(js) {
  return unwrap(await ab("eval", `JSON.stringify(${js})`));
}

/**
 * `agent-browser eval` awaits the expression's result but does not serialize
 * a resolved object for us, so async probes must stringify on the page side.
 */
async function evalAsyncJson(body) {
  return unwrap(await ab("eval", `(async () => { ${body} })()`));
}

const passed = [];
const failed = [];
const check = (cond, msg) => (cond ? passed : failed).push(msg);

let exitCode = 0;
try {
  spawnSync("agent-browser", ["close", "--all"], { encoding: "utf8" });

  // ── Variant A: chip bar present (the real page shape) ────────────────
  await ab("open", base);

  let ready = null;
  for (let i = 0; i < 40; i++) {
    ready = await evalJson("window.__ytpfReady || null");
    if (ready) break;
    await sleep(150);
  }

  if (!ready) throw new Error("harness never set window.__ytpfReady");
  if (!ready.ok) throw new Error(`harness threw: ${ready.error}`);

  // Anchor budget, asserted against the SHIPPED bundle.
  check(ready.anchorCount === 2, `bundle declares exactly 2 DOM anchors (got ${ready.anchorCount})`);
  check(
    JSON.stringify(ready.anchorIds) === JSON.stringify(["search-mount", "grid"]),
    `anchor ids are [search-mount, grid] (got ${JSON.stringify(ready.anchorIds)})`,
  );
  check(
    (ready.diag?.anchors || []).every((a) => a.visible === 1),
    `both anchors resolve to exactly one visible node (${JSON.stringify(ready.diag?.anchors?.map((a) => [a.id, a.matched, a.visible]))})`,
  );

  // Mount contract.
  check(ready.chipMounted, "search chip rendered");
  check(ready.chipCount === 1, `exactly one chip mounted (got ${ready.chipCount})`);
  check(ready.chipInsideTablist, "chip mounted inside chip-bar-view-model [role='tablist']");
  check(
    ready.decoyTablistCount >= 1 && !ready.chipInsideDecoy,
    `chip refused the ${ready.decoyTablistCount} decoy [role='tablist'] node(s) outside the chip bar`,
  );
  check(!ready.legacyFallbackPresent, "no .ytpf-inline-page fallback bar exists anymore");
  check(ready.hiddenRowsPresent === 0, "no .ytpf-hidden rows: we never hide YouTube's cards");
  check((ready.errors || []).length === 0, `no page errors (${JSON.stringify(ready.errors)})`);

  // ── Idle state: their grid is untouched, our panel is dormant ────────
  const idle = await evalJson("window.__ytpfHelpers.snapshot()");
  check(idle.panelPresent, "results panel host is attached (dormant)");
  check(idle.panelHidden === true, "results panel is hidden with no query");
  check(idle.gridDisplay !== "none", `YouTube's grid is visible with no query (display: ${idle.gridDisplay})`);
  const pristineStyle = idle.gridInlineStyle;

  // ── Query active: our list renders, their grid hides ─────────────────
  const active = await evalAsyncJson(
    "await window.__ytpfHelpers.type('focus'); return JSON.stringify(window.__ytpfHelpers.snapshot());",
  );
  check(active.panelHidden === false, "results panel is shown while a query is active");
  check(active.cardCount === 3, `our own result cards rendered from InnerTube data (got ${active.cardCount}, expected 3)`);
  check(
    /^\/playlist\?list=PLTEST/.test(active.firstCardHref || ""),
    `card links to the playlist we built from InnerTube (got ${active.firstCardHref})`,
  );
  check(
    /Focus/i.test(active.firstCardTitle || ""),
    `card title comes from InnerTube (got ${JSON.stringify(active.firstCardTitle)})`,
  );
  check(active.marks > 0, `matched terms are highlighted (${active.marks} <mark> nodes)`);
  check(
    /of \d+ playlists/.test(active.meta || ""),
    `result count reported (got ${JSON.stringify(active.meta)})`,
  );
  check(active.gridDisplay === "none", `YouTube's grid is hidden while our results show (display: ${active.gridDisplay})`);

  // ── Zero matches: still ours, still hidden, with an empty state ──────
  const noMatch = await evalAsyncJson(
    "await window.__ytpfHelpers.type('zzzqqqzzz'); return JSON.stringify(window.__ytpfHelpers.snapshot());",
  );
  check(noMatch.cardCount === 0, `no cards for a non-matching query (got ${noMatch.cardCount})`);
  check(noMatch.emptyShown === true, "empty state shown for a non-matching query");
  check(noMatch.gridDisplay === "none", "grid stays hidden for a non-matching query (we own the surface)");

  // ── Clearing restores their grid EXACTLY ─────────────────────────────
  const cleared = await evalAsyncJson(
    "await window.__ytpfHelpers.type(''); return JSON.stringify(window.__ytpfHelpers.snapshot());",
  );
  check(cleared.panelHidden === true, "results panel hides when the query is cleared");
  check(cleared.gridDisplay !== "none", `YouTube's grid is visible again (display: ${cleared.gridDisplay})`);
  check(
    cleared.gridInlineStyle === pristineStyle,
    `grid inline style restored exactly (was ${JSON.stringify(pristineStyle)}, now ${JSON.stringify(cleared.gridInlineStyle)})`,
  );

  // ── Variant B: NO FALLBACK MOUNT ─────────────────────────────────────
  // With the chip bar absent the mount anchor cannot resolve. The old code
  // fell back to a full-width bar spanning the grid; that is exactly the
  // "appeared somewhere unexpected" failure mode, so now we render nothing.
  await ab("open", `${base}?nochip=1`);
  let noChip = null;
  for (let i = 0; i < 40; i++) {
    noChip = await evalJson("window.__ytpfReady || null");
    if (noChip) break;
    await sleep(150);
  }
  if (!noChip?.ok) throw new Error("no-chip harness never reported");

  check(!noChip.chipMounted, "NO FALLBACK MOUNT: nothing renders when the mount anchor is missing");
  check(noChip.chipCount === 0, `zero .ytpf-inline nodes without a chip bar (got ${noChip.chipCount})`);
  check(!noChip.legacyFallbackPresent, "no .ytpf-inline-page fallback without a chip bar");
  const missing = (noChip.diag?.anchors || []).find((a) => a.id === "search-mount");
  check(missing?.visible === 0, "diagnostic probe reports the mount anchor as unresolved");
  check(
    (noChip.diag?.anchors || []).find((a) => a.id === "grid")?.visible === 1,
    "the grid anchor still resolves — failure is attributed to the right anchor",
  );

  console.log(`feed-page-mount: ${passed.length} passed, ${failed.length} failed`);
  passed.forEach((m) => console.log("  ok   " + m));
  failed.forEach((m) => console.log("  FAIL " + m));
  if (failed.length) exitCode = 1;
} catch (err) {
  console.error("FAIL: test-feed-page-mount threw");
  console.error(err);
  passed.forEach((m) => console.log("  ok   " + m));
  failed.forEach((m) => console.log("  FAIL " + m));
  exitCode = 1;
} finally {
  spawnSync("agent-browser", ["close", "--all"], { encoding: "utf8" });
  server.close();
}
process.exit(exitCode);
