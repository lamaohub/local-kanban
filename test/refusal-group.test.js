// of its tasks (multiPatchEach) — part of the selection did not move, and nothing said which or why; a drop the board
// refused put the card back with no word; a group drop stopped on the first refusal, unsaid. And a refusal of the title or
// the description named no field: the card held the whole edit, and a resend dropped the whole queue with it.
// Run: node --test. KB_DATA_DIR isolates the database.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { changedFields, createRefusedTyped, refusalText, refusedFields } from '../public/js/unsaved.js';

let app, tmp;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo', 'GR', 'demo', 3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'one', 'todo'), (?, 2, 'two', 'doing')").run(pid, pid);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const patch = (key, payload) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload });
const asError = (r) => ({ status: r.statusCode, message: r.json().error, body: r.json() });

test('a refusal of one field names it, and the card takes back that field alone', async () => {
  for (const [body, field] of [[{ description: {} }, 'description'], [{ title: [] }, 'title'], [{ priority: 9 }, 'priority'],
    [{ labels: 'bug' }, 'labels'], [{ position: 'x' }, 'position'], [{ status: 'nope' }, 'status'], [{ status: 'review' }, 'status']]) {
    const sent = { ...body, title: body.title ?? 'kept', priority: body.priority ?? 2 };
    const r = await patch('GR-1', sent);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().field, field, `a refusal of ${field} named no field`);
    assert.deepEqual(refusedFields(asError(r), sent), [field], `the card would hold the rest of the edit with ${field}`);
  }
  // the changes of the set of labels (kb lbl) name the field too
  for (const body of [{ labels_add: 'bug' }, { labels_remove: 'bug' }]) {
    const r = await patch('GR-1', body);
    assert.deepEqual([r.statusCode, r.json().field], [400, 'labels'], `a refusal of ${Object.keys(body)[0]} named no field`);
  }
  // the rest of that edit goes through on its own
  assert.equal((await patch('GR-1', { title: 'kept', priority: 2 })).statusCode, 200);
});

const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
const take = (head) => { const at = board.indexOf(head); assert.ok(at >= 0, head); return board.slice(at, board.indexOf('\n}\n', at) + 2); };
const tr = (s) => s;

function page(answer) {
  const said = [];
  const box = {
    tr, refusalText, said, seg: (s) => s, state: { tasks: [] },
    selectedTaskList: () => [{ key: 'GR-1' }, { key: 'GR-2' }, { key: 'GR-3' }],
    api: async (m, url) => answer(url.split('/').pop()), refresh: async () => {}, styledAlert: (t) => said.push(t),
  };
  vm.createContext(box);
  vm.runInContext(`${take('export function refusedManyText(').replace('export ', '')}\n${take('function sayRefusedMany(')}\n${take('async function multiPatchEach(')}
this.run = multiPatchEach; this.text = refusedManyText;`, box);
  return box;
}
const STRAIGHT = Object.assign(new Error('cannot go straight from "todo" to "review" — it has to pass through the working statuses'), { status: 400 });
const GONE = Object.assign(new Error('task not found'), { status: 404 });

test('a group action says which tasks did not change and why, one line a reason', async () => {
  const box = page((key) => { if (key === 'GR-1' || key === 'GR-3') throw STRAIGHT; return {}; });
  await box.run(() => ({ status: 'review' }), 'Not moved');
  assert.equal(box.said.length, 1, 'the refusals were swallowed');
  assert.equal(box.said[0], `Not moved — GR-1, GR-3: ${refusalText(STRAIGHT).reason}`);
  assert.match(box.said[0], /has to go through work first/);
  // two reasons, two lines; nothing refused — nothing said
  const two = page((key) => { if (key === 'GR-1') throw STRAIGHT; if (key === 'GR-2') throw GONE; return {}; });
  await two.run(() => ({ priority: 3 }));
  assert.deepEqual(two.said[0].split('\n').map((l) => l.split(':')[0]), ['Not saved', 'GR-1', 'GR-2'], 'a heading, then one line a reason');
  const none = page(() => ({}));
  await none.run(() => ({ priority: 3 }));
  assert.deepEqual(none.said, []);
  // a long list is cut
  const keys = Array.from({ length: 9 }, (_, i) => ({ key: `GR-${i + 1}`, e: STRAIGHT }));
  assert.match(box.text('Not moved', keys), /^Not moved — GR-1, GR-2, GR-3, GR-4, GR-5, GR-6 \+3: /);
});

