import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReviewTracker, REVIEW_KEY } from '../src/lib/review.js';

const DAY = 86_400_000;
function harness() {
  let day = 20_000;
  const data = {};
  let fail = false;
  const storage = {
    get: async () => {
      if (fail) throw new Error('storage unavailable');
      return structuredClone(data);
    },
    set: async (value) => { Object.assign(data, structuredClone(value)); },
  };
  return {
    review: createReviewTracker(storage, () => day * DAY),
    restart: () => createReviewTracker(storage, () => day * DAY),
    advance: (days) => { day += days; },
    fail: (value) => { fail = value; },
    data,
  };
}

test('never asks on install, first use, or many saves in a single day', async () => {
  const h = harness();
  assert.equal(await h.review('claim'), false);
  for (let i = 0; i < 20; i++) assert.equal(await h.review('save'), false);
  assert.equal(h.data[REVIEW_KEY].saves, 5);
  assert.equal(h.data[REVIEW_KEY].days, 1);
  h.advance(10);
  assert.equal(await h.review('claim'), false, 'age alone is not repeated use');
});

test('requires five confirmed saves, three separate UTC days, and a week', async () => {
  const h = harness();
  await h.review('save');
  h.advance(1);
  await h.review('save');
  h.advance(1);
  for (let i = 0; i < 3; i++) assert.equal(await h.review('save'), false);
  h.advance(4);
  assert.equal(await h.review('claim'), false, 'six days is too soon');
  h.advance(1);
  assert.equal(await h.review('save'), true);
  assert.equal(await h.review('claim'), true);
});

test('three days and a week still need five saves', async () => {
  const h = harness();
  await h.review('save');
  h.advance(1);
  await h.review('save');
  h.advance(6);
  assert.equal(await h.review('save'), false);
  assert.equal(await h.review('save'), false);
  assert.equal(await h.review('save'), true);
});

test('serializes concurrent saves and allows only one prompt across tabs and restarts', async () => {
  const h = harness();
  await Promise.all([h.review('save'), h.review('save'), h.review('save')]);
  h.advance(1);
  await h.review('save');
  h.advance(6);
  await h.review('save');
  assert.deepEqual(await Promise.all([h.review('claim'), h.review('claim')]), [true, false]);
  h.advance(365);
  const restarted = h.restart();
  assert.equal(await restarted('save'), false);
  assert.equal(await restarted('claim'), false, 'dismissal, closing, or store click never prompts again');
  assert.deepEqual(Object.keys(h.data[REVIEW_KEY]).sort(), ['days', 'firstDay', 'lastDay', 'prompted', 'saves']);
});

test('eligibility survives a closed/hidden sheet without consuming the prompt', async () => {
  const h = harness();
  await h.review('save');
  h.advance(1);
  await h.review('save');
  h.advance(6);
  await h.review('save');
  await h.review('save');
  assert.equal(await h.review('save'), true);
  assert.equal(await h.restart()('save'), true, 'only an explicit claim consumes it');
});

test('storage errors do not poison later operations', async () => {
  const h = harness();
  h.fail(true);
  await assert.rejects(h.review('save'), /storage unavailable/);
  h.fail(false);
  assert.equal(await h.review('save'), false);
});

test('moving the clock backwards does not create extra usage days', async () => {
  const h = harness();
  await h.review('save');
  h.advance(-2);
  await h.review('save');
  assert.equal(h.data[REVIEW_KEY].days, 1);
});
