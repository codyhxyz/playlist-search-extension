# Lifecycle

How the extension starts up, stays in sync with YouTube's constantly-mutating DOM, and cleans up after itself.

> **Doc status (as of v1.7):** the *reconciler* half of this document (startup,
> the shared MutationObserver, the debounce/suppress rules, `enqueueReconcile`)
> is current. The *controller* half is not: the `Ctrl` record, `attachHost` /
> `upsertHost` / `teardownHost`, modal sessions, row fingerprints, and
> synthetic rows all belonged to the DOM-injection architecture that b9b3ed9
> (save sheet) and the `/feed/playlists` rebuild replaced. There is now one
> singleton `feed` state object plus a standalone save sheet; see
> `ui-injection.md` and the "Owned" sections of `src/content.js`.
> Mutation relevance is also much narrower: a mutation matters only if it
> could have created or destroyed one of the two enumerated feed anchors.
> Churn *inside* YouTube's grid is no longer our problem, because we no longer
> read it.

## Startup

The content script is registered dynamically by the service worker (`background.js`) with `runAt: "document_start"`, so it's injected before YouTube's own scripts run on any youtube.com page where the user has granted the optional host permission. `content.js` is an IIFE that ends with a `start()` call.

```js
function start() {
  if (!document.body) {
    requestAnimationFrame(start);
    return;
  }
  _bodyObserver = new MutationObserver(...);
  observeMutationRoot(document.body);  // child/text/lifecycle attributes
  refresh();
  window.addEventListener("yt-navigate-finish", _onNavigateFinish);
  window.addEventListener("yt-page-data-updated", _onPageDataUpdated);
}
start();  // content.js:1732
```

At `document_start`, `document.body` doesn't exist yet, so `start()` retries on the next animation frame. Once the body is there, we set up observation and do an initial `refresh()` — which will usually find nothing, because YouTube hasn't rendered its components either. That's fine; the first real refresh comes when YouTube adds its DOM and the mutation observer fires.

## Triggers for a refresh

There are three sources of "something changed, look again":

| Signal | Why | Handler |
|---|---|---|
| Shared `MutationObserver` on `document.body` and discovered open shadow roots | The modal opens, closes, changes visibility, or replaces/recycles rows. | `enqueueReconcile` (debounced 120ms) |
| `yt-navigate-finish` event | User navigated between pages in YouTube's SPA. The feed page may have appeared or disappeared. | `refresh()` after 250ms |
| `yt-page-data-updated` event | YouTube reloaded page data (e.g., after filter changes on the feed page). | `scheduleRefresh` |

Why both an observer and YouTube's own events? The observer is the source of truth for "something in the DOM changed" — it always fires. The SPA events are an early signal we can use for *intent*: `yt-navigate-finish` tells us the user changed pages, which lets us wait 250ms for YouTube's rendering to settle before re-checking. Using both ensures we don't miss modal openings that happen without any navigation.

## Filtering the mutation firehose

`shouldRefreshFromMutations(mutations)` gates `scheduleRefresh` so we don't re-run on every typing event or video player tick. It returns true only if a mutation looks like it could involve a modal host, a playlist row, or the feed grid. This combined with the 120ms debounce keeps CPU usage negligible.

Focusing our own search input delays mutation reconciliation for 300ms. Mutations are never discarded: one trailing reconciliation runs when the delay expires. This prevents our own paint from stealing focus without losing YouTube lifecycle changes.

## The `refresh()` cycle

`refresh()` is the reconciliation pass. It first tears down modal sessions invalidated by close/open attribute transitions. It then discovers visible modal candidates and assigns each row to its nearest composed modal host, preventing nested `tp-yt-paper-dialog` and `yt-contextual-sheet-layout` elements from receiving duplicate controllers. Finally, it reconciles the feed page and tears down disconnected, hidden, repurposed, or replaced hosts.

A modal teardown is the session reset. Reopening the same DOM element creates a fresh controller, empty query, fresh row fingerprints, and a new API token.

