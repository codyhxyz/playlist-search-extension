// InnerTube response parsing. Pure functions only — no network, no browser, no auth.
//
// The two bugs these pin were both *confident false negatives*, which is the failure
// mode worth guarding hardest:
//   * Missing brand-channel delegation returned 2 playlists instead of 256, and a
//     single membership row instead of 200. Both look like plausible API limits.
//   * Parsing membership from the FIRST `listItems` array rather than a full recursive
//     collect produced "there is no bulk membership endpoint" — a conclusion that was
//     wrong, and wrong in a way that reads as thorough.

import test from "node:test";
import assert from "node:assert/strict";

import {
  cfgFrom,
  parseMembership,
  scanKey,
  scanPlaylists,
  parseCreateResponse,
  parseVideoCount,
  classifyHttp,
  plsError,
  PLS_USER_MESSAGES,
  resetConfigCache,
  fetchAllPlaylists,
  addVideo,
  resolveMembershipTail,
} from "../src/lib/innertube.js";

const scan = (node) => scanPlaylists(node, new Map());
// Titles only, for the tests that are about titles.
const titleOf = (out, id) => out.get(id)?.title;

// ─── cfgFrom: the session handshake ──────────────────────────────────────────

const YTCFG = (extra = "") =>
  `ytcfg.set({"INNERTUBE_CONTEXT_CLIENT_NAME":1,"INNERTUBE_CONTEXT_CLIENT_VERSION":"2.2026",` +
  `"INNERTUBE_API_KEY":"AIzaSyTEST-key_123","INNERTUBE_CONTEXT":{"client":{"clientName":"WEB",` +
  `"clientVersion":"2.20260828.01.00","hl":"en"},"request":{"useSsl":true}}${extra}});`;

test("cfgFrom lifts the context, the api key, and the client version", () => {
  const cfg = cfgFrom(YTCFG());
  assert.equal(cfg.context.client.clientVersion, "2.20260828.01.00");
  assert.equal(cfg.context.client.clientName, "WEB");
  assert.equal(cfg.apiKey, "AIzaSyTEST-key_123");
});

test("cfgFrom lifts DELEGATED_SESSION_ID — the brand-account fix", () => {
  // THE bug. INNERTUBE_CONTEXT does not carry the delegation even when the page has
  // it, and without injecting context.user.onBehalfOfUser a brand account sees 2
  // playlists instead of 256 and exactly one membership row. Nothing errors; you
  // just get a confidently wrong, smaller answer.
  const cfg = cfgFrom(YTCFG(`,"DELEGATED_SESSION_ID":"102341564451195211920"`));
  assert.equal(cfg.delegatedSessionId, "102341564451195211920");
});

test("cfgFrom reports no delegation on a personal account", () => {
  assert.equal(cfgFrom(YTCFG()).delegatedSessionId, null);
});

test("cfgFrom does not mistake the scalar INNERTUBE_CONTEXT_* keys for the object", () => {
  // `INNERTUBE_CONTEXT_CLIENT_NAME` is a prefix match. The `:{` in the regex is the
  // only thing ruling it out, so it gets its own test.
  const onlyScalars = `ytcfg.set({"INNERTUBE_CONTEXT_CLIENT_NAME":1,"INNERTUBE_CONTEXT_CLIENT_VERSION":"2.2026"});`;
  assert.equal(cfgFrom(onlyScalars), null);
});

test("cfgFrom handles an unquoted key and braces inside strings", () => {
  const unquoted =
    `window.ytcfg={INNERTUBE_CONTEXT:{"client":{"clientName":"WEB","clientVersion":"2.1",` +
    `"originalUrl":"https://youtube.com/?q=%7Bnot-a-brace%7D","x":"a{b}c"},"user":{}}};`;
  const cfg = cfgFrom(unquoted);
  assert.equal(cfg.context.client.clientVersion, "2.1");
  assert.equal(cfg.context.client.x, "a{b}c");
});

test("cfgFrom fails closed on unusable input", () => {
  assert.equal(cfgFrom(""), null);
  assert.equal(cfgFrom(null), null);
  assert.equal(cfgFrom(undefined), null);
  assert.equal(cfgFrom("var x = 1;"), null);
  // Present but missing the one field that makes it usable.
  assert.equal(cfgFrom(`{"INNERTUBE_CONTEXT":{"client":{"hl":"en"}}}`), null);
  // Truncated — an unbalanced object must not throw.
  assert.equal(cfgFrom(`{"INNERTUBE_CONTEXT":{"client":{"clientVersion":"2.1"`), null);
});

