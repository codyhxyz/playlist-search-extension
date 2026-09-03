/**
 * Every CSS selector and URL pattern that targets YouTube's DOM lives here.
 *
 * ── The rule this file exists to enforce ────────────────────────────────
 *
 * Own the surface; don't read theirs. YouTube's rendered DOM is not an API.
 * Every historical regression in this extension (CHANGELOG 1.6.6, 1.6.7,
 * 1.6.8, 1.6.10, 1.6.15, 1.6.17) was the same bug wearing a different hat:
 * we were parsing their markup, and they changed their markup.
 *
 * Two architectural moves removed almost all of that coupling:
 *
 *   1. Save-to-playlist (v1.7, commit b9b3ed9) — we no longer inject into
 *      YouTube's "Save to playlist" modal. Our own shadow-DOM sheet renders
 *      from InnerTube. The only coupling left is the action-bar Save button,
 *      intercepted by `aria-label` in content.js (an accessibility signal,
 *      not a selector — so it isn't in this file).
 *
 *   2. `/feed/playlists` (this file's current shape) — we no longer read,
 *      index, filter, hide, or reflow YouTube's playlist cards. We already
 *      fetch the complete playlist library from InnerTube; rendering our own
 *      result list from data we already hold is strictly less fragile than
 *      re-deriving it from their DOM. Deleted with that move:
 *
 *        PLAYLISTS_GRID_SELECTOR, PLAYLISTS_CONTENTS_SELECTOR,
 *        PLAYLISTS_OUTER_ROW_SELECTOR, PLAYLIST_RENDERER_SELECTOR,
 *        PLAYLIST_LINK_SELECTOR, PAGE_RELEVANT_SELECTOR,
 *        ITEM_TEXT_SELECTOR, CHIP_ROW_SELECTORS, CHIP_ROW_WRAPPER_CLASS
 *
 * ── The budget ──────────────────────────────────────────────────────────
 *
 * `/feed/playlists` gets exactly TWO DOM anchors: one place to mount our
 * search UI, one container to hide while our results are showing. That
 * budget is a hard, tested constraint — see the guard in
 * `tests/selectors-anchor-budget.test.mjs`, which fails the build if
 * `FEED_DOM_ANCHORS` grows. If you are about to add a third, the honest
 * move is almost always to derive it from one of these two by DOM
 * relationship, or to stop needing it.
 *
 * ── Anchoring rules ─────────────────────────────────────────────────────
 *
 *   1. Accessibility-tree / semantic signals beat tag names; tag names beat
 *      generated CSS class names. Never anchor on a `.ytChipBarViewModel*`
 *      -style build-generated class if a role or a custom-element tag will do.
 *   2. NO FALLBACK MOUNTS. If an anchor doesn't resolve, we render nothing
 *      and record a diagnostic. Appearing in an unexpected place is a worse
 *      failure than not appearing.
 *   3. Every anchor records a diagnostic when it resolves to nothing (or to
 *      something ambiguous), so breakage is loud instead of silent.
 */

export const PLAYLISTS_FEED_PATH_RE = /^\/feed\/(playlists|library)\/?(\?.*)?$/;

/**
 * ANCHOR 1 of 2 — where our search UI mounts.
 *
 * YouTube's native filter-chip row on /feed/playlists ("Recently added ·
 * Playlists · Music · Owned"). We append our search chip as its last child so
 * it reads as one of YouTube's own controls and costs zero vertical space.
 *
 *   ytd-rich-grid-renderer
 *     #header
 *       chip-bar-view-model                    ← custom-element tag
 *         div[role='tablist']                  ← accessibility signal
 *           …native chips…  + our chip
 *     #contents                                ← ANCHOR 2
 *
 * Anchored on `[role='tablist']` (an accessibility-tree signal that survives
 * CSS-class churn) scoped by the `chip-bar-view-model` custom-element tag so
 * we can never wander into some other tablist on the page. The pre-1.7
 * version of this anchor was a four-entry OR list built on the generated
 * class `.ytChipBarViewModelChipBarScrollContainer` plus two legacy Polymer
 * variants; all of that is gone.
 */
export const FEED_SEARCH_MOUNT_SELECTOR = "chip-bar-view-model [role='tablist']";

/**
 * ANCHOR 2 of 2 — the container we hide while our own results are showing.
 *
 * `ytd-rich-grid-renderer > #contents` is YouTube's rendered playlist grid.
 * We never read it, never index it, never touch a single card inside it; we
 * only toggle its visibility, and restore its exact inline `display` when the
 * query is cleared.
 *
 * Direct-child (`>`) on purpose: `ytd-rich-grid-row` also carries an
 * `#contents`, so a descendant combinator would resolve to N+1 elements and
 * we could hide the wrong one.
 */
export const FEED_GRID_SELECTOR = "ytd-rich-grid-renderer > #contents";

/**
 * The complete, enumerated YouTube-DOM coupling surface for /feed/playlists.
 * content.js resolves anchors exclusively through this list, and the anchor
 * budget test asserts against it. Adding an entry is a deliberate,
 * test-visible act.
 *
 * @typedef {{ id: string, selector: string, purpose: string }} FeedAnchor
 * @type {ReadonlyArray<FeedAnchor>}
 */
export const FEED_DOM_ANCHORS = Object.freeze([
  Object.freeze({
    id: "search-mount",
    selector: FEED_SEARCH_MOUNT_SELECTOR,
    purpose: "mount point for our search chip",
  }),
  Object.freeze({
    id: "grid",
    selector: FEED_GRID_SELECTOR,
    purpose: "YouTube's playlist grid; hidden while our results are showing",
  }),
]);

/** Hard cap. See tests/selectors-anchor-budget.test.mjs. */
export const FEED_DOM_ANCHOR_BUDGET = 2;