test('a drop the board refused says so, and a group drop says what of it did not move', () => {
  const drop = take('async function onDrop(');
  assert.match(drop, /catch \(e\) \{[\s\S]*sayRefusedMany\('Not moved', \[\{ key: t\.key, e \}\]\)/, 'a refused drop went back with no word');
  const group = take('async function onDropGroup(');
  assert.match(group, /catch \(e\) \{ failed\.push\(/, 'one refusal stopped the rest of the group');
  assert.match(group, /sayRefusedMany\('Not moved', failed\)/);
  assert.doesNotMatch(take('async function multiPatchEach('), /catch \{/, 'a refusal is swallowed again');
});

test('a message of several lines keeps them in the window', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.modal-title \{[^}]*white-space: pre-line/);
});

// again, was refused again and called itself — 2000 PATCH in 10 s with the card open, and the title typed with it never saved
test('a refused field waits in the form until it is changed: the rest is saved once, and the resend ends', async () => {
  const refused = createRefusedTyped();
  const snapshot = { title: 'one', description: '' };
  const form = { title: 'one, renamed', description: { not: 'a string' } }; // the server refuses this description
  let sent = 0;
  // resendTaskEdit's way: what the form changed, without what was refused; a refusal of a field sends the rest again
  const resend = async () => {
    const dirty = refused.without('GR-1', changedFields(form, snapshot), form);
    if (!Object.keys(dirty).length) return;
    sent += 1;
    assert.ok(sent < 10, 'the resend does not end');
    const r = await patch('GR-1', dirty);
    if (r.statusCode === 200) { Object.assign(snapshot, dirty); return; }
    const back = refusedFields(asError(r), dirty);
    assert.ok(back.length, 'a refusal without its field');
    refused.keep('GR-1', back, dirty);
    return resend();
  };
  await resend();
  assert.equal(sent, 2, 'the refused edit, then the rest of it');
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/GR-1' })).json().title, 'one, renamed', 'the rest of the edit was not saved');
  assert.ok(refused.has('GR-1'), 'the card forgot what is still not saved');
  await resend();
  assert.equal(sent, 2, 'an unchanged refused field went again');
  form.description = 'typed again';
  await resend();
  assert.equal(sent, 3, 'a field changed after its refusal does not go');
  assert.equal(refused.has('GR-1'), false);
  // labels and status are taken back by the card, not kept here
  refused.keep('GR-2', ['labels', 'status'], { labels: ['x'], status: 'done' });
  assert.equal(refused.has('GR-2'), false);
});

// board's refusals of the rest opened a second window over it. One window says both.
test('a group drop says the refusals of the page and of the board in one window', async () => {
  const said = [];
  const tasks = [{ id: 1, key: 'GR-1', status: 'todo', labels: [] }, { id: 2, key: 'GR-2', status: 'backlog', labels: [] },
    { id: 3, key: 'GR-3', status: 'todo', labels: [] }];
  const box = {
    tr, refusalText, state: { tasks }, dragGroupIds: [1, 2, 3], WORKING: new Set(['prep', 'doing', 'deploy']),
    taskIsNoclaude: () => false, seg: (s) => s, columnComparator: () => () => 0, DEFAULT_SORT: 'pos', colSort: () => 'pos',
    dropPh: { remove() {} }, dropSends: false, clearSelection() {}, refresh: async () => {}, styledAlert: (t) => said.push(t),
    plural: (n, a, b) => (n === 1 ? a : b),
    api: async (m, url) => { if (url.endsWith('/3')) throw STRAIGHT; return {}; },
  };
  vm.createContext(box);
  const line = (head) => { const at = board.indexOf(head); assert.ok(at >= 0, head); return board.slice(at, board.indexOf('\n', at)); };
  vm.runInContext(`${['const DRAG_LOCKED', 'const CREATABLE', 'const NO_DIRECT_FROM', 'const NO_DIRECT_TO'].map(line).join('\n')}
${take('export function moveBlocked(').replace('export ', '')}\n${take('export function refusedManyText(').replace('export ', '')}
${take('function sayRefusedMany(')}\n${take('async function onDropGroup(')}\nthis.drop = onDropGroup;`, box);
  // all three barred by the page: one window
  await box.drop({ clientY: 0 }, 'doing', { querySelectorAll: () => [] });
  assert.equal(said.length, 1, `two windows: ${JSON.stringify(said)}`);
  assert.match(said[0], /^Not moved — GR-1, GR-2, GR-3: working columns are moved by Claude only$/);
  said.length = 0;
  // GR-1 is the page's (Claude moves it), GR-3 the board's refusal, GR-2 goes: still one window, a line each
  tasks[0].status = 'doing'; tasks[1].status = 'backlog'; tasks[2].status = 'backlog';
  await box.drop({ clientY: 0 }, 'todo', { querySelectorAll: () => [] });
  assert.equal(said.length, 1, `two windows: ${JSON.stringify(said)}`);
  assert.deepEqual(said[0].split('\n'), ['Not moved:', 'GR-1: Claude moves these columns itself', `GR-3: ${refusalText(STRAIGHT).reason}`]);
});

// the window of refusals speaks the board's language: the head of the action and each reason go through tr()
test('the window of refusals translates its head and every reason the board gave', () => {
  const box = page(() => ({}));
  box.tr = (s) => `ru:${s}`;
  const reason = refusalText(STRAIGHT).reason;
  assert.equal(box.text('Not moved', [{ key: 'GR-1', e: STRAIGHT }]), `ru:Not moved — GR-1: ru:${reason}`, 'the head or the reason stays English on the Russian board');
  assert.equal(box.text('Not saved', [{ key: 'GR-1', e: STRAIGHT }, { key: 'GR-2', e: GONE }]),
    `ru:Not saved:\nGR-1: ru:${reason}\nGR-2: ru:${refusalText(GONE).reason}`);
  assert.equal(box.text('Not moved', [{ key: 'GR-1', why: 'said already' }]), 'ru:Not moved — GR-1: said already', 'a reason in the page\'s words is translated twice');
});

// a single drop (onDrop of public/js/board.js, run on stand-ins): its PATCH is quiet (the refusal is said here, not as an
// error of the page); a refusal of the board is said with the head of a move; no connection queues it, with no window
test('a single drop: a quiet PATCH, a refusal said as «Not moved», no connection queued with no window', async () => {
  const { dropPatch } = await import('../public/js/order.js');
  const said = [];
  const queued = [];
  const sent = [];
  let refusal = null;
  const tasks = [{ id: 1, key: 'GR-1', status: 'todo', labels: [], position: 1 }];
  const box = {
    tr, refusalText, state: { tasks }, dragGroupIds: null, WORKING: new Set(['prep', 'doing', 'deploy']),
    taskIsNoclaude: () => false, seg: (s) => s, columnComparator: () => () => 0, DEFAULT_SORT: 'pos', colSort: () => 'pos',
    dropPh: { remove() {} }, dropSends: false, $: () => ({ querySelector: () => null }), dropPatch,
    renderBoard() {}, refresh: async () => {}, styledAlert: (t) => said.push(t), noteUnsaved: (f) => queued.push(f),
    plural: (n, a, b) => (n === 1 ? a : b),
    api: async (m, url, body, opts) => { sent.push({ m, url, body, opts }); if (refusal) throw refusal; return {}; },
  };
  vm.createContext(box);
  const line = (head) => { const at = board.indexOf(head); assert.ok(at >= 0, head); return board.slice(at, board.indexOf('\n', at)); };
  vm.runInContext(`${['const DRAG_LOCKED', 'const CREATABLE', 'const NO_DIRECT_FROM', 'const NO_DIRECT_TO'].map(line).join('\n')}
${take('export function moveBlocked(').replace('export ', '')}\n${take('export function refusedManyText(').replace('export ', '')}
${take('function sayRefusedMany(')}\n${take('async function onDrop(')}\nthis.drop = onDrop;`, box);
  const drop = () => box.drop({ preventDefault() {}, dataTransfer: { getData: () => '1' }, clientY: 0 }, 'backlog', { classList: { remove() {} }, querySelectorAll: () => [] });
  await drop();
  assert.equal(sent.length, 1, 'the drop sent nothing');
  assert.equal(sent[0].opts?.quiet, true, 'a refused drop is logged as an error of the page');
  assert.deepEqual(said, []);
  refusal = STRAIGHT;
  await drop();
  assert.deepEqual(said, [`Not moved — GR-1: ${refusalText(STRAIGHT).reason}`], 'a refused drop is not said as a move');
  said.length = 0;
  refusal = Object.assign(new Error('Failed to fetch'), { offline: true });
  await drop();
  assert.equal(queued.length, 1, 'a drop with no connection is not queued');
  assert.deepEqual(said, [], 'a drop with no connection shows a window over the badge of the queue');
});
