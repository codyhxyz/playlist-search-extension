import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/content.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*? from '[^']+';\n/gm, '');
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function harness({ eligible = true, visible = true, ready = true, storageFails = false, closeOnClaim = false } = {}) {
  let listener, opts;
  const messages = [], opened = [], offers = [];
  const sheet = {
    dead: false,
    get canOfferReview() { return ready && !this.dead; },
    offerReview(fn) { if (this.canOfferReview) offers.push(fn); },
    setData() {}, setTitle() {}, setStatus() {}, setMember() {},
    destroy() { this.dead = true; },
  };
  runInNewContext(source, {
    chrome: {
      runtime: {
        onMessage: { addListener(fn) { listener = fn; } },
        sendMessage: async (msg) => {
          messages.push(msg.type);
          if (storageFails) throw new Error('storage unavailable');
          if (msg.type === 'REVIEW_CLAIM' && closeOnClaim) sheet.destroy();
          return { eligible };
        },
      },
      storage: { local: { get: async () => ({}), set: async () => {} } },
    },
    window: { addEventListener() {}, postMessage() {}, open(...args) { opened.push(args); } },
    document: { addEventListener() {}, visibilityState: visible ? 'visible' : 'hidden' },
    location: { href: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', pathname: '/watch', origin: 'https://www.youtube.com' },
    console: { log() {}, warn() {}, error() {} }, AbortController, setTimeout() {},
    createSheet(value) { opts = value; return sheet; },
    accountKey: () => null,
    fetchPicker: async () => [],
    fetchAllPlaylists: async () => [],
    fetchVideoTitle: async () => null,
    orderLikePicker: (rows) => rows,
    saveTargets: (rows) => rows,
    addVideo: async () => ({}),
    createPlaylist: async () => ({}),
    removeVideo: async () => {},
  });
  listener({ type: 'SAVE_INTENT', videoId: 'jNQXAC9IVRw', source: 'test' });
  await tick();
  return { opts, messages, opened, offers, sheet };
}

test('only a confirmed-save notification records use, and the store opens only on click', async () => {
  const h = await harness();
  assert.deepEqual(h.messages, [], 'opening the sheet is not a success');
  h.opts.onSaved();
  await tick();
  assert.deepEqual(h.messages, ['REVIEW_SAVE', 'REVIEW_CLAIM']);
  assert.equal(h.offers.length, 1);
  assert.deepEqual(h.opened, []);
  h.offers[0]();
  assert.deepEqual(h.opened, [[
    'https://chromewebstore.google.com/detail/efgbkmnooapcpdpgmihemfpedchhmmek/reviews',
    '_blank', 'noopener',
  ]]);
});

for (const config of [
  { eligible: false }, { visible: false }, { ready: false },
]) {
  test(`records saves but does not claim a prompt when ${JSON.stringify(config)}`, async () => {
    const h = await harness(config);
    h.opts.onSaved();
    await tick();
    assert.deepEqual(h.messages, ['REVIEW_SAVE']);
    assert.deepEqual(h.offers, []);
  });
}

test('closed sheets still record successful saves without asking', async () => {
  const h = await harness();
  h.sheet.destroy();
  h.opts.onSaved();
  await tick();
  assert.deepEqual(h.messages, ['REVIEW_SAVE']);
  assert.deepEqual(h.offers, []);
});

test('closing between claim and display never resurrects a sheet', async () => {
  const h = await harness({ closeOnClaim: true });
  h.opts.onSaved();
  await tick();
  assert.deepEqual(h.messages, ['REVIEW_SAVE', 'REVIEW_CLAIM']);
  assert.deepEqual(h.offers, []);
});

test('review storage failure cannot reject a successful save', async () => {
  const h = await harness({ storageFails: true });
  assert.equal(h.opts.onSaved(), undefined);
  await tick();
  assert.deepEqual(h.offers, []);
  assert.deepEqual(h.opened, []);
});