test("cfgFrom lifts SESSION_INDEX — which signed-in Google account this tab is", () => {
  // Quoted and bare both occur; it only ever goes into a header, so it is a string.
  assert.equal(cfgFrom(YTCFG(`,"SESSION_INDEX":"1"`)).sessionIndex, "1");
  assert.equal(cfgFrom(YTCFG(`,"SESSION_INDEX":2`)).sessionIndex, "2");
  assert.equal(cfgFrom(YTCFG(`,"SESSION_INDEX": "0"`)).sessionIndex, "0");
});

test("cfgFrom reports no session index when absent, and ignores longer look-alike keys", () => {
  // Absent -> null here; plsPost then sends X-Goog-AuthUser: 0, the server default.
  assert.equal(cfgFrom(YTCFG()).sessionIndex, null);
  assert.equal(cfgFrom(YTCFG(`,"LOGGED_OUT_SESSION_INDEX":"7"`)).sessionIndex, null);
  // Not a number -> not a session index.
  assert.equal(cfgFrom(YTCFG(`,"SESSION_INDEX":"abc"`)).sessionIndex, null);
});

test("cfgFrom lifts the session index and the delegation together", () => {
  const cfg = cfgFrom(YTCFG(`,"SESSION_INDEX":"1","DELEGATED_SESSION_ID":"102341564451195211920"`));
  assert.equal(cfg.sessionIndex, "1");
  assert.equal(cfg.delegatedSessionId, "102341564451195211920");
});

// ─── scanPlaylists: shapes are mid-migration, so we walk ─────────────────────

test("scanPlaylists reads the legacy gridPlaylistRenderer shape", () => {
  const out = scan({
    contents: [{ gridPlaylistRenderer: { playlistId: "PLlegacy001", title: { runs: [{ text: "Deep " }, { text: "Focus" }] } } }],
  });
  // No count field on the entry -> no `count` key at all (not `count: undefined`).
  assert.deepEqual([...out], [["PLlegacy001", { title: "Deep Focus" }]]);
});

test("scanPlaylists reads the post-2026 lockupViewModel shape", () => {
  const out = scan({
    contents: [{ lockupViewModel: { contentId: "PLmodern002", metadata: { lockupMetadataViewModel: { title: { content: "Ocean sounds" } } } } }],
  });
  assert.deepEqual([...out], [["PLmodern002", { title: "Ocean sounds" }]]);
});

test("scanPlaylists reads simpleText titles", () => {
  const out = scan({ playlistAddToOptionRenderer: { playlistId: "PLsimple3", title: { simpleText: "Watch later" } } });
  assert.equal(titleOf(out, "PLsimple3"), "Watch later");
});

test("scanPlaylists strips the VL browse-id prefix", () => {
  // `browse VL<id>` and `playlistId` name the same playlist. Keeping both would
  // double every row in the sheet.
  const out = scan({ a: { playlistId: "VLPLdupe004", title: { content: "Once" } }, b: { playlistId: "PLdupe004" } });
  assert.deepEqual([...out.keys()], ["PLdupe004"]);
});

test("scanPlaylists lets the outermost owner of an id claim the title", () => {
  // Pre-order matters: the renderer owns the human title, while its own nested
  // watchEndpoint owns a video title. Walking inner-first renames playlists after
  // whatever video happens to be first in them.
  const out = scan({
    lockupViewModel: {
      contentId: "PLnested005",
      metadata: { lockupMetadataViewModel: { title: { content: "My playlist" } } },
      onTap: { watchEndpoint: { playlistId: "PLnested005", title: { content: "First video in it" } } },
    },
  });
  assert.equal(titleOf(out, "PLnested005"), "My playlist");
});

test("scanPlaylists ignores ids that are not playlists", () => {
  const out = scan({
    videoId: "dQw4w9WgXcQ",
    browseId: "UCsomechannelid",
    params: "CAF6BlBUOkNBVQ",
    contentId: "not-a-playlist",
  });
  assert.equal(out.size, 0);
});

test("scanPlaylists falls back to the id when a playlist has no findable title", () => {
  // Better a raw id in the list than a silently dropped playlist.
  const out = scan({ gridPlaylistRenderer: { playlistId: "PLtitleless06" } });
  assert.deepEqual(out.get("PLtitleless06"), { title: null });
});

test("scanPlaylists accumulates across continuation pages", () => {
  const found = new Map();
  scanPlaylists({ contents: [{ gridPlaylistRenderer: { playlistId: "PLpage1a", title: { content: "A" } } }] }, found);
  scanPlaylists({ continuationItems: [{ lockupViewModel: { contentId: "PLpage2b", metadata: { title: { content: "B" } } } }] }, found);
  assert.deepEqual([...found.keys()], ["PLpage1a", "PLpage2b"]);
});

