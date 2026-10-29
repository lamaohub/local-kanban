// two words and the card's autosave, which sends the whole field, erased the plan without a word — two tabs the same.
// The card now sends the description its edit started from (`description_base`): one changed since is left as it is,
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, db;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',10)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, description, status, labels) VALUES (?, 1, 'task', 'the start', 'todo', '[]')").run(pid);
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const patch = (body) => app.inject({ method: 'PATCH', url: '/api/tasks/DM-1', payload: body });
const now = () => db.prepare('SELECT title, description FROM tasks WHERE task_no = 1').get();

test('an edit from the description shown goes in', async () => {
  const r = await patch({ description: 'the start, and mine', description_base: 'the start' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().description_conflict, undefined);
  assert.equal(now().description, 'the start, and mine');
});

test('an edit from a description changed since leaves that one, saves the rest and says so', async () => {
  await patch({ description: 'the plan of Claude' }); // kb desc: no base, the last word as before
  const r = await patch({ title: 'renamed', description: 'the start, and mine, and more', description_base: 'the start, and mine' });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().description_conflict, true);
  assert.equal(r.json().description, 'the plan of Claude', 'the answer does not carry the description that stays');
  assert.deepEqual(now(), { title: 'renamed', description: 'the plan of Claude' }, 'the plan was erased, or the title was not saved');
  const only = await patch({ description: 'mine again', description_base: 'the start, and mine' });
  assert.equal(only.json().description_conflict, true, 'an edit of the description alone told nothing');
  assert.equal(now().description, 'the plan of Claude');
});

test('picked over theirs (the base is theirs now), or the same text already there — no conflict', async () => {
  const r = await patch({ description: 'mine, picked', description_base: 'the plan of Claude' });
  assert.equal(r.json().description_conflict, undefined);
  assert.equal(now().description, 'mine, picked');
  const same = await patch({ description: 'mine, picked', description_base: 'something old' });
  assert.equal(same.json().description_conflict, undefined, 'the same words on both sides are no conflict');
});

test('a base that is not text is refused', async () => {
  const r = await patch({ description: 'x', description_base: 42 });
  assert.equal(r.statusCode, 400);
  assert.equal(now().description, 'mine, picked');
});

test('the card sends the base with the description and holds the description while the pick waits', () => {
  const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  assert.match(src, /'description' in patch && drawerSnapshot \? \{ \.\.\.patch, description_base: descBaseOf\(key\) \} : patch/);
  // review: a save still on its way is the base of the next one — two own saves in a row on a slow server are no conflict
  assert.match(src, /function descBaseOf\(key\) \{\s*return descSending\.has\(key\) \? descSending\.get\(key\) : \(drawerSnapshot\?\.description \?\? ''\);/);
  // review: the resend after a lost connection carries the base of the save that did not get there
  assert.match(src, /if \('description' in sent && typeof base === 'string'\) sent\.description_base = base;/);
  assert.match(src, /if \(descConflicts\.has\(key\)\) delete patch\.description;/);
  assert.match(src, /if \(descConflicts\.has\(key\)\) \{ delete dirty\.description; delete fields\.description; \}/, 'the resend after a lost connection sends the description over theirs');
  const init = readFileSync(new URL('../public/js/init.js', import.meta.url), 'utf8');
  assert.match(init, /if \(descConflictPending\(\)\) return true;/, 'a quiet reload of the tab drops the edit that waits');
});
