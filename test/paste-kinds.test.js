import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { IMAGE_TYPES, picturesIn } from '../public/js/unsaved.js';

const item = (type) => ({ kind: 'file', type, getAsFile: () => ({ type }) });

test('one picture in two kinds: the kind the board takes is taken, nothing is refused', () => {
  const { pictures, refused } = picturesIn([item('image/jpeg'), item('image/tiff')]);
  assert.deepEqual(pictures.map((p) => p.type), ['image/jpeg']);
  assert.equal(refused, false, 'a refusal shown over the picture that was attached');
});

test('only kinds the board does not take: refused, nothing sent', () => {
  assert.deepEqual(picturesIn([item('image/tiff'), item('image/heic')]), { pictures: [], refused: true });
});

test('no picture at all (text, a file of another kind) is no paste of a picture: neither taken nor refused', () => {
  assert.deepEqual(picturesIn([{ kind: 'string', type: 'text/plain' }, item('application/pdf')]), { pictures: [], refused: false });
  assert.deepEqual(picturesIn(undefined), { pictures: [], refused: false });
});

test('several pictures the board takes are all taken', () => {
  assert.equal(picturesIn([item('image/png'), item('image/gif'), item('image/webp')]).pictures.length, 3);
});

test('the kinds are the ones the server takes', () => {
  const src = readFileSync(new URL('../src/routes/tasks.js', import.meta.url), 'utf8');
  for (const t of IMAGE_TYPES) assert.ok(src.includes(`'${t}'`), `${t} is not a kind the server takes`);
  assert.match(src, /images only: png, jpeg, webp, gif/);
});

test('every paste of a picture on the page goes through the rule', () => {
  for (const f of ['drawer.js', 'chat.js', 'chaos.js']) {
    const src = readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
    assert.ok(!/clipboardData\?\.items[^\n]*startsWith\('image\/'\)/.test(src), `${f}: a paste takes every image/* again`);
    assert.ok(src.includes('picturesIn('), `${f}: the paste does not use picturesIn`);
  }
});
