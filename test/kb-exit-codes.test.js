import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let server, base;
let reply = { status: 200, body: '{}', type: 'application/json' };

before(async () => {
  server = createServer((req, res) => {
    res.writeHead(reply.status, { 'Content-Type': reply.type });
    res.end(reply.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

const run = (args, env = {}) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base, ...env } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('a lawful refusal (4xx) is code 2', async () => {
  reply = { status: 400, body: JSON.stringify({ error: 'cannot go straight from "backlog" to "review"' }), type: 'application/json' };
  const r = await run(['mv', 'DM-1', 'review']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot go straight/);
});

test('the board failing on us (5xx) has its own code, not the one for "you may not"', async () => {
  reply = { status: 500, body: JSON.stringify({ error: 'internal error' }), type: 'application/json' };
  const r = await run(['mv', 'DM-1', 'review']);
  assert.equal(r.code, 4, 'a board 500 is still indistinguishable from a lawful refusal');
});

test('a 200 that is not JSON is a failure, not a silent success', async () => {
  reply = { status: 200, body: '<html>some other service lives on this port</html>', type: 'text/html' };
  const r = await run(['mv', 'DM-1', 'review']);
  assert.notEqual(r.code, 0, 'kb reported a move that never happened');
  assert.equal(r.code, 4);
  assert.doesNotMatch(r.stdout, /undefined/, 'kb printed "undefined undefined" instead of an explanation');
  assert.match(r.stderr, /KB_URL/, 'the message does not hint at the most likely cause: the wrong port');
});

test('an unreachable board is still code 1', async () => {
  const r = await run(['p'], { KB_URL: 'http://127.0.0.1:1' });
  assert.equal(r.code, 1);
});

test('a successful call is still code 0', async () => {
  reply = { status: 200, body: '[]', type: 'application/json' };
  const r = await run(['p']);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /no projects/);
});

// the next write failed with EPIPE, and kb died with a stack of 20 lines and code 1, which says "the board is not
// responding". It stops quietly now, as cat does.
test('a reader that went away is a quiet stop, not a stack and code 1', async () => {
  const task = { id: 1, key: 'DM-1', project: 'demo', status: 'review', title: 'T', description: 'D', priority: 0, labels: [] };
  const comments = [{ id: 1, author: 'me', body: 'a remark', created_at: '2026-10-18 07:44:00' }];
  const own = createServer((req, res) => {
    const send = (d) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
    if (req.url.endsWith('/comments')) setTimeout(() => send(comments), 300); else send(task);
  });
  await new Promise((r) => own.listen(0, '127.0.0.1', r));
  try {
    // a shell pipe whose reader is gone before kb writes (`head -1` does the same once the output outgrows the pipe's
    // buffer; a pipe closed by node itself did not make kb fail)
    const dir = mkdtempSync(join(tmpdir(), 'kb-pipe-'));
    const [err, code] = [join(dir, 'err'), join(dir, 'code')];
    await new Promise((resolve) => execFile('/bin/sh', ['-c', '( "$0" "$1" show DM-1 2>"$2"; echo $? >"$3" ) | true',
      process.execPath, KB, err, code], { env: { ...process.env, KB_URL: `http://127.0.0.1:${own.address().port}` } }, resolve));
    const r = { stderr: readFileSync(err, 'utf8'), code: Number(readFileSync(code, 'utf8')) };
    rmSync(dir, { recursive: true, force: true });
    assert.equal(r.stderr, '', 'kb printed a stack');
    assert.equal(r.code, 0);
  } finally { own.close(); }
});
