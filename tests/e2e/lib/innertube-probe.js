// Contract probe for the two InnerTube endpoints the extension depends on.
//
// Runs in the PAGE world on a signed-in youtube.com tab, so it has ytcfg and the
// session cookies directly. It deliberately does NOT call our code: it rebuilds the
// requests from YouTube's own config, so a green run means *YouTube still behaves the
// way the extension assumes*, independent of whether our client happens to agree.
// That is the difference between finding out before users do and finding out from a
// one-star review. (ARCHITECTURE.md §5, "contracts are probes you can run on a
// schedule".)
//
// READ-ONLY. Nothing here adds to or removes from a playlist.
//
// Returns a flat object of findings; the spec decides which are fatal. Every field is
// reported even when it fails, because "membership returned 1 row" is a much more
// useful failure than "membership assertion false".

(async () => {
  const ORIGIN = "https://www.youtube.com";
  // "Me at the zoo" — the oldest video on YouTube, and the closest thing the site
  // has to a permanent fixture.
  const VIDEO_ID = "jNQXAC9IVRw";

  const out = {
    ok: false,
    stage: "start",
    delegationPresent: null,
    listStatus: null,
    listCount: null,
    listPages: null,
    membershipStatus: null,
    membershipRows: null,
    membershipWithState: null,
    membershipCappedAt200: null,
    singularKeyRejected: null,
    undelegatedListCount: null,
    delegationMatters: null,
    errors: [],
  };

  function note(e, where) {
    out.errors.push(`${where}: ${(e && e.message) || String(e)}`);
  }

  try {
    const cfg = typeof ytcfg !== "undefined" ? ytcfg : window.ytcfg;
    const baseContext = JSON.parse(JSON.stringify(cfg.get("INNERTUBE_CONTEXT")));
    const apiKey = cfg.get("INNERTUBE_API_KEY") || null;
    const delegated = cfg.get("DELEGATED_SESSION_ID") || null;
    out.delegationPresent = Boolean(delegated);

    const withDelegation = JSON.parse(JSON.stringify(baseContext));
    if (delegated) {
      withDelegation.user = { ...(withDelegation.user || {}), onBehalfOfUser: delegated };
    }

    async function auth() {
      const sapisid =
        document.cookie.match(/(?:^|;\s*)SAPISID=([^;]+)/)?.[1] ??
        document.cookie.match(/(?:^|;\s*)__Secure-3PAPISID=([^;]+)/)?.[1];
      if (!sapisid) throw new Error("no SAPISID cookie — session is signed out");
      const ts = Math.floor(Date.now() / 1000);
      const digest = await crypto.subtle.digest(
        "SHA-1",
        new TextEncoder().encode(`${ts} ${sapisid} ${ORIGIN}`),
      );
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      return `SAPISIDHASH ${ts}_${hex}`;
    }

    async function post(path, body, context) {
      const res = await fetch(
        `${ORIGIN}/youtubei/v1/${path}?prettyPrint=false` + (apiKey ? `&key=${apiKey}` : ""),
        {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
            Authorization: await auth(),
            "X-Origin": ORIGIN,
          },
          body: JSON.stringify({ context, ...body }),
        },
      );
      const text = await res.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {}
      return { status: res.status, json };
    }

    // Same walk the extension does, kept deliberately independent of src/lib.
    const ID_RE = /^(VL)?(PL|LL|WL|FL|RD|UU|OL)/;
    function scanPlaylists(node, found) {
      if (!node || typeof node !== "object") return found;
      if (Array.isArray(node)) {
        for (const v of node) scanPlaylists(v, found);
        return found;
      }
      for (const k of ["playlistId", "contentId"]) {
        const v = node[k];
        if (typeof v === "string" && ID_RE.test(v)) {
          found.add(v.replace(/^VL/, ""));
          break;
        }
      }
      for (const v of Object.values(node)) scanPlaylists(v, found);
      return found;
    }
    function scanKey(node, key, acc) {
      if (!node || typeof node !== "object") return acc;
      if (Array.isArray(node)) {
        for (const v of node) scanKey(v, key, acc);
        return acc;
      }
      for (const [k, v] of Object.entries(node)) {
        if (k === key) acc.push(v);
        scanKey(v, key, acc);
      }
      return acc;
    }

    // ── 1. The library endpoint, which must NOT be capped at 200 ────────────
    out.stage = "browse FEplaylist_aggregation";
    const found = new Set();
    let pages = 0;
    let res = await post("browse", { browseId: "FEplaylist_aggregation" }, withDelegation);
    out.listStatus = res.status;
    while (res.status === 200 && pages < 60) {
      pages++;
      const before = found.size;
      scanPlaylists(res.json, found);
      const token = scanKey(res.json, "continuationCommand", []).find((c) => c && c.token)?.token;
      if (!token || (found.size === before && pages > 1)) break;
      res = await post("browse", { continuation: token }, withDelegation);
    }
    out.listCount = found.size;
    out.listPages = pages;

    // ── 2. The membership endpoint, and the two traps around it ─────────────
    out.stage = "get_add_to_playlist";
    const mem = await post("playlist/get_add_to_playlist", { videoIds: [VIDEO_ID] }, withDelegation);
    out.membershipStatus = mem.status;
    if (mem.status === 200) {
      const rows = [];
      (function walk(n) {
        if (!n || typeof n !== "object") return;
        if (Array.isArray(n)) return n.forEach(walk);
        const o = n.playlistAddToOptionRenderer;
        if (o && typeof o.playlistId === "string") rows.push(o);
        Object.values(n).forEach(walk);
      })(mem.json);
      out.membershipRows = rows.length;
      out.membershipWithState = rows.filter((r) => typeof r.containsSelectedVideos === "string").length;
      out.membershipCappedAt200 = rows.length <= 200;
    }

    // The singular key is a 400. Pinned because getting this wrong once produced a
    // confident "there is no bulk membership endpoint" that was wrong for months.
    out.stage = "singular videoId key";
    const singular = await post("playlist/get_add_to_playlist", { videoId: VIDEO_ID }, withDelegation);
    out.singularKeyRejected = singular.status >= 400;

    // ── 3. Delegation actually matters (brand accounts only) ────────────────
    // Without context.user.onBehalfOfUser a brand account gets 2 playlists, not 256.
    // Nothing errors — you just quietly get the wrong, smaller library.
    if (delegated) {
      out.stage = "undelegated comparison";
      const undel = await post("browse", { browseId: "FEplaylist_aggregation" }, baseContext);
      const undelFound = undel.status === 200 ? scanPlaylists(undel.json, new Set()) : new Set();
      out.undelegatedListCount = undelFound.size;
      out.delegationMatters = found.size > undelFound.size;
    }

    out.stage = "done";
    out.ok = true;
  } catch (e) {
    note(e, out.stage);
  }

  return out;
})()
