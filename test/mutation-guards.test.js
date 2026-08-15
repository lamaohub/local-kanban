
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

let app, tmp, db, restore, backupNow, listBackups;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  ({ backupNow, listBackups } = await import('../src/backup.js'));
  restore = await import('../src/restore.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','Demo',100)").run();

  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const post = (payload) => app.inject({ method: 'POST', url: '/api/tasks', payload: { project: 'demo', ...payload } });
const patch = (key, payload) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, payload });

test('a board opened from a backup cannot reach GitHub', async () => {
  db.prepare("INSERT INTO kv(key, value) VALUES('gh.owner','someone') ON CONFLICT(key) DO UPDATE SET value='someone'").run();
  db.prepare("INSERT INTO kv(key, value) VALUES('gh.repo','someone/board') ON CONFLICT(key) DO UPDATE SET value='someone/board'").run();
  db.prepare("INSERT INTO sync_queue (op, payload) VALUES ('create_issue','{}')").run();
  await backupNow();

  const snapshot = listBackups()[0];
  const checked = restore.inspectBackup(readFileSync(join(tmp, 'backups', snapshot.name)));
  assert.equal(checked.ok, true, checked.error);
  try {
    const { default: Database } = await import('better-sqlite3');
    const copy = new Database(join(checked.dir, 'kanban.db'), { readonly: true });
    const kv = Object.fromEntries(copy.prepare('SELECT key, value FROM kv').all().map((r) => [r.key, r.value]));
    const queued = copy.prepare('SELECT COUNT(*) n FROM sync_queue').get().n;
    copy.close();
    assert.equal(kv['gh.owner'], undefined, 'the copy still knows the owner\'s repository and would write to it');
    assert.equal(kv['gh.repo'], undefined, 'the copy still knows the owner\'s repository and would write to it');
    assert.equal(kv['sync.paused'], '1', 'the sync is not paused in the copy');
    assert.equal(queued, 0, 'the copy inherited a queue of operations aimed at the real repository');
  } finally {
    rmSync(checked.dir, { recursive: true, force: true });
    db.prepare("DELETE FROM kv WHERE key IN ('gh.owner','gh.repo')").run();
    db.prepare('DELETE FROM sync_queue').run();
  }
});

test('a label outside the palette is refused at the door, on POST and on PATCH', async () => {
  const bad = await post({ title: 'x', labels: ['definitely-not-in-the-palette'] });
  assert.equal(bad.statusCode, 400, 'an unknown label is saved silently and then breaks the sync for good');
  assert.match(bad.json().error, /unknown labels/i);

  const ok = await post({ title: 'y', labels: ['bug'] });
  assert.equal(ok.statusCode, 201);
  const key = ok.json().key;
  const badPatch = await patch(key, { labels: ['bug', 'nope'] });
  assert.equal(badPatch.statusCode, 400, 'PATCH lets an unknown label through');
  assert.equal((await patch(key, { labels: [] })).statusCode, 200);
});

test('a noclaude task may go straight to done, a normal one may not', async () => {
  const manual = (await post({ title: 'done by hand', labels: ['noclaude'] })).json();
  assert.equal((await patch(manual.key, { status: 'done' })).statusCode, 200,
    'a manual task is locked out of done — it never passes through the working columns');

  const normal = (await post({ title: 'an ordinary one' })).json();
  const refused = await patch(normal.key, { status: 'done' });
  assert.equal(refused.statusCode, 400, 'the rule "not past the work" stopped being enforced');
  assert.match(refused.json().error, /working statuses/);
});

test('position must be a finite number', async () => {
  const t = (await post({ title: 'position' })).json();
  for (const bad of ['up', {}, [], null, NaN, Infinity]) {
    const r = await patch(t.key, { position: bad });
    assert.equal(r.statusCode, 400, `position: ${JSON.stringify(bad)} was accepted`);
  }
  assert.equal((await patch(t.key, { position: 12.5 })).statusCode, 200);
});

test('esc() escapes every character that can break out of markup or an attribute', async () => {
  const src = readFileSync(fileURLToPath(new URL('../public/js/core.js', import.meta.url)), 'utf8');
  const m = src.match(/export function esc\(s\) \{[\s\S]*?\n\}/);
  assert.notEqual(m, null, 'esc() is gone from core.js');
  const esc = new Function(`${m[0].replace('export ', '')}; return esc;`)();

  assert.equal(esc('<b>'), '&lt;b&gt;');
  assert.equal(esc('a&b'), 'a&amp;b');
  assert.equal(esc('say "hi"'), 'say &quot;hi&quot;');
  assert.equal(esc("it's"), 'it&#39;s');
  assert.equal(esc('" onerror="alert(1)'), '&quot; onerror=&quot;alert(1)');
  assert.equal(esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
});
