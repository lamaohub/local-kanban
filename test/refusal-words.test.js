import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { imageTooLarge, refusalLine, refusalText } from '../public/js/unsaved.js';
import { boardOnly, effortOf, startEffort, checksOnly, manualRefusal } from '../public/js/launch-rules.js';

/* ── the server's own refusals ── */
let app, tmp, db;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  // a stand-in tmux first on the PATH and a socket of its own: these routes must never reach a real one
  mkdirSync(join(tmp, 'bin'));
  writeFileSync(join(tmp, 'bin', 'tmux'), '#!/bin/sh\nexit 1\n');
  chmodSync(join(tmp, 'bin', 'tmux'), 0o755);
  process.env.PATH = `${join(tmp, 'bin')}:${process.env.PATH}`;
  process.env.KB_TMUX_SOCKET = 'kb-test-refusals';
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo', 'DM', 'demo', 4)").run();
  for (const n of [1, 2, 3]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'demo'), ?, ?, 'todo')").run(n, `Task ${n}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/terminal.js')).default);
  await app.ready();
});
after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// what api() turns a refusal into: the status, and the server's text as the message
async function refusal(method, url, payload, headers) {
  const r = await app.inject({ method, url, payload, headers });
  assert.ok(r.statusCode >= 400, `${method} ${url} was not refused (${r.statusCode})`);
  const body = r.json();
  return { status: r.statusCode, message: String(body.error || r.statusCode), body };
}

test('the server\'s refusals of a deleted task say it is gone; the other missing things say what they are', async () => {
  const gone = [
    await refusal('PATCH', '/api/tasks/DM-77', { pinned: 1 }), // pin
    await refusal('PATCH', '/api/tasks/DM-77', { status: 'cancelled' }), // cancel
    await refusal('DELETE', '/api/tasks/DM-77'), // delete
    await refusal('POST', '/api/tasks/DM-77/links', { key: 'DM-1' }), // the open card of the picker
    await refusal('POST', '/api/tasks/DM-77/attachments', PNG, { 'content-type': 'image/png' }),
  ];
  for (const e of gone) assert.equal(refusalText(e).gone, true, `${e.message} does not take the card of a deleted task off the board`);
  const other = refusalText(await refusal('POST', '/api/tasks/DM-1/links', { key: 'DM-99' }));
  assert.equal(other.gone, false, 'the task to link to is gone, and the open card is closed as if it were');
  assert.equal(other.text, 'That task no longer exists — it was deleted.');
  assert.equal(other.refresh, true);
  const project = refusalText(await refusal('POST', '/api/tasks', { project: 'nope', title: 'x', status: 'backlog' }));
  assert.equal(project.gone, false);
  assert.equal(project.reason, 'the project no longer exists');
  const attachment = refusalText(await refusal('DELETE', '/api/tasks/DM-1/attachments/999'));
  assert.equal(attachment.gone, false, 'a gone attachment says the whole task was deleted');
  const claude = refusalText(await refusal('POST', '/api/tasks/DM-1/terminal', { text: 'y' }));
  assert.equal(claude.claudeGone, true, 'no Claude on the task reads as something else');
  assert.equal(claude.gone, false);
});

test('the server\'s refusals of an attachment say why in the board\'s words', async () => {
  const kind = refusalText(await refusal('POST', '/api/tasks/DM-1/attachments', PNG, { 'content-type': 'image/bmp' }));
  assert.equal(kind.reason, 'only PNG, JPEG, WebP and GIF images can be attached');
  const id = db.prepare("SELECT id FROM tasks WHERE task_no = 2").get().id;
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO task_attachments (task_id, file, mime) VALUES (?, ?, 'image/png')").run(id, `${i}.png`);
  const full = refusalText(await refusal('POST', '/api/tasks/DM-2/attachments', PNG, { 'content-type': 'image/png' }));
  assert.equal(full.reason, 'the task already holds as many images as it can');
  for (let i = 0; i < 30; i++) db.prepare("INSERT INTO task_comments (task_id, author, body, image) VALUES (?, 'me', '', ?)").run(id, `c${i}.png`);
  const comments = refusalText(await refusal('POST', '/api/tasks/DM-2/comments', PNG, { 'content-type': 'image/png' }));
  assert.equal(comments.reason, 'the task already holds as many images as it can');
  const big = refusalText(await refusal('POST', '/api/tasks/DM-1/attachments', Buffer.alloc(6 * 1024 * 1024 + 10), { 'content-type': 'image/png' }));
  assert.equal(big.reason, 'it is larger than the board takes');
});

