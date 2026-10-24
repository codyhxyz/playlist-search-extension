import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../src/welcome.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/onboarding-state.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '') + '\n' + readFileSync(new URL('../src/welcome.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '');
const origin = 'https://www.youtube.com/*';
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

function harness({ granted = true, contains = async () => granted, version = 'test', reducedMotion = false, playbackFails = false } = {}) {
  const nodes = {};
  const mediaCalls = [];
  let motionListener;
  const motion = {
    matches: reducedMotion,
    addEventListener(type, listener) { assert.equal(type, 'change'); motionListener = listener; },
  };
  let focused;
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    nodes[match[3]] = {
      disabled: /\bdisabled\b/.test(match[2]), hidden: /\bhidden\b/.test(match[2]),
      dataset: {}, textContent: '', attributes: {}, listeners: {},
      src: match[2].match(/\bsrc="([^"]+)"/)?.[1],
      play() { mediaCalls.push('play'); return playbackFails ? Promise.reject(new Error('blocked')) : Promise.resolve(); },
      pause() { mediaCalls.push('pause'); },
      addEventListener(type, fn) { this.listeners[type] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      focus() { focused = match[3]; },
    };
  }
  const handlers = {};
  const calls = [];
  const behavior = {
    contains,
    request: async () => { granted = true; return true; },
    register: async () => ({ ok: true }),
    open: async () => ({}),
  };
  const chrome = {
    runtime: {
      getManifest: () => ({ version }),
      sendMessage: (message) => { calls.push(['register', message]); return behavior.register(); },
    },
    permissions: {
      contains: (value) => { calls.push(['contains', value]); return behavior.contains(); },
      request: (value) => { calls.push(['request', value]); return behavior.request(); },
      onAdded: { addListener: (fn) => { handlers.added = fn; } },
      onRemoved: { addListener: (fn) => { handlers.removed = fn; } },
    },
    tabs: { create: (value) => { calls.push(['open', value]); return behavior.open(); } },
  };
  const body = { dataset: {} };
  runInNewContext(source, {
    chrome, document: { body, getElementById: (id) => nodes[id] },
    window: { matchMedia: (query) => { assert.equal(query, '(prefers-reduced-motion: reduce)'); return motion; } },
  });
  return {
    nodes, body, calls, behavior, handlers, mediaCalls,
    setReducedMotion: (value) => { motion.matches = value; motionListener(); },
    click: (id) => nodes[id].listeners.click(),
    setGranted: (value) => { granted = value; },
    focused: () => focused,
  };
}
const count = (h, name) => h.calls.filter(([kind]) => kind === name).length;
function assertNotReady(h) {
  assert.notEqual(h.body.dataset.permission, 'granted');
  assert.equal(h.nodes.ready.hidden, false);
  assert.equal(h.nodes.open.disabled, true);
}
function assertReady(h) {
  assert.equal(h.body.dataset.permission, 'granted');
  assert.equal(h.nodes.permission.hidden, true);
  assert.equal(h.nodes.ready.hidden, false);
  assert.equal(h.nodes.open.disabled, false);
}

test('default HTML welcomes users to first success without a permission gate', () => {
  assert.match(html, /<title>YouTube Playlist Search — Welcome<\/title>/);
  assert.match(html, /<body data-permission="checking">/);
  assert.match(html, /<section id="permission"[^>]* hidden>/);
  assert.doesNotMatch(html, /<section id="ready"[^>]* hidden>/);
  assert.match(html, /Save to the right playlist\./);
  assert.match(html, /Search your playlists right in YouTube’s Save menu/);
  assert.match(html, />Open YouTube<\/button>/);
  assert.match(html, /src="icons\/icon128.png" width="72" height="72"/);
  assert.match(html, />Shortcuts<\/h2>/);
  assert.match(html, /Alt\+S.*Save the current video or Short/);
  assert.match(html, /Alt\+P.*Find a playlist/);
  assert.doesNotMatch(html, /Keep it handy|jump right in|no extra setup|tabs already open|reload YouTube|Less scrolling|More saving|Optional shortcuts|<svg|class="sheet"|class="steps"|Type a name/);
  assert.match(html, /cannot work while YouTube site access is restricted/);
  assert.match(html, /Extensions → YouTube Playlist Search → Site access/);
  assert.match(html, /Access is used only on www\.youtube\.com, to search and save to your playlists\./);
  assert.match(html, /<details id="access">\s*<summary>What it can access<\/summary>/, 'access disclosure is native and collapsed by default');
  assert.match(html, /“Read and change your data on www\.youtube\.com” warning Chrome showed at install/);
  assert.match(html, /www\.youtube\.com/);
  assert.match(html, /background: var\(--required-bg\)/);
  assert.match(html, /#open \{ background: var\(--red\)/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.doesNotMatch(html, /<table|Required:|Setup isn’t finished|Checking YouTube access/);
});

test('the real recording autoplays muted with native controls and no demo button', async () => {
  const h = harness();
  await tick();
  assert.equal(h.nodes['demo-video'].src, 'assets/onboarding-demo.mp4');
  assert.equal(h.nodes['demo-video'].muted, true);
  assert.equal(h.nodes['demo-video'].autoplay, true);
  assert.deepEqual(h.mediaCalls, ['play']);
  assert.match(html, /<video[^>]+muted loop playsinline controls/);
  assert.match(html, /poster="assets\/onboarding-demo-poster.webp"/);
  assert.doesNotMatch(html, /demo-toggle|Play demo|Stop demo|onboarding-demo\.gif/);
  assert.match(html, /@media \(max-width: 600px\)/);
  assert.doesNotMatch(html, /<input|onclick=|<img[^>]+https:/);
});

test('reduced motion prevents autoplay and updates playback when the preference changes', async () => {
  const h = harness({ reducedMotion: true });
  await tick();
  assert.equal(h.nodes['demo-video'].autoplay, false);
  assert.deepEqual(h.mediaCalls, ['pause']);
  h.setReducedMotion(false);
  assert.equal(h.nodes['demo-video'].autoplay, true);
  assert.deepEqual(h.mediaCalls, ['pause', 'play']);
  h.setReducedMotion(true);
  assert.deepEqual(h.mediaCalls, ['pause', 'play', 'pause']);
});

test('blocked autoplay does not break onboarding or produce an unhandled rejection', async () => {
  const h = harness({ playbackFails: true });
  await tick();
  assertReady(h);
  assert.deepEqual(h.mediaCalls, ['play']);
});

test('version is read from the runtime manifest rather than hardcoded', () => {
  const h = harness({ version: '87.23.19.4' });
  assert.equal(h.nodes.version.textContent, 'v87.23.19.4');
  assert.match(html, /<span id="version"><\/span>/);
});

test('permission checking preserves welcome without flashing the recovery warning', async () => {
  const check = deferred();
  const h = harness({ contains: () => check.promise });
  assertNotReady(h);
  assert.equal(h.nodes.permission.hidden, true);
  assert.equal(h.nodes.retry.hidden, true);
  assert.equal(h.nodes.grant.disabled, true);
  assert.equal(count(h, 'request'), 0);
  check.resolve(true);
  await tick();
  assertReady(h);
  assert.equal(count(h, 'request'), 0);
  assert.equal(count(h, 'open'), 0, 'welcome does not open tabs without a click');
});

test('restricted site access reveals recovery only after permission verification', async () => {
  const h = harness({ granted: false });
  assert.equal(h.nodes.permission.hidden, true);
  await tick();
  assertNotReady(h);
  assert.equal(h.body.dataset.permission, 'restricted');
  assert.equal(h.nodes.permission.hidden, false);
  assert.equal(h.nodes.grant.disabled, false);
  assert.equal(h.nodes.retry.hidden, true);
  assert.equal(count(h, 'register'), 0);
});

test('already-granted init waits for registration and checks permission again before ready', async () => {
  const h = harness({ granted: true });
  const registration = deferred();
  h.behavior.register = () => registration.promise;
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.permission.hidden, true);
  assert.equal(count(h, 'request'), 0);
  assert.equal(count(h, 'register'), 1);
  registration.resolve({ ok: true });
  await tick();
  assertReady(h);
  assert.equal(count(h, 'contains'), 2);
});

test('Grant requests directly in the click gesture, ignores duplicate clicks and its onAdded race', async () => {
  const h = harness({ granted: false });
  await tick();
  const request = deferred();
  h.behavior.request = () => request.promise;
  const before = h.calls.length;
  const completion = h.click('grant');
  assert.equal(h.calls[before][0], 'request');
  assert.equal(h.calls.length, before + 1, 'no asynchronous permission preflight');
  assert.equal(h.calls[before][1].origins[0], origin);
  assert.equal(h.nodes.grant.disabled, true);
  await h.click('grant');
  h.setGranted(true);
  h.handlers.added({ origins: [origin] });
  assert.equal(count(h, 'register'), 0);
  request.resolve(true);
  await completion;
  assertReady(h);
  assert.equal(count(h, 'request'), 1);
  assert.equal(count(h, 'register'), 1);
  assert.equal(h.focused(), 'heading');
});

test('denial is recoverable and a second grant succeeds', async () => {
  const h = harness({ granted: false });
  await tick();
  h.behavior.request = async () => false;
  await h.click('grant');
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
  assert.match(h.nodes.status.textContent, /wasn’t restored.*Extensions.*Site access.*www\.youtube\.com/);
  assert.equal(h.focused(), 'grant');
  h.behavior.request = async () => { h.setGranted(true); return true; };
  await h.click('grant');
  assertReady(h);
});

for (const reply of [{ ok: false, error: 'missing bundle' }, undefined]) {
  test(`initial registration response ${JSON.stringify(reply)} cannot claim ready and supports retry`, async () => {
    const h = harness({ granted: true });
    h.behavior.register = async () => reply;
    await tick();
    assertNotReady(h);
    assert.equal(h.nodes.status.dataset.state, 'err');
    assert.match(h.nodes.status.textContent, /Try again.*chrome:\/\/extensions/);
    assert.equal(h.nodes.permission.hidden, true);
    assert.equal(h.nodes.retry.hidden, false);
    h.behavior.register = async () => ({ ok: true });
    await h.click('retry');
    assert.equal(count(h, 'request'), 0);
    assertReady(h);
  });
}

test('registration rejection after granting access stays not ready and recovers', async () => {
  const h = harness({ granted: false });
  await tick();
  h.behavior.register = async () => { throw new Error('worker unavailable'); };
  await h.click('grant');
  assertNotReady(h);
  assert.match(h.nodes.status.textContent, /Couldn’t get Playlist Search ready.*Try again/);
  assert.equal(h.nodes.permission.hidden, true);
  h.behavior.register = async () => ({ ok: true });
  await h.click('retry');
  assertReady(h);
});

test('permission check rejection is visible and retry recovers without requesting consent', async () => {
  const h = harness({ granted: true });
  h.behavior.contains = async () => { throw new Error('check failed'); };
  // The first contains call was already started; exercise the post-registration check.
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.status.dataset.state, 'err');
  assert.match(h.nodes.status.textContent, /Couldn’t get Playlist Search ready/);
  assert.equal(h.nodes.permission.hidden, true);
  h.behavior.contains = async () => true;
  await h.click('retry');
  assertReady(h);
});

