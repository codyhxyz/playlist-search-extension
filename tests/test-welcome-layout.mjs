import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { promisify } from 'node:util';

if (process.env.YTPF_SKIP_BROWSER_TESTS || spawnSync('which', ['agent-browser']).status !== 0) {
  console.log('SKIP: welcome layout (browser checks disabled or agent-browser unavailable)');
  process.exit(0);
}

const root = new URL('../src/', import.meta.url);
const version = JSON.parse(readFileSync(new URL('manifest.json', root))).version;
const allowed = new Set([
  'welcome.html', 'welcome.js', 'onboarding-state.js', 'icons/icon128.png',
  'assets/onboarding-demo.mp4', 'assets/onboarding-demo-poster.webp',
]);
const types = { html: 'text/html', js: 'text/javascript', png: 'image/png', mp4: 'video/mp4', webp: 'image/webp' };
const mock = `<script>globalThis.chrome = {
  runtime: {getManifest: () => ({version: ${JSON.stringify(version)}}), sendMessage: async () => ({ok: true})},
  permissions: {contains: async () => true, request: async () => true,
    onAdded: {addListener() {}}, onRemoved: {addListener() {}}},
  tabs: {create: async () => ({})},
  commands: {getAll: async () => [{name: 'open-save-sheet', shortcut: 'Alt+S'}, {name: 'find-playlist', shortcut: 'Alt+P'}]}
};</script>`;
const server = http.createServer((req, res) => {
  const file = new URL(req.url, 'http://127.0.0.1').pathname.slice(1);
  if (!allowed.has(file)) { res.writeHead(404).end(); return; }
  let content = readFileSync(new URL(file, root));
  if (file === 'welcome.html') content = content.toString().replace('<script type="module"', mock + '<script type="module"');
  res.setHeader('Content-Type', types[file.split('.').at(-1)]);
  res.end(content);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const exec = promisify(execFile);
const session = `pls-welcome-layout-${process.pid}`;
const ab = async (...args) => (await exec('agent-browser', ['--session', session, ...args], { timeout: 30_000 })).stdout.trim();

try {
  for (const [width, height] of [[1440, 900], [1366, 768], [1280, 720], [1024, 768], [1280, 600], [800, 600], [360, 800], [320, 568]]) {
    await ab('set', 'viewport', String(width), String(height));
    await ab('set', 'media', width < 760 ? 'dark' : 'light');
    await ab('open', `http://127.0.0.1:${server.address().port}/welcome.html`);
    await ab('wait', '--fn', 'document.body.dataset.permission === "granted"');
    // The staged entrance moves sections by up to 12px for its first 800ms; the
    // layout under test is the one it settles into.
    await ab('wait', '--fn', 'document.getAnimations().every((a) => a.playState !== "running")');
    const result = JSON.parse(JSON.parse(await ab('eval', `JSON.stringify({
      width: innerWidth, height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      sections: [...document.querySelectorAll('header,.intro,figure,.shortcuts,footer')].map(e => e.getBoundingClientRect().toJSON()),
      accessOpen: document.querySelector('#access').open,
      font: parseFloat(getComputedStyle(document.body).fontSize),
      logo: document.querySelector('.logo').getBoundingClientRect().width,
      button: document.querySelector('#open').getBoundingClientRect().height,
      video: document.querySelector('video').getBoundingClientRect().width
    })`)));
    assert.equal(result.accessOpen, false, 'The access disclosure starts collapsed');
    assert.ok(result.scrollWidth <= width, `${width}×${height}: horizontal overflow`);
    assert.ok(result.font >= 16 && result.logo >= 64 && result.button >= 44, 'Do not fit by shrinking text, branding or controls');
    if (width >= 760) {
      assert.ok(result.scrollHeight <= height + 1, `${width}×${height}: page requires scrolling (${result.scrollHeight}px)`);
      assert.ok(result.sections.every(r => r.top >= 0 && r.bottom <= height + 1), 'Every desktop section must remain visible');
      assert.ok(result.video >= 360, 'Keep the recording large enough to read');
    }
    if (width === 1366 || width === 360) {
      await ab('screenshot', `/tmp/playlist-welcome-compact-${width}.png`);
    }
    // Open, the access disclosure may make the page scroll, but never sideways.
    await ab('click', '#access summary');
    await ab('wait', '--fn', 'document.querySelector("#access").open');
    await ab('wait', '--fn', 'document.getAnimations().every((a) => a.playState !== "running")');
    const open = JSON.parse(JSON.parse(await ab('eval', `JSON.stringify({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      body: document.querySelector('.access-body').getBoundingClientRect().toJSON()
    })`)));
    assert.ok(open.scrollWidth <= width, `${width}×${height}: horizontal overflow with the access disclosure open`);
    assert.ok(open.body.left >= 0 && open.body.right <= width && open.body.height > 0, `${width}×${height}: access disclosure content must be visible and within the viewport width`);
    console.log(`✓ Welcome layout ${width}×${height}: ${result.scrollHeight}px document (${open.scrollHeight}px open), no horizontal overflow`);
  }
} finally {
  try { await ab('close'); } finally { server.closeAllConnections(); server.close(); }
}
