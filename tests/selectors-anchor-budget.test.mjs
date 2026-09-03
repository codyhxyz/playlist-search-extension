/**
 * Anchor-budget guard for the /feed/playlists surface.
 *
 * This is the test that makes "own the surface, don't read theirs" a rule
 * instead of an aspiration. `/feed/playlists` is allowed exactly TWO YouTube
 * DOM anchors — one place to mount our search UI, one container to hide while
 * our own results are showing. Everything the page needs is already in the
 * InnerTube library snapshot we fetch, so a third anchor means someone
 * started reading YouTube's markup again, which is how every 1.6.x feed
 * regression happened (CHANGELOG 1.6.6 / 1.6.7 / 1.6.8 / 1.6.10 / 1.6.15 /
 * 1.6.17).
 *
 * If you are here because this test is red: the fix is almost never "raise
 * the budget." It is usually one of
 *   - derive the thing you want from one of the two anchors by DOM
 *     relationship (parent / sibling), or
 *   - get it from the InnerTube data you already hold, or
 *   - decide you don't need it.
 *
 * Run: `node --test tests/selectors-anchor-budget.test.mjs`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  FEED_DOM_ANCHORS,
  FEED_DOM_ANCHOR_BUDGET,
  FEED_SEARCH_MOUNT_SELECTOR,
  FEED_GRID_SELECTOR,
} from "../src/lib/selectors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SELECTORS_SRC = readFileSync(
  path.join(__dirname, "../src/lib/selectors.js"),
  "utf8",
);

test("the feed surface declares exactly two YouTube DOM anchors", () => {
  assert.equal(FEED_DOM_ANCHOR_BUDGET, 2, "the budget itself must stay at 2");
  assert.equal(
    FEED_DOM_ANCHORS.length,
    FEED_DOM_ANCHOR_BUDGET,
    `/feed/playlists is budgeted ${FEED_DOM_ANCHOR_BUDGET} DOM anchors, found ${FEED_DOM_ANCHORS.length}: ` +
      FEED_DOM_ANCHORS.map((a) => `${a.id}="${a.selector}"`).join(", "),
  );
  assert.deepEqual(
    FEED_DOM_ANCHORS.map((a) => a.id).sort(),
    ["grid", "search-mount"],
    "anchor ids are part of the contract; content.js resolves them by id",
  );
});

test("each anchor is a single selector, not an OR-list of variants", () => {
  // A comma turns one anchor into N fallbacks wearing one name — the exact
  // dodge that let CHIP_ROW_SELECTORS grow to four entries. One anchor, one
  // selector; if it stops resolving we render nothing and say so loudly.
  for (const anchor of FEED_DOM_ANCHORS) {
    assert.ok(
      !anchor.selector.includes(","),
      `anchor "${anchor.id}" is a selector list ("${anchor.selector}") — that is N anchors, not one`,
    );
    assert.ok(
      anchor.selector.trim().length > 0,
      `anchor "${anchor.id}" has an empty selector`,
    );
    assert.equal(typeof anchor.purpose, "string");
    assert.ok(anchor.purpose.length > 0, `anchor "${anchor.id}" needs a purpose`);
  }
});

test("anchors prefer roles and element tags over build-generated classes", () => {
  // YouTube's `.ytChipBarViewModelChipBarScrollContainer`-style classes are
  // emitted by their build and churn on every rollout. A role or a
  // custom-element tag carries the same information and survives.
  for (const anchor of FEED_DOM_ANCHORS) {
    const generated = anchor.selector.match(/\.yt[A-Z][A-Za-z0-9]*/g) || [];
    assert.deepEqual(
      generated,
      [],
      `anchor "${anchor.id}" uses build-generated class(es) ${generated.join(", ")}; use a role or tag`,
    );
  }
});

test("the mount anchor is an accessibility signal scoped by a tag", () => {
  assert.match(FEED_SEARCH_MOUNT_SELECTOR, /\[role=/);
  assert.match(FEED_SEARCH_MOUNT_SELECTOR, /^chip-bar-view-model\b/);
});

test("the grid anchor is a direct child, so it can only ever match one node", () => {
  // `ytd-rich-grid-renderer #contents` (descendant) also matches the
  // `#contents` inside every `ytd-rich-grid-row`. Hiding the wrong one would
  // be silent and ugly, so the combinator is part of the contract.
  assert.match(FEED_GRID_SELECTOR, />\s*#contents\s*$/);
});

test("no resurrected card-reading selectors live in selectors.js", () => {
  // Named-and-shamed exports that were deleted when /feed/playlists stopped
  // reading YouTube's cards. If one of these comes back as an export, the
  // extension is parsing their markup again.
  const banned = [
    "PLAYLISTS_GRID_SELECTOR",
    "PLAYLISTS_CONTENTS_SELECTOR",
    "PLAYLISTS_OUTER_ROW_SELECTOR",
    "PLAYLIST_RENDERER_SELECTOR",
    "PLAYLIST_LINK_SELECTOR",
    "PAGE_RELEVANT_SELECTOR",
    "ITEM_TEXT_SELECTOR",
    "CHIP_ROW_SELECTORS",
    "CHIP_ROW_WRAPPER_CLASS",
  ];
  for (const name of banned) {
    assert.ok(
      !new RegExp(`^export\\s+const\\s+${name}\\b`, "m").test(SELECTORS_SRC),
      `${name} was deleted with the card-reading architecture; it must not come back`,
    );
  }
});

test("selectors.js exports no DOM selector outside the anchor list", () => {
  // Catches the other dodge: adding a selector constant that content.js uses
  // directly, bypassing FEED_DOM_ANCHORS and therefore this budget.
  const exported = [...SELECTORS_SRC.matchAll(/^export\s+const\s+(\w+)/gm)].map(
    (m) => m[1],
  );
  const allowed = new Set([
    "PLAYLISTS_FEED_PATH_RE", // a URL pattern, not a DOM anchor
    "FEED_SEARCH_MOUNT_SELECTOR",
    "FEED_GRID_SELECTOR",
    "FEED_DOM_ANCHORS",
    "FEED_DOM_ANCHOR_BUDGET",
  ]);
  const unexpected = exported.filter((name) => !allowed.has(name));
  assert.deepEqual(
    unexpected,
    [],
    `unexpected export(s) in selectors.js: ${unexpected.join(", ")}. ` +
      "Every YouTube DOM selector must be an entry in FEED_DOM_ANCHORS so the budget test can see it.",
  );
});

test("content.js resolves anchors only through the enumerated list", () => {
  const contentSrc = readFileSync(
    path.join(__dirname, "../src/content.js"),
    "utf8",
  );
  const imported = contentSrc.match(
    /import\s*\{([^}]*)\}\s*from\s*"\.\/lib\/selectors\.js"/,
  );
  assert.ok(imported, "content.js must import from ./lib/selectors.js");
  const names = imported[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  assert.deepEqual(
    names.sort(),
    ["FEED_DOM_ANCHORS", "PLAYLISTS_FEED_PATH_RE"],
    "content.js should import the anchor LIST (plus the path regex), never individual selectors — " +
      "importing a selector directly is how a third anchor sneaks past the budget",
  );
});
