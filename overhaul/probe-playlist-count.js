// PROBE: does FEplaylist_aggregation paginate past the ~200 cap?
//
// HOW TO RUN:
//   1. Open https://www.youtube.com in Chrome, signed in.
//   2. Open DevTools console (Cmd+Opt+J).
//   3. Paste this whole file, hit enter.
//
// WHAT TO LOOK FOR: the final "TOTAL UNIQUE PLAYLISTS" number.
//   - If it's > 200 and matches roughly what you have  -> thesis holds, build it.
//   - If it stops at ~200                              -> wrong endpoint, need a different source.
//   - If it errors                                     -> paste me `window.__probe` and the error.

(async () => {
  const origin = 'https://www.youtube.com';

  const sapisid =
    document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ??
    document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
  if (!sapisid) {
    console.error('No SAPISID cookie. Are you signed in on www.youtube.com?');
    return;
  }

  const ts = Math.floor(Date.now() / 1000);
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(`${ts} ${sapisid} ${origin}`)
  );
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const authorization = `SAPISIDHASH ${ts}_${hex}`;

  const context = window.ytcfg?.get?.('INNERTUBE_CONTEXT');
  if (!context) {
    console.error('No ytcfg INNERTUBE_CONTEXT. Run this on a normal youtube.com page, not an iframe.');
    return;
  }

  const post = async (body) => {
    const res = await fetch(`${origin}/youtubei/v1/browse?prettyPrint=false`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authorization,
        'X-Origin': origin,
      },
      body: JSON.stringify({ context, ...body }),
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  };

  // Response shape is unknown / mid-migration (gridPlaylistRenderer vs lockupViewModel),
  // so don't assume a path — just deep-scan for the keys we care about.
  const collect = (node, key, out) => {
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) {
      for (const v of node) collect(v, key, out);
      return out;
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === key) out.push(v);
      collect(v, key, out);
    }
    return out;
  };

  const idsFrom = (data) => {
    const found = new Set();
    for (const k of ['playlistId', 'contentId']) {
      for (const v of collect(data, k, [])) {
        // playlist ids: PL…, LL, WL, FL…, and the VL-prefixed browse form
        if (typeof v === 'string' && /^(VL)?(PL|LL|WL|FL|RD|UU|OL)/.test(v)) {
          found.add(v.replace(/^VL/, ''));
        }
      }
    }
    return found;
  };

  const tokenFrom = (data) => {
    const cmds = collect(data, 'continuationCommand', []);
    for (const c of cmds) if (c?.token) return c.token;
    return null;
  };

  const all = new Set();
  let page = 0;
  let data = await post({ browseId: 'FEplaylist_aggregation' });
  window.__probe = data; // first response kept for inspection if anything looks off

  while (true) {
    page++;
    const before = all.size;
    for (const id of idsFrom(data)) all.add(id);
    const token = tokenFrom(data);
    console.log(
      `page ${page}: +${all.size - before} new, running total ${all.size}, ` +
        `continuation ${token ? 'yes' : 'NO'}`
    );

    if (!token) break;
    if (page >= 40) {
      console.warn('stopping at 40 pages as a safety bound');
      break;
    }
    if (all.size === before && page > 1) {
      console.warn('a page added nothing new — stopping');
      break;
    }
    data = await post({ continuation: token });
    await new Promise((r) => setTimeout(r, 250)); // be polite
  }

  console.log('%cTOTAL UNIQUE PLAYLISTS: ' + all.size, 'font-size:16px;font-weight:bold');
  console.log('sample:', [...all].slice(0, 10));
  console.log('(first raw response is in window.__probe if you need to inspect it)');
})();
