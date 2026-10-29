import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let server, base;
let seen = [];
let answer = () => ({ status: 200, body: {} });

before(async () => {
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url}`);
    const { status, body } = answer(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(status === 204 ? '' : JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const run = (args, env = {}) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base, ...env };
  delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID;
  if (!env.KB_DEBUG) delete e.KB_DEBUG;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const fresh = (fn) => { seen = []; answer = fn; };
const task = { id: 7, key: 'DM-7', status: 'todo', project: 'demo', title: 'a task', labels: [], checklist: [], links: [] };

test('an argument that is not a task key never reaches the address', async () => {
  fresh(() => ({ status: 200, body: task }));
  for (const args of [['note', '../backups?', 'x'], ['unlink', '../errors?', 'x'], ['unlink', 'DM-7', '../errors?'],
    ['desc', '../projects/demo?', 'overwritten'], ['rm', '../horizons/6?'], ['mv', '..', 'done'], ['show', '.'],
    ['lbl', 'DM-7/../../backups', '+bug'], ['check', '../sync/retry?', '1']]) {
    seen = [];
    const r = await run(args);
    assert.equal(r.code, 2, `kb ${args.join(' ')} -> ${r.code}: ${r.stderr}`);
    assert.match(r.stderr, /is not a task key/);
    assert.deepEqual(seen, [], `kb ${args.join(' ')} sent ${seen}`);
  }
});

// closes nothing, whatever alias names the status, and says which command does
test('kb mv closes no task: it names kb done or kb cancel and sends nothing', async () => {
  fresh((req) => ({ status: 200, body: { ...task, status: req.method === 'PATCH' ? 'review' : task.status } }));
  for (const [st, word] of [['done', 'done'], ['dn', 'done'], ['cancelled', 'cancel'], ['cancel', 'cancel'], ['c', 'cancel']]) {
    seen = [];
    const r = await run(['mv', 'DM-7', st]);
    assert.equal(r.code, 2, `kb mv DM-7 ${st} -> ${r.code}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, new RegExp(`person's word — kb ${word} DM-7`));
    assert.deepEqual(seen, [], `kb mv DM-7 ${st} reached the board`);
  }
  seen = [];
  const r = await run(['mv', 'DM-7', 'review']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-7 review');
  assert.deepEqual(seen, ['PATCH /api/tasks/DM-7']);
});

test('a project name is one encoded path segment', async () => {
  fresh(() => ({ status: 200, body: { slug: 'a/b', prefix: 'AB', name: 'odd' } }));
  let r = await run(['info', '../backups?']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(seen, ['GET /api/projects/..%2Fbackups%3F'], 'the project went into the address as a path');
  for (const proj of ['..', '.']) {
    seen = [];
    r = await run(['svc', proj]);
    assert.equal(r.code, 2);
    assert.deepEqual(seen, [], `kb svc ${proj} reached the board as a step up the path`);
  }
});

test('a name from the prototype is an unknown command, not "the board is not responding"', async () => {
  fresh(() => ({ status: 200, body: [] }));
  for (const c of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const r = await run([c]);
    assert.equal(r.code, 2, `kb ${c} -> ${r.code}`);
    assert.match(r.stderr, /^kb p\|ls\|next\|take/, `kb ${c} printed ${r.stderr.split('\n')[0]}`);
    assert.doesNotMatch(r.stderr, /\n\s+at /, 'a raw stack again');
  }
  assert.deepEqual(seen, []);
});

test('a foreign service answering 200 {} is code 4 — never a success, and kb rm sends it no DELETE', async () => {
  fresh(() => ({ status: 200, body: {} }));
  for (const args of [['mv', 'DM-7', 'review'], ['done', 'DM-7'], ['add', 'demo', 'title'], ['p'], ['ls', 'demo'], ['next', 'demo'],
    ['take', 'demo'], ['show', 'DM-7'], ['lbl', 'DM-7', '+bug'], ['note', 'DM-7', 'hi'], ['info', 'demo'], ['svc', 'demo'],
    ['sync'], ['retry'], ['rm', 'DM-7'], ['unlink', 'DM-7', 'DM-8'], ['check', 'DM-7', '1']]) {
    const r = await run(args);
    assert.equal(r.code, 4, `kb ${args.join(' ')} -> ${r.code}: ${r.stdout}${r.stderr}`);
    assert.equal(r.stdout, '', `kb ${args.join(' ')} printed ${r.stdout}`);
    assert.match(r.stderr, /is KB_URL .* the board\?/);
  }
  assert.deepEqual(seen.filter((s) => s.startsWith('DELETE')), [], 'kb sent a DELETE to something that is not the board');
});

test('kb rm reads the task first and deletes it by the id the board gave', async () => {
  fresh((req) => (req.method === 'DELETE' ? { status: 204 } : { status: 200, body: task }));
  const r = await run(['rm', 'dm-7']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-7 deleted');
  assert.deepEqual(seen, ['GET /api/tasks/dm-7', 'DELETE /api/tasks/7']);
});

test('a trailing slash in KB_URL is not part of the address', async () => {
  fresh(() => ({ status: 200, body: [] }));
  const r = await run(['p'], { KB_URL: `${base}///` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'no projects');
  assert.deepEqual(seen, ['GET /api/projects']);
});

test('an exception inside kb is code 3 and one line; the stack only with KB_DEBUG', async () => {
  fresh(() => ({ status: 200, body: { key: 'DM-7', status: 'todo', title: 't' } }));
  let r = await run(['show', 'DM-7']);
  assert.equal(r.code, 3, `an exception inside kb exited with ${r.code} — the same code as "the board is down" when it is 1`);
  assert.match(r.stderr, /^kb: internal error — .+ \(stack trace: KB_DEBUG=1\)\n$/);
  r = await run(['show', 'DM-7'], { KB_DEBUG: '1' });
  assert.equal(r.code, 3);
  assert.match(r.stderr, /\n\s+at /, 'KB_DEBUG=1 no longer prints the stack');
});
