#!/usr/bin/env node
// Chrome Web Store structural validator.
//
// Scans src/manifest.json + src/*.{js,html} for review-blockers the CWS
// reviewers catch late (broad host patterns, unused permissions, remote
// code, SW keepalive hacks, CSP holes, listing-field length limits).
//
// Usage:
//   node scripts/validate-cws.mjs [--json]
//
// Exit codes:
//   0 — no errors (warnings may still print)
//   1 — one or more errors
//   2 — validator setup problem (manifest missing)

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const MANIFEST_PATH = join(SRC, "manifest.json");
const ARGS = process.argv.slice(2);
const JSON_MODE = ARGS.includes("--json");

const BROAD_PATTERNS = new Set([
  "<all_urls>",
  "*://*/*",
  "https://*/*",
  "http://*/*",
  "*://*",
]);

const SENSITIVE_PERMS = new Set([
  "tabs",
  "cookies",
  "downloads",
  "webRequest",
  "webRequestBlocking",
]);

// Permissions consumed via manifest fields, not chrome.<perm>.* calls.
const DECLARATIVE_PERMS = new Set(["sidePanel"]);

// Files/dirs under src/ that ship to the store via build-store-zip.sh.
// test-search.js and any future test-*.js files stay out; vendor/ is 3rd
// party and shouldn't be scanned for style/pattern violations.
const SKIP_ENTRIES = new Set(["vendor", "welcome-assets", "icons"]);
const TEST_FILE_RE = /^test-.*\.(m?js|cjs)$/;
const SCAN_EXT_RE = /\.(js|mjs|html)$/;

