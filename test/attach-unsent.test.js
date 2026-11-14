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
  assert.match(take('function carryTaskMemory('), /unsentPictures\.set\(to, \[\.\.\.unsentOf\(to\), \.\.\.unsentPictures\.get\(from\)\]\)/, 'a task moved to another project loses its pictures cut off on their way');
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

// (⋯ → «Move to project…», the right click, a selection) left them under the old key: gone from the card, and the tab
// never reloaded quietly again. A task deleted elsewhere while its card was open kept them the same way.
test('a task moved from this tab takes its kept pictures and a half-typed comment to its new key', async () => {
  const a = { url: 'blob:a' }; const b = { url: 'blob:b' };
  const box = { unsentPictures: new Map([['CK-1', [a]], ['FG-2', [b]]]), commentDrafts: new Map([['CK-1', 'half a comment']]) };
  vm.runInNewContext(['const unsentOf = (key) => unsentPictures.get(key) || [];', take('function carryTaskMemory(')].join('\n'), box);
  box.carryTaskMemory('CK-1', 'FG-2');
  assert.equal(box.unsentPictures.has('CK-1'), false, 'the pictures stay under the old key, out of sight');
  const now = box.unsentPictures.get('FG-2') || [];
  assert.ok(now.length === 2 && now[0] === b && now[1] === a, 'the pictures kept under the new key are lost');
  assert.equal(box.commentDrafts.get('FG-2'), 'half a comment');
  assert.equal(box.commentDrafts.has('CK-1'), false);
  assert.match(take('export function openMovePicker('), /carryTaskMemory\(key, moved\.key\);[^\n]*\n\s+if \(key === state\.drawerKey\) openDrawer\(moved\.key/, 'a move from the card\'s ⋯ leaves its pictures under the old key');
  assert.match(take('function openGroupMove('), /for \(const \[was, now\] of renamed\) carryTaskMemory\(was, now\);/, 'a move of a selection leaves the pictures under the old keys');
  assert.match(take('export async function followMovedTask('), /carryTaskMemory\(from, to\);/, 'a move made elsewhere leaves the pictures under the old key');
  const run = {};
  vm.runInNewContext(`${take('export async function moveEach(')}\nthis.moveEach = moveEach;`, run);
  const r = await run.moveEach(['CK-1', 'CK-2', 'FG-3'], 'fg', { post: async (k) => ({ key: `FG-${k.slice(3)}0` }), projectOf: (k) => (k.startsWith('FG') ? 'fg' : 'ck'), openKey: () => null, why: String });
  assert.deepEqual(JSON.parse(JSON.stringify(r.renamed)), [['CK-1', 'FG-10'], ['CK-2', 'FG-20']], 'the group move does not say the new key of each task');
});

test('the open card of a task deleted elsewhere drops its kept pictures', () => {
  assert.match(take('export async function syncOpenDrawerStatus('), /e\?\.status === 404 && state\.drawerKey === key\) \{\n\s+forgetUnsent\(key\);/,
    'a task deleted elsewhere keeps its pictures in the tab: it never reloads quietly again');
});

// × that took nothing off, a retry sent twice by a double press, a deleted task that kept its pictures all passed the set
function shownCard() {
  const els = { x: [], retry: [] };
  const attrs = (html, cls) => [...html.matchAll(new RegExp(`class="${cls}" data-u="(\\d+)"[^>]*?( disabled)?>([^<]*)`, 'g'))]
    .map((m) => ({ dataset: { u: m[1] }, disabled: Boolean(m[2]), text: m[3] }));
  const box = {
    innerHTML: '', classList: { add() {}, remove() {} },
    querySelectorAll(sel) {
      if (sel === '.attach-x[data-u]') return (els.x = attrs(box.innerHTML, 'attach-x'));
      if (sel === '.attach-retry') return (els.retry = attrs(box.innerHTML, 'attach-retry'));
      return [];
    },
  };
  const sent = [];
  const ctx = {
    state: { drawerKey: 'DM-1' }, $: () => box, tr: (s) => s, unsentPictures: new Map(), openLightbox() {}, deleteAttachment() {},
    URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} }, Date,
    uploadAttachment: (blob, key, opts) => { sent.push([key, opts.kept]); return new Promise(() => {}); }, // in flight
  };
  const at = src.indexOf('let attachShown');
  vm.runInNewContext([
    'const unsentOf = (key) => unsentPictures.get(key) || [];', take('function keepUnsent('), take('function dropUnsent('),
    src.slice(src.indexOf('const RETRY_STUCK_MS'), src.indexOf('\n', src.indexOf('const RETRY_STUCK_MS'))),
    src.slice(at, src.indexOf('\n', at)), take('function renderAttachments('),
    src.slice(src.indexOf('const sendingNow'), src.indexOf('\n', src.indexOf('const sendingNow'))),
  ].join('\n'), ctx);
  return { ctx, box, els, sent };
}

