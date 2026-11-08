// on it, and its Claude reported it «still in Review»: `kb note` prints no status. Every answer about such a task to a
// Claude session now carries a warning, and kb prints it to stderr — the real `bin/kb` against the real routes.
// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
  app.addHook('onSend', routes.typedBackHeader);
  await app.register(routes.default);
  await app.register((await import('../src/routes/projects.js')).default);
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

test('the session hears of the task its words left in doing from any kb it runs, and kb add offers to link them', async () => {
  const { key, id } = handedIn();
  moveTyped(row(id), SID);
  const add = await kb(['add', 'demo', 'Add more sites to the white list']);
  assert.equal(add.code, 0, add.stderr);
  const made = add.stdout.split(' ')[0];
  assert.ok(warned(add, key), `kb add did not name the task left in doing: ${JSON.stringify(add.stderr)}`);
  assert.ok(add.stderr.includes(`link them: kb link ${key} ${made}\n`), `kb add did not offer the link: ${add.stderr}`);
  for (const args of [['pri', made, 'high'], ['ls', 'demo'], ['show', made], ['show', key]]) {
    const r = await kb(args);
    assert.equal(r.code, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(warned(r, key), `kb ${args.join(' ')} did not name ${key}: ${JSON.stringify(r.stderr)}`);
    assert.equal(r.stderr.split('kb: warning').length - 1, 1, `kb ${args.join(' ')} said it more than once: ${r.stderr}`);
  }
  const desc = await kb(['desc', made, 'the list']);
  assert.ok(warned(desc, key) && !desc.stderr.includes('link them'), `only kb add offers the link: ${desc.stderr}`);

  const OTHER = '99999999-2222-4333-8444-666666666666';
  for (const args of [['show', key], ['note', key, 'a checker\'s word'], ['add', 'demo', 'Theirs'], ['ls', 'demo']]) {
    const r = await kb(args, OTHER);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stderr.includes('warning') && !r.stderr.includes('link them'), `kb ${args[0]} of another session was warned: ${r.stderr}`);
  }

  assert.equal((await kb(['review', key, 'Handed in again.'])).code, 0);
  const quiet = await kb(['ls', 'demo']);
  assert.ok(!quiet.stderr.includes('warning'), `handed in again, and still named: ${quiet.stderr}`);
});

const asSession = async (method, path, body) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { 'x-claude-session': SID, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
};
const bodyWarned = (r, key) => typeof r.json.warning?.text === 'string'
  && r.json.warning.key === key && r.json.warning.text.startsWith(`${key} is in doing — the person's words moved it back from review`);

test('a move that changes nothing and a note sent again still say the task is in doing — in the answer itself', async () => {
  const { key, id } = handedIn();
  moveTyped(row(id), SID);
  // `kb mv X doing` on a task already in doing writes the status again (planPatch); a second `kb lbl X +bug` writes nothing
  // at all — the PATCH answers from the row as it is (no updates), and that answer still says why the task is there
  const card = await asSession('GET', `/api/tasks/${key}`);
  assert.equal(card.status, 200);
  assert.ok(bodyWarned(card, key), `GET of the task did not carry the warning in its body: ${JSON.stringify(card.json.warning)}`);
  const mv = await asSession('PATCH', `/api/tasks/${key}`, { status: 'doing' });
  assert.equal(mv.status, 200, JSON.stringify(mv.json));
  assert.ok(bodyWarned(mv, key), `kb mv to the column it is in did not carry the warning: ${JSON.stringify(mv.json)}`);
  assert.ok(bodyWarned(await asSession('PATCH', `/api/tasks/${key}`, { labels_add: ['bug'] }), key));
  const updated = row(id).updated_at;
  const same = await asSession('PATCH', `/api/tasks/${key}`, { labels_add: ['bug'] });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  assert.deepEqual([row(id).status, row(id).labels, row(id).updated_at], ['doing', '["bug"]', updated], 'the second +bug wrote something: no longer the path of no updates');
  assert.ok(bodyWarned(same, key), `a PATCH that changed nothing did not carry the warning: ${JSON.stringify(same.json)}`);
  const note = { author: 'claude', body: 'the same word twice', client_key: 'typed-warn-same-key' };
  const first = await asSession('POST', `/api/tasks/${key}/comments`, note);
  assert.equal(first.status, 201);
  assert.ok(bodyWarned(first, key), JSON.stringify(first.json));
  const again = await asSession('POST', `/api/tasks/${key}/comments`, note);
  assert.equal(again.status, 200, 'the note sent again was written twice');
  assert.equal(again.json.id, first.json.id);
  assert.ok(bodyWarned(again, key), `a note sent again did not carry the warning: ${JSON.stringify(again.json)}`);
});

