# Search

All search logic lives in `src/content.js`. The extension uses [MiniSearch](https://github.com/lucaong/minisearch) (vendored in `src/vendor/minisearch.js`) for BM25 ranking.

Both search surfaces rank the same data: the playlist library fetched from
InnerTube. Nothing is indexed from YouTube's rendered DOM.

## One index over the InnerTube library

Since v1.7 there is a single source of playlists: the InnerTube library
snapshot (`loadAllPlaylists`). Both surfaces — the owned save sheet and the
owned `/feed/playlists` result list — render from it, so the index has one
kind of document and nothing to reconcile.

`createPlaylistIndex(playlists)` builds it:

```js
docs = playlists.map((pl, i) => ({
  id:   `pl:${i}`,
  text: normalizeText(pl.title),
  ref:  String(i),          // index back into feed.playlists
}));
```

`searchPlaylists(query)` searches it and maps each hit's `ref` back to the
playlist object, returning `{ playlist, score, terms }`. Queries shorter than
two characters skip BM25 (tokenization is useless there) and fall back to a
substring scan ranked by match position.

### What this replaced, and why

Through 1.6.18 this was a *unified* index: DOM rows scraped out of YouTube's
rendered markup, merged with API-fetched playlists, tagged `source: "dom"` or
`source: "api"`, with deduplication by playlist ID plus a title-consumption
heuristic for the modern view-model rows that expose no ID at all. Hits on
`"dom"` docs re-ordered YouTube's own rows; hits on `"api"` docs rendered
synthetic rows.

All of that existed to paper over a decision we no longer make — reading
playlists out of YouTube's DOM. With both surfaces rendering their own list
from one snapshot, the dedup rules, the anonymous-title reconciliation, and
the `source` tag all became answers to a question nobody asks any more.

## BM25 options

```js
const BM25_SEARCH_OPTIONS = {
  prefix: true,
  fuzzy: 0.2,
  combineWith: "OR",
  weights: { fuzzy: 0.1, prefix: 0.75 },
};
```

- **`prefix: true`** — "fav" matches "Favorites"
- **`fuzzy: 0.2`** — tolerates ~20% character edit distance (typos)
- **`combineWith: "OR"`** — multi-word queries match rows that contain *any* term (with BM25 ranking surfacing rows that contain *all* terms higher)
- **Weights** — prefix matches score much higher than fuzzy matches, so "fav" prefers "Favorites" over a typo-corrected "fav" → "fab"

## Short-query fallback

If the query is under 2 characters, BM25 doesn't help — it has too little signal. `searchUnified` falls back to a substring scan over DOM rows only (content.js:455):

```js
if (!ctrl.bm25 || query.length < 2) {
  return ctrl.rows.map((row) => {
    const at = text.indexOf(query);
    return at < 0 ? null : { source: "dom", row, score: 1000 - at, ... };
  }).filter(Boolean);
}
```

Score is `1000 - position`, so earlier matches rank higher. API playlists are skipped here — short queries would match almost everything.

## Highlighting

`applyHighlight` wraps matched label text in `<mark>` tags. Before each search, `restoreHighlight` uses the `labelState` WeakMap to restore the original HTML. The stored text prevents restoration after YouTube recycles the label for another playlist.

The highlight respects shadow DOM: `getLabelElement` descends through single-child element chains to find the innermost text-bearing node (see content.js:611). YouTube's component tree varies, so we can't assume the title is at a fixed depth.

## The search flow per keystroke

1. `input` event fires on the search field.
2. `applyFilter(ctrl)` runs (content.js:1453).
3. If in the modal, re-collect rows — YouTube may have added more since the last refresh.
4. `searchUnified(ctrl, query)` returns `{ source, row | playlist, score, terms }[]`.
5. For `source: "dom"` matches, show the row (optionally reorder) and apply highlight.
6. For `source: "api"` matches, render up to 24 synthetic rows below the existing DOM rows.
7. Hide every DOM row that didn't match.

`ctrl.sortResults` is `true` in the modal (reorder rows by BM25 score) and `false` on the feed page (preserve YouTube's original ordering).

## Why no `<script>` for MiniSearch?

MiniSearch is loaded via `manifest.json`'s `content_scripts.js` array *before* `content.js`. That puts `MiniSearch` on the content script's isolated world globals. We check `typeof MiniSearch !== "function"` at the top of `createPlaylistIndex` and fall back to substring search if for some reason it didn't load.
