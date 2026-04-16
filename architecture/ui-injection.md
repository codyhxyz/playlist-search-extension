# UI Injection

How a content script running in the youtube.com isolated world puts a search bar inside YouTube's own UI — without breaking YouTube's components, across multiple layout variants, through shadow roots, in both light and dark mode.

## Two surfaces

The extension attaches to exactly two places:

| Surface | Where | Behavior |
|---|---|---|
| `"modal"` | The "Save to playlist" dialog | Fetches full library, reorders rows by BM25 score, renders synthetic rows for API-only hits, input is focused automatically |
| `"page"` | `/feed/playlists` or `/feed/library` | Filters existing rows only, preserves YouTube's ordering, shows a `"n of m"` match counter |

Both use the same `createInlineFilterUi(surface)` (content.js:975) builder. Styling differs (height, padding, sticky positioning) but the HTML shape is identical:

```html
<section class="ytpf-inline ytpf-inline-modal|ytpf-inline-page">
  <div class="ytpf-row">
    <div class="ytpf-input-wrap">
      <input class="ytpf-input" placeholder="Search playlists" />
      <button class="ytpf-clear">×</button>
    </div>
  </div>
  <span class="ytpf-meta" aria-live="polite"></span>  <!-- page only -->
</section>
```

## Host detection

YouTube ships many component variants depending on client version, A/B test bucket, and device. We match the playlist-specific renderers directly, then scope row discovery within that host:

```js
// Playlist-add renderers only. Do NOT add tp-yt-paper-dialog or
// yt-contextual-sheet-layout here — YouTube reuses those for many other
// dialogs (e.g. the upload Visibility step), and broadening this selector
// causes the filter bar to attach to unrelated surfaces.
const MODAL_HOST_SELECTOR =
  "ytd-add-to-playlist-renderer, yt-add-to-playlist-renderer";

// Scoped to inside a playlist host, so generic row components are safe here.
const MODAL_ROW_SELECTOR =
  "ytd-playlist-add-to-option-renderer, yt-playlist-add-to-option-renderer, " +
  "yt-checkbox-list-entry-renderer, yt-list-item-view-model, " +
  "yt-collection-item-view-model";

const PLAYLISTS_GRID_SELECTOR = "ytd-rich-grid-renderer";
const PLAYLISTS_FEED_PATH_RE = /^\/feed\/(playlists|library)\/?(\?.*)?$/;
```

If YouTube introduces a new playlist-add host variant, add its specific renderer tag here — not a generic container. `src/test-search.js` has a guard assertion that fails if the two generic components ever sneak back in.

## Shadow DOM traversal

YouTube uses web components heavily, and some of its layers render inside shadow roots. A plain `document.querySelectorAll` would miss those. `queryAllDeep(selector, root)` (content.js:331) walks the light DOM *and* every nested shadow root:

```js
function walk(nodeRoot) {
  nodeRoot.querySelectorAll(selector).forEach(addResult);
  const walker = document.createTreeWalker(nodeRoot, NodeFilter.SHOW_ELEMENT);
  let node = walker.currentNode;
  while (node) {
    if (node.shadowRoot) walk(node.shadowRoot);
    node = walker.nextNode();
  }
}
```

Every time we look for modal hosts or rows, we use `queryAllDeep`, not `document.querySelectorAll`.

## Scoped style injection

The extension's CSS lives in two places:

1. **`src/styles.css`** — CSS custom properties that bridge YouTube's theme tokens (`--yt-spec-*`) into our own (`--ytpf-*`). Loaded via `manifest.json`'s `content_scripts.css`, so it's injected once per page into the light DOM.
2. **`ALL_STYLES` string in content.js** — the actual layout rules (`.ytpf-inline`, `.ytpf-row`, synthetic row styling, etc.). Injected lazily by `ensureScopedStyles(rootNode)` (content.js:292) into whatever document *or shadow root* the UI is mounted in.

This dual approach matters because a `<style>` in the outer document doesn't apply inside a shadow root — we have to re-inject it into each shadow root that contains our UI. `ensureScopedStyles` uses a fixed element ID (`ytpf-inline-style`) to dedup, so it's safe to call on every refresh.

## Mount point selection

`findMountPoint(rows, host, surface)` (called from `attachHost`) picks where to insert the search bar. The logic prefers:

1. Just **after** the last element before the first row (so the bar sits above the list)
2. Failing that, **before** the first row
3. Failing that, append to the host as a last resort

There's also a safety net after insertion (content.js:1605): if the UI renders but has zero client rects — meaning something's hiding it — we reinsert it as the host's first child. YouTube's layout can surprise us.

## Preventing event bleed

The modal is a native YouTube component that handles clicks, focus, and keydown on its own elements. Our search input lives inside that host, so any `click` or `keydown` on our UI could bubble up and be misinterpreted (e.g., as a modal-close gesture or as typing into a playlist title field).

`guardModalUiInteractions(ui, "modal")` (content.js:1025) attaches `stopPropagation` handlers to our UI for `click`, `mousedown`, `mouseup`, `keydown`, `keyup`, `pointerdown`, `pointerup`, and `focusin`. The feed page doesn't need this — there's no modal to interrupt.

Additionally, focusing our input suppresses our own mutation observer for 300ms (content.js:1585) so YouTube's internal DOM churn doesn't cause a refresh that would steal focus.

## Synthetic rows

When a search matches API playlists not present in the DOM, we render "synthetic rows" below the real ones (content.js:1262). Each synthetic row has a title (with highlight marks) and a "+" button. Clicking it calls `innertubeSaveVideo(playlistId, videoId)` and flips the button to a checkmark on success.

Why synthetic? The YouTube modal's own rows are bound to YouTube's playlist data model. Fabricating one would break its internal state. Adding our own DOM elements next to them is safe — YouTube ignores them, and we clean them up on teardown (`clearSynthRows`).

Capped at `MODAL_API_RESULTS_LIMIT = 24` to keep the modal manageable.

## Theming

Colors come from YouTube's own CSS custom properties, read via fallbacks in `src/styles.css`:

```css
:root {
  --ytpf-bg:     var(--yt-spec-menu-background, #fff);
  --ytpf-text:   var(--yt-spec-text-primary,    #0f0f0f);
  --ytpf-muted:  var(--yt-spec-text-secondary,  #606060);
  --ytpf-accent: var(--yt-spec-call-to-action,  #065fd4);
  --ytpf-border: var(--yt-spec-10-percent-layer, rgba(0,0,0,.1));
}
```

Dark mode "just works" because YouTube sets `--yt-spec-*` tokens to dark values when `html[dark]` is active. We never check a theme boolean; we just consume the current tokens.

## Highlight marks

Matched terms are wrapped in `<mark>` with our own styling so they don't look like browser-default yellow. The original HTML is cached in `labelHtmlCache` (a WeakMap keyed by the label element) — `restoreHighlight` restores it before each new search so marks don't nest.