test('initial permission check rejection is handled without an unhandled rejection', async () => {
  const h = harness({ contains: async () => { throw new Error('check failed'); } });
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.permission.hidden, true);
  assert.equal(h.nodes.retry.hidden, false);
  assert.match(h.nodes.status.textContent, /Couldn’t get Playlist Search ready/);
  assert.equal(count(h, 'register'), 0);
});

test('synchronous request error restores a usable retry button', async () => {
  const h = harness({ granted: false });
  await tick();
  h.behavior.request = () => { throw new Error('prompt unavailable'); };
  await h.click('grant');
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
  assert.match(h.nodes.status.textContent, /couldn’t be restored.*Site access.*www\.youtube\.com/);
  h.behavior.request = async () => { h.setGranted(true); return true; };
  await h.click('grant');
  assertReady(h);
});

test('revocation clears ready immediately; unrelated permissions are ignored; regrant verifies registration', async () => {
  const h = harness({ granted: true });
  await tick();
  assertReady(h);
  h.handlers.removed({ origins: ['https://example.com/*'] });
  assertReady(h);
  h.setGranted(false);
  h.handlers.removed({ origins: [origin] });
  assertNotReady(h);
  assert.match(h.nodes.status.textContent, /access was removed.*Site access.*www\.youtube\.com/);
  await h.click('open');
  assert.equal(count(h, 'open'), 0);
  h.setGranted(true);
  h.handlers.added({ origins: [origin] });
  await tick();
  assertReady(h);
  assert.equal(count(h, 'register'), 2);
});