// ─── video counts: strict, or nothing ────────────────────────────────────────

test("parseVideoCount reads the English count labels YouTube ships", () => {
  assert.equal(parseVideoCount("12 videos"), 12);
  assert.equal(parseVideoCount("1 video"), 1);
  assert.equal(parseVideoCount("1,234 videos"), 1234);
  assert.equal(parseVideoCount("12,345,678 videos"), 12345678);
  assert.equal(parseVideoCount("No videos"), 0);
  assert.equal(parseVideoCount("25 episodes"), 25); // the real capture's wording
  assert.equal(parseVideoCount("1 episode"), 1);
  assert.equal(parseVideoCount("42"), 42); // videoCountShortText
  assert.equal(parseVideoCount("42\u00a0videos"), 42);
  // InnerTube text objects, both flavours.
  assert.equal(parseVideoCount({ runs: [{ text: "42" }, { text: " videos" }] }), 42);
  assert.equal(parseVideoCount({ simpleText: "7" }), 7);
  assert.equal(parseVideoCount({ content: "3 videos" }), 3);
});

test("parseVideoCount says undefined rather than guess", () => {
  // "1.234" is 1234 in German and 1.234 in English. Either reading could be wrong,
  // so neither is taken.
  assert.equal(parseVideoCount("1.234 videos"), undefined);
  assert.equal(parseVideoCount("1.234"), undefined);
  assert.equal(parseVideoCount("1 234 videos"), undefined);
  assert.equal(parseVideoCount("1,2K videos"), undefined);
  assert.equal(parseVideoCount("1.2K videos"), undefined);
  assert.equal(parseVideoCount("12,34 videos"), undefined); // not a thousands grouping
  assert.equal(parseVideoCount("12 vidéos"), undefined);
  assert.equal(parseVideoCount("Mix"), undefined);
  assert.equal(parseVideoCount("Updated today"), undefined);
  assert.equal(parseVideoCount("-3 videos"), undefined);
  assert.equal(parseVideoCount(""), undefined);
  assert.equal(parseVideoCount(null), undefined);
  assert.equal(parseVideoCount(undefined), undefined);
  assert.equal(parseVideoCount(12), undefined); // not a label
});

test("scanPlaylists reads the legacy count fields", () => {
  const out = scan({
    contents: [
      { gridPlaylistRenderer: { playlistId: "PLcnt01", title: { content: "A" }, videoCountText: { runs: [{ text: "1,234" }, { text: " videos" }] } } },
      { gridPlaylistRenderer: { playlistId: "PLcnt02", title: { content: "B" }, videoCountShortText: { simpleText: "0" } } },
      { gridPlaylistRenderer: { playlistId: "PLcnt03", title: { content: "C" }, videoCountText: { simpleText: "No videos" } } },
    ],
  });
  assert.deepEqual([...out], [
    ["PLcnt01", { title: "A", count: 1234 }],
    ["PLcnt02", { title: "B", count: 0 }],
    ["PLcnt03", { title: "C", count: 0 }],
  ]);
});

test("scanPlaylists reads a lockup's count badge, skipping badges that are not counts", () => {
  const badge = (text) => ({ thumbnailBadgeViewModel: { text } });
  const out = scan({
    lockupViewModel: {
      contentId: "PLbadge01",
      contentImage: { thumbnailViewModel: { overlays: [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [badge("Mix"), badge("12 videos")] } }] } },
      metadata: { lockupMetadataViewModel: { title: { content: "Badged" } } },
    },
  });
  assert.deepEqual(out.get("PLbadge01"), { title: "Badged", count: 12 });
});

test("scanPlaylists never borrows a count from outside the entry", () => {
  // The real MrBeast capture carries "978 videos" in the CHANNEL header. A count
  // must come from the entry that owns the id or not at all.
  const out = scan({
    header: { metadataParts: [{ text: { content: "978 videos" } }], thumbnailBadgeViewModel: { text: "978 videos" } },
    contents: [{ lockupViewModel: { contentId: "PLnocnt01", metadata: { lockupMetadataViewModel: { title: { content: "Bare" } } } } }],
  });
  assert.deepEqual(out.get("PLnocnt01"), { title: "Bare" });
  assert.equal("count" in out.get("PLnocnt01"), false);
});

