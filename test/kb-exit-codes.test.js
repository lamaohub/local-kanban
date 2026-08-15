import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

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
  reply = { status: 400, body: JSON.stringify({ error: 'cannot go straight from "backlog" to "done"' }), type: 'application/json' };
  const r = await run(['mv', 'DM-1', 'done']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /cannot go straight/);
});

test('the board failing on us (5xx) has its own code, not the one for "you may not"', async () => {
  reply = { status: 500, body: JSON.stringify({ error: 'internal error' }), type: 'application/json' };
  const r = await run(['mv', 'DM-1', 'done']);
  assert.equal(r.code, 4, 'a board 500 is still indistinguishable from a lawful refusal');
});

test('a 200 that is not JSON is a failure, not a silent success', async () => {
  reply = { status: 200, body: '<html>some other service lives on this port</html>', type: 'text/html' };
  const r = await run(['mv', 'DM-1', 'done']);
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
