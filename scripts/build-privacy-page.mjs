#!/usr/bin/env node
// Render PRIVACY.md -> docs/privacy-policy.html.
//
// These were two hand-maintained copies of the same policy and they had already
// drifted: the published page was missing the entire "On YouTube's Internal
// InnerTube API" section that the repo copy had carried for a release. A privacy
// policy that disagrees with itself is worse than either version alone, and the
// published one is the one that counts — it is linked from the Chrome Web Store
// listing and from the extension's welcome page.
//
// So: PRIVACY.md is the source of truth, and this generates the page.
//
// Deliberately a tiny converter rather than a markdown dependency. It handles
// exactly the subset PRIVACY.md uses and THROWS on anything else, so a new
// construct fails the build instead of silently rendering as literal asterisks.
//
// Usage:
//   node scripts/build-privacy-page.mjs [--check]
//
// --check exits non-zero if the committed page differs from what the source
// would produce — that's the CI guard against editing the HTML by hand.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "PRIVACY.md");
const OUT = join(ROOT, "docs", "privacy-policy.html");
const CHECK = process.argv.includes("--check");

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Sentinel for parked code spans. Written as an escape, never as a literal
// control byte — an earlier version embedded raw NULs here, which made git
// classify this file as binary and refuse to diff or merge it textually.
const SENTINEL = "\u0001";

/** Inline: `code`, **bold**, [text](url), and bare em dashes. Order matters. */
function inline(text) {
  const codes = [];
  // Pull code spans out first so their contents are never treated as markup.
  let out = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code>${escapeHtml(code)}</code>`);
    return `${SENTINEL}${codes.length - 1}${SENTINEL}`;
  });
  out = escapeHtml(out);
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    if (!/^https?:\/\//.test(href)) throw new Error(`non-http link in PRIVACY.md: ${href}`);
    return `<a href="${href}">${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  if (out.includes("*")) throw new Error(`unhandled '*' after inline pass: ${text.slice(0, 80)}`);
  return out.replace(new RegExp(SENTINEL + "(\\d+)" + SENTINEL, "g"), (_, i) => codes[Number(i)]);
}

function render(md) {
  const lines = md.split("\n");
  const html = [];
  let list = null; // "ul" | "ol"
  let para = [];

  const flushPara = () => {
    if (para.length === 0) return;
    html.push(`  <p>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const closeList = () => {
    if (list) html.push(`  </${list}>`);
    list = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === "") {
      flushPara();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushPara();
      closeList();
      const level = heading[1].length;
      html.push(`  <h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // Nested bullets are folded into the parent item's text: the policy uses them
    // for elaboration, not hierarchy, and a flat rendering reads the same.
    const nested = line.match(/^\s{2,}-\s+(.*)$/);
    if (nested) {
      if (!list) throw new Error(`nested bullet with no parent list: ${line}`);
      html.push(`    <li>${inline(nested[1])}</li>`);
      continue;
    }

    const bullet = line.match(/^-\s+(.*)$/);
    if (bullet) {
      flushPara();
      if (list !== "ul") {
        closeList();
        html.push("  <ul>");
        list = "ul";
      }
      html.push(`    <li>${inline(bullet[1])}</li>`);
      continue;
    }

    const numbered = line.match(/^\d+\.\s+(.*)$/);
    if (numbered) {
      flushPara();
      if (list !== "ol") {
        closeList();
        html.push("  <ol>");
        list = "ol";
      }
      html.push(`    <li>${inline(numbered[1])}</li>`);
      continue;
    }

    if (list) {
      // A continuation line inside a list item.
      const last = html.pop();
      html.push(last.replace(/<\/li>$/, ` ${inline(line.trim())}</li>`));
      continue;
    }

    para.push(line.trim());
  }
  flushPara();
  closeList();
  return html.join("\n");
}

const body = render(readFileSync(SRC, "utf8"));
const page = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>YouTube Playlist Search Privacy Policy</title>
  <link rel="canonical" href="https://playlist.codyh.xyz/privacy-policy.html">
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
           margin: 40px auto; max-width: 760px; line-height: 1.65; padding: 0 16px; }
    h1, h2, h3 { line-height: 1.3; }
    h2 { margin-top: 2em; }
    code { background: rgba(127, 127, 127, 0.16); padding: 2px 5px; border-radius: 4px;
           font-size: 0.9em; }
    li { margin: 0.35em 0; }
    li > ul, li > ol { margin-top: 0.35em; }
  </style>
</head>
<body>
<!-- GENERATED FROM PRIVACY.md by scripts/build-privacy-page.mjs — do not edit by hand. -->
${body}
</body>
</html>
`;

if (CHECK) {
  const current = readFileSync(OUT, "utf8");
  if (current !== page) {
    console.error(
      "privacy page is out of date with PRIVACY.md.\n" +
        "Run: node scripts/build-privacy-page.mjs",
    );
    process.exit(1);
  }
  console.log("privacy page matches PRIVACY.md");
} else {
  writeFileSync(OUT, page);
  console.log(`wrote ${OUT} from PRIVACY.md`);
}