test("a later mention fills in a missing count but never overwrites one", () => {
  const found = new Map();
  scanPlaylists({ gridPlaylistRenderer: { playlistId: "PLfill01", title: { content: "T" } } }, found);
  scanPlaylists({ gridPlaylistRenderer: { playlistId: "PLfill01", videoCountShortText: { simpleText: "5" } } }, found);
  scanPlaylists({ gridPlaylistRenderer: { playlistId: "PLfill01", videoCountShortText: { simpleText: "99" } } }, found);
  assert.deepEqual([...found], [["PLfill01", { title: "T", count: 5 }]]);
});

// ─── parseMembership: tri-state, and the tail must stay unknown ──────────────

const option = (playlistId, containsSelectedVideos, title) => ({
  playlistAddToOptionRenderer: { playlistId, containsSelectedVideos, title: { simpleText: title } },
});

test("parseMembership maps ALL to true and NONE to false", () => {
  const map = parseMembership({
    contents: [{ addToPlaylistRenderer: { playlists: [option("PLin01", "ALL", "In"), option("PLout02", "NONE", "Out")] } }],
  });
  assert.equal(map.get("PLin01"), true);
  assert.equal(map.get("PLout02"), false);
});

test("parseMembership treats SOME as contained", () => {
  // SOME is the multi-video case. We only ever ask about one video, so it should
  // not occur — but reading it as "not in" would be the wrong way to be wrong.
  const map = parseMembership({ x: [option("PLsome03", "SOME", "Partial")] });
  assert.equal(map.get("PLsome03"), true);
});

test("parseMembership leaves unreported playlists ABSENT, never false", () => {
  // The 200-row cap is a hard server limit — the same 200 ids for every video, no
  // continuation, no widening param. On a larger library the tail is genuinely
  // unknowable, and YouTube's own picker is blind there too. content.js maps
  // absence to `undefined` so the sheet renders those rows bare. Writing `false`
  // here would make the UI assert "not in this playlist" without evidence.
  const map = parseMembership({ x: [option("PLreported04", "NONE", "Reported")] });
  assert.equal(map.has("PLreported04"), true);
  assert.equal(map.has("PLunreported05"), false);
  assert.equal(map.get("PLunreported05"), undefined);
});

test("parseMembership collects EVERY option renderer, not the first list it finds", () => {
  // Taking the first `listItems` array is one of the two mistakes that produced
  // "there is no bulk membership endpoint". The shape is mid-migration; walk it all.
  const map = parseMembership({
    header: { listItems: [] },
    contents: [
      { sectionA: { listItems: [option("PLdeep06", "ALL", "Deep A")] } },
      { sectionB: { nested: { deeper: { listItems: [option("PLdeep07", "NONE", "Deep B")] } } } },
    ],
  });
  assert.equal(map.size, 2);
  assert.equal(map.get("PLdeep06"), true);
  assert.equal(map.get("PLdeep07"), false);
});

test("parseMembership ignores renderers missing either field it needs", () => {
  const map = parseMembership({
    x: [
      { playlistAddToOptionRenderer: { playlistId: "PLnostate08" } },
      { playlistAddToOptionRenderer: { containsSelectedVideos: "ALL" } },
    ],
  });
  assert.equal(map.size, 0);
});

test("parseMembership returns an empty map for junk rather than throwing", () => {
  assert.equal(parseMembership(null).size, 0);
  assert.equal(parseMembership({}).size, 0);
  assert.equal(parseMembership({ error: { code: 400 } }).size, 0);
});

// ─── scanKey: the continuation walk ──────────────────────────────────────────

test("scanKey collects values at any depth", () => {
  const tokens = scanKey(
    { a: { continuationCommand: { token: "T1" } }, b: [{ c: { continuationCommand: { token: "T2" } } }] },
    "continuationCommand",
    [],
  );
  assert.deepEqual(tokens.map((t) => t.token), ["T1", "T2"]);
});

test("scanKey returns an empty list when the key is absent — the loop's stop signal", () => {
  assert.deepEqual(scanKey({ contents: [{ a: 1 }] }, "continuationCommand", []), []);
});

// ─── Captured fixtures ───────────────────────────────────────────────────────
// The synthetic cases above only prove the parser agrees with my model of the
// response. These run it against payloads YouTube actually sent, which is the only
// way to find out where the model is wrong. `real-channel-playlists-mrbeast.json`
// was captured live from youtube.com/@MrBeast/playlists (public, no auth needed).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/innertube");
const fixture = (name) => JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