test('words that took a task from To do into prep say nothing of Review', async () => {
  no += 1;
  const id = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`).lastInsertRowid;
  const key = `DM-${no}`;
  assert.deepEqual(moveTyped(row(id), SID), { prep: [key], doing: [] });
  const last = db.prepare('SELECT e.session_id, m.kind FROM task_events e LEFT JOIN typed_moves m ON m.event_id = e.id WHERE e.task_id = ? ORDER BY e.id DESC LIMIT 1').get(id);
  assert.deepEqual({ ...last }, { session_id: SID, kind: 'typed' }, 'the case is gone: the move to prep is no typed move of the session');
  for (const [method, path, body] of [['GET', `/api/tasks/${key}`], ['POST', `/api/tasks/${key}/comments`, { author: 'claude', body: 'a word' }],
    ['PATCH', `/api/tasks/${key}`, { status: 'prep' }]]) {
    const r = await asSession(method, path, body);
    assert.ok(r.status < 300, `${method} ${path}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.warning, undefined, `${method} ${path} said a task in prep is in doing: ${JSON.stringify(r.json.warning)}`);
  }
  const shown = await kb(['show', key]);
  assert.ok(!shown.stderr.includes('warning'), shown.stderr);
});

test('the board puts the header on its root instance, so every route of it carries the word', () => {
  const src = readFileSync(fileURLToPath(new URL('../src/server.js', import.meta.url)), 'utf8');
  assert.match(src, /^app\.addHook\('onSend', typedBackHeader\);$/m);
});

test('a refused command, a route of projects and two tasks left in doing: every one is named', async () => {
  const a = handedIn();
  const b = handedIn();
  moveTyped(row(a.id), SID);
  moveTyped(row(b.id), SID);
  // … so the first is left in doing by words of its own again, as a turn that goes on with both would leave them
  db.prepare("UPDATE tasks SET status = 'doing' WHERE id = ?").run(a.id);
  const ev = db.prepare("INSERT INTO task_events (task_id, status, session_id) VALUES (?, 'doing', ?)").run(a.id, SID).lastInsertRowid;
  db.prepare("INSERT INTO typed_moves (event_id, kind) VALUES (?, 'typed')").run(ev);
  assert.equal(JSON.parse(decodeURIComponent((await fetch(`${base}/api/projects`, { headers: { 'x-claude-session': SID } })).headers.get('x-kb-typed-back'))).length, 2,
    'the case is gone: the header does not name two tasks');
  try {
    const refused = await kb(['mv', 'DM-9999', 'doing']); // the board's own refusal: 404 on the PATCH
    assert.equal(refused.code, 2, refused.stderr);
    const missing = await kb(['show', 'DM-9999']);
    assert.equal(missing.code, 2, missing.stderr);
    for (const [what, r] of [['a refused move', refused], ['an unknown task', missing], ['kb p', await kb(['p'])], ['kb info', await kb(['info', 'demo'])]]) {
      assert.ok(warned(r, a.key) && warned(r, b.key), `${what} did not name both tasks left in doing: ${JSON.stringify(r.stderr)}`);
      assert.equal(r.stderr.split('kb: warning').length - 1, 2, `${what} said it more or less than once a task: ${r.stderr}`);
    }
  } finally {
    for (const t of [a, b]) assert.equal((await kb(['review', t.key, 'Handed in again.'])).code, 0);
  }
});
