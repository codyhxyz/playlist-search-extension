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
 * ── Save-modal DOM reference (captured 2026-04-16) ───────────────────────
 *
 * YouTube ships two coexisting variants of the "Save to playlist" modal.
 * Selectors below must keep matching BOTH; the new view-model variant has
 * been rolling out and is what most users see now.
 *
 * OLD (Polymer renderer, pre-rollout):
 *   ytd-add-to-playlist-renderer
 *     #playlists / yt-checkbox-list-renderer
 *       ytd-playlist-add-to-option-renderer  (rows; .data has playlistId)
 *         tp-yt-paper-checkbox               (toggle)
 *         #label / yt-formatted-string       (title)
 *
 * NEW (view-model, post-rollout):
 *   yt-sheet-view-model                              ← scrolls
 *     yt-contextual-sheet-layout                     ← MODAL_HOST (also used
 *       yt-panel-header-view-model[aria-label=          by other sheets like
 *         "Save video to..."]                          upload Visibility —
 *       yt-list-view-model                             distinguish via the
 *         toggleable-list-item-view-model  ← ROW       :has(toggleable-…)
 *           yt-list-item-view-model[                   guard, since the old
 *             role=listitem,                           narrowing-only fix
 *             aria-pressed=true|false,                 (commit d652799)
 *             aria-label="<title>, <Private|Public|    blocked the new
 *               Unlisted>, <Selected|Not selected>"]   modal entirely.
 *             button.ytListItemViewModelButtonOrAnchor[aria-pressed]
 *               span.ytListItemViewModelTitle  ← TITLE TEXT (clean, no
 *                 "Watch later"                  children, normalizable)
 *               span.ytListItemViewModelSubtitle  ← privacy ("Private")
 *             yt-collection-thumbnail-view-model  ← playlist marker; the
 *                                                   visibility dialog has
 *                                                   no collection thumbs
 *       yt-panel-footer-view-model
 *
 * Notes for future maintenance:
 * - View-model rows have NO Polymer .data/.__data — getRowPlaylistId returns
 *   null for them. Existing rows just get hidden/shown; saving still works
 *   because the user clicks YouTube's own toggle button. Synth rows (filtered
 *   API matches) carry the playlistId from the InnerTube response, so they
 *   call innertubeSaveVideo directly without needing DOM-derived IDs.
 * - The new modal is not virtualized: all 200+ playlists render up-front.
 * - aria-label on yt-list-item-view-model is locale-dependent ("Private",
 *   "Selected") — never key off it for matching; use it only as a last-resort
 *   text fallback.
 *
 * Generic dialog containers (tp-yt-paper-dialog, yt-contextual-sheet-layout)
 * are reused across the site for non-playlist surfaces. The :has(...) guard
 * ensures we only attach when the dialog actually contains playlist rows.
 *
 * yt-collection-thumbnail-view-model is required inside the toggleable rows
 * because the "Save video to…" sheet's rows always carry playlist thumbnails,
 * while bulk-action sheets (e.g. "Add all to…" from the playlist ⋮ menu) and
 * unrelated contextual menus (Shuffle / Download / etc.) do not.
 * Belt-and-suspenders: isSaveVideoModal() in refresh() adds a JS-level check
 * on the old-style Polymer renderer that guards against the "Add all to…"
 * sub-dialog when data.videoId is absent.
 */

export const MODAL_HOST_SELECTOR =
  "ytd-add-to-playlist-renderer, " +
  "yt-add-to-playlist-renderer, " +
  "yt-contextual-sheet-layout:has(toggleable-list-item-view-model yt-collection-thumbnail-view-model), " +
  "tp-yt-paper-dialog:has(toggleable-list-item-view-model yt-collection-thumbnail-view-model)";

export const MODAL_ROW_SELECTOR =
  "toggleable-list-item-view-model, ytd-playlist-add-to-option-renderer, yt-playlist-add-to-option-renderer, yt-checkbox-list-entry-renderer, yt-list-item-view-model, yt-collection-item-view-model";

export const PLAYLISTS_GRID_SELECTOR =
  "ytd-rich-grid-renderer, ytd-grid-renderer, ytd-item-section-renderer";

export const PLAYLISTS_CONTENTS_SELECTOR = ":scope > #contents, :scope > #items";

export const PLAYLISTS_OUTER_ROW_SELECTOR =
  "ytd-rich-item-renderer, ytd-rich-grid-media, yt-lockup-view-model";

export const PLAYLIST_RENDERER_SELECTOR =
  "ytd-grid-playlist-renderer, ytd-playlist-renderer, ytd-compact-playlist-renderer, yt-lockup-view-model, yt-collection-item-view-model";

export const PLAYLISTS_FEED_PATH_RE = /^\/feed\/(playlists|library)\/?(\?.*)?$/;

// YouTube migrated playlist URLs in 2026 from /playlist?list=PL... to
// /show/VL{PL...}?sbp=...; keep both for back-compat. Also accept watch
// URLs that carry &list= (e.g., the lockup's primary "play next" link).
export const PLAYLIST_LINK_SELECTOR =
  "a[href*='/playlist?list='], a[href*='youtube.com/playlist?list='], a[href*='/show/VL'], a[href*='youtube.com/show/VL'], a[href*='/watch?'][href*='list=']";

export const CHECKBOX_SELECTOR =
  "tp-yt-paper-checkbox, [role='checkbox'], input[type='checkbox']";

export const MODAL_RELEVANT_SELECTOR = `${MODAL_HOST_SELECTOR}, ${MODAL_ROW_SELECTOR}, ${CHECKBOX_SELECTOR}`;

export const PAGE_RELEVANT_SELECTOR = `${PLAYLISTS_GRID_SELECTOR}, ${PLAYLISTS_OUTER_ROW_SELECTOR}, ${PLAYLIST_RENDERER_SELECTOR}`;

export const ITEM_TEXT_SELECTOR =
  "#label, #video-title, .playlist-title, yt-formatted-string[id='label'], yt-formatted-string, span#label, a#video-title, .ytListItemViewModelTitle, .yt-lockup-metadata-view-model-wiz__title, [class*='LockupMetadataViewModelTitle']";