test("scanPlaylists parses a real captured channel-playlists response", () => {
  const found = scan(fixture("real-channel-playlists-mrbeast.json"));
  assert.equal(found.size, 5);
  for (const [id, { title }] of found) {
    assert.match(id, /^PL/, `${id} should be a playlist id`);
    // A raw id leaking through as the title is the visible symptom of the
    // id/title pairing being wrong — it would render as gibberish in the sheet.
    assert.ok(title && title !== id, `playlist ${id} came back with no human title`);
  }
  assert.ok([...found.values()].some((e) => e.title === "If You Survive, You Win"));
});

test("real capture: every playlist's count comes from its own badge", () => {
  // Evidence, not a model: these are the badges YouTube actually rendered on
  // youtube.com/@MrBeast/playlists ("4 episodes" …). The channel header's
  // "978 videos" is in the same payload and must NOT appear here.
  const found = scan(fixture("real-channel-playlists-mrbeast.json"));
  assert.deepEqual(
    [...found].map(([id, e]) => [id, e.title, e.count]),
    [
      ["PLoSWVnSA9vG8hI-SUpAimvYJrPh-PRRvp", "If You Survive, You Win", 4],
      ["PLoSWVnSA9vG_s-XT40oPKF0iWFGw8pOp2", "Helping People In Need", 9],
      ["PLoSWVnSA9vG8SK6-_45PAu6RVTaP1zXHf", "MrBeast Tries To Survive", 8],
      ["PLoSWVnSA9vG_PuIrGMfUtJ2wwKSUb2CFd", "Cheapest Vs Most Expensive", 9],
      ["PLoSWVnSA9vG9hJNdgr-81MG59EYT9eEYn", "MrBeast’s Most Viewed Videos", 25],
    ],
  );
});

test("synthetic fixtures: counts where the shape has one, absent where it does not", () => {
  const grid = scan(fixture("grid-playlist-renderer.json"));
  assert.equal(grid.get("PLAA1111111111111111111111111111").count, 42);
  // Only `thumbnailText` here — not a field we read, so no count is claimed.
  assert.equal(grid.get("PLBB2222222222222222222222222222").count, undefined);
  assert.equal(scan(fixture("continuation-response.json")).get("PLGG7777777777777777777777777777").count, 5);
  // The synthetic lockup puts "1,234 videos" in an invented metadata row, not a
  // badge; the real capture shows no such row, so it is deliberately not read.
  assert.equal(scan(fixture("lockup-view-model.json")).get("PLCC3333333333333333333333333333").count, undefined);
});

test("a real response still yields a continuation token — the walk keeps going", () => {
  // If this stops finding a token, fetchAllPlaylists silently stops after page 1
  // and every user with a large library quietly loses the tail.
  const tokens = scanKey(fixture("real-channel-playlists-mrbeast.json"), "continuationCommand", []);
  assert.ok(tokens.some((c) => c && typeof c.token === "string"), "expected at least one continuation token");
});

test("both captured renderer generations parse", () => {
  // YouTube has been mid-migration between these two for over a year and ships
  // them to different users on the same day.
  assert.equal(scan(fixture("grid-playlist-renderer.json")).size, 2, "legacy gridPlaylistRenderer");
  assert.equal(scan(fixture("lockup-view-model.json")).size, 2, "post-2026 lockupViewModel");
  assert.equal(scan(fixture("continuation-response.json")).size, 1, "continuation page");
});

test("an unrecognised renderer yields nothing rather than garbage", () => {
  // Fail closed. Inventing a playlist out of a shape we don't understand is worse
  // than showing one fewer row.
  assert.equal(scan(fixture("unknown-renderer.json")).size, 0);
});

// ─── Is there anything to sort "Recently updated" by? ────────────────────────
// Asked before designing the sort, answered from real captures rather than from
// memory, and pinned here so the answer does not have to be re-derived — or
// re-guessed — by the next person who wants the feature.
//
// These are "notice me" tests. They assert an ABSENCE, so the day YouTube starts
// shipping a timestamp on a playlist entry they go red, and that red is the
// signal that "Recently updated" has become buildable. Read the failure as an
// invitation, not a regression.

// Every object that directly owns a playlist id — i.e. one rendered row.
function playlistEntries(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) playlistEntries(v, out);
    return out;
  }
  if (typeof node.playlistId === "string" || typeof node.contentId === "string") out.push(node);
  for (const v of Object.values(node)) playlistEntries(v, out);
  return out;
}

function everyKey(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const v of node) everyKey(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    out.add(k);
    everyKey(v, out);
  }
  return out;
}

