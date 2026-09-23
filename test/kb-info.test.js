// project's description, where owners keep the context for work ("the plan lives in CLAUDE.md",
// "deployed by skill X"), and not which documents the project has. The skill says "read CLAUDE.md
// first, and if there is none — README / ARCHITECTURE"; the board already finds those files for the
// project page, and Claude went looking by itself and sometimes missed.
// The real binary `bin/kb` against the real project routes on a real socket, like kb-checklist.test.js.
// Run: node --test. The database is isolated through KB_DATA_DIR (see src/db.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  const folder = (name, files) => {
    const dir = join(tmp, 'code', name);
    mkdirSync(dir, { recursive: true });
    for (const f of files) writeFileSync(join(dir, f), '# notes\n');
    return dir;
  };
  const add = db.prepare('INSERT INTO projects (slug, prefix, name, path, description) VALUES (?,?,?,?,?)');
  add.run('full', 'FU', 'full', folder('full', ['CLAUDE.md', 'README.md']), 'The plan and the status live in CLAUDE.md');
  add.run('readme', 'RM', 'readme', folder('readme', ['README.md']), null);
  add.run('bare', 'BA', 'bare', folder('bare', []), null);
  add.run('gone', 'GO', 'gone', join(tmp, 'code', 'not-there'), null);
  add.run('nopath', 'NP', 'nopath', null, 'Only a description');
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  app = Fastify();
  await app.register(projectRoutes);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const run = (args) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const lines = (r) => r.stdout.split('\n');

test('kb info prints the description and the documents the project has', async () => {
  const r = await run(['info', 'full']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('description: The plan and the status live in CLAUDE.md'), r.stdout);
  assert.ok(lines(r).includes('docs: CLAUDE.md, README.md'), r.stdout);
});

test('a missing CLAUDE.md is said out loud, with what to read instead', async () => {
  let r = await run(['info', 'readme']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('docs: no CLAUDE.md — read README.md instead'), r.stdout);
  assert.ok(!r.stdout.includes('description:'), 'an empty description gets no line');
  r = await run(['info', 'bare']);
  assert.ok(lines(r).includes('docs: no CLAUDE.md, and no README.md / ARCHITECTURE.md either'), r.stdout);
});

test('a folder that is not on this machine is not reported as a project without docs', async () => {
  const r = await run(['info', 'gone']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('docs: — the project folder does not exist on this machine'), r.stdout);
});

test('a project without a path gets no docs line, and info still works', async () => {
  const r = await run(['info', 'nopath']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r).includes('description: Only a description'), r.stdout);
  assert.ok(!r.stdout.includes('docs:'), r.stdout);
});
