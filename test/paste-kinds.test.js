import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
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

// a terminal field that took every image/* in other words, passed the set. The real handlers run here on stand-ins.
const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const fnOf = (head) => { const at = drawer.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return drawer.slice(at, drawer.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };
const IMAGES_ONLY = { status: 400, message: 'images only' };
const pasteOf = (items) => ({ clipboardData: { items }, target: { id: 'd-desc' }, preventDefault() {}, stopPropagation() {} });

test('the card\'s paste: one picture in two kinds is sent once and unrefused; a kind it does not take alone is refused, unsent', async () => {
  const run = (items) => {
    const box = { sent: [], alerts: [], state: { drawerKey: 'DM-1' }, picturesIn, IMAGES_ONLY, tr: (s) => s, refusalLine: (h) => h };
    box.styledAlert = (m) => box.alerts.push(m);
    box.uploadAttachment = (blob) => { box.sent.push(blob.type); };
    box.uploadCommentImage = box.addPendingPicture = () => { throw new Error('not this way'); };
    vm.runInNewContext(`${fnOf('export function onDrawerPaste(')}\nthis.onDrawerPaste = onDrawerPaste;`, box);
    box.onDrawerPaste(pasteOf(items));
    return box;
  };
  const two = run([item('image/jpeg'), item('image/tiff')]);
  assert.deepEqual([...two.sent], ['image/jpeg'], 'the TIFF of the picture is sent as well (and refused over it)');
  assert.equal(two.alerts.length, 0, 'a refusal shown over the picture that was attached');
  const tiff = run([item('image/tiff')]);
  assert.equal(tiff.sent.length, 0);
  assert.equal(tiff.alerts.length, 1, 'a picture of a kind the board does not take is pasted and nothing is said');
});

test('the terminal field\'s paste goes through the same rule', () => {
  const box = { picturesIn, IMAGES_ONLY, tr: (s) => s, refusalLine: (h) => h, alerts: [], took: [] };
  box.styledAlert = (m) => box.alerts.push(m);
  box.wirePicturePick = () => {};
  box.termImage = (input, keyOf, f) => box.took.push(f.type);
  const handlers = {};
  const input = { disabled: false, closest: () => null, addEventListener: (t, f) => { handlers[t] = f; } };
  vm.runInNewContext(`${fnOf('export function wireTermImages(')}\nthis.wire = wireTermImages;`, box);
  box.wire(input, () => 'DM-1');
  handlers.paste(pasteOf([item('image/jpeg'), item('image/tiff')]));
  assert.deepEqual([...box.took], ['image/jpeg'], 'the terminal field takes every image/* of a paste');
  assert.equal(box.alerts.length, 0);
  handlers.paste(pasteOf([item('image/tiff')]));
  assert.equal(box.took.length, 1);
  assert.equal(box.alerts.length, 1, 'the terminal field is silent on a picture it does not take');
});

test('the chat and «Chaos» say the refusal of a paste with no kind the board takes', () => {
  const chat = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /if \(refused\) \{ note\.textContent = refusalLine\('Could not attach', IMAGES_ONLY, tr\); note\.classList\.remove\('hidden'\); return; \}/, 'the chat is silent on a picture it does not take');
  const chaos = readFileSync(new URL('../public/js/chaos.js', import.meta.url), 'utf8');
  assert.match(chaos, /if \(refused\) \{ \$\('chaos-hint'\)\.textContent = refusalLine\('Could not attach', IMAGES_ONLY, tr\)/, '«Chaos» is silent on a picture it does not take');
});
