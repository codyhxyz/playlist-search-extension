import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createReviewTracker } from '../src/lib/review.js';

const origin = 'https://www.youtube.com/*';
const manifest = JSON.parse(readFileSync(new URL('../src/manifest.json', import.meta.url), 'utf8'));
const source = readFileSync(new URL('../src/background.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ granted = false, existingWelcome = false } = {}) {
  const handlers = {};
  const calls = { tabs: [], focused: [], windows: [], badges: [], titles: [], messages: [], registrations: [], local: {} };
  const event = (name) => ({ addListener: (fn) => { handlers[name] = fn; } });
  const chrome = {
    permissions: { onAdded: event('added'), onRemoved: event('removed') },
    scripting: {
      getRegisteredContentScripts: async () => [],
      unregisterContentScripts: async () => {},
      registerContentScripts: async (scripts) => { calls.registrations.push(scripts); },
    },
    action: {
      onClicked: event('action'),
      setBadgeText: async (value) => { calls.badges.push(value.text); },
      setBadgeBackgroundColor: async () => {},
      setTitle: async (value) => { calls.titles.push(value.title); },
    },
    runtime: {
      id: 'test',
      getURL: (path) => `chrome-extension://test/${path}`,
      getManifest: () => ({ version: 'test' }),
      getContexts: async () => existingWelcome ? [{ tabId: 20, windowId: 4 }] : [],
      onMessage: event('message'), onInstalled: event('installed'), onStartup: event('startup'),
    },
    tabs: {
      create: async (value) => { calls.tabs.push(value); },
      update: async (id, value) => { calls.focused.push({ id, ...value }); },
      // Chrome withholds URL without host access; no broad `tabs` permission.
      query: async () => [granted
        ? { id: 1, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }
        : { id: 1 }],
      sendMessage: async (id, value) => { calls.messages.push({ id, ...value }); },
      onRemoved: event('tabRemoved'),
    },
    windows: { update: async (id, value) => { calls.windows.push({ id, ...value }); } },
    contextMenus: {
      onClicked: event('menu'),
      removeAll: (cb) => cb(),
      create: (_value, cb) => cb(),
    },
    commands: { onCommand: event('command') },
    storage: {
      local: {
        remove: async () => {},
        get: async () => structuredClone(calls.local),
        set: async (value) => { Object.assign(calls.local, value); },
      },
      session: { setAccessLevel: async () => {} },
    },
  };
  runInNewContext(source, {
    chrome, console: { log() {}, warn() {}, error() {} },
    YOUTUBE_ORIGIN: origin,
    hasYouTubePermission: async () => granted,
    touchesYouTube: (permissions) => permissions?.origins?.includes(origin),
    isAddToPlaylist: () => true,
    videoIdFromUrl: (url) => url?.includes('watch?v=') ? 'jNQXAC9IVRw' : null,
    resolveVideoId: () => ({ videoId: 'jNQXAC9IVRw', from: 'test' }),
    createReviewTracker,
  });
  return { calls, handlers, setGranted: (value) => { granted = value; } };
}

test('YouTube-only access is required at installation, with no optional host grant', () => {
  assert.deepEqual(manifest.host_permissions, [origin]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.permissions.includes('tabs'), false);
  assert.equal(manifest.permissions.includes('activeTab'), false);
});

test('only the extension’s top-frame YouTube content script can record review engagement', async () => {
  const { calls, handlers } = harness();
  const valid = { id: 'test', url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', frameId: 0, tab: { id: 1 } };
  for (const sender of [
    { ...valid, id: 'other' }, { ...valid, frameId: 1 },
    { ...valid, url: 'https://www.youtube.com.evil.test/' }, { ...valid, tab: undefined },
  ]) {
    assert.equal(handlers.message({ type: 'REVIEW_SAVE' }, sender, () => assert.fail('untrusted sender replied')), false);
  }
  const response = await new Promise((resolve) => {
    assert.equal(handlers.message({ type: 'REVIEW_SAVE' }, valid, resolve), true);
  });
  assert.equal(response.eligible, false);
  assert.equal(calls.local.plsReview.saves, 1);
  assert.equal(calls.tabs.length, 0);
});

test('a normal install registers scripts and saves without acknowledging the welcome page', async () => {
  const { calls, handlers } = harness({ granted: true });
  await tick();
  await handlers.installed({ reason: 'install' });
  await tick();
  assert.equal(calls.tabs.length, 1);
  assert.ok(calls.registrations.length > 0);
  assert.equal(calls.badges.at(-1), '');
  handlers.action({ id: 1, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  await tick();
  assert.equal(calls.messages[0].type, 'SAVE_INTENT');
  assert.equal(calls.tabs.length, 1);
});

test('missing access is visible without reopening setup on worker start or browser startup', async () => {
  const { calls, handlers } = harness();
  await tick();
  handlers.startup();
  await tick();
  assert.equal(calls.badges.at(-1), 'OFF');
  assert.match(calls.titles.at(-1), /access|setup/i);
  assert.equal(calls.tabs.length, 0);
  assert.equal(calls.registrations.length, 0);
});

test('toolbar recovers ignored setup and focuses the existing setup tab/window', async () => {
  const { calls, handlers } = harness({ existingWelcome: true });
  handlers.action({ id: 1 });
  await tick();
  assert.equal(calls.focused[0].id, 20);
  assert.equal(calls.windows[0].id, 4);
  assert.equal(calls.tabs.length, 0);
});

test('concurrent explicit entrypoints open only one setup tab', async () => {
  const { calls, handlers } = harness();
  handlers.action({ id: 1 });
  handlers.action({ id: 1 });
  await handlers.command('find-playlist');
  await tick();
  assert.equal(calls.tabs.length, 1);
});

for (const entry of ['menu', 'open-save-sheet', 'find-playlist']) {
  test(`${entry} explains missing permission instead of silently failing`, async () => {
    const { calls, handlers } = harness();
    if (entry === 'menu') {
      handlers.menu({ menuItemId: 'pls-save-here', linkUrl: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' },
        { id: 1, url: 'https://www.youtube.com/' });
    } else {
      await handlers.command(entry);
    }
    await tick();
    assert.equal(calls.tabs.length, 1);
    assert.match(calls.tabs[0].url, /welcome\.html/);
    assert.equal(calls.messages.length, 0);
  });
}

test('grant clears the badge and revocation restores recovery without opening a tab', async () => {
  const { calls, handlers, setGranted } = harness();
  await tick();
  setGranted(true);
  handlers.added({ origins: [origin] });
  await tick();
  assert.equal(calls.badges.at(-1), '');
  assert.equal(calls.registrations.length, 1);
  setGranted(false);
  handlers.removed({ origins: [origin] });
  await tick();
  assert.equal(calls.badges.at(-1), 'OFF');
  assert.equal(calls.tabs.length, 0);
});

test('page-controlled hook messages cannot open setup while permission is missing', async () => {
  const { calls, handlers } = harness();
  handlers.message({ type: 'PANEL_REQUEST', path: 'get_panel', body: {} },
    { tab: { id: 1, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' } }, () => {});
  await tick();
  assert.equal(calls.tabs.length, 0);
  assert.equal(calls.messages.length, 0);
});

test('a configured install neither opens setup again on update nor blocks toolbar saves', async () => {
  const { calls, handlers } = harness({ granted: true });
  await tick();
  await handlers.installed({ reason: 'update' });
  handlers.action({ id: 1, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' });
  await tick();
  assert.equal(calls.tabs.length, 0);
  assert.equal(calls.messages[0].type, 'SAVE_INTENT');
});
