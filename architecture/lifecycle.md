# Lifecycle

How the extension starts up, stays in sync with YouTube's constantly-mutating DOM, and cleans up after itself.

## Startup

The content script is registered dynamically by the service worker (`background.js`) with `runAt: "document_start"`, so it's injected before YouTube's own scripts run on any youtube.com page where the user has granted the optional host permission. `content.js` is an IIFE that ends with a `start()` call.

```js
function start() {
  if (!document.body) {
    requestAnimationFrame(start);
    return;
  }
  _bodyObserver = new MutationObserver(...);
  _bodyObserver.observe(document.body, { childList: true, subtree: true });
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
| `MutationObserver` on `document.body` | The modal opens, closes, or changes. New rows arrive. | `scheduleRefresh` (debounced 120ms) |
| `yt-navigate-finish` event | User navigated between pages in YouTube's SPA. The feed page may have appeared or disappeared. | `refresh()` after 250ms |
| `yt-page-data-updated` event | YouTube reloaded page data (e.g., after filter changes on the feed page). | `scheduleRefresh` |

Why both an observer and YouTube's own events? The observer is the source of truth for "something in the DOM changed" — it always fires. The SPA events are an early signal we can use for *intent*: `yt-navigate-finish` tells us the user changed pages, which lets us wait 250ms for YouTube's rendering to settle before re-checking. Using both ensures we don't miss modal openings that happen without any navigation.

## Filtering the mutation firehose

`shouldRefreshFromMutations(mutations)` gates `scheduleRefresh` so we don't re-run on every typing event or video player tick. It returns true only if a mutation looks like it could involve a modal host, a playlist row, or the feed grid. This combined with the 120ms debounce keeps CPU usage negligible.

Focusing our own search input also **suppresses** mutations for 300ms (`suppressMutations(300)` called from the `focus` listener in `attachHost`, content.js:1585). This prevents the observer from reacting to our own UI insertion and stealing focus back.

## The `refresh()` cycle

`refresh()` (content.js:1668) is the reconciliation pass:

```js
function refresh() {
  const activeHosts = new Set();

  // 1. Any visible modals?
  queryAllDeep(MODAL_HOST_SELECTOR).filter(isVisible).forEach((host) => {
    const rows = collectRows(host);
    if (!rows.length) return;
    activeHosts.add(host);
    upsertHost(host, rows, "modal");
  });

  // 2. Feed page surface?
  const pageSurface = collectFeedPageSurface();
  if (pageSurface) {
    activeHosts.add(pageSurface.host);
    upsertHost(pageSurface.host, pageSurface.rows, "page");
  }

  // 3. Tear down any hosts we were tracking that are no longer active
  for (const host of [...controllerHosts]) {
    if (!activeHosts.has(host) || !host.isConnected) {
      const ctrl = controllers.get(host);
      if (ctrl && ctrl.root.contains(document.activeElement)) continue;  // user is typing — don't kill it
      teardownHost(host);
    }
  }
}
```

Three phases: find modals, find the feed page, and tear down whatever we had before that's no longer there. The focus check in phase 3 prevents a flaky mutation from destroying the UI mid-keystroke.

## `upsertHost` — idempotent attach

`upsertHost(host, rows, surface)` (content.js:1624) decides whether to:

- **Attach** fresh — no existing controller for this host
- **Re-attach** — existing controller, but its UI got detached from the DOM (or the surface changed)
- **Skip** — rows haven't changed
- **Update** — rows changed; keep the controller but rebuild the index

This means a refresh that fires many times in a row is cheap: once the UI is mounted and rows are stable, `upsertHost` does almost nothing.

When rows change, unhidden rows get re-shown and un-highlighted so YouTube sees its DOM in the expected state before we re-apply the filter.

## Per-host controller

Each attached surface gets a `ctrl` object (content.js:1562) held in a `WeakMap<host, ctrl>`:

```js
{
  host,                 // The modal or page container
  surface,              // "modal" | "page"
  rows,                 // Current row elements (Array)
  bm25,                 // MiniSearch index (rebuilt when rows or API data change)
  root, input, clear, meta,  // UI elements
  parent,               // Parent of rows, used for row reordering
  sortResults,          // true in modal (reorder), false on page
  synthRows,            // Synthetic API-row elements
  apiToken,             // Counter used to cancel stale API requests
  scrollContainer,      // Modal only — the scrollable ancestor, used to ensure "expand" fits
}
```

A WeakMap was chosen so detached hosts get garbage collected automatically. We also maintain a parallel `controllerHosts: Set<host>` for iteration (WeakMaps aren't iterable). `teardownHost` keeps both in sync.

## Modal bootstrapping

When a modal surface is attached:

1. `attachHost` builds the UI with *just* DOM rows in the index (no API data yet).
2. 160ms later, `setTimeout(() => bootstrapModalApi(ctrl), 160)` runs.
3. `bootstrapModalApi` (content.js:1366) calls `loadAllPlaylists()` — returning the session cache if fresh, or fetching via InnerTube.
4. When playlists arrive, it rebuilds the BM25 index with the merged set and re-runs `applyFilter(ctrl)`.

The user can start typing immediately against the DOM-only index. When the API data lands, results seamlessly expand to include the full library.

The 160ms delay gives the modal time to finish its own opening animation. Focusing our input immediately on open would fight YouTube's own focus management.

## Teardown

`teardownHost(host)` (content.js:1418) runs when:

- The modal closes (observer sees the host removed)
- The user navigates away from the feed page
- `refresh()` decides the host is no longer active

It:

1. Increments `apiToken` — any pending API response for this controller will be discarded when it arrives.
2. Removes synthetic rows.
3. Un-hides every row it had hidden.
4. Restores any highlights it had applied (from `labelHtmlCache`).
5. Removes the `MODAL_EXPANDED_CLASS` if this was a modal.
6. Removes its UI from the DOM.
7. Deletes the controller entry.
8. If no controllers remain, disconnects the mutation observer and removes the SPA event listeners — the extension goes fully idle until navigation.

Step 1 is important: if a user opens a modal, starts a fetch, and closes it before the fetch completes, the response should land in a void, not try to update a dead controller.

## Putting it together

```
document_start
  ↓
start() → MutationObserver watches document.body
  ↓
[user opens Save modal]
  ↓
observer fires → scheduleRefresh (120ms debounce)
  ↓
refresh() → modal host detected → upsertHost() → attachHost()
  ↓
[UI visible, DOM-only index]
  ↓
setTimeout 160ms → bootstrapModalApi() → innertubeLoadPlaylists()
  ↓
[index rebuilt with API data, applyFilter re-runs]
  ↓
[user types → input event → applyFilter → searchUnified → show/hide/reorder]
  ↓
[user closes modal]
  ↓
observer fires → refresh() → host gone → teardownHost()
  ↓
[controllers empty → observer and listeners disconnected]
  ↓
[idle until next mutation or navigation]
```