/* ── the rule ── */
test('a refusal never says the server\'s English, and each kind says its own thing', () => {
  const cases = [
    [{ offline: true, message: 'Failed to fetch' }, 'no connection to the board — try again'],
    [{ status: 404, message: 'task not found' }, 'the task no longer exists — it was deleted'],
    [{ status: 404, message: '404' }, 'the task no longer exists — it was deleted'],
    [{ status: 404, message: 'the task to link to was not found' }, 'that task no longer exists — it was deleted'],
    [{ status: 404, message: 'project not found' }, 'the project no longer exists'],
    [{ status: 404, message: 'no Claude of the board works on this task' }, 'Claude of the board no longer runs on this task'],
    [{ status: 404, message: 'attachment not found' }, 'the board did not accept it'],
    [{ status: 409, message: 'Claude has exited in this terminal' }, 'Claude of the board no longer runs on this task'],
    [{ status: 409, message: 'the Claude app is not installed here — pick Terminal or Copy in Settings' }, 'the Claude app is not installed on this computer — pick Terminal or Copy in Settings'],
    [{ status: 413, message: 'Payload Too Large' }, 'it is larger than the board takes'],
    [{ status: 501, message: 'no terminal to open on this system — copy the prompt instead' }, 'this computer cannot do it — pick another way in Settings'],
    [{ status: 500, message: "can't find pane: kb-1" }, 'the board answered with an error — the details are in Settings → Errors'],
    [{ status: 400, message: 'images only: png, jpeg, webp, gif' }, 'only PNG, JPEG, WebP and GIF images can be attached'],
    [{ status: 400, message: 'limit of attachments per task: 30' }, 'the task already holds as many images as it can'],
    [{ status: 400, message: 'cannot go straight from "todo" to "done"' }, 'the task has to go through work first'],
    [{ status: 400, message: 'keys: tasks of this project only' }, 'the board did not accept it'],
  ];
  for (const [e, reason] of cases) {
    const r = refusalText(e);
    assert.equal(r.reason, reason, `${e.status || 'offline'} ${e.message}`);
    if (!/^(404|Failed to fetch)$/.test(e.message)) {
      assert.ok(!r.text.includes(e.message) && !r.reason.includes(e.message), `the server's words leak: ${e.message}`);
    }
  }
  assert.equal(refusalText({ status: 404, message: 'attachment not found' }).refresh, true, 'a thing of the task that is gone leaves the card as it was');
  assert.equal(refusalText({ status: 500 }).refresh, false);
  assert.equal(refusalText({ offline: true }).gone, false);
});

test('a refusal after the action that failed goes through the board\'s translation, both parts', () => {
  const tr = (s) => `ru:${s}`;
  assert.equal(refusalLine('Could not attach', { status: 400, message: 'limit of attachments per task: 30' }, tr),
    'ru:Could not attach: ru:the task already holds as many images as it can');
});

