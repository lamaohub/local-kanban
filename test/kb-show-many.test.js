// The real `bin/kb` against a stand-in board that records every request.
// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const tasks = { 'DM-1': 1, 'DM-2': 2, 'DM-3': 3 };
let server, base;
let seen = [];
let brokenComments = null; // the task id whose comments the board fails on

before(async () => {
  server = createServer((req, res) => {
    seen.push(req.url);
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.endsWith('/comments')) {
      const id = Number(req.url.split('/').at(-2));
      if (id === brokenComments) return send(500, { error: 'internal error' });
      return send(200, [{ id, author: 'claude', body: `report on task ${id}`, created_at: '2026-11-02 10:00:00' }]);
    }
    const k = req.url.split('/').pop();
    if (!tasks[k]) return send(404, { error: 'task not found' });
    return send(200, { id: tasks[k], key: k, status: 'todo', project: 'demo', title: `title of ${k}`, labels: [], checklist: [], links: [] });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const run = (args) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base };
  delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID; delete e.KB_DEBUG;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('every key is printed, in the order given, a line between the cards', async () => {
  const r = await run(['show', 'DM-2', 'DM-1', 'DM-3']);
  assert.equal(r.code, 0, r.stderr);
  const cards = r.stdout.split('---\n');
  assert.equal(cards.length, 3);
  assert.match(cards[0], /^DM-2 demo todo\ntitle of DM-2/);
  assert.match(cards[1], /^DM-1 demo todo\ntitle of DM-1/);
  assert.match(cards[2], /^DM-3 demo todo\ntitle of DM-3/);
});

test('every card prints its own comments', async () => {
  const r = await run(['show', 'DM-1', 'DM-2', 'DM-3']);
  assert.equal(r.code, 0, r.stderr);
  const cards = r.stdout.split('---\n');
  for (const [i, card] of cards.entries()) assert.match(card, new RegExp(`report on task ${i + 1}\\n`), `card ${i + 1}: ${card}`);
});

test('one key prints as before, with no separator', async () => {
  const r = await run(['show', 'DM-1']);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('---'));
  assert.equal(r.stderr, '');
});

test('a wrong key refuses before the first request', async () => {
  seen = [];
  const r = await run(['show', 'DM-1', '../backups?']);
  assert.equal(r.code, 2);
  assert.deepEqual(seen, []);
  assert.equal(r.stdout, '');
});

test('a task the board does not know stops there, and says at which key', async () => {
  const r = await run(['show', 'DM-1', 'DM-9', 'DM-2']);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /title of DM-1/);
  assert.ok(!r.stdout.includes('title of DM-2'));
  assert.match(r.stderr, /kb: task not found/);
  assert.match(r.stderr, /stopped at DM-9: 1 of 3 printed/);
  assert.ok(!r.stderr.includes('cut short'), 'nothing of DM-9 was printed');
});

test('a card that was refused leaves no separator hanging at the end of the output', async () => {
  const r = await run(['show', 'DM-1', 'DM-9']);
  assert.equal(r.code, 2);
  assert.ok(!r.stdout.includes('---'), r.stdout);
});

test('comments that did not load leave a card printed in part, and the words say so', async (t) => {
  t.after(() => { brokenComments = null; });
  brokenComments = 2;
  const r = await run(['show', 'DM-1', 'DM-2', 'DM-3']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stdout, /title of DM-2/, 'the head of the card stays printed');
  assert.ok(!r.stdout.includes('title of DM-3'));
  assert.match(r.stderr, /stopped at DM-2: 1 of 3 printed, DM-2 is cut short — its comments did not load/);
});

test('one key with comments that did not load says so too', async (t) => {
  t.after(() => { brokenComments = null; });
  brokenComments = 1;
  const r = await run(['show', 'DM-1']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stdout, /title of DM-1/);
  assert.match(r.stderr, /DM-1 is cut short — its comments did not load/);
  assert.ok(!r.stderr.includes('stopped at'), r.stderr);
});

test('no key is a usage refusal', async () => {
  const r = await run(['show']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /kb show <key>/);
});
