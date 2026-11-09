// The real routes on a real socket and the real bin/kb. Run: node --test. The database is isolated through KB_DATA_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, db, base, PLAN_KEEP, ownerOnly;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  ({ PLAN_KEEP } = await import('../src/epics.js'));
  ({ ownerOnly } = await import('../src/share.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Editor epic', 'todo')").run(pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 2, 'Plain task', 'todo')").run(pid);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/epics.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const kb = (args, input) => new Promise((resolve) => {
  const p = execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base, CLAUDE_CODE_SESSION_ID: '' } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  if (input !== undefined) { p.stdin.end(input); }
});
const put = (key, body) => app.inject({ method: 'PUT', url: `/api/tasks/${key}/plan`, payload: { body } });

test('a task without a plan answers 404 no-plan, and its card says nothing of a plan', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks/DM-2/plan' });
  assert.equal(r.statusCode, 404);
  assert.equal(r.json().reason, 'no-plan');
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/DM-2' })).json().plan, null);
  const s = await kb(['show', 'DM-2']);
  assert.equal(s.code, 0, s.stderr);
  assert.doesNotMatch(s.stdout, /^plan:/m);
});

test('versions: a new text is the next version, the same text writes nothing, an earlier version stays readable', async () => {
  let r = await put('DM-1', '# Plan\n\n| stage | tasks |\n|---|---|\n| 1 | 12 |\n');
  assert.equal(r.statusCode, 200);
  assert.deepEqual([r.json().version, r.json().changed], [1, true]);
  r = await put('DM-1', '# Plan\r\n\r\n| stage | tasks |\r\n|---|---|\r\n| 1 | 12 |\r\n'); // the same text with CRLF
  assert.deepEqual([r.json().version, r.json().changed], [1, false], 'the same plan is no new version');
  r = await put('DM-1', '# Plan\n\nStage 1 is done.\n');
  assert.deepEqual([r.json().version, r.json().changed], [2, true]);
  const cur = (await app.inject({ method: 'GET', url: '/api/tasks/dm-1/plan' })).json();
  assert.equal(cur.version, 2);
  assert.equal(cur.current, 2);
  assert.match(cur.body, /Stage 1 is done/);
  assert.deepEqual(cur.versions.map((v) => v.version), [2, 1]);
  const old = (await app.inject({ method: 'GET', url: '/api/tasks/DM-1/plan?version=1' })).json();
  assert.match(old.body, /\| 1 \| 12 \|/);
  assert.equal(old.current, 2);
  const card = (await app.inject({ method: 'GET', url: '/api/tasks/DM-1' })).json();
  assert.deepEqual([card.plan.version, card.plan.versions_n], [2, 2]);
  assert.doesNotMatch(card.description || '', /Stage 1/, 'the plan is never copied into the description');
});

test('refusals name the field: not text, empty, too long, a version that is not a number, a version that is not there', async () => {
  for (const body of [undefined, 5, '   ', 'x'.repeat(300_001)]) {
    const r = await put('DM-2', body);
    assert.equal(r.statusCode, 400, String(body).slice(0, 20));
    assert.equal(r.json().field, 'body');
  }
  let r = await app.inject({ method: 'GET', url: '/api/tasks/DM-1/plan?version=abc' });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'GET', url: '/api/tasks/DM-1/plan?version=1&version=2' });
  assert.equal(r.statusCode, 400);
  r = await app.inject({ method: 'GET', url: '/api/tasks/DM-1/plan?version=99' });
  assert.equal(r.statusCode, 404);
  r = await put('DM-404', '# x');
  assert.equal(r.statusCode, 404);
});

test('the file: markdown, named by the key and the version', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks/DM-1/plan.md' });
  assert.equal(r.statusCode, 200);
  assert.match(r.headers['content-type'], /^text\/markdown/);
  assert.equal(r.headers['content-disposition'], 'attachment; filename="DM-1-plan.md"');
  assert.match(r.body, /Stage 1 is done/);
  const old = await app.inject({ method: 'GET', url: '/api/tasks/DM-1/plan.md?version=1' });
  assert.equal(old.headers['content-disposition'], 'attachment; filename="DM-1-plan-v1.md"');
});

test(`only the last ${'PLAN_KEEP'} versions are kept`, async () => {
  for (let i = 0; i < PLAN_KEEP + 3; i++) assert.equal((await put('DM-2', `# v${i}`)).statusCode, 200);
  const p = (await app.inject({ method: 'GET', url: '/api/tasks/DM-2/plan' })).json();
  assert.equal(p.versions.length, PLAN_KEEP);
  assert.equal(p.version, PLAN_KEEP + 3);
  assert.equal(p.versions.at(-1).version, 4);
});

test('kb plan writes from a file and from stdin, prints the plan, lists versions; kb show carries one line of it', async () => {
  const file = join(tmp, 'PLAN.md');
  writeFileSync(file, '# Plan\n\nStage 2: commands.\n');
  let r = await kb(['plan', 'DM-1', file]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-1 plan v3');
  r = await kb(['plan', 'DM-1', file]);
  assert.equal(r.stdout.trim(), 'DM-1 plan v3 (unchanged)');
  r = await kb(['plan', 'DM-1', '-'], '# Plan\n\nStage 3: MCP.\n');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-1 plan v4');
  r = await kb(['plan', 'DM-1']);
  assert.equal(r.stdout, '# Plan\n\nStage 3: MCP.\n');
  r = await kb(['plan', 'DM-1', '--version', '3']);
  assert.match(r.stdout, /Stage 2/);
  assert.match(r.stderr, /an earlier version; the current one is v4/);
  r = await kb(['plan', 'DM-1', '--versions']);
  assert.match(r.stdout.split('\n')[0], /^v4 \d{4}-\d\d-\d\d \d\d:\d\d \d+ characters \(current\)$/);
  r = await kb(['show', 'DM-1']);
  assert.match(r.stdout, /^plan: v4, \d{4}-\d\d-\d\d \d\d:\d\d, \d+ characters — kb plan DM-1 prints it$/m);
  assert.doesNotMatch(r.stdout, /Stage 3/, 'kb show does not print the plan itself');
});

test('kb plan refusals: no plan, a file that is not there, wrong words — code 2', async () => {
  let r = await kb(['plan', 'DM-404']);
  assert.equal(r.code, 2);
  r = await kb(['plan', 'DM-1', join(tmp, 'nope.md')]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot read/);
  for (const a of [['plan'], ['plan', 'DM-1', '--version'], ['plan', 'DM-1', 'a.md', 'b.md'], ['plan', '../x']]) {
    r = await kb(a);
    assert.equal(r.code, 2, a.join(' '));
  }
});

test('a guest of the Wi-Fi door reads the plan and does not write it', () => {
  assert.equal(ownerOnly('GET', '/api/tasks/:id/plan'), false);
  assert.equal(ownerOnly('GET', '/api/tasks/:id/plan.md'), false);
  assert.equal(ownerOnly('PUT', '/api/tasks/:id/plan'), true);
});

test('the plan window reads a hand-wrapped document: a lone line break is a space there, and stays a break in a chat', async () => {
  const { chatText } = await import('../public/js/chat-md.js');
  assert.equal(chatText('one\ntwo', null, { soft: true }), '<p>one two</p>');
  assert.equal(chatText('one\ntwo'), '<p>one<br>two</p>');
  assert.match(chatText('| a | b |\n|---|---|\n| 1 | 2 |', null, { soft: true }), /<table>/);
});