test("no real playlist entry carries a date — the reason there is no 'Recently updated' sort", () => {
  const entries = playlistEntries(fixture("real-channel-playlists-mrbeast.json"));
  assert.ok(entries.length >= 5, "expected the captured playlist rows");
  const dateKey = /publish|created|modified|updated|lastVideo|dateAdded|timestamp|uploadDate/i;
  const found = [];
  for (const e of entries) for (const k of everyKey(e)) if (dateKey.test(k)) found.push(k);
  assert.deepEqual(
    [...new Set(found)],
    [],
    "YouTube now ships a date on playlist entries — 'Recently updated' is buildable; " +
      "wire it up in sheet.js instead of leaving the sort list at title-only",
  );
});

test("the real lockup's metadata row is EMPTY — the synthetic fixture's 'Updated yesterday' is invented", () => {
  // `lockup-view-model.json` is hand-written and contains an "Updated yesterday"
  // metadata row. It is not real. Designing a recency sort against it would ship a
  // "Recently updated" that silently ordered by something else, which is the exact
  // bug class architecture/coverage.md was written to stop. The real capture is the
  // arbiter: title, a video-count badge, and a bare delimiter.
  const real = playlistEntries(fixture("real-channel-playlists-mrbeast.json")).filter(
    (e) => e.contentType === "LOCKUP_CONTENT_TYPE_PLAYLIST",
  );
  assert.equal(real.length, 5, "expected the five captured playlist lockups");
  for (const e of real) {
    const meta = e.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel;
    assert.ok(meta, "expected the current lockup metadata shape");
    assert.deepEqual(
      Object.keys(meta),
      ["delimiter"],
      "the real payload gained a metadata row — check whether it is a date before assuming it is not",
    );
  }
  // …and the synthetic one really does claim otherwise, so nobody reads the two as
  // agreeing and picks the wrong arbiter.
  const synthetic = JSON.stringify(fixture("lockup-view-model.json"));
  assert.match(synthetic, /Updated yesterday/);
});

test("scanPlaylists preserves the server's response order", () => {
  // fetchAllPlaylists hands the sheet a Map's iteration order, i.e. the order
  // YouTube sent. content.js relies on that being STABLE (a re-render must not
  // shuffle equal rows). Nothing may rely on it MEANING anything — what that
  // ordering represents has never been established, so it is not offered as a
  // named sort. See the note in src/lib/innertube.js.
  const out = scan({
    contents: [
      { gridPlaylistRenderer: { playlistId: "PLthird01", title: { content: "Zebra" } } },
      { gridPlaylistRenderer: { playlistId: "PLfirst02", title: { content: "Apple" } } },
      { gridPlaylistRenderer: { playlistId: "PLsecond3", title: { content: "Mango" } } },
    ],
  });
  assert.deepEqual([...out.keys()], ["PLthird01", "PLfirst02", "PLsecond3"]);
});

test("parseMembership reads the live get_add_to_playlist shape", () => {
  const data = fixture("add-to-playlist-panel.json");
  const map = parseMembership(data);
  assert.equal(map.get("PLexampleContains001"), true);
  assert.equal(map.get("PLexampleOmitted002"), false);
  assert.equal(map.get("WL"), false);
  // Rows are nested two levels below the response root. A parser that indexed a
  // fixed path — or took the first listItems array it found — reads zero here,
  // which is precisely how "there is no bulk membership endpoint" got written down.
  assert.equal(map.size, 3);

  const remove = data.contents[0].addToPlaylistRenderer.playlists[0]
    .playlistAddToOptionRenderer.removeFromPlaylistServiceEndpoint.playlistEditEndpoint;
  assert.deepEqual(remove, {
    playlistId: "WL",
    actions: [{ removedVideoId: "jNQXAC9IVRw", action: "ACTION_REMOVE_VIDEO_BY_VIDEO_ID" }],
  });
});

test("parseCreateResponse extracts playlistId from direct and nested response shapes", () => {
  assert.equal(parseCreateResponse({ playlistId: "PLcreated123" }), "PLcreated123");
  assert.equal(
    parseCreateResponse({ responseContext: {}, data: { playlistId: "PLnested456" } }),
    "PLnested456",
  );
  assert.equal(parseCreateResponse(null), null);
  assert.equal(parseCreateResponse({}), null);
});


// ─── Classified errors ───────────────────────────────────────────────────────
// The UI renders "Couldn’t save to “X”. " + userMessage, so each userMessage is one
// sentence with exactly one closing full stop — no "..", no "!.", no trailing space.

