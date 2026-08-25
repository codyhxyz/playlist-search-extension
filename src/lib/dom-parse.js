/**
 * Pure(ish) extractors that read YouTube's Polymer `.data` / `.__data` blobs
 * and decide what they tell us. These functions never write DOM, never call
 * fetch, and never touch chrome.* — input is an element-shaped object,
 * output is a value. That makes them fixture-testable in plain Node with
 * trivial object stubs (no jsdom required).
 *
 * They live here, not in content.js, because every entry below corresponds
 * to a bug-once-shipped:
 *
 *   - getRowPlaylistId — when YouTube rolled out view-model rows (no
 *     Polymer .data), this was the function that started returning null
 *     for half the rows. The synth-save path now bypasses DOM IDs entirely.
 */

/**
 * Read the `playlistId` off a Polymer row, looking in every place YouTube
 * has stashed it across renderer versions. Returns null for view-model rows
 * (no Polymer data) — those are handled via DOM toggle clicks, not direct
 * API saves.
 */
export function getRowPlaylistId(row) {
  const data = row?.data || row?.__data;
  if (data?.playlistId) return data.playlistId;
  const onTap = data?.onTap || data?.data?.onTap;
  const cmd = onTap?.addToPlaylistCommand || onTap?.toggledServiceEndpoint;
  if (cmd?.playlistId) return cmd.playlistId;
  return null;
}

/**
 * Pull a human-readable title out of a Polymer row's `.data` / `.__data`.
 * Returns the raw string (caller normalizes whitespace) or null when no
 * recognizable title key is present — the latter signals "fall back to DOM
 * text extraction" upstream.
 *
 * Walks every shape we've seen in production:
 *   - .title.simpleText      (legacy playlistRenderer)
 *   - .title.runs[0].text    (most current renderers)
 *   - .title as a bare string (very old renderers)
 *   - .label.* same triple   (some checkbox-list variants)
 *
 * When YouTube ships a new title-bearing shape, this is the function that
 * starts returning null; tests/dom-parse.test.mjs catches it.
 *
 * @param {object|null|undefined} data Either row.data, row.__data, or the
 *   blob passed by the caller after picking the right slot.
 * @returns {string|null}
 */
export function extractTitleFromPolymerData(data) {
  if (!data) return null;
  return (
    data.title?.simpleText ||
    data.title?.runs?.[0]?.text ||
    (typeof data.title === "string" ? data.title : null) ||
    data.label?.simpleText ||
    data.label?.runs?.[0]?.text ||
    (typeof data.label === "string" ? data.label : null) ||
    null
  );
}
