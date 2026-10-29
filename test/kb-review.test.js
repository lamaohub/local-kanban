// the note on the card with exit code 2, and the retry after `kb mv <key> doing` added a second one — the
// kanban skill carried a rule just to work around it. Now the move goes first and the note only after it.
// The real `bin/kb` against a stand-in board that records every request.
// Run: node --test
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
    res.end(JSON.stringify(body));
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
const task = { id: 7, key: 'DM-7', status: 'review', project: 'demo', title: 'a task', labels: [], checklist: [], links: [] };
const comment = { id: 1, author: 'claude', body: 'done' };

test('a refused move leaves no note on the card', async () => {
  seen = [];
  answer = (req) => (req.method === 'PATCH'
    ? { status: 400, body: { error: 'cannot go straight from "todo" to "review" — it has to pass through the working statuses' } }
    : { status: 201, body: comment });
  const r = await run(['review', 'DM-7', 'done']);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /cannot go straight/);
  assert.deepEqual(seen, ['PATCH /api/tasks/DM-7'], 'the note was written for a move that did not happen');
});

test('the move goes first, the note after it', async () => {
  seen = [];
  answer = (req) => (req.method === 'PATCH' ? { status: 200, body: task } : { status: 201, body: comment });
  const r = await run(['review', 'DM-7', 'done']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'DM-7 review 📝');
  assert.deepEqual(seen, ['PATCH /api/tasks/DM-7', 'POST /api/tasks/DM-7/comments']);
  assert.equal(r.stderr, '');
});

test('a note that did not save after the move says so and how to add it', async () => {
  seen = [];
  answer = (req) => (req.method === 'PATCH' ? { status: 200, body: task } : { status: 500, body: { error: 'internal error' } });
  const r = await run(['review', 'DM-7', 'done']);
  assert.equal(r.code, 4, r.stderr);
  assert.match(r.stderr, /DM-7 is in review, but the note did not save — kb note DM-7/);
});
