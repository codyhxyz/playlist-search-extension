// L1 — intent, part 1 of 2: the observer. Runs in the MAIN world at document_start.
//
// WHY THIS FILE EXISTS (measured live 2026-08-28, client 2.20260828.01.00):
// `chrome.webRequest.onBeforeRequest` **cannot read the body of these requests**.
// YouTube issues them as `fetch(new Request(url, {body: <gzip stream>}))`, and Chrome
// hands a streamed upload to webRequest as `requestBody: {error: "Unknown error."}` —
// no `raw`, no bytes, nothing. Verified on every save surface. Sibling `log_event`
// calls (plain string bodies) *do* arrive intact, which is what made this look like it
// worked: the endpoint we actually need is exactly the one we cannot read.
//
// ARCHITECTURE.md §7 named this as unknown #4 and pre-authorised the answer:
// "If not, MAIN-world `fetch` patching is the fallback." This is that fallback.
//
// It still honours the cardinal rule — **zero DOM**. No selectors, no MutationObserver,
// no reading YouTube's markup, no node written into their tree. We observe the host
// app's own network calls, which is Sidecar rule #1 ("intent from the network"), just
// from the only vantage point where the bytes are legible.
//
// Two properties worth stating because they are load-bearing:
//  1. We NEVER consume YouTube's request body — always `.clone()`, always pass the
//     original through untouched. A bug here would break youtube.com, so it is written
//     to fail silently and call through no matter what.
//  2. Our own InnerTube calls (innertube.js) run in the ISOLATED world and are
//     therefore invisible here. That is what makes this hook immune to the
//     self-retrigger loop that the webRequest path has to defend against.

(() => {
  if (window.__plsIntentHook) return;

  // `e.message` on a non-object throw (`throw null`, or a cross-realm value)
  // raises a TypeError *inside the catch* — which would propagate straight out
  // of our patched window.fetch and break youtube.com's own request. This file
  // promises it can never do that; the promise needs this to be true.
  const why = (e) => {
    try { return (e && e.message) || String(e); } catch { return 'unknown'; }
  };
  window.__plsIntentHook = true;

  // Path-anchored, not substring-anchored: `get_panel` is a generic endpoint and we
  // must not confuse it with e.g. `share/get_share_panel`.
  const WATCHED = /\/youtubei\/v1\/(?:get_panel|playlist\/get_add_to_playlist)(?:[?#]|$)/;

  let warnedUnreadable = false;

  function post(url, body) {
    // Forward only the tiny routing fields. `context` (visitor id, client fingerprint,
    // delegation) never leaves the page — there is no reason for it to cross worlds.
    const slim = {};
    for (const k of ['panelId', 'params', 'continuation', 'videoId']) {
      if (typeof body[k] === 'string') slim[k] = body[k];
    }
    if (Array.isArray(body.videoIds)) {
      slim.videoIds = body.videoIds.filter((v) => typeof v === 'string').slice(0, 4);
    }
    let path = url;
    try {
      path = new URL(url, location.origin).pathname;
    } catch {}
    window.postMessage({ __pls: 'panel-request', path, body: slim }, location.origin);
  }

  async function decode(buf) {
    const u8 = new Uint8Array(buf);
    // YouTube gzips InnerTube request bodies.
    if (u8[0] === 0x1f && u8[1] === 0x8b) {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Response(stream).text();
    }
    return new TextDecoder().decode(u8);
  }

  async function readAndReport(url, getBytes) {
    try {
      const buf = await getBytes();
      if (!buf) return;
      const body = JSON.parse(await decode(buf));
      if (body && typeof body === 'object') post(url, body);
    } catch (e) {
      console.warn('[pls][hook] could not read a watched request body', why(e));
    }
  }

  // One body-shape dispatch for both transports: returns a thunk that yields the bytes
  // WITHOUT consuming `src` (none of these shapes is single-use, unlike a stream), or
  // null for a shape we cannot read safely (streams, FormData, URLSearchParams, null).
  // Only called inside the callers' try blocks, so a throw here still cannot escape.
  function bytesOf(src) {
    if (typeof src === 'string') return () => new TextEncoder().encode(src).buffer;
    if (src instanceof ArrayBuffer) return () => src;
    if (ArrayBuffer.isView(src)) return () => src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
    if (typeof Blob !== 'undefined' && src instanceof Blob) return () => src.arrayBuffer();
    return null;
  }

  // --- fetch. YouTube calls fetch(new Request(...)) today; the other forms are here
  // so a client refactor degrades to "still works" rather than "silently stops".
  const origFetch = window.fetch;
  // `any` on purpose: we accept every overload fetch does (string | URL | Request)
  // and duck-type our way through, because narrowing here would mean *rejecting*
  // a shape YouTube might legitimately use and going silently blind on it.
  /** @param {any} input @param {any} [init] */
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (typeof url === 'string' && WATCHED.test(url)) {
        const src = init && init.body;
        const getBytes = bytesOf(src);
        if (src == null && input && typeof input.clone === 'function') {
          // Request object: clone tees the body stream, leaving the original intact.
          const c = input.clone();
          readAndReport(url, () => c.arrayBuffer());
        } else if (getBytes) {
          readAndReport(url, getBytes);
        } else if (src && !warnedUnreadable) {
          warnedUnreadable = true;
          console.warn(
            '[pls][hook] watched request carried a body shape we cannot read without ' +
              'consuming it — intent detection is DOWN for this surface',
            Object.prototype.toString.call(src)
          );
        }
      }
    } catch (e) {
      // Never let our observation break the host app.
      console.warn('[pls][hook] observer threw, passing the request through', why(e));
    }
    return origFetch.apply(this, arguments);
  };

  // --- XHR. Not used for these endpoints today; cheap insurance if that changes.
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__plsUrl = url;
    return xhrOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (typeof this.__plsUrl === 'string' && WATCHED.test(this.__plsUrl)) {
        // Unreadable shapes are ignored silently here — XHR is insurance, not a live path.
        const getBytes = bytesOf(body);
        if (getBytes) readAndReport(this.__plsUrl, getBytes);
      }
    } catch {}
    return xhrSend.apply(this, arguments);
  };

  // Handshake. The isolated-world half loads later (document_idle) so it cannot see
  // this file's globals; it pings, we answer. If it never gets an answer it says so
  // out loud, because a silent hook means saves silently do nothing.
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__pls === 'hook-ping') {
      window.postMessage({ __pls: 'hook-ready' }, location.origin);
    }
  });

  console.log('[pls][hook] observing YouTube InnerTube panel requests (MAIN world)');
})();