test("classifyHttp maps status codes to the kinds the UI can explain", () => {
  assert.equal(classifyHttp(200), null);
  assert.equal(classifyHttp(204), null);
  assert.equal(classifyHttp(401), "auth");
  assert.equal(classifyHttp(403), "auth");
  assert.equal(classifyHttp(429), "rate");
  assert.equal(classifyHttp(500), "server");
  assert.equal(classifyHttp(503), "server");
  assert.equal(classifyHttp(599), "server");
  assert.equal(classifyHttp(400), "http");
  assert.equal(classifyHttp(404), "http");
  assert.equal(classifyHttp(409), "http");
  assert.equal(classifyHttp(302), "http");
});

test("plsError carries kind, userMessage, and a descriptive message", () => {
  const cause = new TypeError("Failed to fetch");
  const e = plsError("offline", "browse -> network failure: Failed to fetch", cause);
  assert.ok(e instanceof Error);
  assert.equal(e.kind, "offline");
  assert.equal(e.userMessage, "You’re offline.");
  assert.equal(e.message, "browse -> network failure: Failed to fetch");
  assert.equal(e.cause, cause);
  // The signed-out log line stays recognisable.
  assert.equal(plsError("auth", "no SAPISID cookie — signed out?").message, "no SAPISID cookie — signed out?");
});

test("every userMessage is one clean sentence", () => {
  assert.deepEqual(PLS_USER_MESSAGES, {
    offline: "You’re offline.",
    auth: "You’re signed out of YouTube — sign in and try again.",
    rate: "YouTube is rate-limiting requests — wait a moment.",
    server: "YouTube had a problem — try again.",
    http: "YouTube rejected the request.",
    rejected: "YouTube rejected the change.",
  });
  for (const [kind, msg] of Object.entries(PLS_USER_MESSAGES)) {
    assert.match(msg, /^[A-Z][^]*[^.!?\s]\.$/, `${kind}: must end in exactly one full stop`);
    assert.equal(msg, msg.trim(), `${kind}: no stray whitespace`);
  }
});

// ─── The calls, against a stubbed page + fetch (no network) ──────────────────
// Only the browser globals the module already reads are stubbed (document.scripts,
// document.cookie, fetch, navigator.onLine); the module itself is untouched. This
// proves what we SEND — it proves nothing about how YouTube answers two signed-in
// accounts, which is still pending live verification.

