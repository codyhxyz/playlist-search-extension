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
      console.warn('[pls][hook] could not read a watched request body', e.message);
    }
  }

  // --- fetch. YouTube calls fetch(new Request(...)) today; the other forms are here
  // so a client refactor degrades to "still works" rather than "silently stops".
  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : input && input.url;
      if (typeof url === 'string' && WATCHED.test(url)) {
        const src = init && init.body;
        if (src == null && input && typeof input.clone === 'function') {
          // Request object: clone tees the body stream, leaving the original intact.
          const c = input.clone();
          readAndReport(url, () => c.arrayBuffer());
        } else if (typeof src === 'string') {
          readAndReport(url, () => new TextEncoder().encode(src).buffer);
        } else if (src instanceof ArrayBuffer) {
          readAndReport(url, () => src);
        } else if (ArrayBuffer.isView(src)) {
          readAndReport(url, () => src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength));
        } else if (typeof Blob !== 'undefined' && src instanceof Blob) {
          readAndReport(url, () => src.arrayBuffer());
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
      console.warn('[pls][hook] observer threw, passing the request through', e.message);
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
        const url = this.__plsUrl;
        if (typeof body === 'string') readAndReport(url, () => new TextEncoder().encode(body).buffer);
        else if (body instanceof ArrayBuffer) readAndReport(url, () => body);
        else if (ArrayBuffer.isView(body))
          readAndReport(url, () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
        else if (typeof Blob !== 'undefined' && body instanceof Blob) readAndReport(url, () => body.arrayBuffer());
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