test('× of a picture «not sent» takes it off; «retry» sends it once and shows it «sending…» while it goes', async () => {
  const { ctx, box, els, sent } = shownCard();
  ctx.keepUnsent('DM-1', pic); ctx.keepUnsent('DM-1', pic);
  ctx.renderAttachments([]);
  assert.equal(els.x.length, 2);
  els.x[0].onclick();
  assert.equal(ctx.unsentPictures.get('DM-1')?.length, 1, '× of a picture «not sent» does not take it off');
  ctx.renderAttachments();
  const kept = ctx.unsentPictures.get('DM-1')[0];
  els.retry[0].onclick(); els.retry[0].onclick(); // a double press
  await null;
  assert.equal(sent.length, 1, 'a double press of «retry» sends the picture twice');
  assert.equal(sent[0][1], kept, 'a retry is not sent as the kept picture: a failure would keep a second copy');
  assert.match(box.innerHTML, /disabled>sending…/, 'a picture on its way does not say so');
  assert.equal(ctx.unsentPictures.get('DM-1')?.length, 1, 'a picture on its way leaves the card: closed and opened meanwhile, it is not there');
});

test('a task deleted from this tab drops its kept pictures', () => {
  assert.match(take('export async function deleteTask('), /catch \(e\) \{ sayRefused\(e, key\); return; \}\n\s+forgetUnsent\(key\);/,
    'a deleted task keeps its pictures in the tab: it never reloads quietly again');
});

// its draft under the old key — out of sight, and the tab never reloaded quietly again; only the open card followed it
test('a task moved or deleted elsewhere with its card closed takes its kept pictures and draft along, or drops them', () => {
  const a = { url: 'blob:a' }; const c = { url: 'blob:c' };
  const box = {
    state: { drawerKey: 'OPN-1' }, URL: { revokeObjectURL: () => {} },
    unsentPictures: new Map([['CK-1', [a]], ['CK-3', [c]], ['OPN-1', [{ url: 'blob:o' }]]]),
    commentDrafts: new Map([['CK-1', 'half a comment'], ['CK-3', 'gone'], ['OPN-1', 'open']]),
  };
  vm.runInNewContext(['const unsentOf = (key) => unsentPictures.get(key) || [];', take('function forgetUnsent('),
    take('function carryTaskMemory('), take('export function taskKeyEvent('), 'this.taskKeyEvent = taskKeyEvent;'].join('\n'), box);
  box.taskKeyEvent({ type: 'task.moved', data: { key: 'FG-2', old_key: 'CK-1' } });
  const moved = box.unsentPictures.get('FG-2') || [];
  assert.ok(moved.length === 1 && moved[0] === a, 'a picture of a task moved with its card closed stays under the old key');
  assert.equal(box.unsentPictures.has('CK-1'), false);
  assert.equal(box.commentDrafts.get('FG-2'), 'half a comment');
  box.taskKeyEvent({ type: 'task.deleted', data: { key: 'CK-3' } });
  assert.equal(box.unsentPictures.has('CK-3'), false, 'a task deleted with its card closed keeps its pictures, and the tab never reloads');
  assert.equal(box.commentDrafts.has('CK-3'), false);
  // the open card follows its task itself (followMovedTask after its autosave, the 404 of its refresh)
  box.taskKeyEvent({ type: 'task.moved', data: { key: 'FG-9', old_key: 'OPN-1' } });
  box.taskKeyEvent({ type: 'task.deleted', data: { key: 'OPN-1' } });
  assert.equal(box.unsentPictures.get('OPN-1').length, 1, 'the stream took the open card\'s pictures away from it');
  assert.equal(box.commentDrafts.get('OPN-1'), 'open');
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const stream = sse.slice(sse.indexOf('function streamMessage('), sse.indexOf('sseQueue.push(ev);'));
  assert.match(stream, /\n {2}taskKeyEvent\(ev\);/, 'the stream no longer hands a task\'s move or deletion to the card\'s memory');
});
