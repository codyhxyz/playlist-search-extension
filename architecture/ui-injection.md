# UI Injection

How a content script running in the youtube.com isolated world adds search to
YouTube — without parsing YouTube's markup, in both light and dark mode, and
without breaking when they rebuild their components (which they do, often).

## The rule

**Own the surface; don't read theirs.** YouTube's rendered DOM is not an API.
Every regression this extension has shipped came from treating it like one:
1.6.6–1.6.18 on the Save modal, and 1.6.6 / 1.6.7 / 1.6.8 / 1.6.10 / 1.6.15 /
1.6.17 on `/feed/playlists`. Both surfaces have since been rebuilt to render
from the InnerTube library snapshot we already fetch.

What survives is a small, enumerated, tested set of attachment points.

## Two surfaces

| Surface | Attachment to YouTube | What we render |
|---|---|---|
| Save sheet | One intercepted click: the action-bar button whose `aria-label` starts with "Save", on `ytd-watch-flexy` / `ytd-shorts`. No selector, no modal DOM. | Our own shadow-DOM sheet at `#ytpf-save-sheet-host`: search input, playlist rows, add/remove toggles via `browse/edit_playlist`. |
| `/feed/playlists` | Exactly two DOM anchors (below). | A search chip in YouTube's chip bar (light DOM, so it looks native) + a shadow-DOM result list at `#ytpf-feed-results-host`. |

Neither surface reads a playlist title, ID, thumbnail, or count out of
YouTube's DOM. Both render from `loadAllPlaylists()`.

## The two anchors

`src/lib/selectors.js` holds the complete YouTube DOM coupling surface for the
feed page. It is exactly two entries, and
`tests/selectors-anchor-budget.test.mjs` fails the build if it grows:

```js
FEED_SEARCH_MOUNT_SELECTOR = "chip-bar-view-model [role='tablist']";
FEED_GRID_SELECTOR         = "ytd-rich-grid-renderer > #contents";
```

```
ytd-rich-grid-renderer
  #header
    chip-bar-view-model
      [role='tablist']        ← ANCHOR 1: our search chip is appended here
        …native chips… + our chip
  #contents                   ← ANCHOR 2: hidden while our results show
  #ytpf-feed-results-host     ← our shadow-DOM result list (inserted after it)
```

Why these two, and why in this form:

- **Accessibility signals beat tag names; tag names beat generated classes.**
  `[role='tablist']` is what the chip bar *is*; `.ytChipBarViewModelChipBarScrollContainer`
  is what their build emitted this quarter. The `chip-bar-view-model` tag
  scopes it so we can't wander into another tablist on the page — the mount
  test asserts exactly that against a fixture containing decoy tablists.
- **The grid anchor uses a direct-child combinator on purpose.**
  `ytd-rich-grid-renderer #contents` (descendant) also matches the `#contents`
  inside every `ytd-rich-grid-row`; hiding the wrong one would be silent.
- **The results panel needs no anchor of its own.** It is inserted as
  `grid.after(panel)`, derived from anchor 2 by DOM relationship.

## No fallback mounts

If an anchor doesn't resolve, we render **nothing** and record a diagnostic.

Through 1.6.18 the feed bar fell back to a full-width `.ytpf-inline-page`
mount when no chip bar was found. That fallback is deleted. A UI that appears
somewhere unexpected is worse than a UI that doesn't appear: the user can't
distinguish it from a YouTube bug, so it never gets reported, and the "safe"
fallback is the thing that looks broken.

`resolveFeedAnchor(id)` records:

- `feed_anchor_unresolved:<id>` — nothing visible matched. Includes the
  selector, its purpose, and how many nodes matched but were invisible.
- `feed_anchor_ambiguous:<id>` — more than one visible match, meaning our
  scoping assumption broke and "take the first" would be a coin flip.

`refresh()` additionally schedules `feed_surface_missing` with a full probe of
both anchors after `TIMINGS.MOUNT_CHECK_DELAY_MS`, so a slow second paint
isn't reported as breakage. `window.__ytpfDiag()` returns the same probe on
demand — anchor-by-anchor match/visible counts, what we have mounted, whether
the grid is currently hidden, and the library status.

## Hiding their grid reversibly

The only thing we still do to a YouTube node is toggle `display` on anchor 2:

```js
feed.gridDisplay   = grid.style.display;           // "" when unset
feed.gridStyleAttr = grid.getAttribute("style");   // null when absent
grid.style.setProperty("display", "none", "important");
```

On restore we remove the property, reapply the captured value, and drop an
empty `style=""` attribute if there wasn't one before. "Restore" means the
attribute is byte-identical, not merely equivalent — the e2e spec and the
Chromium fixture test both compare `getAttribute("style")` before and after.

We reapply rather than overwrite the whole attribute so that anything YouTube
wrote while we were hidden survives.

Their grid is hidden **only once we have results to show in its place**: a
failed or in-flight library fetch leaves their page exactly as it was, with
our status line below it.

## Shadow DOM traversal

YouTube uses web components heavily, and some layers render inside shadow
roots. `queryAllDeep(selector, root)` walks the light DOM *and* every nested
shadow root. Anchor resolution tries a plain `document.querySelectorAll` first
and only falls back to the deep walk when that comes up empty — a full
TreeWalker sweep twice per reconcile is not free on a page with thousands of
nodes, and a future YouTube move into a shadow root should degrade to
"slower", not "broken".

## Styling

Two stylesheets, for two different jobs:

1. **`src/styles.css`** (+ the identical `CHIP_STYLES` string in content.js,
   injected by `ensureScopedStyles`) — styles our search chip only. The chip
   lives in YouTube's light DOM because it has to look like a native
   `chip-view-model`: 32px tall, 8px radius, `--yt-spec-badge-chip-background`
   fill. `color-scheme: inherit` carries YouTube's scheme into the `<input>`
   so the UA doesn't paint a white field on a dark page (1.6.14).
2. **`FEED_PANEL_STYLES`** — lives inside the results panel's shadow root, so
   YouTube's page styles can't reach in and ours can't leak out.

Both read YouTube's `--yt-spec-*` custom properties. Those inherit *through*
the shadow boundary, so light/dark tracks the page for free; the
`[data-ytpf-dark]` attribute on the panel host only selects the right
*fallback* values for when those tokens are missing.

Notably absent: `.ytpf-hidden`, `.ytpf-page-filtering`,
`.ytpf-page-filtering-rows`. We no longer hide rows or override YouTube's grid
layout, so the shape-gated reflow hack from 1.6.10/1.6.17 has nothing left to
gate.

## Highlight marks

Matched terms are wrapped in `<mark class="ytpf-mark">` by
`buildHighlightFragment(text, ranges)`, which builds a `DocumentFragment` of
text nodes and marks — no `innerHTML`, so no escaping to get wrong.

This used to be the risky part: we rewrote the innards of YouTube's own label
elements and had to remember the original HTML per node (`labelState`),
fingerprint recycled rows, and restore on every filter pass. Now we highlight
titles in cards we created a moment ago, so there is nothing to restore and
nothing to recycle.

## Accessibility notes

- The chip carries `role="search"`. It sits inside a `[role='tablist']` and is
  emphatically not a tab; declaring a landmark keeps assistive tech from
  announcing it as one.
- The chip's row is a `<label>` wrapping the input, so clicking the icon or
  padding proxies focus via native label semantics — no `for=`, no handler.
- The result count is an `aria-live="polite"` region; the loading/error line
  is `role="status"`.
- Result cards are real `<a href="/playlist?list=…">` links inside a `<ul>`,
  so they open in a new tab, are keyboard reachable, and expose a URL on
  hover.