test('a late registration response cannot overwrite revocation', async () => {
  const h = harness({ granted: true });
  const registration = deferred();
  h.behavior.register = () => registration.promise;
  await tick();
  h.setGranted(false);
  h.handlers.removed({ origins: [origin] });
  registration.resolve({ ok: true });
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
});

test('registration success without actual permission does not claim ready', async () => {
  const h = harness({ granted: true });
  h.behavior.register = async () => { h.setGranted(false); return { ok: true }; };
  await tick();
  assertNotReady(h);
  assert.match(h.nodes.status.textContent, /access was removed/);
});

test('Open YouTube creates a fresh tab, prevents duplicate pending opens and recovers from errors', async () => {
  const h = harness({ granted: true });
  await tick();
  const opened = deferred();
  h.behavior.open = () => opened.promise;
  const completion = h.click('open');
  assert.equal(h.nodes.open.disabled, true);
  await h.click('open');
  assert.equal(count(h, 'open'), 1);
  assert.equal(h.calls.find(([kind]) => kind === 'open')[1].url, 'https://www.youtube.com/');
  opened.resolve({});
  await completion;
  assert.equal(h.nodes.open.disabled, false);
  h.behavior.open = async () => { throw new Error('tab failed'); };
  await h.click('open');
  assert.match(h.nodes.status.textContent, /Couldn’t open YouTube.*Try Open YouTube again/);
  assert.equal(h.nodes.open.disabled, false);
  h.behavior.open = async () => ({});
  await h.click('open');
  assert.equal(h.nodes.status.dataset.state, '');
  assert.match(h.nodes.status.textContent, /opened in a fresh tab/);
});

