/**
 * Pure functions that walk InnerTube API response JSON and extract playlists.
 *
 * This is the OTHER high-churn surface besides selectors. YouTube migrates
 * response shapes mid-renderer rollout (CHANGELOG 1.6.9 caught a silent
 * lockupViewModel migration that capped results at ~200 for weeks), so this
 * file:
 *
 *   1. Knows about every renderer shape that has ever shipped playlists in
 *      it: gridPlaylistRenderer (legacy), playlistRenderer, and
 *      lockupViewModel (post-2026).
 *   2. Stays pure — input is parsed JSON, output is { playlists, continuation }
 *      plus an optional `onShapeUnknown` callback. No fetch, no chrome.*, no
 *      DOM. That makes it fixture-testable in plain Node (see
 *      tests/innertube-parse.test.mjs).
 *   3. Owns the shape canary. When a response advances continuation but
 *      yields zero playlists, OR when items match no known renderer key, we
 *      emit a structured event through the caller-provided sink so future
 *      shape migrations show up the same day they roll out instead of
 *      whenever the next user emails support.
 */

/**
 * Extract the human-readable title from any renderer that follows the
 * standard `{ title: { runs: [{ text }] } }` / `{ title: { simpleText } }`
 * shape (both gridPlaylistRenderer and playlistRenderer use this).
 */
export function rendererTitle(r) {
  return r?.title?.runs?.[0]?.text || r?.title?.simpleText || "Untitled";
}

/**
 * Walk an InnerTube response and pull out every playlist we can recognize.
 *
 * @param {object} data Parsed JSON from /youtubei/v1/browse.
 * @param {(reason: object) => void} [onShapeUnknown] Optional canary sink.
 *   Called once per call when items were present but no playlists were
 *   extracted — that's the symptom of a renderer migration we don't yet
 *   handle. Receives { itemKeys, sampleItem, hasContinuation }.
 * @returns {{ playlists: Array<{id:string,title:string,itemCount:number}>, continuation: string|null }}
 */
