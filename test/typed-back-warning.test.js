// on it, and its Claude reported it «still in Review»: `kb note` prints no status. Every answer about such a task to a
// Claude session now carries a warning, and kb prints it to stderr — the real `bin/kb` against the real routes.
// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const SID = '99999999-2222-4333-8444-555555555555';
let app, tmp, db, base, pid, moveTyped, no = 0;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-typed-warn-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',100)").run().lastInsertRowid;
  const routes = await import('../src/routes/tasks.js');
  moveTyped = routes.moveTyped;
  app = Fastify();
  await app.register(routes.default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const kb = (args, session = SID) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base };
  delete e.CLAUDE_CODE_SESSION_ID;
  delete e.CLAUDE_CODE_HOST_SESSION_ID;
  if (session) e.CLAUDE_CODE_SESSION_ID = session;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

/** A task handed in by the session, with one checklist item: its key and id. */
function handedIn() {
  no += 1;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'review')").run(pid, no, `Task ${no}`).lastInsertRowid;
  db.prepare("INSERT INTO task_events (task_id, status, session_id) VALUES (?, 'review', ?)").run(id, SID);
  db.prepare("INSERT INTO task_checklist (task_id, text, position) VALUES (?, 'the item', 1)").run(id);
  return { key: `DM-${no}`, id };
}
const row = (id) => db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
const warned = (r, key) => r.stderr.includes(`kb: warning — ${key} is in doing — the person's words moved it back from review`);

test('words move a handed-in task to doing: note, show, check and lbl say so, once each, and say how to hand it in', async () => {
  const { key, id } = handedIn();
  assert.deepEqual(moveTyped(row(id), SID), { prep: [], doing: [key] });
  assert.equal(row(id).status, 'doing');
  for (const args of [['note', key, 'done the extra bit'], ['show', key], ['check', key, '1'], ['lbl', key, '+bug']]) {
    const r = await kb(args);
    assert.equal(r.code, 0, `${args[0]}: ${r.stderr}`);
    assert.ok(warned(r, key), `${args[0]} did not say the task is in doing: ${JSON.stringify(r.stderr)}`);
    assert.equal(r.stderr.split('kb: warning').length - 1, 1, `${args[0]} said it more than once: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`at \\d{2}:\\d{2}; .*hand it in again: kb review ${key} "…"`), r.stderr);
  }
  assert.equal(row(id).status, 'doing', 'a warning moved the task');

  const back = await kb(['review', key, 'Handed in again.']);
  assert.equal(back.code, 0, back.stderr);
  assert.ok(!back.stderr.includes('warning'), `the hand-in itself warned: ${back.stderr}`);
  assert.equal(row(id).status, 'review');
  const after = await kb(['note', key, 'one more word']);
  assert.ok(!after.stderr.includes('warning'), `handed in again, and still warned: ${after.stderr}`);
});

test('in doing without words, from no session, or after Claude moved it itself — silent', async () => {
  const plain = handedIn();
  assert.equal((await kb(['mv', plain.key, 'doing'])).code, 0);
  for (const args of [['note', plain.key, 'a word'], ['show', plain.key]]) {
    const r = await kb(args);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stderr.includes('warning'), `${args[0]} warned on a task kb itself moved: ${r.stderr}`);
  }

  const typed = handedIn();
  moveTyped(row(typed.id), SID);
  const anon = await kb(['note', typed.key, 'from a shell'], null);
  assert.equal(anon.code, 0, anon.stderr);
  assert.ok(!anon.stderr.includes('warning'), `warned with no Claude session: ${anon.stderr}`);
  // the page asks without a session too: its answer carries no warning
  const page = await (await fetch(`${base}/api/tasks/${typed.key}`)).json();
  assert.equal(page.warning, undefined);

  // a later move of Claude's own (doing → ready → doing) is no longer the words' move
  assert.equal((await kb(['mv', typed.key, 'ready'])).code, 0);
  assert.equal((await kb(['mv', typed.key, 'doing'])).code, 0);
  const own = await kb(['note', typed.key, 'mine now']);
  assert.ok(!own.stderr.includes('warning'), `warned after Claude's own move: ${own.stderr}`);
});

test('a project that ships on the word: the way back is ready, not review', async () => {
  db.prepare('UPDATE projects SET ready_gate = 1 WHERE id = ?').run(pid);
  try {
    const { key, id } = handedIn();
    moveTyped(row(id), SID);
    const r = await kb(['note', key, 'a word']);
    assert.ok(warned(r, key), r.stderr);
    assert.match(r.stderr, new RegExp(`hand it in again: kb mv ${key} ready\\n`), r.stderr);
    assert.equal((await kb(['mv', key, 'ready'])).code, 0, 'the way the warning names is refused');
  } finally {
    db.prepare('UPDATE projects SET ready_gate = NULL WHERE id = ?').run(pid);
  }
});
