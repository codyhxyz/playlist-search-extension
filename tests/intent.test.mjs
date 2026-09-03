// Intent resolution — the layer that decides "is this a save request, and for which
// video?". Everything under test is pure, so this suite needs no browser and no auth.
//
// These are the regressions that actually shipped:
//   * Percent-encoded `params` threw inside atob(), which is why saving worked on the
//     watch page and silently did nothing on the home feed for an entire release.
//   * A fixed-offset regex over the protobuf happened to work on one surface and
//     returned a wrong id on others.
//   * Firing on the `get_panel` URL alone put our UI inside unrelated YouTube menus,
//     because `get_panel` is generic — the "Ask" panel uses it too.

import test from "node:test";
import assert from "node:assert/strict";

import {
  ADD_TO_PLAYLIST_PANEL,
  b64ToBytes,
  blobMentions,
  idsInBlob,
  isAddToPlaylist,
  resolveVideoId,
  videoIdFromUrl,
} from "../src/lib/intent.js";

// ─── protobuf fixture builder ────────────────────────────────────────────────
// Real `params` blobs are opaque and account-specific, so we synthesise them to the
// layout captured live on 2026-08-28: field 111 (length-delimited) containing field 1
// (length-delimited) = the videoId, with an optional trailing field 5 that is present
// on the watch page and absent on the feed.

function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return out;
}

/** A length-delimited (wire type 2) field. */
function field(num, payload) {
  const bytes = typeof payload === "string" ? [...Buffer.from(payload, "utf8")] : payload;
  return [...varint((num << 3) | 2), ...varint(bytes.length), ...bytes];
}

/** A varint (wire type 0) field. */
function vfield(num, value) {
  return [...varint(num << 3), ...varint(value)];
}

function toB64Url(bytes, { padded = false } = {}) {
  const b64 = Buffer.from(Uint8Array.from(bytes)).toString("base64");
  const url = b64.replace(/\+/g, "-").replace(/\//g, "_");
  return padded ? url : url.replace(/=+$/, "");
}

const WATCH_ID = "dQw4w9WgXcQ";
const FEED_ID = "aBcD_1234-x";

/** The shape every save surface produced: 111 → 1 = videoId. */
const paramsFor = (id, extra = []) => field(111, [...field(1, id), ...extra]);

// ─── videoIdFromUrl — the zero-DOM floor ─────────────────────────────────────

test("videoIdFromUrl reads every YouTube URL shape we can be invoked on", () => {
  assert.equal(videoIdFromUrl(`https://www.youtube.com/watch?v=${WATCH_ID}`), WATCH_ID);
  assert.equal(videoIdFromUrl(`https://www.youtube.com/watch?v=${WATCH_ID}&list=PLabc&t=42`), WATCH_ID);
  // Shorts has NO native save affordance, so this path is its only coverage.
  assert.equal(videoIdFromUrl(`https://www.youtube.com/shorts/${WATCH_ID}`), WATCH_ID);
  assert.equal(videoIdFromUrl(`https://www.youtube.com/embed/${WATCH_ID}`), WATCH_ID);
  assert.equal(videoIdFromUrl(`https://www.youtube.com/live/${WATCH_ID}`), WATCH_ID);
  assert.equal(videoIdFromUrl(`https://youtu.be/${WATCH_ID}?si=xyz`), WATCH_ID);
});

test("videoIdFromUrl refuses anything that is not an 11-char id", () => {
  assert.equal(videoIdFromUrl("https://www.youtube.com/feed/playlists"), null);
  assert.equal(videoIdFromUrl("https://www.youtube.com/@MrBeast"), null);
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=tooshort"), null);
  assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=this-one-is-way-too-long"), null);
  assert.equal(videoIdFromUrl("not a url at all"), null);
  assert.equal(videoIdFromUrl(undefined), null);
  assert.equal(videoIdFromUrl(null), null);
  assert.equal(videoIdFromUrl(12345), null);
});

// ─── b64ToBytes — the home-feed bug ──────────────────────────────────────────

test("b64ToBytes decodes percent-encoded padding", () => {
  // THE home-feed regression. When the protobuf length makes the base64 padded,
  // YouTube ships `...OA%3D%3D`. atob() THROWS on '%', so the old code silently
  // dropped every feed save while the watch page (unpadded) kept working.
  const raw = toB64Url(paramsFor(FEED_ID), { padded: true });
  assert.ok(raw.includes("="), "fixture must actually be padded to be meaningful");
  const percentEncoded = raw.replace(/=/g, "%3D");

  const direct = b64ToBytes(raw);
  const viaPercent = b64ToBytes(percentEncoded);
  assert.deepEqual([...viaPercent], [...direct]);
});

test("b64ToBytes tolerates missing padding and base64url alphabet", () => {
  const bytes = [...Buffer.from("hello world!!", "utf8")];
  const unpadded = toB64Url(bytes);
  assert.ok(!unpadded.includes("="));
  assert.deepEqual([...b64ToBytes(unpadded)], bytes);
});

test("b64ToBytes throws on garbage so callers can treat it as 'not a blob'", () => {
  assert.throws(() => b64ToBytes("!!!! not base64 !!!!"));
});

// ─── idsInBlob — walk the protobuf, don't guess offsets ──────────────────────

test("idsInBlob finds the videoId and reports the field path it came from", () => {
  const hits = idsInBlob(toB64Url(paramsFor(WATCH_ID)));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, WATCH_ID);
  assert.equal(hits[0].path, "111.1");
});