export function parsePlaylistRenderers(data, onShapeUnknown) {
  const playlists = [];
  let continuation = null;
  // Track raw item count + the set of top-level keys we saw — this is what
  // the canary uses to decide "we walked items but found nothing recognizable."
  let itemsSeen = 0;
  const unknownItemKeys = new Set();
  let sampleUnknownItem = null;

  function visitItems(items) {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      itemsSeen += 1;

      const gpr = item.gridPlaylistRenderer;
      if (gpr?.playlistId) {
        playlists.push({
          id: gpr.playlistId,
          title: rendererTitle(gpr),
          itemCount:
            parseInt(
              gpr.videoCountShortText?.simpleText ||
                gpr.thumbnailText?.runs?.[0]?.text ||
                "0",
              10,
            ) || 0,
        });
        continue;
      }

      const pr = item.playlistRenderer;
      if (pr?.playlistId) {
        playlists.push({
          id: pr.playlistId,
          title: rendererTitle(pr),
          itemCount: parseInt(pr.videoCount || "0", 10) || 0,
        });
        continue;
      }

      // YouTube migrated /feed/playlists rows to lockupViewModel in 2026.
      // Without this branch the parser silently dropped every lockup-shaped
      // playlist, capping results at whatever the API still happened to
      // return as legacy renderers (~200 latest).
      const lvm = item.lockupViewModel;
      if (lvm?.contentId && /PLAYLIST/.test(lvm.contentType || "")) {
        const title =
          lvm.metadata?.lockupMetadataViewModel?.title?.content || "Untitled";
        let itemCount = 0;
        const rows =
          lvm.metadata?.lockupMetadataViewModel?.metadata
            ?.contentMetadataViewModel?.metadataRows || [];
        outer: for (const row of rows) {
          for (const part of row?.metadataParts || []) {
            const m = /(\d[\d,]*)/.exec(part?.text?.content || "");
            if (m) {
              itemCount = parseInt(m[1].replace(/,/g, ""), 10) || 0;
              if (itemCount) break outer;
            }
          }
        }
        playlists.push({ id: lvm.contentId, title, itemCount });
        continue;
      }

      const rich = item.richItemRenderer?.content;
      if (rich) {
        // richItemRenderer is a wrapper, not the renderer itself; descend.
        // Don't count the wrapper as "unknown" — its content recurses through
        // visitItems and any unrecognized payload there gets flagged.
        visitItems([rich]);
        continue;
      }

      const cont =
        item.continuationItemRenderer?.continuationEndpoint
          ?.continuationCommand?.token;
      if (cont) {
        continuation = cont;
        continue;
      }

      // Item didn't match any known shape. Record its top-level keys for
      // the canary so we can identify the new renderer in diagnostics.
      for (const key of Object.keys(item || {})) unknownItemKeys.add(key);
      if (!sampleUnknownItem && item && typeof item === "object") {
        sampleUnknownItem = item;
      }
    }
  }

  const tabs = data?.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
  for (const tab of tabs) {
    const content = tab?.tabRenderer?.content;
    const sections = content?.sectionListRenderer?.contents || [];
    for (const section of sections) {
      const grid =
        section?.itemSectionRenderer?.contents?.[0]?.gridRenderer;
      if (grid) {
        visitItems(grid.items);
        const gc = grid.continuations?.[0]?.nextContinuationData?.continuation;
        if (gc) continuation = gc;
      }
      const shelf = section?.shelfRenderer?.content?.gridRenderer;
      if (shelf) {
        visitItems(shelf.items);
      }
    }
    const richGrid = content?.richGridRenderer?.contents;
    if (richGrid) visitItems(richGrid);
  }

  const actions = data?.onResponseReceivedActions || [];
  for (const action of actions) {
    visitItems(
      action?.appendContinuationItemsAction?.continuationItems ||
        action?.reloadContinuationItemsCommand?.continuationItems ||
        [],
    );
  }

  // Shape canary: if ANY item didn't match a known renderer shape, YouTube
  // probably shipped (or is mid-rollout shipping) a renderer we don't yet
  // handle. Fire regardless of how many *other* items we did parse — the
  // 1.6.9 lockupViewModel cap-at-200 regression was exactly the case where
  // we parsed *some* items (legacy ones) but silently dropped the new shape.
  // Keying the diagnostic by sorted unknown-keys (done by the caller) lets
  // recordDiagnostic's per-invariant 30s throttle suppress duplicate
  // shipments without suppressing distinct migrations.
  if (typeof onShapeUnknown === "function" && unknownItemKeys.size > 0) {
    try {
      onShapeUnknown({
        itemsSeen,
        unknownItemKeys: [...unknownItemKeys].sort(),
        // How many items the parser actually classified — when this is
        // positive AND unknownItemKeys is non-empty, you're looking at a
        // mid-rollout (the bad case the original trigger missed).
        playlistsExtracted: playlists.length,
        hasContinuation: Boolean(continuation),
        // Truncated sample so the diagnostic ring doesn't bloat — just the
        // top-level keys plus a single nested level for shape inference.
        sampleItemShape: sampleUnknownItem
          ? summarizeShape(sampleUnknownItem)
          : null,
      });
    } catch {
      // Canary must never break the parser. Swallow.
    }
  }

  return { playlists, continuation };
}

/**
 * Return a 2-level keys-only shape summary of an object. Used by the canary
 * to describe an unrecognized renderer without dumping its entire payload
 * (renderers carry thumbnails, accessibility text, and tracking blobs that
 * would blow past the diagnostic ring's 10KB budget).
 */
function summarizeShape(obj, depth = 0) {
  if (obj === null || typeof obj !== "object" || depth > 1) {
    return typeof obj;
  }
  if (Array.isArray(obj)) {
    return obj.length === 0
      ? "[]"
      : [`[${obj.length}]`, summarizeShape(obj[0], depth + 1)];
  }
  const out = {};
  for (const key of Object.keys(obj)) {
    out[key] = summarizeShape(obj[key], depth + 1);
  }
  return out;
}
