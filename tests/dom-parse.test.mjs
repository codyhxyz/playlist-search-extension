/**
 * Tests for the pure Polymer-data extractors. These functions never touch
 * a real DOM — they just read `.data` / `.__data` blobs and `.matches()` —
 * so we exercise them with simple object stubs. No jsdom needed.
 *
 * Run: `node --test tests/dom-parse.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getRowPlaylistId,
  isSaveVideoModal,
  extractTitleFromPolymerData,
} from "../src/lib/dom-parse.js";

// ── getRowPlaylistId ───────────────────────────────────────────────────────

test("getRowPlaylistId reads .data.playlistId (top-level Polymer)", () => {
  assert.equal(getRowPlaylistId({ data: { playlistId: "PLAA" } }), "PLAA");
});

test("getRowPlaylistId reads .__data.playlistId (private Polymer slot)", () => {
  assert.equal(getRowPlaylistId({ __data: { playlistId: "PLBB" } }), "PLBB");
});

test("getRowPlaylistId reads onTap.addToPlaylistCommand.playlistId", () => {
  const row = {
    data: {
      onTap: { addToPlaylistCommand: { playlistId: "PLCC" } },
    },
  };
  assert.equal(getRowPlaylistId(row), "PLCC");
});

test("getRowPlaylistId reads onTap.toggledServiceEndpoint.playlistId", () => {
  const row = {
    data: {
      onTap: { toggledServiceEndpoint: { playlistId: "PLDD" } },
    },
  };
  assert.equal(getRowPlaylistId(row), "PLDD");
});

test("getRowPlaylistId returns null for view-model rows (no Polymer data)", () => {
  // The post-2026 toggleable-list-item-view-model rows have no .data; this
  // is the case where the synth-save path takes over via direct InnerTube
  // calls rather than relying on DOM-derived IDs.
  assert.equal(getRowPlaylistId({}), null);
  assert.equal(getRowPlaylistId({ data: {} }), null);
});

// ── isSaveVideoModal ───────────────────────────────────────────────────────

function mockHost({ matchSelector = false, data = undefined } = {}) {
  return {
    matches(sel) {
      return matchSelector === true || matchSelector === sel;
    },
    data,
  };
}

test("isSaveVideoModal: non-Polymer hosts pass through (view-model handled by :has)", () => {
  const host = mockHost({ matchSelector: false }); // not the old Polymer renderer
  assert.equal(isSaveVideoModal(host), true);
});

test("isSaveVideoModal: old Polymer host with videoId is allowed", () => {
  const host = mockHost({ matchSelector: true, data: { videoId: "abc123" } });
  assert.equal(isSaveVideoModal(host), true);
});

test("isSaveVideoModal: old Polymer host with empty videoId is rejected (1.6.11 bug)", () => {
  // This is the exact case that motivated commit cd0ad74: the "Add all to…"
  // bulk sub-dialog has data.videoId === "" (or absent value present-as-key),
  // and was incorrectly receiving the search bar.
  const host = mockHost({ matchSelector: true, data: { videoId: "" } });
  assert.equal(isSaveVideoModal(host), false);
});

test("isSaveVideoModal: Polymer host whose data hasn't hydrated yet is allowed", () => {
  // If the renderer mounts but .data is still undefined, we can't tell yet —
  // allow through and let a later refresh tick re-evaluate. Rejecting here
  // would cause race-condition flakiness on slow connections.
  const host = mockHost({ matchSelector: true, data: undefined });
  assert.equal(isSaveVideoModal(host), true);
});

test("isSaveVideoModal: Polymer host whose data has no videoId key is allowed", () => {
  // Different from videoId === "" — if the key is absent entirely, this is
  // probably some other Polymer state we haven't classified; don't reject.
  const host = mockHost({ matchSelector: true, data: { somethingElse: 1 } });
  assert.equal(isSaveVideoModal(host), true);
});

// ── extractTitleFromPolymerData ────────────────────────────────────────────

test("extractTitleFromPolymerData: title.runs[0].text wins (modern shape)", () => {
  assert.equal(
    extractTitleFromPolymerData({ title: { runs: [{ text: "Workout" }] } }),
    "Workout",
  );
});

test("extractTitleFromPolymerData: title.simpleText (legacy shape)", () => {
  // simpleText is checked first in the chain — both populated picks simpleText.
  // That's been the behavior since 1.5.3; preserving it under refactor.
  assert.equal(
    extractTitleFromPolymerData({ title: { simpleText: "Old shape" } }),
    "Old shape",
  );
});

test("extractTitleFromPolymerData: bare string title (very old renderers)", () => {
  assert.equal(extractTitleFromPolymerData({ title: "Stringly typed" }), "Stringly typed");
});

test("extractTitleFromPolymerData: .label fallback (checkbox-list variants)", () => {
  assert.equal(
    extractTitleFromPolymerData({ label: { runs: [{ text: "From label" }] } }),
    "From label",
  );
});

test("extractTitleFromPolymerData: returns null when no title-bearing key matches", () => {
  // Critical: returning null is the signal upstream to fall back to DOM text
  // extraction. Returning "" or "Untitled" would suppress that fallback and
  // leave the row with a meaningless searchable string.
  assert.equal(extractTitleFromPolymerData({}), null);
  assert.equal(extractTitleFromPolymerData({ unrelated: "x" }), null);
  assert.equal(extractTitleFromPolymerData(null), null);
  assert.equal(extractTitleFromPolymerData(undefined), null);
});

test("extractTitleFromPolymerData: empty string in title.simpleText is treated as null", () => {
  // YouTube sometimes hydrates Polymer data with empty strings before the
  // real title arrives. We want the DOM-fallback path to take over in that
  // window rather than caching an empty string as the row's text.
  assert.equal(
    extractTitleFromPolymerData({ title: { simpleText: "" } }),
    null,
  );
});
