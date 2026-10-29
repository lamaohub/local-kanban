import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { IMAGE_MAX_BYTES, imageTooLarge, refusalLine, refusalText } from '../public/js/unsaved.js';

let app, tmp, server;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo', 'DM', 'demo', 2)").run();
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'demo'), 1, 'Task 1', 'todo')").run();
  server = await import('../src/routes/tasks.js');
  app = Fastify();
  await app.register(server.default);
  await app.ready();
});
after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('the page and the server take the same largest image, and it is the limit the server really applies', async () => {
  assert.equal(IMAGE_MAX_BYTES, server.IMAGE_MAX_BYTES, 'the page refuses a different size than the server');
  const send = (n, url) => app.inject({ method: 'POST', url, payload: Buffer.alloc(n), headers: { 'content-type': 'image/png' } });
  for (const url of ['/api/tasks/DM-1/attachments', '/api/tasks/DM-1/comments']) {
    assert.equal((await send(IMAGE_MAX_BYTES, url)).statusCode, 201, `${url}: an image of exactly the limit is refused`);
    assert.equal((await send(IMAGE_MAX_BYTES + 1, url)).statusCode, 413, `${url}: an image over the limit is taken`);
  }
});

test('an image over the limit is the refusal the server would give — «larger than the board takes»', () => {
  assert.equal(imageTooLarge({ size: IMAGE_MAX_BYTES }), null);
  assert.equal(imageTooLarge({ size: 10 }), null);
  const big = imageTooLarge({ size: IMAGE_MAX_BYTES + 1 });
  assert.equal(big.status, 413);
  assert.equal(refusalText(big).reason, 'it is larger than the board takes');
});

const takeFrom = (src, file) => (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const tr = (s) => `ru:${s}`;
const TOO_BIG = 'ru:Could not attach: ru:it is larger than the board takes';

test('the card says it before sending: an attachment, a comment image and an image pasted into a new task', async () => {
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const take = takeFrom(drawer, 'drawer.js');
  const calls = { sent: [], alerts: [], autosave: 0, drawn: 0 };
  const box = {
    state: { drawerKey: 'DM-1' }, tr, seg: (s) => s, refusalText, refusalLine, imageTooLarge,
    apiBlob: async (path, blob) => { calls.sent.push({ path, size: blob.size }); return {}; },
    api: async () => ({ attachments: [] }),
    styledAlert: (m) => calls.alerts.push(m),
    renderAttachments: () => { calls.drawn++; }, renderComments: () => {}, commentArrived: () => {}, showOwnComment: () => {}, renderPendingAttachments: () => {},
    scheduleAutosave: () => { calls.autosave++; },
    URL: { createObjectURL: () => 'blob:x' },
    pendingAttachments: [],
  };
  vm.runInNewContext([
    take('export async function uploadAttachment('),
    take('async function redrawAttachments('),
    take('async function uploadCommentImage('),
    take('export function onDrawerPaste('),
    take('function addPendingPicture('),
  ].join('\n'), box);
  const big = { size: IMAGE_MAX_BYTES + 1, type: 'image/png' };
  const fits = { size: IMAGE_MAX_BYTES, type: 'image/png' };
  await box.uploadAttachment(big);
  await box.uploadCommentImage(big);
  assert.deepEqual(calls.sent, [], 'an image over the limit is still sent — Safari takes the answer for a lost connection');
  assert.deepEqual(calls.alerts, [TOO_BIG, TOO_BIG]);
  await box.uploadAttachment(fits);
  await box.uploadCommentImage(fits);
  assert.equal(calls.sent.length, 2, 'an image of exactly the limit is not sent');
  // a new task: the image is kept until the task is created — one over the limit is said now, not kept to fail later
  box.state.drawerKey = null;
  const paste = (blob) => box.onDrawerPaste({
    target: { id: 'd-desc' }, preventDefault: () => {},
    clipboardData: { items: [{ type: 'image/png', getAsFile: () => blob }] },
  });
  paste(big);
  assert.equal(box.pendingAttachments.length, 0, 'an image over the limit waits to be sent with the new task');
  assert.equal(calls.alerts.length, 3);
  paste(fits);
  assert.equal(box.pendingAttachments.length, 1);
  assert.equal(calls.autosave, 1, 'a refused image creates the new task');
});

test('Chaos says it when the image is added, and does not keep it', () => {
  const chaos = readFileSync(new URL('../public/js/chaos.js', import.meta.url), 'utf8');
  const els = {};
  const box = {
    tr, refusalLine, imageTooLarge, chaosPending: [], renderChaosPending: () => {},
    $: (id) => { if (!els[id]) els[id] = { textContent: '', className: '' }; return els[id]; },
    URL: { createObjectURL: () => 'blob:x' },
  };
  vm.runInNewContext(takeFrom(chaos, 'chaos.js')('function chaosAddImages('), box);
  box.chaosAddImages([{ size: IMAGE_MAX_BYTES + 1, type: 'image/png' }, { size: 100, type: 'image/png' }]);
  assert.equal(box.chaosPending.length, 1, 'the image over the limit is kept to fail after the task is created');
  assert.equal(els['chaos-hint'].textContent, TOO_BIG);
  assert.equal(els['chaos-hint'].className, 'chaos-hint err');
});