test('onAdded supersedes an old permission check but does not duplicate in-flight registration', async () => {
  const firstCheck = deferred();
  const h = harness({ contains: () => firstCheck.promise });
  h.setGranted(true);
  h.behavior.contains = async () => true;
  const registration = deferred();
  h.behavior.register = () => registration.promise;
  h.handlers.added({ origins: [origin] });
  await tick();
  h.handlers.added({ origins: [origin] });
  firstCheck.resolve(false);
  await tick();
  assertNotReady(h);
  assert.equal(count(h, 'register'), 1);
  registration.resolve({ ok: true });
  await tick();
  assertReady(h);
});

test('revocation while the prompt is pending ignores its late result and permits retry', async () => {
  const h = harness({ granted: false });
  await tick();
  const request = deferred();
  h.behavior.request = () => request.promise;
  const completion = h.click('grant');
  h.handlers.removed({ origins: [origin] });
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, true);
  request.resolve(true);
  await completion;
  assertNotReady(h);
  assert.equal(count(h, 'register'), 0);
  assert.equal(h.nodes.grant.disabled, false);
  h.behavior.request = async () => { h.setGranted(true); return true; };
  await h.click('grant');
  assertReady(h);
});

test('a positive request result is not trusted when required site access remains withheld', async () => {
  const h = harness({ granted: false });
  await tick();
  h.behavior.request = async () => true;
  await h.click('grant');
  assertNotReady(h);
  assert.equal(h.nodes.permission.hidden, false);
  assert.equal(h.nodes.grant.disabled, false);
  assert.equal(count(h, 'register'), 0);
  assert.match(h.nodes.status.textContent, /Extensions.*Site access.*www\.youtube\.com/);
});

test('an asynchronously rejected recovery request keeps honest Chrome site-control guidance', async () => {
  const h = harness({ granted: false });
  await tick();
  h.behavior.request = async () => { throw new Error('required host prompt unavailable'); };
  await h.click('grant');
  assertNotReady(h);
  assert.equal(h.nodes.permission.hidden, false);
  assert.equal(h.nodes.grant.disabled, false);
  assert.match(h.nodes.status.textContent, /couldn’t be restored.*Extensions.*Site access.*www\.youtube\.com/);
  assert.equal(count(h, 'register'), 0);
});

test('revocation wins over a late post-registration permission check', async () => {
  const h = harness();
  const check = deferred();
  h.behavior.contains = () => check.promise;
  await tick();
  h.setGranted(false);
  h.handlers.removed({ origins: [origin] });
  check.resolve(true);
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.permission.hidden, false);
  assert.match(h.nodes.status.textContent, /access was removed/);
});

test('a stale initial check error cannot replace a newer verified welcome state', async () => {
  const check = deferred();
  const h = harness({ contains: () => check.promise });
  h.behavior.contains = async () => true;
  h.handlers.added({ origins: [origin] });
  await tick();
  assertReady(h);
  check.reject(new Error('old check failed'));
  await tick();
  assertReady(h);
  assert.notEqual(h.nodes.status.dataset.state, 'err');
  assert.equal(h.nodes.retry.hidden, true);
});

test('a late tab-opening error cannot overwrite revoked-access recovery', async () => {
  const h = harness();
  await tick();
  const opened = deferred();
  h.behavior.open = () => opened.promise;
  const completion = h.click('open');
  h.handlers.removed({ origins: [origin] });
  opened.reject(new Error('late tab failure'));
  await completion;
  assertNotReady(h);
  assert.match(h.nodes.status.textContent, /access was removed/);
  assert.equal(h.nodes.permission.hidden, false);
});