function loadManifest() {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(`ERROR: no manifest at ${relative(ROOT, MANIFEST_PATH)}`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

function walkSrc() {
  const out = [];
  function visit(dir) {
    for (const entry of readdirSync(dir)) {
      if (SKIP_ENTRIES.has(entry) || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        visit(full);
        continue;
      }
      if (!SCAN_EXT_RE.test(entry)) continue;
      if (TEST_FILE_RE.test(entry)) continue;
      out.push({
        relPath: relative(ROOT, full),
        content: readFileSync(full, "utf8"),
      });
    }
  }
  visit(SRC);
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split("\n").length;
}

// ─── Rules ────────────────────────────────────────────────────────────────

function hostPermissionsBreadth({ manifest }) {
  const hp = manifest.host_permissions ?? [];
  const broad = hp.filter((p) => BROAD_PATTERNS.has(p));
  if (broad.length === 0) return [];
  return [{
    rule: "host-permissions-breadth",
    severity: "error",
    message: `Broad host_permissions declared: ${broad.join(", ")}`,
    why: "Broad host patterns trigger CWS in-depth review and significantly delay approval.",
    fix: "Move to optional_host_permissions and request at runtime from a user gesture.",
  }];
}

function contentScriptsMatchesBreadth({ manifest }) {
  const cs = manifest.content_scripts ?? [];
  const out = [];
  cs.forEach((entry, i) => {
    const broad = (entry.matches ?? []).filter((m) => BROAD_PATTERNS.has(m));
    if (broad.length > 0) {
      out.push({
        rule: "content-scripts-matches-breadth",
        severity: "error",
        message: `content_scripts[${i}].matches is broad: ${broad.join(", ")}`,
        why: "Broad content-script matches count as broad host access for review purposes.",
        fix: "Narrow matches, or register programmatically via chrome.scripting.registerContentScripts after a user-gesture permission grant.",
      });
    }
  });
  return out;
}

function unusedPermission({ manifest, sources }) {
  const perms = manifest.permissions ?? [];
  const corpus = sources.map((s) => s.content).join("\n");
  const out = [];
  for (const p of perms) {
    if (DECLARATIVE_PERMS.has(p)) continue;
    const used = new RegExp(`\\b(?:browser|chrome)\\.${p}\\b`).test(corpus);
    if (!used) {
      out.push({
        rule: "unused-permission",
        severity: "error",
        message: `'${p}' declared but no chrome.${p}.* / browser.${p}.* call found in source`,
        why: "Unused permissions extend review time and can cause rejection.",
        fix: `Remove '${p}' from manifest.permissions, or add the usage if intentional.`,
      });
    }
  }
  return out;
}

function sensitivePermissionDeclared({ manifest }) {
  const perms = manifest.permissions ?? [];
  const sensitive = perms.filter((p) => SENSITIVE_PERMS.has(p));
  if (sensitive.length === 0) return [];
  return [{
    rule: "sensitive-permission-declared",
    severity: "warn",
    message: `Sensitive permission(s) declared: ${sensitive.join(", ")}`,
    why: "tabs/cookies/downloads/webRequest get extra verification and slow review.",
    fix: "Prefer activeTab over tabs; prefer declarativeNetRequest over webRequest. Justify each in the CWS dashboard.",
  }];
}

function cspExtensionPages({ manifest }) {
  const csp = manifest.content_security_policy;
  if (!csp) return [];
  const policy = typeof csp === "string" ? csp : csp.extension_pages ?? "";
  if (!policy) return [];
  const out = [];
  if (/unsafe-eval/.test(policy)) {
    out.push({
      rule: "csp-extension-pages",
      severity: "error",
      message: "content_security_policy.extension_pages contains 'unsafe-eval'",
      why: "MV3 disallows unsafe-eval in extension_pages; will be rejected.",
      fix: "Remove unsafe-eval. For WebAssembly use wasm-unsafe-eval.",
    });
  }
  const scriptSrc = policy.match(/script-src\s+([^;]+)/);
  if (scriptSrc) {
    const values = scriptSrc[1].trim().split(/\s+/);
    const bad = values.filter(
      (v) => !v.startsWith("'") && !v.startsWith("http://localhost") && !v.startsWith("http://127.0.0.1"),
    );
    if (bad.length > 0) {
      out.push({
        rule: "csp-extension-pages",
        severity: "error",
        message: `script-src has external origin(s): ${bad.join(", ")}`,
        why: "Only 'self', 'wasm-unsafe-eval', and localhost are allowed in extension_pages script-src.",
        fix: "Remove external origins. Bundle all dependencies locally.",
      });
    }
  }
  return out;
}

/**
 * Replace JS comments (// to EOL, plus block comments) with spaces, preserving
 * line breaks so line numbers in error messages still point at the right
 * source line. Used by remoteCodePatterns so the word "eval" in an
 * explanatory comment doesn't trip the eval() detector.
 */
function stripJsComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // Track whether we're inside a string literal so '// or eval(' inside a
  // string isn't stripped. Templates intentionally not handled — none of our
  // regexes' false-positive cases live in templates today; revisit if that
  // changes.
  let inStr = null;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
      if (c === inStr) inStr = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      // Line comment — consume to EOL, emit spaces to preserve column.
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      // Block comment — consume to */, emit spaces and newlines to preserve
      // line numbers / columns.
      const start = i;
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      const end = Math.min(i + 2, n);
      for (let j = start; j < end; j++) out += src[j] === "\n" ? "\n" : " ";
      i = end;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function remoteCodePatterns({ sources }) {
  const patterns = [
    [/\beval\s*\(/g, "eval() call"],
    [/\bnew\s+Function\s*\(/g, "new Function() call"],
    [/<script[^>]+src\s*=\s*["']https?:/gi, '<script src="http..."> tag'],
    [/\bimport\s*\(\s*["'`]https?:/g, "dynamic import() of remote URL"],
  ];
  const out = [];
  for (const src of sources) {
    // Strip JS comments before scanning so a word like "eval" appearing
    // in an explanatory comment doesn't get flagged. Offsets are preserved
    // (comments replaced with spaces) so line numbers in the error point
    // at the right source line. HTML files don't get stripped — the
    // <script src="http"> pattern is HTML-only and needs the raw content.
    const scanContent = src.relPath.endsWith(".html")
      ? src.content
      : stripJsComments(src.content);
    for (const [re, label] of patterns) {
      for (const match of scanContent.matchAll(re)) {
        out.push({
          rule: "remote-code-patterns",
          severity: "error",
          message: `Remote-code pattern detected: ${label}`,
          why: "MV3 and CWS policy ban remote code execution.",
          fix: "Remove the dynamic-code pattern; bundle all logic locally.",
          locations: [`${src.relPath}:${lineOf(src.content, match.index ?? 0)}`],
        });
      }
    }
  }
  return out;
}

function swKeepaliveHack({ backgroundSources }) {
  const out = [];
  for (const src of backgroundSources) {
    for (const match of src.content.matchAll(/\bsetInterval\s*\(/g)) {
      out.push({
        rule: "sw-keepalive-hack",
        severity: "warn",
        message: "setInterval() in background service worker",
        why: "Periodic timers used to keep the SW alive are an anti-pattern and may be flagged.",
        fix: "Use chrome.alarms for scheduled work; use event listeners for reactive work.",
        locations: [`${src.relPath}:${lineOf(src.content, match.index ?? 0)}`],
      });
    }
  }
  return out;
}

function swListenerTopLevel({ backgroundSources }) {
  const out = [];
  for (const src of backgroundSources) {
    // Match await at column 0 only. Indented awaits live inside async
    // functions (listener callbacks, helpers) and are harmless.
    const hasTopLevelAwait = /^await\s+/m.test(src.content);
    const hasAddListener = /\.addListener\s*\(/.test(src.content);
    if (hasTopLevelAwait && hasAddListener) {
      out.push({
        rule: "sw-listener-top-level",
        severity: "warn",
        message: "Background file uses top-level await AND registers addListener",
        why: "Event listeners must register synchronously. Top-level await delays registration past SW startup and causes missed events.",
        fix: "Register all listeners before any await. Move awaited setup inside listener callbacks.",
        locations: [src.relPath],
      });
    }
  }
  return out;
}

function warMatchesBreadth({ manifest }) {
  const war = manifest.web_accessible_resources ?? [];
  const out = [];
  war.forEach((entry, i) => {
    const broad = (entry.matches ?? []).filter((m) => BROAD_PATTERNS.has(m));
    if (broad.length > 0) {
      out.push({
        rule: "war-matches-breadth",
        severity: "warn",
        message: `web_accessible_resources[${i}].matches is broad: ${broad.join(", ")}`,
        why: "Broad WAR makes your resources addressable by any site; reviewers flag this.",
        fix: "Scope matches to the specific origins that need access.",
      });
    }
  });
  return out;
}

function listingFieldsPresent({ manifest }) {
  const out = [];
  const { name, description, icons } = manifest;
  if (!name) {
    out.push({ rule: "listing-fields-present", severity: "error", message: "manifest.name is missing", why: "Missing title is a Yellow Zinc rejection.", fix: "Set manifest.name (≤45 chars)." });
  } else if (name.length > 45) {
    out.push({ rule: "listing-fields-present", severity: "error", message: `manifest.name is ${name.length} chars (max 45)`, why: "CWS enforces a 45-char limit on name.", fix: "Shorten the name." });
  }
  if (!description) {
    out.push({ rule: "listing-fields-present", severity: "error", message: "manifest.description is missing", why: "Missing description is a Yellow Zinc rejection.", fix: "Set manifest.description (≤132 chars)." });
  } else if (description.length > 132) {
    out.push({ rule: "listing-fields-present", severity: "warn", message: `manifest.description is ${description.length} chars (CWS tile shows ~132)`, why: "Long descriptions get truncated in the CWS tile.", fix: "Front-load the critical info into the first 132 chars." });
  }
  if (!icons || !icons["128"]) {
    out.push({ rule: "listing-fields-present", severity: "error", message: "manifest.icons['128'] is missing", why: "128x128 icon is required; missing icon is a Yellow Zinc rejection.", fix: "Add icons/icon128.png and reference it from manifest.icons." });
  }
  return out;
}

// Scans built JS for string-concatenated URL patterns that CWS automated
// review has flagged as potential obfuscation (Red Titanium). Heuristic:
// a string literal beginning with http(s):// followed by `+`. False
// positives in log messages are tolerated — warn, not error.
function redTitaniumDynamicUrlConcat({ sources }) {
  const re = /(?:"https?:\/\/"|'https?:\/\/')\s*\+/g;
  const out = [];
  for (const src of sources) {
    for (const match of src.content.matchAll(re)) {
      out.push({
        rule: "red-titanium-dynamic-url-concat",
        severity: "warn",
        message: "Dynamic URL construction via string concatenation",
        why: "CWS automated review has flagged concatenated URL construction as obfuscation, even when the intent is allowlisting.",
        fix: "Replace with a hardcoded const array: const ALLOWED_HOSTS = ['https://api.example.com'] — reference ALLOWED_HOSTS[0] directly.",
        locations: [`${src.relPath}:${lineOf(src.content, match.index ?? 0)}`],
      });
    }
  }
  return out;
}

// Cross-check that every file the manifest references as a service worker,
// content script JS, content script CSS, or icons is present under src/.
// Catches "forgot to commit" regressions where the manifest points at a
// file that only exists on the author's machine.
function manifestReferencesExist({ manifest }) {
  const out = [];
  const checks = [];
  const sw = manifest.background?.service_worker;
  if (sw) checks.push(sw);
  for (const entry of manifest.content_scripts ?? []) {
    for (const f of entry.js ?? []) checks.push(f);
    for (const f of entry.css ?? []) checks.push(f);
  }
  for (const size of ["16", "48", "128"]) {
    if (manifest.icons?.[size]) checks.push(manifest.icons[size]);
  }
  for (const rel of checks) {
    if (!existsSync(join(SRC, rel))) {
      out.push({
        rule: "manifest-references-exist",
        severity: "error",
        message: `manifest references \`${rel}\` but src/${rel} does not exist`,
        why: "Loading the extension will fail when Chrome can't find a declared file.",
        fix: `Create src/${rel}, or remove the reference from manifest.json.`,
      });
    }
  }
  return out;
}

const RULES = [
  hostPermissionsBreadth,
  contentScriptsMatchesBreadth,
  unusedPermission,
  sensitivePermissionDeclared,
  cspExtensionPages,
  remoteCodePatterns,
  swKeepaliveHack,
  swListenerTopLevel,
  warMatchesBreadth,
  listingFieldsPresent,
  redTitaniumDynamicUrlConcat,
  manifestReferencesExist,
];

function main() {
  const manifest = loadManifest();
  const sources = walkSrc();
  const backgroundSources = sources.filter((s) => s.relPath.endsWith("background.js"));
  const ctx = { manifest, sources, backgroundSources };
  const findings = RULES.flatMap((r) => r(ctx));
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warn");

  if (JSON_MODE) {
    process.stdout.write(JSON.stringify({
      schemaVersion: 1,
      rulesRun: RULES.length,
      summary: { errors: errors.length, warnings: warnings.length },
      findings,
    }, null, 2) + "\n");
    process.exit(errors.length > 0 ? 1 : 0);
  }

  console.log(`CWS validator — ${RULES.length} rules`);
  if (findings.length === 0) {
    console.log("\u2713 Structural checks passed.");
    process.exit(0);
  }
  for (const f of findings) {
    const badge = f.severity === "error" ? "\u2717 error" : "\u26a0 warn ";
    console.log(`\n${badge} ${f.rule}: ${f.message}`);
    console.log(`  why: ${f.why}`);
    console.log(`  fix: ${f.fix}`);
    for (const loc of f.locations ?? []) console.log(`    ${loc}`);
  }
  console.log(`\n\u2014 ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(errors.length > 0 ? 1 : 0);
}

main();
