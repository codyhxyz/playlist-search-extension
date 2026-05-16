/**
 * Fixture-driven regression suite for parsePlaylistRenderers.
 *
 * Every YouTube renderer migration that hit us in production (1.6.9
 * lockupViewModel cap, 1.5.3 ID-dedup) maps to a fixture under
 * tests/fixtures/innertube/. When YouTube ships the next migration:
 *
 *   1. Capture a real response. **See tests/fixtures/innertube/CAPTURE.md
 *      for the exact recipe** (DevTools or scripted via agent-browser).
 *   2. Drop it under tests/fixtures/innertube/<new-shape>.json.
 *   3. Add a test below asserting expected IDs / titles / counts.
 *   4. Watch the suite fail; fix src/lib/innertube-parse.js; ship.
 *
 * The checked-in fixtures are **synthetic** but shape-faithful (padded with
 * the structural noise real responses carry). Replacing each one with a
 * real capture is a high-leverage move — pre-emptively catches shape drift
 * that a hand-written fixture wouldn't anticipate.
 *
 * Run: `node --test tests/innertube-parse.test.mjs` (fast — no rebuild),
 *      or `npm test` for the full pipeline (build → unit → integration).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePlaylistRenderers,
  rendererTitle,
} from "../src/lib/innertube-parse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, "fixtures", "innertube");

function load(name) {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));
}

// ── rendererTitle ──────────────────────────────────────────────────────────

test("rendererTitle prefers runs[0].text over simpleText", () => {
  const r = {
    title: { runs: [{ text: "Runs wins" }], simpleText: "Simple loses" },
  };
  assert.equal(rendererTitle(r), "Runs wins");
});

test("rendererTitle falls back to simpleText when runs absent", () => {
  assert.equal(rendererTitle({ title: { simpleText: "fallback" } }), "fallback");
});

test("rendererTitle returns 'Untitled' for missing title", () => {
  assert.equal(rendererTitle({}), "Untitled");
  assert.equal(rendererTitle(null), "Untitled");
});

// ── gridPlaylistRenderer (legacy) ──────────────────────────────────────────

test("parses gridPlaylistRenderer shape (legacy)", () => {
  const data = load("grid-playlist-renderer.json");
  const { playlists, continuation } = parsePlaylistRenderers(data);

  assert.equal(playlists.length, 2);
  assert.deepEqual(playlists[0], {
    id: "PLAA1111111111111111111111111111",
    title: "Workout — Heavy Lifts",
    itemCount: 42,
  });
  assert.deepEqual(playlists[1], {
    id: "PLBB2222222222222222222222222222",
    title: "Lo-fi Study",
    itemCount: 12,
  });
  assert.equal(continuation, "TOKEN_PAGE_2_AAA");
});

// ── lockupViewModel (post-2026) ────────────────────────────────────────────

// ── REAL capture — public channel /playlists ─────────────────────────────
//
// Captured live via agent-browser from https://www.youtube.com/@MrBeast/playlists
// (no login required — fully public). This is the HIGH-LEVERAGE regression
// net described in CAPTURE.md: a payload YouTube actually ships, including
// every renderer / metadata / navigation shape they pack in, not a fake.
//
// When YouTube reshapes the lockupViewModel renderer the way they did in
// 1.6.9, THIS test goes red without anyone having to predict what the new
// shape looks like. That's the whole point.
//
// If MrBeast ever reorders / renames / removes the playlists below, just
// recapture (see CAPTURE.md) and update the expected IDs / titles. The
// shape assertions matter; the specific titles don't.

// ── REAL captures pending a logged-in session ─────────────────────────────
//
// Two surfaces need a YouTube login to capture: the Save-to-playlist modal
// and a personal /feed/playlists library. The infrastructure to grab them
// is in scripts/capture-innertube.mjs — one command each, scrub + parse
// summary baked in. When the session lands:
//
//   node scripts/capture-innertube.mjs modal https://www.youtube.com/watch?v=<id>
//   node scripts/capture-innertube.mjs feed
//
// Each writes a real-*.json fixture under tests/fixtures/innertube/. Then
// remove the `skip` flag below and replace the assertions with whatever
// counts / IDs the parse summary printed. The mrbeast test is the model.

import { existsSync as _existsSync } from "node:fs";
const MODAL_FIXTURE = path.join(FIXTURES, "real-save-modal-feed-aggregation.json");
const FEED_FIXTURE = path.join(FIXTURES, "real-feed-playlists-initial.json");
const FEED_CONT_FIXTURE = path.join(FIXTURES, "real-feed-playlists-continuation.json");

test(
  "REAL: parses Save-to-playlist modal (FEplaylist_aggregation)",
  { skip: !_existsSync(MODAL_FIXTURE) && "fixture missing — run scripts/capture-innertube.mjs modal <watch-url> with a logged-in session" },
  () => {
    const data = load("real-save-modal-feed-aggregation.json");
    const reasons = [];
    const { playlists } = parsePlaylistRenderers(data, (info) => reasons.push(info));
    // Once captured, replace these with the real expected values from the
    // capture script's parse summary.
    assert.ok(playlists.length > 0, "Save modal returned at least one playlist");
    assert.ok(playlists[0].id?.startsWith("PL") || playlists[0].id?.startsWith("LL") || playlists[0].id?.startsWith("WL"), `first id looks playlist-shaped (got ${playlists[0]?.id})`);
    assert.equal(reasons.length, 0, "no canary on a known-good payload");
  },
);

test(
  "REAL: parses personal /feed/playlists initial page",
  { skip: !_existsSync(FEED_FIXTURE) && "fixture missing — run scripts/capture-innertube.mjs feed with a logged-in session" },
  () => {
    const data = load("real-feed-playlists-initial.json");
    const reasons = [];
    const { playlists, continuation } = parsePlaylistRenderers(data, (info) => reasons.push(info));
    assert.ok(playlists.length > 0, "/feed/playlists returned at least one playlist");
    // If your library is small enough to fit on one page this will be null
    // and that's fine — adjust after capture.
    assert.ok(continuation === null || typeof continuation === "string");
    assert.equal(reasons.length, 0, "no canary on a known-good payload");
  },
);

test(
  "REAL: parses /feed/playlists continuation page (1.6.9 truncation surface)",
  { skip: !_existsSync(FEED_CONT_FIXTURE) && "fixture missing — run scripts/capture-innertube.mjs feed (capture only fires if your library is large enough to paginate)" },
  () => {
    const data = load("real-feed-playlists-continuation.json");
    const reasons = [];
    const { playlists } = parsePlaylistRenderers(data, (info) => reasons.push(info));
    // The continuation-response shape (onResponseReceivedActions →
    // appendContinuationItemsAction) is exactly where 1.6.9 silently truncated.
    // The very fact that this fixture parses to >0 playlists is the regression
    // proof; the canary staying silent is the second.
    assert.ok(playlists.length > 0, "continuation page yielded playlists (1.6.9 regression class)");
    assert.equal(reasons.length, 0, "no canary on a known-good payload");
  },
);

test("REAL: parses public channel /playlists (MrBeast — lockup shape, no login)", () => {
  const data = load("real-channel-playlists-mrbeast.json");
  const reasons = [];
  const { playlists, continuation } = parsePlaylistRenderers(data, (info) => {
    reasons.push(info);
  });

  // We captured 5 real playlists from this channel. If this number changes
  // it means *either* the channel's playlists changed (just recapture) or
  // the parser silently started dropping items (the 1.6.9 failure pattern).
  // Either way: someone needs to look.
  assert.equal(playlists.length, 5, "MrBeast capture had 5 lockup-shaped playlists");

  // Sanity-check that the *first* extracted playlist has the real ID/title
  // we captured. The structural shape (lockupViewModel.contentId,
  // lockupMetadataViewModel.title.content) is the exact surface that broke
  // in 1.6.9 — if YouTube renames either key, this assertion fails loudly.
  assert.equal(playlists[0].id, "PLoSWVnSA9vG8hI-SUpAimvYJrPh-PRRvp");
  assert.equal(playlists[0].title, "If You Survive, You Win");

  // Real capture from a fully-public channel — the parser must NOT fire the
  // shape canary. If it does, we accidentally regressed our renderer
  // recognition while staring straight at a known-good payload.
  assert.equal(reasons.length, 0, "no shape canary on a known-good payload");

  // MrBeast's channel page returns fewer than the continuation threshold —
  // null is the correct value here. (When this stops being true, just
  // bump the assertion. The parser path is what we're locking down.)
  assert.equal(continuation, null);
});

test("parses lockupViewModel shape (post-2026 migration that broke 1.6.9)", () => {
  const data = load("lockup-view-model.json");
  const { playlists, continuation } = parsePlaylistRenderers(data);

  assert.equal(playlists.length, 2);
  assert.deepEqual(playlists[0], {
    id: "PLCC3333333333333333333333333333",
    title: "Saved for later",
    itemCount: 1234, // comma-formatted "1,234" → 1234
  });
  // Second playlist has no metadata rows — itemCount falls back to 0.
  assert.equal(playlists[1].id, "PLDD4444444444444444444444444444");
  assert.equal(playlists[1].title, "Album Listen-throughs");
  assert.equal(playlists[1].itemCount, 0);
  assert.equal(continuation, "TOKEN_PAGE_2_BBB");
});

test("ignores lockupViewModel items whose contentType isn't a playlist", () => {
  const data = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [
          { lockupViewModel: { contentId: "VIDEO_X", contentType: "LOCKUP_CONTENT_TYPE_VIDEO" } },
        ] } } } }],
      },
    },
  };
  const { playlists } = parsePlaylistRenderers(data);
  assert.equal(playlists.length, 0);
});

// ── continuation pages ─────────────────────────────────────────────────────

test("parses onResponseReceivedActions continuation pages", () => {
  const data = load("continuation-response.json");
  const { playlists, continuation } = parsePlaylistRenderers(data);

  assert.equal(playlists.length, 1);
  assert.equal(playlists[0].id, "PLGG7777777777777777777777777777");
  assert.equal(continuation, "TOKEN_PAGE_3");
});

// ── shape canary ───────────────────────────────────────────────────────────

test("shape canary fires when items present but no playlists matched", () => {
  const data = load("unknown-renderer.json");
  const reasons = [];
  const { playlists, continuation } = parsePlaylistRenderers(data, (info) => {
    reasons.push(info);
  });

  assert.equal(playlists.length, 0);
  assert.equal(continuation, null);
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].itemsSeen, 2);
  assert.equal(reasons[0].playlistsExtracted, 0);
  assert.ok(
    reasons[0].unknownItemKeys.includes("futurePlaylistRenderer"),
    "canary should surface the unrecognized top-level renderer key so " +
      "diagnostics name the migration that broke us",
  );
});

// ── canary mid-rollout regression — the 1.6.9 failure pattern ──────────────
//
// This is the test that codifies the reviewer's blocker: if YouTube ships
// a new renderer to a *fraction* of items in a response (mid-rollout, or
// shape A and shape B mixed in the same page), the parser will silently
// drop the new ones while pagination keeps advancing. That's exactly what
// 1.6.9 was. The widened canary trigger must fire whenever ANY item used
// an unknown shape, not just when zero items parsed.

test("shape canary fires on mixed-rollout responses (1.6.9 regression class)", () => {
  // Half the items use the known gridPlaylistRenderer shape, half use a
  // hypothetical new shape. The OLD canary trigger (playlists.length === 0)
  // would have stayed silent on this response — that's the gap.
  const data = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [
          { gridPlaylistRenderer: {
              playlistId: "PL_KNOWN_1",
              title: { runs: [{ text: "Known shape — should parse" }] },
              videoCountShortText: { simpleText: "10" } } },
          { futurePlaylistViewModelV2: {
              id: "PL_UNKNOWN_1",
              name: "Future shape — silently dropped today" } },
          { gridPlaylistRenderer: {
              playlistId: "PL_KNOWN_2",
              title: { runs: [{ text: "Another known shape" }] },
              videoCountShortText: { simpleText: "5" } } },
          { futurePlaylistViewModelV2: {
              id: "PL_UNKNOWN_2",
              name: "Another future shape" } },
        ] } } } }],
      },
    },
  };

  const reasons = [];
  const { playlists } = parsePlaylistRenderers(data, (info) => reasons.push(info));

  // Two known items parsed, two new-shape items silently dropped — but the
  // canary must scream so we KNOW we're losing data.
  assert.equal(playlists.length, 2, "known items still parse");
  assert.equal(reasons.length, 1, "canary fires even though some items parsed");
  assert.equal(reasons[0].playlistsExtracted, 2);
  assert.equal(reasons[0].itemsSeen, 4);
  assert.deepEqual(reasons[0].unknownItemKeys, ["futurePlaylistViewModelV2"]);
});

test("shape canary unknown-keys list is sorted (stable diagnostic key)", () => {
  // The wrapper in content.js uses unknownItemKeys.join(',') as the
  // diagnostic invariant key — sorting matters so { A, B } and { B, A }
  // collapse to the same throttled key instead of writing two ring entries.
  const data = {
    contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: {
      richGridRenderer: { contents: [
        { zNewRenderer: { id: "1" } },
        { aNewRenderer: { id: "2" } },
      ] },
    } } }] } },
  };
  const reasons = [];
  parsePlaylistRenderers(data, (info) => reasons.push(info));
  assert.deepEqual(reasons[0].unknownItemKeys, ["aNewRenderer", "zNewRenderer"]);
});

test("shape canary does NOT fire when items match known renderers", () => {
  const data = load("grid-playlist-renderer.json");
  const reasons = [];
  const { playlists } = parsePlaylistRenderers(data, (info) => {
    reasons.push(info);
  });

  assert.equal(playlists.length, 2);
  assert.equal(reasons.length, 0);
});

test("shape canary does NOT fire when response has zero items at all", () => {
  // An empty response (user has no playlists) is not a migration signal —
  // we'd be writing diagnostics for every empty user, which is noise.
  const data = {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [] } } } }],
      },
    },
  };
  const reasons = [];
  parsePlaylistRenderers(data, (info) => reasons.push(info));
  assert.equal(reasons.length, 0);
});

test("canary callback throwing does not break the parser", () => {
  const data = load("unknown-renderer.json");
  // If recordDiagnostic ever throws (chrome.storage unavailable, etc.) the
  // parser must still return what it found rather than propagating the error.
  const { playlists } = parsePlaylistRenderers(data, () => {
    throw new Error("simulated diagnostic sink failure");
  });
  assert.equal(playlists.length, 0); // parser still returns cleanly
});