## `upsertHost` — idempotent attach

`upsertHost(host, rows, surface)` (content.js:1624) decides whether to:

- **Attach** fresh — no existing controller for this host
- **Re-attach** — existing controller, but its UI got detached from the DOM (or the surface changed)
- **Skip** — rows haven't changed
- **Update** — rows changed; keep the controller but rebuild the index

This means a refresh that fires many times in a row is cheap: once the UI is mounted and rows are stable, `upsertHost` does almost nothing.

Row equality includes element identity and a content fingerprint. Equal-cardinality replacement and same-element title/ID recycling therefore rebuild the index instead of reusing stale row data.

## Per-host controller

Each attached surface gets a `ctrl` object held in the `controllers` Map:

```js
{
  host,                 // The modal or page container
  surface,              // "modal" | "page"
  rows,                 // Current row elements (Array)
  bm25,                 // MiniSearch index (rebuilt when rows or API data change)
  apiPlaylists, apiAccountKey, apiPendingAccountKey, // account-scoped API snapshot
  targetVideoId, rowFingerprints, // modal identity and recycled-row detection
  root, input, clear, meta,  // UI elements
  parent,               // Parent of rows, used for row reordering
  sortResults,          // true in modal (reorder), false on page
  synthRows,            // Synthetic API-row elements
  apiToken,             // Counter used to cancel stale API requests
  scrollContainer,      // Modal only — the scrollable ancestor, used to ensure "expand" fits
}
```

Controllers live in one iterable `Map<Element, Ctrl>`. `teardownHost` is the only disposal path; there is no parallel host set to drift out of sync.

## Modal bootstrapping

When a modal surface is attached:

1. `attachHost` builds the UI with *just* DOM rows in the index (no API data yet).
2. `bootstrapModalApi(ctrl)` snapshots the active account/channel identity and calls `loadAllPlaylists(session)`.
3. The load joins only an in-flight request for that same account identity.
4. When playlists arrive, the response is applied only if the controller, request token, and current account still match. It then rebuilds the BM25 index and re-runs `applyFilter(ctrl)`.

The user can start typing immediately against the DOM-only index. When the API data lands, results seamlessly expand to include the full library.

Autofocus waits two animation frames, then verifies that the same visible controller still owns the connected input before focusing it.

## Teardown

`teardownHost(host)` (content.js:1418) runs when:

- The modal closes (observer sees the host removed)
- The user navigates away from the feed page
- `refresh()` decides the host is no longer active

It:

1. Increments `apiToken` — any pending API response for this controller will be discarded when it arrives.
2. Removes synthetic rows.
3. Un-hides every row it had hidden.
4. Restores highlights from `labelState` only when the label still belongs to the same playlist.
5. Removes the `MODAL_EXPANDED_CLASS` if this was a modal.
6. Removes its UI from the DOM.
7. Deletes the controller entry.
8. Leaves global observers and SPA listeners active for the lifetime of the content script. Disconnecting them after the first close caused later Save clicks in the same tab to be missed.

Step 1 is important: if a user opens a modal, starts a fetch, and closes it before the fetch completes, the response should land in a void, not try to update a dead controller.

## Putting it together

```
document_start
  ↓
start() → MutationObserver watches document.body + discovered shadow roots
  ↓
[user opens Save modal]
  ↓
observer fires → enqueueReconcile (120ms debounce)
  ↓
refresh() → modal host detected → upsertHost() → attachHost()
  ↓
[UI visible, DOM-only index]
  ↓
bootstrapModalApi() → account-scoped innertubeLoadPlaylists()
  ↓
[index rebuilt with API data, applyFilter re-runs]
  ↓
[user types → input event → applyFilter → searchUnified → show/hide/reorder]
  ↓
[user closes modal]
  ↓
observer fires → refresh() → host gone → teardownHost()
  ↓
[controller removed; global observer remains active]
  ↓
[next Save open is discovered, even in the same tab]
```