function withPage({ ytcfgExtra = "", cookie = "SAPISID=abc123", onLine, respond }, fn) {
  return async () => {
    const saved = { document: globalThis.document, fetch: globalThis.fetch };
    const navDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const calls = [];
    globalThis.document = {
      scripts: [{ textContent: YTCFG(ytcfgExtra) }],
      cookie,
      documentElement: { innerHTML: "" },
    };
    Object.defineProperty(globalThis, "navigator", { value: { onLine }, configurable: true, writable: true });
    globalThis.fetch = async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return respond(calls.length, init);
    };
    const log = console.log;
    console.log = () => {};
    resetConfigCache();
    try {
      await fn(calls);
    } finally {
      console.log = log;
      globalThis.document = saved.document;
      globalThis.fetch = saved.fetch;
      if (navDesc) Object.defineProperty(globalThis, "navigator", navDesc);
      else delete globalThis.navigator;
      resetConfigCache();
    }
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

test(
  "plsPost sends X-Goog-AuthUser from SESSION_INDEX and X-Goog-PageId for a brand channel",
  withPage(
    { ytcfgExtra: `,"SESSION_INDEX":"1","DELEGATED_SESSION_ID":"102341564451195211920"`, respond: () => json({}) },
    async (calls) => {
      await fetchAllPlaylists();
      const h = calls[0].init.headers;
      assert.equal(h["X-Goog-AuthUser"], "1");
      assert.equal(h["X-Goog-PageId"], "102341564451195211920");
      assert.match(h.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
      // The proven fix stays in place alongside the header.
      assert.equal(calls[0].body.context.user.onBehalfOfUser, "102341564451195211920");
    },
  ),
);

test(
  "plsPost defaults X-Goog-AuthUser to 0 and sends no PageId on a personal account",
  withPage({ respond: () => json({}) }, async (calls) => {
    await fetchAllPlaylists();
    const h = calls[0].init.headers;
    assert.equal(h["X-Goog-AuthUser"], "0");
    assert.equal("X-Goog-PageId" in h, false);
  }),
);

test(
  "fetchAllPlaylists returns counts, in order, only where parsed",
  withPage({ respond: () => json(fixture("real-channel-playlists-mrbeast.json")) }, async () => {
    // The fixture carries a continuation token; the stub answers page 2 with the
    // same payload, which adds nothing new — so the walk stops, as in production.
    const list = await fetchAllPlaylists();
    assert.deepEqual(list.map((p) => p.count), [4, 9, 8, 9, 25]);
    assert.equal(list[0].id, "PLoSWVnSA9vG8hI-SUpAimvYJrPh-PRRvp");
    assert.equal(list[0].title, "If You Survive, You Win");
  }),
);

const rejectsWith = async (p, kind) => {
  const e = await p.then(() => assert.fail("expected a rejection"), (err) => err);
  assert.equal(e.kind, kind, `kind — message was: ${e.message}`);
  assert.equal(e.userMessage, PLS_USER_MESSAGES[kind]);
  return e;
};

test(
  "signed out: no SAPISID cookie -> auth, before any request",
  withPage({ cookie: "PREF=f6=40000000", respond: () => json({}) }, async (calls) => {
    const e = await rejectsWith(addVideo("PLx", "vid"), "auth");
    assert.equal(e.message, "no SAPISID cookie — signed out?");
    assert.equal(calls.length, 0);
  }),
);

test(
  "navigator.onLine === false -> offline, without calling fetch",
  withPage({ onLine: false, respond: () => json({}) }, async (calls) => {
    await rejectsWith(addVideo("PLx", "vid"), "offline");
    assert.equal(calls.length, 0);
  }),
);

test(
  "fetch rejecting (TypeError) -> offline",
  withPage(
    { respond: () => { throw new TypeError("Failed to fetch"); } },
    async () => {
      const e = await rejectsWith(addVideo("PLx", "vid"), "offline");
      assert.match(e.message, /network failure/);
    },
  ),
);

for (const [status, kind] of [[401, "auth"], [403, "auth"], [429, "rate"], [503, "server"], [400, "http"]]) {
  test(
    `HTTP ${status} -> ${kind}`,
    withPage({ respond: () => json({ error: {} }, status) }, async () => {
      const e = await rejectsWith(addVideo("PLx", "vid"), kind);
      assert.match(e.message, new RegExp(`browse/edit_playlist -> ${status}`));
    }),
  );
}

test(
  "edit_playlist answering a non-SUCCEEDED status -> rejected",
  withPage({ respond: () => json({ status: "STATUS_FAILED" }) }, async () => {
    const e = await rejectsWith(addVideo("PLx", "vid"), "rejected");
    assert.match(e.message, /STATUS_FAILED/);
  }),
);

// ─── resolveMembershipTail: cancellation ─────────────────────────────────────

test(
  "resolveMembershipTail stops on abort, resolves with what it has, and goes quiet",
  withPage(
    {
      // Every playlist page has a continuation, so a walk would run 12 pages if
      // nothing stopped it.
      respond: (_n, init) =>
        init.signal?.aborted
          ? Promise.reject(new DOMException("aborted", "AbortError"))
          : json({ contents: [{ videoId: "other" }], c: { continuationCommand: { token: "T" } } }),
    },
    async (calls) => {
      const ac = new AbortController();
      const resolved = [];
      const warn = console.warn;
      const warnings = [];
      console.warn = (...a) => warnings.push(a);
      try {
        const p = resolveMembershipTail("vid", ["PL1", "PL2", "PL3", "PL4"], (id) => resolved.push(id), 2, ac.signal);
        // Let a couple of requests go out, then close the sheet.
        await new Promise((r) => setTimeout(r, 0));
        ac.abort();
        const before = calls.length;
        const map = await p;
        assert.ok(map instanceof Map);
        assert.equal(map.size, 0, "no walk finished, so nothing is settled");
        assert.deepEqual(resolved, [], "onResolved must never fire after abort");
        assert.ok(calls.length <= before + 2, "no new pages fetched after abort (at most the in-flight ones)");
        assert.ok(calls.length < 24, "the walk did not run to completion");
        assert.deepEqual(warnings, [], "a cancel is not a failure");
      } finally {
        console.warn = warn;
      }
    },
  ),
);

test(
  "resolveMembershipTail without a signal still settles every playlist",
  withPage(
    { respond: (n) => json(n % 2 ? { contents: [{ videoId: "vid" }] } : { contents: [] }) },
    async () => {
      const resolved = [];
      const map = await resolveMembershipTail("vid", ["PL1", "PL2"], (id, hit) => resolved.push([id, hit]), 1);
      assert.deepEqual([...map], [["PL1", true], ["PL2", false]]);
      assert.deepEqual(resolved, [["PL1", true], ["PL2", false]]);
    },
  ),
);
