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
import { refusalText, refusedFields } from '../public/js/unsaved.js';

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
    [{ labels: 'bug' }, 'labels'], [{ position: 'x' }, 'position'], [{ status: 'nope' }, 'status']]) {
    const sent = { ...body, title: body.title ?? 'kept', priority: body.priority ?? 2 };
    const r = await patch('GR-1', sent);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().field, field, `a refusal of ${field} named no field`);
    assert.deepEqual(refusedFields(asError(r), sent), [field], `the card would hold the rest of the edit with ${field}`);
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
