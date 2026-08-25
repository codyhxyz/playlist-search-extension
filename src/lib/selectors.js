/**
 * Every CSS selector and URL pattern that targets YouTube's DOM lives here.
 *
 * This is the single highest-churn surface in the extension — see the
 * 1.6.6–1.6.12 entries in CHANGELOG.md for the kind of regressions that keep
 * recurring. Keeping the selectors in one place gives us:
 *
 *   1. A grep target. When YouTube ships a new renderer variant, the diff
 *      against this file *is* the impact assessment.
 *   2. A test surface. tests/innertube-parse.test.mjs + the agent-browser
 *      harness can import these directly and assert against fixture DOM /
 *      JSON without spinning up the whole content script.
 *   3. A documentation surface. The maintenance comments below are the only
 *      record of *why* each variant is in the OR list — kept here so they
 *      survive the next selector tweak.
 *
 * ── Save-to-playlist surface (since v1.7) ───────────────────────────────
 *
 * The extension no longer injects into YouTube's "Save to playlist" modal.
 * That DOM migrated repeatedly (see CHANGELOG 1.6.6–1.6.18) and every
 * migration broke the modal surface silently. The save sheet is now a fully
 * owned shadow-DOM UI backed by InnerTube; the only YouTube coupling is the
 * action-bar Save button, intercepted by aria-label in content.js. All
 * MODAL_* / CHECKBOX selectors were deleted with that architecture.
 */



export const PLAYLISTS_GRID_SELECTOR =
  "ytd-rich-grid-renderer, ytd-grid-renderer, ytd-item-section-renderer";

export const PLAYLISTS_CONTENTS_SELECTOR = ":scope > #contents, :scope > #items";

export const PLAYLISTS_OUTER_ROW_SELECTOR =
  "ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model";

export const PLAYLIST_RENDERER_SELECTOR =
  "ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model, yt-collection-item-view-model";

export const PLAYLISTS_FEED_PATH_RE = /^\/feed\/(playlists|library)\/?(\?.*)?$/;

/**
 * Native filter-chip-bar on /feed/playlists ("Recently added · Playlists ·
 * Music · Owned"). When present, we prepend our search input as a sibling
 * chip so it reads as part of YouTube's UI instead of getting its own
 * full-width row below. Ordered most-specific → least so the first match
 * wins; the absent-chip-row case falls back to the grid-spanning bar
 * (the historic `.ytpf-inline-page` mount).
 *
 * As of 2026-05 YouTube has migrated this surface from the legacy Polymer
 * `ytd-feed-filter-chip-bar-renderer` → the new `chip-bar-view-model` web
 * component. We probe view-model first, then Polymer for back-compat with
 * any mid-rollout user still on the old chip bar. The view-model layout:
 *
 *   ytd-rich-grid-renderer
 *     #header  ← chip bar lives here
 *       chip-bar-view-model.ytChipBarViewModelHost
 *         div.ytChipBarViewModelChipBarScrollContainer[role='tablist']
 *           div.ytChipBarViewModelChipWrapper   (one per native chip)
 *             chip-view-model.ytChipViewModelHost
 *     #contents
 *       … playlist lockups …  ← grid mount target for the fallback bar
 *
 * Mount strategy: prepend a `<div class="ytChipBarViewModelChipWrapper">`
 * to the scroll container so our chip inherits the native chip-spacing
 * margins. The LCA with the grid is `ytd-rich-grid-renderer`, which is
 * also where the existing `.ytpf-inline-page` mount lives.
 */
export const CHIP_ROW_SELECTORS = [
  // Post-2026 view-model (current production rollout)
  "chip-bar-view-model .ytChipBarViewModelChipBarScrollContainer",
  "chip-bar-view-model [role='tablist']",
  // Legacy Polymer chip-bar (kept for mid-rollout fallback; remove once
  // the view-model rollout is universal and a release cycle has passed)
  "ytd-feed-filter-chip-bar-renderer #chips",
  "yt-chip-cloud-renderer #chips",
];

/**
 * Wrapper class for our chip when mounted in the view-model chip bar.
 * Adding this class around our `<input>` makes the chip inherit native
 * chip spacing for free — the chip-bar style sheet keys off this class.
 * Empty for legacy chip bar (those use `#chips` flex gap, no wrapper).
 */
export const CHIP_ROW_WRAPPER_CLASS = "ytChipBarViewModelChipWrapper";

// YouTube migrated playlist URLs in 2026 from /playlist?list=PL... to
// /show/VL{PL...}?sbp=...; keep both for back-compat. Also accept watch
// URLs that carry &list= (e.g., the lockup's primary "play next" link).
export const PLAYLIST_LINK_SELECTOR =
  "a[href*='/playlist?list='], a[href*='youtube.com/playlist?list='], a[href*='/show/VL'], a[href*='youtube.com/show/VL'], a[href*='/watch?'][href*='list=']";



export const PAGE_RELEVANT_SELECTOR = `${PLAYLISTS_GRID_SELECTOR}, ${PLAYLISTS_OUTER_ROW_SELECTOR}, ${PLAYLIST_RENDERER_SELECTOR}`;

export const ITEM_TEXT_SELECTOR =
  "#label, #video-title, .playlist-title, yt-formatted-string[id='label'], yt-formatted-string, span#label, a#video-title, .ytListItemViewModelTitle, .yt-lockup-metadata-view-model-wiz__title, [class*='LockupMetadataViewModelTitle']";
