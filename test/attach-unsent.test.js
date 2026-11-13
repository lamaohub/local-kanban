import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canRetry, imageTooLarge, refusalLine, refusalText } from '../public/js/unsaved.js';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};

function card(answer) {
  const calls = { alerts: [], drawn: 0, revoked: 0 };
  const box = {
    state: { drawerKey: 'DM-1' }, tr: (s) => s, seg: (s) => s, canRetry, imageTooLarge, refusalLine, refusalText,
    apiBlob: async () => answer(), api: async () => ({ attachments: [] }),
    styledAlert: (m) => calls.alerts.push(m), sayRefused: () => calls.alerts.push('gone'),
    renderAttachments: () => { calls.drawn++; },
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => { calls.revoked++; } },
    unsentPictures: new Map(),
  };
  vm.runInNewContext([
    'const unsentOf = (key) => unsentPictures.get(key) || [];',
    take('function keepUnsent('), take('function dropUnsent('), take('function forgetUnsent('),
    take('export async function uploadAttachment('), take('async function redrawAttachments('),
  ].join('\n'), box);
  return { box, calls };
}
const pic = { size: 100, type: 'image/png' };
const offline = () => { throw Object.assign(new Error('Load failed'), { offline: true }); };

test('cut off on its way: the picture stays on its card, said and drawn at once', async () => {
  const { box, calls } = card(offline);
  assert.equal(await box.uploadAttachment(pic, 'DM-1', { keep: true }), null);
  assert.equal(box.unsentPictures.get('DM-1')?.length, 1, 'a picture cut off on its way is lost');
  assert.equal(calls.drawn, 1, 'the card still shows the thumbnail of the wiped list');
  assert.equal(calls.alerts.length, 1);
});

test('a server down (5xx) is cut off as well; the picture of a card not on screen waits for it', async () => {
  const { box, calls } = card(() => { throw Object.assign(new Error('HTTP 502'), { status: 502 }); });
  await box.uploadAttachment(pic, 'DM-7', { keep: true });
  assert.equal(box.unsentPictures.get('DM-7')?.length, 1);
  assert.equal(calls.drawn, 0, 'another card was drawn with this task\'s picture');
});

test('a refusal of the picture itself is said and not kept: sending it again cannot help', async () => {
  for (const status of [400, 413]) {
    const { box, calls } = card(() => { throw Object.assign(new Error('images only'), { status }); });
    await box.uploadAttachment(pic, 'DM-1', { keep: true });
    assert.equal(box.unsentPictures.size, 0, `a picture refused with ${status} is offered to be sent again`);
    assert.equal(calls.alerts.length, 1);
  }
});

test('an upload that is not the card\'s own (the chat, the terminal field) keeps nothing — they hold their pictures themselves', async () => {
  const { box } = card(offline);
  await box.uploadAttachment(pic, 'DM-1');
  assert.equal(box.unsentPictures.size, 0);
});

test('a retry keeps the picture where it is while it goes: sent — it goes; cut off again — it stays once; refused — it goes', async () => {
  for (const [answer, left] of [[() => ({ id: 1 }), 0], [offline, 1], [() => { throw Object.assign(new Error('images only'), { status: 400 }); }, 0]]) {
    const { box } = card(answer);
    box.keepUnsent('DM-1', pic);
    const kept = box.unsentPictures.get('DM-1')[0];
    kept.sending = Date.now();
    await box.uploadAttachment(pic, 'DM-1', { keep: true, kept });
    assert.equal(box.unsentPictures.get('DM-1')?.length || 0, left);
    if (left) assert.equal(box.unsentPictures.get('DM-1')[0], kept, 'a retry cut off again made a second copy');
    if (left) assert.equal(kept.sending, 0, 'a retry cut off again stays «sending…»');
  }
});

test('the task gone: its kept pictures go with it', async () => {
  const { box } = card(() => { throw Object.assign(new Error('task not found'), { status: 404 }); });
  box.keepUnsent('DM-1', pic);
  await box.uploadAttachment(pic, 'DM-1', { keep: true });
  assert.equal(box.unsentPictures.has('DM-1'), false);
});

test('a reload of the tab and a move of the task keep them', () => {
  assert.match(readFileSync(new URL('../public/js/init.js', import.meta.url), 'utf8'), /if \(hasUnsentPictures\(\)\) return true/, 'a quiet reload of the tab loses the pictures cut off on their way');
  assert.match(take('export async function followMovedTask('), /unsentPictures\.set\(to, unsentPictures\.get\(from\)\)/, 'a task moved to another project loses its pictures cut off on their way');
});

test('taken off: the rest stays, the last one takes the task out', () => {
  const { box, calls } = card(offline);
  box.keepUnsent('DM-1', pic); box.keepUnsent('DM-1', pic);
  const [a, b] = box.unsentPictures.get('DM-1');
  box.dropUnsent('DM-1', a);
  assert.equal(box.unsentPictures.get('DM-1').length, 1);
  assert.equal(box.unsentPictures.get('DM-1')[0], b, 'the other picture was taken off');
  box.dropUnsent('DM-1', b);
  assert.equal(box.unsentPictures.has('DM-1'), false);
  assert.equal(calls.revoked, 2);
});

test('a new task sends its pictures so that a cut-off one stays, and × of the form survives a list that changed', () => {
  const create = take('async function createTask(');
  assert.match(create, /uploadAttachment\(p\.blob, created\.key, \{ keep: true \}\)/, 'the pictures of a new task are wiped when their upload is cut off');
  assert.match(take('function renderPendingAttachments('), /if \(!pendingAttachments\[i\]\) return/, '× of a thumbnail drawn before the list changed throws');
  assert.match(take('export function wirePicturePick('), /take\(f, clicked \?\? at\(\)\)/, 'a change without our click passes null for the moment');
});
