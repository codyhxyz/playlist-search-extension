# Search

All search logic lives in `src/content.js`. The extension uses [MiniSearch](https://github.com/lucaong/minisearch) (vendored in `src/vendor/minisearch.js`) for BM25 ranking.

## The unified index

The central idea: **one search index covers both DOM playlists and API-fetched playlists.** A user typing in the modal should get the best-ranked result across their full library, not a split ranking between "what YouTube rendered" and "what we fetched."

`createUnifiedIndex(rows, apiPlaylists)` (content.js:403) builds it:

```
docs = [
  ...rows.map(i => ({ id: "dom:${i}", text, source: "dom", ref: i })),
  ...apiPlaylists
       .filter(pl => !domIds.has(pl.id))
       .filter(pl => !consumeAnonymousNativeTitle(pl.title))
       .map(pl => ({ id: "api:${pl.id}", text, source: "api", ref: pl.id }))
]
```

Each doc is tagged with its source (`"dom"` or `"api"`) and a `ref` back to the original row element or playlist ID. When a search result comes back, `searchUnified` (content.js:454) uses that ref to either:

- `source === "dom"` — show the existing DOM row (and reorder it in the modal)
- `source === "api"` — render a **synthetic row** the user can click to save the video to a playlist YouTube didn't load

## Deduplication

Rows with playlist IDs deduplicate by ID. Distinct IDs remain searchable when titles match.

Modern view-model rows do not expose IDs. Each ID-less native title consumes one equal API title in stable order. This prevents a native row from also appearing as a blind synthetic add action. Extra equal-title API playlists remain searchable.

`src/test-search.cjs` covers both rules.

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

MiniSearch is loaded via `manifest.json`'s `content_scripts.js` array *before* `content.js`. That puts `MiniSearch` on the content script's isolated world globals. We check `typeof MiniSearch !== "function"` at the top of `createUnifiedIndex` and fall back to substring search if for some reason it didn't load.
