import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const PORT = 3100;
const SELF = { host: `127.0.0.1:${PORT}` };
let app, tmp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;

  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Task', 'backlog')").run(pid);

  const { makeOriginGuard } = await import('../src/origin-guard.js');
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  app.addHook('onRequest', makeOriginGuard(PORT));
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const dup = (headers) => app.inject({ method: 'POST', url: '/api/tasks/DM-1/duplicate', headers });

test('POST from a foreign Origin is rejected (403), no task is created', async () => {
  const r = await dup({ ...SELF, origin: 'https://evil.example', 'content-type': 'text/plain' });
  assert.equal(r.statusCode, 403);
});

test('POST with an unexpected Host is rejected (421) — DNS rebinding', async () => {
  const r = await dup({ host: 'kanban.evil.example' });
  assert.equal(r.statusCode, 421);
});

test('POST with Sec-Fetch-Site: cross-site is rejected (403) even without an Origin', async () => {
  const r = await dup({ ...SELF, 'sec-fetch-site': 'cross-site' });
  assert.equal(r.statusCode, 403);
});

test('GET from a foreign Origin is rejected too — the board cannot be read from outside', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?all=1', headers: { ...SELF, origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 403);
});

test('kb (no Origin, no Sec-Fetch-Site) passes', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=demo&all=1', headers: SELF });
  assert.equal(r.statusCode, 200);
});

test('the board in a browser (same-origin) passes and the task is created', async () => {
  const r = await dup({ ...SELF, origin: `http://127.0.0.1:${PORT}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(r.statusCode, 201);
});

test('localhost and [::1] on the same port count as our own', async () => {
  for (const host of [`localhost:${PORT}`, `[::1]:${PORT}`]) {
    const r = await app.inject({ method: 'GET', url: '/api/tasks?project=demo', headers: { host, origin: `http://${host}` } });
    assert.equal(r.statusCode, 200, host);
  }
});

test('following a bookmark (Sec-Fetch-Site: none) passes', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/tasks?project=demo', headers: { ...SELF, 'sec-fetch-site': 'none' } });
  assert.equal(r.statusCode, 200);
});

test('a host listed in KB_ALLOWED_HOSTS is accepted', async () => {
  process.env.KB_ALLOWED_HOSTS = 'kanban.local:8080';
  const { makeOriginGuard } = await import('../src/origin-guard.js');
  const guard = makeOriginGuard(PORT);
  const seen = [];
  const reply = { code(c) { seen.push(c); return this; }, send() { return this; } };
  let passed = false;
  guard({ headers: { host: 'kanban.local:8080', origin: 'http://kanban.local:8080' } }, reply, () => { passed = true; });
  delete process.env.KB_ALLOWED_HOSTS;
  assert.equal(passed, true);
  assert.deepEqual(seen, []);
});
