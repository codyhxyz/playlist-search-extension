#!/usr/bin/env node
/**
 * Capture real InnerTube responses as test fixtures.
 *
 * Three surfaces, three commands:
 *
 *   node scripts/capture-innertube.mjs channel @MrBeast
 *       Public channel /playlists page. NO LOGIN NEEDED — works in any
 *       agent-browser session. Used to seed the lockupViewModel real-fixture
 *       (tests/fixtures/innertube/real-channel-playlists-mrbeast.json).
 *
 *   node scripts/capture-innertube.mjs modal <youtube-watch-url>
 *       Save-to-playlist modal response (browseId: FEplaylist_aggregation).
 *       REQUIRES LOGIN — use --session-name to point at a logged-in profile.
 *
 *   node scripts/capture-innertube.mjs feed
 *       Personal /feed/playlists, initial page + first continuation.
 *       REQUIRES LOGIN. Catches the 1.6.9 pagination-truncation surface.
 *
 * Common options:
 *   --session-name <name>   agent-browser session to use (default: anonymous
 *                           one-shot for `channel`, "youtube" for modal/feed).
 *   --out <path>            Override output fixture path.
 *
 * What this script does for you:
 *   1. Wraps the agent-browser open / eval / network-requests dance into one
 *      call so you don't have to remember the incantation.
 *   2. Scrubs visitorData / trackingParams / clickTrackingParams from the
 *      captured JSON before writing — keeps session-identifying tokens out
 *      of committed fixtures.
 *   3. Stamps a _provenance block at the top with the source URL + date so
 *      future-you (or future-reviewer) knows where the fixture came from.
 *   4. Pretty-prints the parse summary so you can sanity-check before
 *      committing (expected playlist count, first ID/title, continuation
 *      token, whether the shape canary fired).
 *
 * After capture:
 *   - Verify the parse summary looks right.
 *   - Update the corresponding `REAL:` test in tests/innertube-parse.test.mjs
 *     to assert the captured count + first ID/title (replace the skip
 *     reason once the file exists). The mrbeast-channel test is the model.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlaylistRenderers } from "../src/lib/innertube-parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const FIXTURES = path.join(REPO, "tests", "fixtures", "innertube");

function die(msg) {
  console.error(`[capture] ${msg}`);
  process.exit(2);
}

function which(bin) {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function ab(args, opts = {}) {
  return execFileSync("agent-browser", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

function scrub(node, depth = 0) {
  if (depth > 60) return node;
  if (Array.isArray(node)) return node.map((x) => scrub(x, depth + 1));
  if (node && typeof node === "object") {
    const out = {};
    for (const k of Object.keys(node)) {
      if (
        k === "visitorData" ||
        k === "trackingParams" ||
        k === "clickTrackingParams"
      ) {
        out[k] = "PLACEHOLDER_SCRUBBED";
      } else if (k === "loggingDirectives") {
        out[k] = { _scrubbed: true };
      } else {
        out[k] = scrub(node[k], depth + 1);
      }
    }
    return out;
  }
  return node;
}

function writeFixture(outPath, sourceUrl, captured) {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const scrubbed = scrub(captured);
  const stamped = {
    _provenance: `REAL capture — ${sourceUrl} on ${new Date().toISOString().slice(0, 10)}. Captured via scripts/capture-innertube.mjs. Scrubbed: visitorData, trackingParams, clickTrackingParams, loggingDirectives. Every renderer / metadata / navigation shape preserved as YouTube actually shipped it.`,
    ...scrubbed,
  };
  writeFixture._payload = stamped;
  writeFileSync(outPath, JSON.stringify(stamped, null, 2) + "\n");

  // Sanity summary — exercise the parser against what we just captured.
  const reasons = [];
  const { playlists, continuation } = parsePlaylistRenderers(stamped, (info) =>
    reasons.push(info),
  );
  console.log(`[capture] wrote ${path.relative(REPO, outPath)} (${JSON.stringify(stamped).length} bytes)`);
  console.log(`[capture] parsed: ${playlists.length} playlists, continuation=${continuation ? "yes" : "no"}, canary=${reasons.length ? "FIRED" : "silent"}`);
  if (playlists.length > 0) {
    console.log(`[capture] first: id=${playlists[0].id}  title=${JSON.stringify(playlists[0].title)}  count=${playlists[0].itemCount}`);
  }
  if (reasons.length > 0) {
    console.log(`[capture] canary unknown keys: ${reasons[0].unknownItemKeys.join(", ")}`);
    console.log(`[capture] → parser likely needs a new renderer branch in src/lib/innertube-parse.js`);
  }
  return { playlists, continuation, reasons };
}

function pullYtInitialData() {
  // agent-browser eval returns the JS-side result as a JSON-encoded string
  // in the .data.result field. Two levels of JSON.parse to get the real
  // InnerTube payload back.
  const raw = ab([
    "eval",
    "JSON.stringify(typeof ytInitialData !== 'undefined' ? ytInitialData : null)",
    "--json",
  ]);
  const wrapper = JSON.parse(raw);
  if (!wrapper.success) die(`agent-browser eval failed: ${wrapper.error}`);
  const inner = JSON.parse(wrapper.data.result);
  if (inner === null) {
    die("ytInitialData not present on this page — wrong URL, or the page hasn't finished loading.");
  }
  return inner;
}

function pullLastBrowseXhr() {
  // Initial /feed/playlists ships ytInitialData inline. Continuation pages
  // come back via XHR. This grabs the most recent successful /youtubei/v1/
  // browse response and returns the parsed JSON body.
  const listRaw = ab([
    "network",
    "requests",
    "--filter",
    "youtubei/v1/browse",
    "--status",
    "200",
    "--json",
  ]);
  const list = JSON.parse(listRaw);
  const reqs = list?.data?.requests || [];
  if (!reqs.length) {
    die("No /youtubei/v1/browse XHR was captured. Trigger a navigation/scroll/click that fires one, then re-run.");
  }
  const last = reqs[reqs.length - 1];
  const detailRaw = ab(["network", "request", last.id, "--json"]);
  const detail = JSON.parse(detailRaw);
  const body = detail?.data?.response?.body;
  if (!body) die(`Captured request ${last.id} had no response body. Re-run after the request fully completes.`);
  try {
    return JSON.parse(body);
  } catch (e) {
    die(`Response body wasn't valid JSON: ${e.message}`);
  }
}

// ── Subcommands ─────────────────────────────────────────────────────────────

function cmdChannel(flags) {
  const handle = flags._[0];
  if (!handle) die("usage: capture-innertube.mjs channel @<handle>");
  const url = `https://www.youtube.com/${handle.startsWith("@") ? handle : "@" + handle}/playlists`;
  const out = flags.out || path.join(FIXTURES, `real-channel-playlists-${handle.replace(/^@/, "").toLowerCase()}.json`);

  console.log(`[capture] opening ${url}`);
  ab(["open", url]);
  // Small wait for ytInitialData hydration.
  spawnSync("sleep", ["2"]);
  const data = pullYtInitialData();
  writeFixture(out, url, data);
}

function cmdModal(flags) {
  const watchUrl = flags._[0];
  if (!watchUrl) die("usage: capture-innertube.mjs modal <youtube-watch-url>");
  const out = flags.out || path.join(FIXTURES, "real-save-modal-feed-aggregation.json");

  console.log(`[capture] opening ${watchUrl}`);
  ab(["open", watchUrl]);
  spawnSync("sleep", ["3"]);
  // Clear the request log so we only see the click-triggered XHR.
  ab(["network", "requests", "--clear"]);
  // The Save button on a watch page. aria-label catches both the old Polymer
  // and new view-model variants.
  console.log("[capture] clicking Save…");
  try {
    ab(["click", "button[aria-label*='Save']"]);
  } catch (e) {
    die("Could not click the Save button. Likely not logged in, or page hasn't finished loading. " + e.message);
  }
  spawnSync("sleep", ["2"]);
  const data = pullLastBrowseXhr();
  writeFixture(out, watchUrl, data);
}

function cmdFeed(flags) {
  const url = "https://www.youtube.com/feed/playlists";
  const outInitial = flags.out || path.join(FIXTURES, "real-feed-playlists-initial.json");
  const outContinuation = path.join(FIXTURES, "real-feed-playlists-continuation.json");

  console.log(`[capture] opening ${url}`);
  ab(["open", url]);
  spawnSync("sleep", ["3"]);
  const initial = pullYtInitialData();
  writeFixture(outInitial, url, initial);

  // Trigger a continuation by scrolling to the bottom of the grid.
  console.log("[capture] scrolling to trigger continuation XHR…");
  ab(["network", "requests", "--clear"]);
  ab(["scroll", "down", "20000"]);
  spawnSync("sleep", ["3"]);
  try {
    const cont = pullLastBrowseXhr();
    writeFixture(outContinuation, url + " (continuation)", cont);
  } catch (e) {
    console.warn("[capture] no continuation XHR captured (library may be smaller than the first page). Initial fixture is still good.");
  }
}

// ── Entry ───────────────────────────────────────────────────────────────────

function main() {
  if (!which("agent-browser")) {
    die("agent-browser not on PATH. See ~/.claude/CLAUDE.md for install pointers.");
  }
  const [cmd, ...rest] = process.argv.slice(2);
  const flags = parseFlags(rest);
  if (cmd === "channel") return cmdChannel(flags);
  if (cmd === "modal") return cmdModal(flags);
  if (cmd === "feed") return cmdFeed(flags);
  console.error(`Usage:
  node scripts/capture-innertube.mjs channel @<handle>
  node scripts/capture-innertube.mjs modal <youtube-watch-url>
  node scripts/capture-innertube.mjs feed
Flags: --session-name <name>  --out <path>`);
  process.exit(1);
}

main();
