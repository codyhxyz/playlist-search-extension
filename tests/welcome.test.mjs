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
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness({ granted = false, contains = async () => granted } = {}) {
  const nodes = {};
  let focused;
  for (const match of html.matchAll(/<([a-z0-9]+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    nodes[match[3]] = {
      disabled: /\bdisabled\b/.test(match[2]), hidden: /\bhidden\b/.test(match[2]),
      dataset: {}, textContent: '', attributes: {}, listeners: {},
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
      getManifest: () => ({ version: 'test' }),
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
  runInNewContext(source, { chrome, document: { body, getElementById: (id) => nodes[id] } });
  return {
    nodes, body, calls, behavior, handlers,
    click: (id) => nodes[id].listeners.click(),
    setGranted: (value) => { granted = value; },
    focused: () => focused,
  };
}
const count = (h, name) => h.calls.filter(([kind]) => kind === name).length;
function assertNotReady(h) {
  assert.equal(h.body.dataset.permission, 'ungranted');
  assert.equal(h.nodes.ready.hidden, true);
  assert.equal(h.nodes.open.disabled, true);
}
function assertReady(h) {
  assert.equal(h.body.dataset.permission, 'granted');
  assert.equal(h.nodes.permission.hidden, true);
  assert.equal(h.nodes.ready.hidden, false);
  assert.equal(h.nodes.open.disabled, false);
}

test('the page is short, permission-first, accessible and names the required next navigation', () => {
  assert.match(html, /extension will not work until you allow YouTube access/);
  assert.match(html, /Grant YouTube access/);
  assert.match(html, /Required: allow YouTube access/);
  assert.match(html, /cannot show your searchable playlists without this step/);
  assert.match(html, /background: var\(--required-bg\)/);
  assert.match(html, /background: var\(--action\)/);
  assert.match(html, /Choose <strong>Allow/);
  assert.match(html, /existing YouTube sign-in/);
  assert.match(html, /not sent to third parties/);
  assert.match(html, /Open a fresh YouTube tab/);
  assert.match(html, /reload any YouTube tab you already had open/);
  assert.match(html, /account with your playlists/);
  assert.match(html, /Save → search → pick a playlist/);
  assert.match(html, /Extensions.*puzzle menu.*YouTube Playlist Search.*Pinning is optional/);
  assert.match(html, /role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /prefers-color-scheme: light/);
  assert.doesNotMatch(html, /<table|The 200 limit|Where you’ll see it/);
});

test('initial check without permission enables only Grant', async () => {
  const h = harness();
  assert.equal(h.nodes.grant.disabled, true);
  assertNotReady(h);
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
  assert.equal(count(h, 'register'), 0);
});

test('already-granted init waits for registration and checks permission again before ready', async () => {
  const h = harness({ granted: true });
  const registration = deferred();
  h.behavior.register = () => registration.promise;
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, true);
  assert.equal(count(h, 'register'), 1);
  registration.resolve({ ok: true });
  await tick();
  assertReady(h);
  assert.equal(count(h, 'contains'), 2);
});

test('Grant requests directly in the click gesture, ignores duplicate clicks and its onAdded race', async () => {
  const h = harness();
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
  const h = harness();
  await tick();
  h.behavior.request = async () => false;
  await h.click('grant');
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
  assert.match(h.nodes.status.textContent, /wasn’t allowed.*try again/);
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
    assert.match(h.nodes.status.textContent, /Try setup again.*chrome:\/\/extensions/);
    assert.equal(h.nodes.grant.disabled, false);
    h.behavior.register = async () => ({ ok: true });
    await h.click('grant');
    assertReady(h);
  });
}

test('registration rejection after granting access stays not ready and recovers', async () => {
  const h = harness();
  await tick();
  h.behavior.register = async () => { throw new Error('worker unavailable'); };
  await h.click('grant');
  assertNotReady(h);
  assert.match(h.nodes.status.textContent, /Setup couldn’t finish.*Try setup again/);
  h.behavior.register = async () => ({ ok: true });
  await h.click('grant');
  assertReady(h);
});

test('permission check rejection is visible and the grant gesture can recover', async () => {
  const h = harness({ granted: true });
  h.behavior.contains = async () => { throw new Error('check failed'); };
  // The first contains call was already started; exercise the post-registration check.
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.status.dataset.state, 'err');
  assert.match(h.nodes.status.textContent, /Couldn’t verify setup/);
  h.behavior.contains = async () => true;
  await h.click('grant');
  assertReady(h);
});

test('initial permission check rejection is handled without an unhandled rejection', async () => {
  const h = harness({ contains: async () => { throw new Error('check failed'); } });
  await tick();
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
  assert.match(h.nodes.status.textContent, /Couldn’t verify setup/);
  assert.equal(count(h, 'register'), 0);
});

test('synchronous request error restores a usable retry button', async () => {
  const h = harness();
  await tick();
  h.behavior.request = () => { throw new Error('prompt unavailable'); };
  await h.click('grant');
  assertNotReady(h);
  assert.equal(h.nodes.grant.disabled, false);
  assert.match(h.nodes.status.textContent, /Try setup again/);
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
  assert.match(h.nodes.status.textContent, /access was removed.*Grant access/);
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
  const h = harness();
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