test("idsInBlob still finds the id when the trailing field 5 is present", () => {
  // Watch-page blobs carry an extra varint the feed's do not. A fixed-offset regex
  // is exactly what this breaks.
  const hits = idsInBlob(toB64Url(paramsFor(WATCH_ID, vfield(5, 3))));
  assert.deepEqual(hits.map((h) => h.path), ["111.1"]);
  assert.equal(hits[0].id, WATCH_ID);
});

test("idsInBlob descends one level of nested base64", () => {
  // Continuation tokens embed another token, which is where the id can hide.
  const inner = toB64Url(paramsFor(FEED_ID));
  const hits = idsInBlob(toB64Url(field(2, inner)));
  assert.equal(hits.length, 1);
  assert.equal(hits[0].id, FEED_ID);
  assert.match(hits[0].path, /\//, "nested hits record both outer and inner paths");
});

test("idsInBlob returns nothing rather than throwing on an undecodable blob", () => {
  assert.deepEqual(idsInBlob("%%%not-base64%%%"), []);
});

// ─── the gate ────────────────────────────────────────────────────────────────

test("isAddToPlaylist accepts YouTube's own name for the panel", () => {
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", { panelId: ADD_TO_PLAYLIST_PANEL }), true);
});

test("isAddToPlaylist REJECTS the generic get_panel call", () => {
  // The regression this whole gate exists for: `get_panel` is generic. The "Ask"
  // panel uses the same endpoint with no panelId. Firing on the URL alone is how
  // the 1.6.x extension rendered its UI inside unrelated YouTube menus.
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", { params: "abc" }), false);
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", { panelId: "PAsomething_else" }), false);
});

test("isAddToPlaylist accepts the endpoint whose path states its own purpose", () => {
  assert.equal(isAddToPlaylist("/youtubei/v1/playlist/get_add_to_playlist", { videoIds: [WATCH_ID] }), true);
});

test("isAddToPlaylist finds the panel name buried in a continuation token", () => {
  // Paginated / restored panels don't repeat `panelId` — it's inside the token.
  const token = toB64Url(field(1, ADD_TO_PLAYLIST_PANEL));
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", { continuation: token }), true);
  assert.equal(blobMentions(token, ADD_TO_PLAYLIST_PANEL), true);
  assert.equal(blobMentions(toB64Url(field(1, "PAsomething_else")), ADD_TO_PLAYLIST_PANEL), false);
});

test("isAddToPlaylist survives junk bodies", () => {
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", null), false);
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", undefined), false);
  assert.equal(isAddToPlaylist("/youtubei/v1/get_panel", "a string"), false);
  assert.equal(isAddToPlaylist(undefined, {}), false);
});

// ─── resolveVideoId — one path, ordered by directness ────────────────────────

test("resolveVideoId prefers a stated videoId over anything it would have to decode", () => {
  const r = resolveVideoId({ videoId: WATCH_ID, params: toB64Url(paramsFor(FEED_ID)) });
  assert.equal(r.videoId, WATCH_ID);
  assert.equal(r.from, "body.videoId");
});

test("resolveVideoId reads videoIds[] — the shape our own membership call uses", () => {
  const r = resolveVideoId({ videoIds: [WATCH_ID] });
  assert.equal(r.videoId, WATCH_ID);
  assert.equal(r.from, "body.videoIds[]");
});

test("resolveVideoId decodes params and names the field path it used", () => {
  const r = resolveVideoId({ panelId: ADD_TO_PLAYLIST_PANEL, params: toB64Url(paramsFor(FEED_ID)) });
  assert.equal(r.videoId, FEED_ID);
  assert.equal(r.from, "body.params[field 111.1]");
});

test("resolveVideoId decodes a percent-encoded params blob — the home-feed case", () => {
  const params = toB64Url(paramsFor(FEED_ID), { padded: true }).replace(/=/g, "%3D");
  const r = resolveVideoId({ panelId: ADD_TO_PLAYLIST_PANEL, params });
  assert.equal(r.videoId, FEED_ID, "a padded, percent-encoded blob must still resolve");
});

test("resolveVideoId prefers field 111.1 when a blob offers several candidates", () => {
  // Drift insurance: if another id-shaped field appears we must not pick it at
  // random, and the note must make the ambiguity visible in the log.
  const blob = toB64Url([...field(3, FEED_ID), ...paramsFor(WATCH_ID)]);
  const r = resolveVideoId({ params: blob });
  assert.equal(r.videoId, WATCH_ID);
  assert.equal(r.from, "body.params[field 111.1]");
  assert.match(r.note, /2 candidates/);
});

test("resolveVideoId falls back through the zero-DOM sources in order", () => {
  const link = resolveVideoId({}, { linkUrl: `https://www.youtube.com/watch?v=${WATCH_ID}` });
  assert.equal(link.from, "info.linkUrl");

  const src = resolveVideoId({}, { srcUrl: `https://youtu.be/${WATCH_ID}` });
  assert.equal(src.from, "info.srcUrl");

  const tab = resolveVideoId({}, { tabUrl: `https://www.youtube.com/shorts/${WATCH_ID}` });
  assert.equal(tab.from, "tab.url");
  assert.equal(tab.videoId, WATCH_ID);
});

test("resolveVideoId prefers the clicked link over the page it was clicked on", () => {
  // Right-clicking a thumbnail in the feed while a *different* video is open.
  const r = resolveVideoId(
    {},
    { linkUrl: `https://www.youtube.com/watch?v=${FEED_ID}`, tabUrl: `https://www.youtube.com/watch?v=${WATCH_ID}` },
  );
  assert.equal(r.videoId, FEED_ID);
});

test("resolveVideoId returns null WITH a trail when it genuinely cannot tell", () => {
  // A dropped intent must be diagnosable. "undefined" with no explanation is the
  // failure mode this whole module is written to escape.
  const r = resolveVideoId({ params: "notabase64blob!!" }, { tabUrl: "https://www.youtube.com/feed/you" });
  assert.equal(r.videoId, null);
  assert.equal(r.from, null);
  assert.ok(r.tried.length >= 5, "every source it consulted is recorded");
  assert.ok(r.tried.some((t) => t.startsWith("body.videoId")));
  assert.ok(r.tried.some((t) => t.includes("tab.url")));
});