const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
const inDict = (s) => dict.includes(`'${s}':`) || dict.includes(`"${s}":`);
test('what a refusal says is in the Russian dictionary — the sentence, the reason and the name of the action', () => {
  const errors = [
    { offline: true }, { status: 404 }, { status: 404, message: 'the task to link to was not found' }, { status: 404, message: 'project not found' },
    { status: 404, message: 'no Claude of the board works on this task' }, { status: 404, message: 'attachment not found' },
    { status: 409, message: 'the Claude app is not installed here' }, { status: 413 }, { status: 501 }, { status: 500 },
    { status: 400, message: 'cannot go straight from "a" to "b"' }, { status: 400, message: 'images only' },
    { status: 400, message: 'limit of images in comments: 30' }, { status: 400, message: 'x' },
  ];
  const said = errors.flatMap((e) => [refusalText(e).text, refusalText(e).reason]);
  assert.deepEqual([...new Set(said)].filter((s) => !inDict(s)), [], 'a refusal stays English on the Russian board');
  const heads = ['drawer.js', 'sse.js'].flatMap((f) => [...readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8').matchAll(/refusalLine\('([^']+)'/g)].map((m) => m[1]));
  assert.ok(heads.length >= 7, `the card and the start of Claude say ${heads.length} refusals after their action`);
  assert.deepEqual(heads.filter((h) => !inDict(h)), [], 'the name of the action stays English on the Russian board');
});

/* ── the card ── */
const drawerSrc = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const sseSrc = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
const takeFrom = (src, file) => (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const objectFrom = (src, file) => (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}`);
  return src.slice(at, src.indexOf('\n};\n', at) + 3);
};
const take = takeFrom(drawerSrc, 'drawer.js');
const settle = () => new Promise((r) => { setImmediate(r); });
const NO_TASK = () => Object.assign(new Error('task not found'), { status: 404 });
const OFFLINE = () => Object.assign(new Error('Failed to fetch'), { offline: true });
const FAILED = () => Object.assign(new Error("can't find pane: kb-1"), { status: 500 });

function card({ open = 'VV-1' } = {}) {
  const calls = { api: [], alerts: [], queued: [], closed: 0, refreshed: 0, soon: [], attachments: 0, comments: 0 };
  const box = {
    state: { drawerKey: open, tasks: [{ key: 'VV-1', pinned: 0 }, { key: 'VV-2', pinned: 1 }] },
    tr: (s) => `ru:${s}`,
    seg: (s) => encodeURIComponent(String(s)),
    refusalText, refusalLine, imageTooLarge,
    answer: () => ({}),
    api: async (method, path, body) => { calls.api.push({ method, path, body }); return box.answer(method, path, body); },
    apiBlob: async (path) => { calls.api.push({ method: 'POST', path, blob: true }); return box.answer('POST', path); },
    styledAlert: (m) => { calls.alerts.push(m); },
    styledConfirm: async () => true,
    closeDrawer: () => { calls.closed++; box.state.drawerKey = null; },
    refresh: () => { calls.refreshed++; },
    queueTaskEdit: (key, fields) => { calls.queued.push({ key, fields }); },
    closeDrawerMenu: () => {}, closeCardMenu: () => {},
    termSoon: (ms) => { calls.soon.push(ms); },
    renderAttachments: () => { calls.attachments++; },
    renderComments: () => { calls.comments++; },
    termUntrusted: new Set(),
    els: {},
    $: (id) => { if (!box.els[id]) box.els[id] = { value: '', disabled: false }; return box.els[id]; },
    commentDrafts: new Map(), autoGrow: () => {}, renderLaunchButtons: () => {},
    showWorkTab: (tab) => { calls.tab = tab; }, stopTermPoll: () => {}, savedTab: () => 'comments',
  };
  vm.runInNewContext([
    'var drawerPinned = 0; var termKey = null; var termInfo = null; var termFollow = false; var termSeen = null; var drawerTask = null;',
    take('export function sayRefused('),
    take('async function togglePinTask('),
    take('export async function cancelTask('),
    take('export async function deleteTask('),
    take('function linkRefused('),
    objectFrom(drawerSrc, 'drawer.js')('const CLAUDE_NOT_READY = {'),
    'var termPressed = false;',
    take('function selectingIn('),
    take('async function termSend('),
    take('async function termStop('),
    take('async function deleteAttachment('),
    take('async function redrawAttachments('),
    take('export async function uploadAttachment('),
    take('async function uploadCommentImage('),
  ].join('\n'), box);
  return { box, calls };
}
const leaks = (calls) => calls.alerts.filter((m) => /task not found|can't find pane|Failed to fetch|limit of|images only|Payload/.test(m));

test('pin, cancel and delete of a task deleted outside say so and take its card off the board — they said nothing', async () => {
  for (const act of ['togglePinTask', 'cancelTask', 'deleteTask']) {
    const c = card();
    c.box.answer = () => { throw NO_TASK(); };
    await c.box[act]('VV-1'); // a refusal nobody handles rejects here
    assert.deepEqual(c.calls.alerts, ['ru:This task no longer exists — it was deleted.'], `${act}: nothing is said`);
    assert.equal(c.calls.closed, 1, `${act}: the open card of the deleted task stays`);
    assert.equal(c.calls.refreshed, 1, `${act}: its ghost card stays on the board`);
  }
  const c = card();
  c.box.answer = () => { throw FAILED(); };
  await c.box.togglePinTask('VV-2'); // a card that is not the open one
  assert.equal(c.calls.closed, 0, 'a refusal of another task closes the open card');
  assert.deepEqual(leaks(c.calls), []);
  assert.match(c.calls.alerts[0], /the board answered with an error/);
});

test('without a connection pin and cancel wait in the queue like the other menu changes; a deletion is not queued', async () => {
  const c = card();
  c.box.answer = () => { throw OFFLINE(); };
  await c.box.togglePinTask('VV-1');
  await c.box.togglePinTask('VV-2');
  await c.box.cancelTask('VV-1');
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls.queued)), [
    { key: 'VV-1', fields: { pinned: 1 } }, { key: 'VV-2', fields: { pinned: 0 } }, { key: 'VV-1', fields: { status: 'cancelled' } },
  ]);
  assert.equal(c.calls.closed, 0, 'a cancel that is only queued closes the card as if it were done');
  assert.deepEqual(c.calls.alerts, []);
  await c.box.deleteTask('VV-1');
  assert.equal(c.calls.queued.length, 3, 'a deletion waits to happen later, by itself');
  assert.deepEqual(c.calls.alerts, ['ru:No connection to the board — try again']);
  assert.equal(c.calls.closed, 0);
});

test('a task deleted elsewhere and deleted here again is said once, not as a failure', async () => {
  const c = card({ open: 'VV-9' });
  c.box.answer = (m) => { if (m === 'DELETE') throw NO_TASK(); return {}; };
  await c.box.deleteTask('VV-1');
  assert.deepEqual(c.calls.alerts, ['ru:This task no longer exists — it was deleted.']);
  assert.equal(c.calls.closed, 0, 'another open card is closed');
  assert.equal(c.calls.refreshed, 1);
});

test('the link picker says a refusal in its own line, drops a chosen task that is gone and closes when its own is gone', () => {
  const picker = () => {
    const p = { failed: [], dropped: [], closed: 0 };
    return Object.assign(p, { fail: (m) => p.failed.push(m), drop: (k) => p.dropped.push(k), close: () => { p.closed++; } });
  };
  let c = card();
  let p = picker();
  c.box.linkRefused(Object.assign(new Error('the task to link to was not found'), { status: 404 }), 'VV-1', 'VV-5', p);
  assert.deepEqual(p.failed, ['ru:That task no longer exists — it was deleted.']);
  assert.deepEqual(p.dropped, ['VV-5'], 'the task that is gone stays in the list to be picked again');
  assert.equal(p.closed + c.calls.closed, 0);
  assert.equal(c.calls.refreshed, 1);
  p = picker();
  c.box.linkRefused(NO_TASK(), 'VV-1', 'VV-5', p);
  assert.equal(p.closed, 1, 'the picker of a deleted task stays open');
  assert.equal(c.calls.closed, 1);
  assert.deepEqual(p.failed, []);
  c = card();
  p = picker();
  c.box.linkRefused(FAILED(), 'VV-1', 'VV-5', p);
  c.box.linkRefused(OFFLINE(), 'VV-1', null, p); // creating the new task to link
  assert.deepEqual(p.failed, ['ru:Not saved: the board answered with an error — the details are in Settings → Errors.', 'ru:No connection to the board — try again']);
  assert.deepEqual(p.dropped, [], 'a task that is still there leaves the list');
  c.box.linkRefused(Object.assign(new Error('project not found'), { status: 404 }), 'VV-1', null, p);
  assert.equal(p.failed[2], 'ru:Not saved: the project no longer exists.');
  assert.equal(c.calls.closed, 0);
});

test('typing into the terminal: a Claude that is gone, a deleted task and a failure — each in the board\'s words', async () => {
  const typed = async (err) => {
    const c = card();
    c.box.termKey = 'VV-1';
    c.box.termInfo = { session: 's1', dead: false };
    c.box.answer = () => { throw err; };
    assert.equal(await c.box.termSend({ text: 'y', key: 'Enter' }), false);
    return c.calls;
  };
  let calls = await typed(Object.assign(new Error('Claude has exited in this terminal'), { status: 409 }));
  assert.deepEqual(calls.alerts, ['ru:Claude of the board no longer runs on this task — nothing was sent.']);
  assert.deepEqual(calls.soon, [0], 'the screen does not look again to show how Claude ended');
  calls = await typed(Object.assign(new Error('no Claude of the board works on this task'), { status: 404 }));
  assert.deepEqual(calls.alerts, ['ru:Claude of the board no longer runs on this task — nothing was sent.']);
  assert.equal(calls.closed, 0, 'no Claude on the task closes the card as if the task were deleted');
  calls = await typed(NO_TASK());
  assert.deepEqual(calls.alerts, ['ru:This task no longer exists — it was deleted.']);
  assert.equal(calls.closed, 1);
  calls = await typed(FAILED());
  assert.deepEqual(calls.alerts, ['ru:Could not type into the terminal: ru:the board answered with an error — the details are in Settings → Errors']);
  calls = await typed(OFFLINE());
  assert.deepEqual(calls.alerts, ['ru:Could not type into the terminal: ru:no connection to the board — try again']);
});

test('an attachment the server refuses says why; a deleted task takes its card off; a gone attachment is only redrawn', async () => {
  const pasted = async (err, fn = 'uploadAttachment') => {
    const c = card();
    c.box.answer = (m) => { if (m === 'POST') throw err; return { attachments: [] }; };
    await c.box[fn]({ type: 'image/png' });
    return c.calls;
  };
  let calls = await pasted(Object.assign(new Error('limit of attachments per task: 30'), { status: 400 }));
  assert.deepEqual(calls.alerts, ['ru:Could not attach: ru:the task already holds as many images as it can']);
  assert.equal(calls.attachments, 0);
  calls = await pasted(Object.assign(new Error('images only: png, jpeg, webp, gif'), { status: 400 }), 'uploadCommentImage');
  assert.deepEqual(calls.alerts, ['ru:Could not attach: ru:only PNG, JPEG, WebP and GIF images can be attached']);
  calls = await pasted(OFFLINE());
  assert.deepEqual(calls.alerts, ['ru:Could not attach: ru:no connection to the board — try again']);
  for (const fn of ['uploadAttachment', 'uploadCommentImage']) {
    calls = await pasted(NO_TASK(), fn);
    assert.deepEqual(calls.alerts, ['ru:This task no longer exists — it was deleted.'], fn);
    assert.equal(calls.closed, 1, `${fn}: the card of the deleted task stays open`);
  }
  const ok = card(); // not refused: the card draws the new one

  ok.box.answer = () => ({ attachments: [] });
  await ok.box.uploadAttachment({ type: 'image/png' });
  assert.equal(ok.calls.attachments, 1, 'a pasted image does not show up in the card');

  const removed = async (err) => {
    const c = card();
    c.box.answer = (m) => { if (m === 'DELETE') throw err; return { attachments: [] }; };
    await c.box.deleteAttachment(7);
    return c.calls;
  };
  calls = await removed(Object.assign(new Error('attachment not found'), { status: 404 }));
  assert.deepEqual(calls.alerts, [], 'an attachment deleted in another tab is a failure');
  assert.equal(calls.attachments, 1, 'the card still shows the attachment that is gone');
  calls = await removed(NO_TASK());
  assert.deepEqual(calls.alerts, ['ru:This task no longer exists — it was deleted.']);
  calls = await removed(FAILED());
  assert.deepEqual(calls.alerts, ['ru:Could not delete the attachment: ru:the board answered with an error — the details are in Settings → Errors']);
  assert.equal(calls.attachments, 0);
});

test('a stop of Claude the server refuses says why; a Claude already gone is no failure', async () => {
  const stopped = async (err) => {
    const c = card();
    c.box.termKey = 'VV-1';
    c.box.termInfo = { session: 's1', dead: true };
    c.box.answer = () => { throw err; };
    c.box.els['d-tabs'] = { querySelector: () => null };
    await c.box.termStop();
    return c.calls;
  };
  assert.deepEqual((await stopped(FAILED())).alerts, ['ru:Could not stop Claude: ru:the board answered with an error — the details are in Settings → Errors']);
  assert.deepEqual((await stopped(Object.assign(new Error('no Claude of the board works on this task'), { status: 404 }))).alerts, []);
});

test('a refused upload carries what api() refusals carry — the status, or no connection — not only the server\'s text', async () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const fromCore = takeFrom(core, 'core.js');
  const box = { reported: [], answer: null, Map };
  box.fetch = async () => box.answer();
  vm.runInNewContext([
    fromCore('export function apiError('),
    fromCore('async function answerOf('),
    'const reportError = (scope, message) => { reported.push(message); };',
    core.slice(core.indexOf('export const apiBlob = '), core.indexOf('\n};\n', core.indexOf('export const apiBlob = ')) + 3).replace(/^export /, ''),
    'out = { apiBlob };',
  ].join('\n'), box);
  box.answer = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(box.out.apiBlob('/api/tasks/VV-1/attachments', { type: 'image/png' }), (e) => e.offline === true && !e.status);
  box.answer = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ error: 'images only: png, jpeg, webp, gif' }) });
  await assert.rejects(box.out.apiBlob('/api/tasks/VV-1/attachments', { type: 'image/bmp' }),
    (e) => e.status === 400 && e.message === 'images only: png, jpeg, webp, gif' && !e.offline);
  assert.equal(box.reported.length, 2, 'a refused upload is missing from Settings → Errors');
});

/* ── the start of Claude ── */
test('a start of Claude the server refuses says why in the board\'s words — the app that is not there among them', async () => {
  const takeSse = takeFrom(sseSrc, 'sse.js');
  const alerts = [];
  const box = {
    tr: (s) => `ru:${s}`, refusalLine,
    styledAlert: (m) => alerts.push(m), flashButton: () => {}, openTerminalOf: () => {}, copyText: async () => true,
    askProjectFolder: async () => false, getSetting: () => 'board', pickedSetting: () => 'board', boardOnly, effortOf, startEffort, checksOnly, launchMode: async () => 'board',
    manualRefusal, refresh: () => {},
    refusalText, state: { drawerKey: null }, closeDrawer: () => {},
    failure: null,
    api: async () => { throw box.failure; },
  };
  vm.runInNewContext([
    takeSse('function refusedManual('),
    takeSse('function refusedCheck('),
    takeSse('function startRefused('),
    takeSse('async function postLaunch('),
    objectFrom(sseSrc, 'sse.js')('const BOARD_WHY = {'),
    takeSse('export async function launchInClaude('),
  ].join('\n'), box);
  box.failure = Object.assign(new Error('the Claude app is not installed here — pick Terminal or Copy in Settings'), { status: 409, body: {} });
  await box.postLaunch({ mode: 'desktop', text: 'x' }, null);
  box.failure = Object.assign(new Error('error: tmux: server exited unexpectedly'), { status: 500, body: {} });
  await box.launchInClaude({ text: 'x', project: 'demo', keys: ['VV-1'] });
  box.failure = Object.assign(new Error('task not found'), { status: 404, body: {} });
  await box.launchInClaude({ text: 'x', project: 'demo', keys: ['VV-1'] });
  assert.deepEqual(alerts, [
    'ru:Could not start Claude: ru:the Claude app is not installed on this computer — pick Terminal or Copy in Settings',
    'ru:Could not start Claude: ru:the board answered with an error — the details are in Settings → Errors',
    'ru:Could not start Claude: ru:the task no longer exists — it was deleted',
  ]);
  await settle();
});
