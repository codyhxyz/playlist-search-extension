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

import { cfgFrom, parseMembership, scanKey, scanPlaylists } from "../src/lib/innertube.js";

const scan = (node) => scanPlaylists(node, new Map());

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

// ─── scanPlaylists: shapes are mid-migration, so we walk ─────────────────────

test("scanPlaylists reads the legacy gridPlaylistRenderer shape", () => {
  const out = scan({
    contents: [{ gridPlaylistRenderer: { playlistId: "PLlegacy001", title: { runs: [{ text: "Deep " }, { text: "Focus" }] } } }],
  });
  assert.deepEqual([...out], [["PLlegacy001", "Deep Focus"]]);
});

test("scanPlaylists reads the post-2026 lockupViewModel shape", () => {
  const out = scan({
    contents: [{ lockupViewModel: { contentId: "PLmodern002", metadata: { lockupMetadataViewModel: { title: { content: "Ocean sounds" } } } } }],
  });
  assert.deepEqual([...out], [["PLmodern002", "Ocean sounds"]]);
});

test("scanPlaylists reads simpleText titles", () => {
  const out = scan({ playlistAddToOptionRenderer: { playlistId: "PLsimple3", title: { simpleText: "Watch later" } } });
  assert.equal(out.get("PLsimple3"), "Watch later");
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
  assert.equal(out.get("PLnested005"), "My playlist");
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
  assert.equal(out.get("PLtitleless06"), null);
});

test("scanPlaylists accumulates across continuation pages", () => {
  const found = new Map();
  scanPlaylists({ contents: [{ gridPlaylistRenderer: { playlistId: "PLpage1a", title: { content: "A" } } }] }, found);
  scanPlaylists({ continuationItems: [{ lockupViewModel: { contentId: "PLpage2b", metadata: { title: { content: "B" } } } }] }, found);
  assert.deepEqual([...found.keys()], ["PLpage1a", "PLpage2b"]);
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
  for (const [id, title] of found) {
    assert.match(id, /^PL/, `${id} should be a playlist id`);
    // A raw id leaking through as the title is the visible symptom of the
    // id/title pairing being wrong — it would render as gibberish in the sheet.
    assert.ok(title && title !== id, `playlist ${id} came back with no human title`);
  }
  assert.ok([...found.values()].includes("If You Survive, You Win"));
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

test("parseMembership reads the live get_add_to_playlist shape", () => {
  const map = parseMembership(fixture("add-to-playlist-panel.json"));
  assert.equal(map.get("PLexampleContains001"), true);
  assert.equal(map.get("PLexampleOmitted002"), false);
  assert.equal(map.get("WL"), false);
  // Rows are nested two levels below the response root. A parser that indexed a
  // fixed path — or took the first listItems array it found — reads zero here,
  // which is precisely how "there is no bulk membership endpoint" got written down.
  assert.equal(map.size, 3);
});
