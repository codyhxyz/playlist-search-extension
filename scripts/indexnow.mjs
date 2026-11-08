#!/usr/bin/env node
// Tell IndexNow engines (Bing, Yandex, Seznam, Naver...) that the site changed.
//
//   node scripts/indexnow.mjs [https://playlist.codyh.xyz]
//
// Reads every <loc> from the live sitemap and submits them in one request.
// The key is the name of the docs/<32 hex>.txt file, which Vercel serves at the
// site root so engines can confirm we own the host. Run by
// .github/workflows/indexnow.yml after each Production deploy.
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const site = (process.argv[2] || "https://playlist.codyh.xyz").replace(/\/$/, "");
const host = new URL(site).host;
const docs = join(dirname(fileURLToPath(import.meta.url)), "..", "docs");
const keyFile = readdirSync(docs).find((f) => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) throw new Error("no docs/<key>.txt IndexNow key file");
const key = keyFile.slice(0, -4);

const live = await fetch(`${site}/${keyFile}`).then((r) => r.text());
if (live.trim() !== key) throw new Error(`${site}/${keyFile} does not serve the key yet`);

const xml = await fetch(`${site}/sitemap.xml`).then((r) => r.text());
const urlList = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
if (!urlList.length) throw new Error("sitemap has no <loc> entries");

const res = await fetch("https://api.indexnow.org/indexnow", {
  method: "POST",
  headers: { "content-type": "application/json; charset=utf-8" },
  body: JSON.stringify({ host, key, keyLocation: `${site}/${keyFile}`, urlList }),
});
console.log(`IndexNow ${res.status} for ${urlList.length} URLs on ${host}`);
// 200 = accepted, 202 = accepted, key validation pending.
if (res.status !== 200 && res.status !== 202) {
  console.error(await res.text());
  process.exit(1);
}
