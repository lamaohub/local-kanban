// — whenever it is about to ask the person; the request shows up in the card of the task the session works on,
// and the answer given there goes back to Claude Code in the shape it reads: allow / deny with a message, a
// question answered by echoing its questions with `answers`, a plan approved by echoing its input. Only the
// board's page may answer; every answer lands in the task's history and never in GitHub; a request whose hook
// stopped waiting (the person answered in Claude itself) leaves the card.
// The real bin/kb runs against the real routes on a real socket: kb speaks HTTP.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const S1 = '11111111-1111-4111-8111-111111111111'; // works on the board's tasks
const S2 = '22222222-2222-4222-8222-222222222222'; // a session the board has never heard of
const S3 = '33333333-3333-4333-8333-333333333333'; // handed its task in
const S4 = '44444444-4444-4444-8444-444444444444'; // its only task is done
const PAGE = { origin: 'http://127.0.0.1:3100', 'sec-fetch-site': 'same-origin' };
let app, tmp, base, db, kvSet, asksMod, bus;
const events = [];
let askPosts = 0; // requests the hook made to the board

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_GH_BIN = join(tmp, 'no-gh');
  ({ db, kvSet } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  asksMod = await import('../src/claude-asks.js');
  asksMod.setAskTimings({ hold: 300, gone: 400, early: 0 }); // answers at once, except where a test says otherwise
  ({ bus } = await import('../src/bus.js'));
  bus.on('event', (e) => { if (e.type.startsWith('ask.')) events.push(e); });
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','AS','Demo',6)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const no of [1, 2, 3, 4, 5]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  app = Fastify();
  app.addHook('onRequest', async (req) => { if (req.method === 'POST' && req.url === '/api/asks') askPosts++; });
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/claude.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  const move = (key, status, sid) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': sid }, payload: { status } });
  for (const k of ['AS-1', 'AS-2']) await move(k, 'prep', S1); // a batch moved to prep at once
  await move('AS-1', 'doing', S1); // the session is on AS-1
  await move('AS-3', 'prep', S3); await move('AS-3', 'doing', S3); await move('AS-3', 'review', S3);
  await move('AS-4', 'prep', S4); await move('AS-4', 'doing', S4); await move('AS-4', 'review', S4);
  db.prepare("UPDATE tasks SET status = 'done' WHERE task_no = 4").run();
});

after(async () => {
  asksMod?.resetAsks();
  await app?.close();
  for (const d of [tmp, process.env.KB_CLAUDE_DIR]) if (d) rmSync(d, { recursive: true, force: true });
});

const request = (o = {}) => ({ hook_event_name: 'PermissionRequest', session_id: S1, transcript_path: '/x.jsonl', cwd: '/x', permission_mode: 'default', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' }, ...o });
const ask = (o) => app.inject({ method: 'POST', url: '/api/asks', payload: request(o) });
const wait = (id) => app.inject({ method: 'GET', url: `/api/asks/${id}/wait` }).then((r) => r.json());
const answer = (id, body, headers = PAGE) => app.inject({ method: 'POST', url: `/api/asks/${id}/decision`, headers, payload: body });
const QUESTIONS = [
  { question: 'Which colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false },
  { question: 'Which sizes?', header: 'Sizes', options: [{ label: 'S' }, { label: 'M' }, { label: 'L' }], multiSelect: true },
];
const nextEvent = (type, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { bus.off('event', on); reject(new Error(`no ${type} within ${ms} ms`)); }, ms);
  const on = (e) => { if (e.type === type && pred(e.data)) { clearTimeout(t); bus.off('event', on); resolve(e.data); } };
  bus.on('event', on);
});
const history = (no) => db.prepare("SELECT c.author, c.body FROM task_comments c JOIN tasks t ON t.id = c.task_id WHERE t.task_no = ? ORDER BY c.id").all(no);

test('a session the board does not know gets no request, and the hook steps aside; a broken request is refused', async () => {
  assert.deepEqual((await ask({ session_id: S2 })).json(), { id: null });
  assert.deepEqual((await ask({ session_id: S4 })).json(), { id: null }, 'a session whose only task is done got one');
  for (const bad of [{ session_id: 'nope' }, { tool_name: '' }, { tool_name: 'a b' }, { tool_input: [1] }, { hook_event_name: 'PreToolUse' },
    { tool_input: { command: 'x'.repeat(300 * 1024) } }]) {
    assert.equal((await ask(bad)).statusCode, 400, JSON.stringify(bad).slice(0, 80));
  }
  for (const payload of ['[1]', '"x"']) {
    assert.equal((await app.inject({ method: 'POST', url: '/api/asks', headers: { 'content-type': 'application/json' }, payload })).statusCode, 400);
  }
});

test('the request lands on the task the session is on, and says what kind it is', async () => {
  const a = (await ask()).json();
  assert.equal(a.key, 'AS-1', 'the session is on AS-1 — the rest of its batch only waits in prep');
  assert.equal(a.kind, 'permission');
  assert.equal(a.decision, undefined, 'internals went out to the page');
  assert.equal((await ask({ tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } })).json().kind, 'question');
  assert.equal((await ask({ tool_name: 'ExitPlanMode', tool_input: { plan: 'one' } })).json().kind, 'plan');
  // a session that handed its task in and asks for something after: the request still has a card
  assert.equal((await ask({ session_id: S3 })).json().key, 'AS-3');
  asksMod.resetAsks();
});

test('only the board page gives an answer', async () => {
  const a = (await ask()).json();
  const pending = wait(a.id);
  assert.equal((await answer(a.id, { behavior: 'allow' }, {})).statusCode, 403, 'kb or curl answered for the person');
  assert.equal((await answer(a.id, { behavior: 'allow' }, { 'sec-fetch-site': 'same-origin' })).statusCode, 403, 'no Origin — not a page');
  assert.equal((await answer(a.id, { behavior: 'allow' }, { origin: PAGE.origin, 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
  assert.deepEqual(await pending, { decision: { behavior: 'allow' } });
  // a board opened by a LAN address over plain http: browsers send no Sec-Fetch-* there, the Origin has to do
  const b = (await ask()).json();
  const late = wait(b.id);
  assert.equal((await answer(b.id, { behavior: 'allow' }, { origin: 'http://192.168.1.5:3100' })).statusCode, 200);
  assert.deepEqual(await late, { decision: { behavior: 'allow' } });
});

test('an answer in the first moment after the request appeared is refused', async () => {
  // between the request and the click, and the click was taken; the poll is held long for the same reason
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  asksMod.setAskTimings({ hold: 60000, gone: 400, early: 250 });
  try {
    const a = (await ask()).json();
    const p = wait(a.id);
    assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 425, 'a click that landed as the request slid in was taken');
    mock.timers.tick(249);
    assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 425, 'the window closed early');
    mock.timers.tick(2);
    assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
    assert.deepEqual(await p, { decision: { behavior: 'allow' } });
  } finally { mock.timers.reset(); asksMod.setAskTimings({ hold: 300, gone: 400, early: 0 }); }
});

test('the three clocks end in order: the board, then kb, then Claude Code', async () => {
  const { HOOK_TIMEOUT_S, HOOK_WAIT_MS } = await import('../src/claude-hooks.js');
  assert.ok(asksMod.ASK_LIFETIME_MS < HOOK_WAIT_MS, 'kb gives up while the card still offers the request');
  assert.ok(HOOK_WAIT_MS < HOOK_TIMEOUT_S * 1000, 'Claude Code kills kb before kb ends its own wait');
});

test('every poll still open gets the answer, and so does one that comes just after', async () => {
  const a = (await ask()).json();
  const first = wait(a.id);
  const second = wait(a.id); // the hook asked again before its first poll was seen closed
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
  assert.deepEqual(await Promise.all([first, second]), [{ decision: { behavior: 'allow' } }, { decision: { behavior: 'allow' } }]);
  assert.deepEqual(await wait(a.id), { decision: { behavior: 'allow' } }, 'a poll that came as the answer went out was told the request is gone');
  assert.deepEqual(asksMod.pendingAsks(), [], 'the card kept a request that has its answer');
});

test('the answer reaches Claude even when its history line cannot be written', async () => {
  db.exec("CREATE TRIGGER no_board_lines BEFORE INSERT ON task_comments WHEN NEW.author = 'board' BEGIN SELECT RAISE(ABORT, 'disk is full'); END");
  try {
    const before = history(1).length;
    const a = (await ask()).json();
    const p = wait(a.id);
    const removed = nextEvent('ask.removed', (d) => d.id === a.id);
    assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
    assert.deepEqual(await p, { decision: { behavior: 'allow' } });
    assert.equal((await removed).outcome, 'decided');
    assert.equal(history(1).length, before);
    assert.ok(db.prepare("SELECT 1 FROM app_errors WHERE message LIKE '%history line was not written%'").get(), 'the failed history line was not logged');
  } finally { db.exec('DROP TRIGGER no_board_lines'); }
});

test('allow and deny reach the hook as Claude Code reads them; the first answer wins', async () => {
  const a = (await ask()).json();
  const p = wait(a.id);
  assert.equal((await answer(a.id, { behavior: 'deny', message: 'not on the shared branch' })).statusCode, 200);
  assert.deepEqual(await p, { decision: { behavior: 'deny', message: 'not on the shared branch' } });
  // the hook already has the first answer: the request is over
  const b = (await ask()).json();
  const q = wait(b.id);
  await answer(b.id, { behavior: 'deny' });
  assert.deepEqual(await q, { decision: { behavior: 'deny', message: 'Denied from the board' } });
  assert.equal((await answer(b.id, { behavior: 'allow' })).statusCode, 404);
  // the first answer waits for the hook's next poll: a second one does not replace it
  const d = (await ask()).json();
  assert.equal((await answer(d.id, { behavior: 'deny' })).statusCode, 200);
  assert.equal((await answer(d.id, { behavior: 'allow' })).statusCode, 409, 'a second answer replaced the first');
  assert.deepEqual(await wait(d.id), { decision: { behavior: 'deny', message: 'Denied from the board' } });
  const c = (await ask()).json();
  assert.equal((await answer(c.id, { behavior: 'maybe' })).statusCode, 400);
  asksMod.resetAsks();
});

test('a question is answered by echoing its questions with answers; a plan by echoing its input', async () => {
  const a = (await ask({ tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } })).json();
  assert.equal((await answer(a.id, { behavior: 'allow', answers: { 'Which colour?': 'Red' } })).statusCode, 400, 'a question was left unanswered');
  assert.equal((await answer(a.id, { behavior: 'allow', answers: { 'Which colour?': ['Red', 'Blue'], 'Which sizes?': ['S'] } })).statusCode, 400, 'two answers to a single choice');
  const p = wait(a.id);
  assert.equal((await answer(a.id, { behavior: 'allow', answers: { 'Which colour?': 'Blue', 'Which sizes?': ['S', 'L'] } })).statusCode, 200);
  assert.deepEqual(await p, { decision: { behavior: 'allow', updatedInput: { questions: QUESTIONS, answers: { 'Which colour?': 'Blue', 'Which sizes?': 'S, L' } } } });
  const planInput = { plan: '## Plan\n1. Do it', planFilePath: '/plans/x.md' };
  const b = (await ask({ tool_name: 'ExitPlanMode', tool_input: planInput })).json();
  const q = wait(b.id);
  await answer(b.id, { behavior: 'allow' });
  assert.deepEqual(await q, { decision: { behavior: 'allow', updatedInput: planInput } }, 'a bare allow does not approve a plan in Claude Code');
  const c = (await ask({ tool_name: 'ExitPlanMode', tool_input: planInput })).json();
  const r = wait(c.id);
  await answer(c.id, { behavior: 'deny', message: 'split step 1' });
  assert.deepEqual(await r, { decision: { behavior: 'deny', message: 'split step 1' } });
});

test('an answer given between two polls of the hook reaches the next one', async () => {
  const a = (await ask()).json();
  assert.deepEqual(await wait(a.id), { pending: true });
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
  assert.deepEqual(await wait(a.id), { decision: { behavior: 'allow' } });
  assert.deepEqual(asksMod.pendingAsks(), [], 'the request outlived its answer');
});

test('a request whose hook stopped waiting leaves the card, and an answer to it is refused', async () => {
  const before = history(1).length;
  const a = (await ask()).json();
  const gone = nextEvent('ask.removed', (d) => d.id === a.id);
  assert.deepEqual(await wait(a.id), { pending: true });
  const ev = await gone; // no poll after this one: Claude Code took the answer in its own window
  assert.equal(ev.outcome, 'gone');
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 404);
  assert.equal(history(1).length, before, 'an answer that never reached Claude went into the history');
  assert.deepEqual(asksMod.pendingAsks(), []);
});

test('an answer to a request whose hook went quiet is refused even before the request is cleared away', async (t) => {
  const a = (await ask()).json();
  assert.deepEqual(await wait(a.id), { pending: true });
  // the clock jumps: the hook has been silent for ten minutes, the clean-up timer has not run yet
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * 60_000 });
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 404, 'an answer went to a hook that is no longer there');
  t.mock.timers.reset();
  asksMod.resetAsks();
});

// The hook polled once more and died (Claude Code stopped it: the person answered in Claude, or stopped the
// session) — the board has not noticed yet, so it takes the answer: a live hook between two polls looks the same.
// Nobody picks that answer up. The request then leaves as 'gone', not 'decided', and the card that sent the answer
// must say it did not reach Claude: its block vanishing like after a delivery would pass the answer off as given.
test('an answer taken after the hook was gone never passes for a delivered one', async () => {
  const before = history(1).length;
  const a = (await ask()).json();
  assert.deepEqual(await wait(a.id), { pending: true });
  const left = nextEvent('ask.removed', (d) => d.id === a.id);
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
  assert.equal((await left).outcome, 'gone', 'an answer nobody picked up left the card as a delivered one');
  assert.equal(history(1).length, before, 'an answer that never reached Claude went into the history');
  const { removalNote } = await import('../public/js/ask-rules.js');
  assert.equal(removalNote('decided', true), null);
  assert.equal(removalNote('decided', false), null);
  assert.equal(removalNote('gone', false), 'Claude already has an answer — given in its own window');
  assert.equal(removalNote('expired', true), 'Claude stopped waiting for an answer here');
  assert.match(String(removalNote('gone', true)), /did not reach Claude/, 'the card lets an answer that never reached Claude pass for a given one');
  // the card asks these rules about the answer it sent itself, and each note has its line in the Russian dictionary
  const code = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(code('asks.js'), /removalNote\(d\.outcome, sending\.has\(d\.id\)\)/, 'the card says nothing when an answer it sent never reached Claude');
  const core = code('core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  for (const [o, mine] of [['gone', false], ['gone', true], ['expired', false]]) {
    assert.ok(dict.includes(`'${removalNote(o, mine)}':`), `"${removalNote(o, mine)}" stays English on the Russian board`);
  }
});

// an answer — given in its own window", although the answer came from the board; and a request the board lost when it
// was restarted left the card without a word. The status codes stay as they were; the refusal carries a `reason`.
test('a late answer is told why the request is over: another tab, Claude\'s own window, the wait ran out, a restart', async (t) => {
  const reason = async (id) => { const r = await answer(id, { behavior: 'allow' }); return [r.statusCode, r.json().reason]; };
  // another tab answered first: before the hook took the answer, and after
  const a = (await ask()).json();
  assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
  assert.deepEqual(await reason(a.id), [409, 'board']);
  assert.deepEqual(await wait(a.id), { decision: { behavior: 'allow' } });
  assert.deepEqual(await reason(a.id), [404, 'board'], 'a tab whose answer lost to another tab\'s is told Claude answered in its own window');
  // Claude took an answer in its own window: the hook went quiet
  const b = (await ask()).json();
  const left = nextEvent('ask.removed', (d) => d.id === b.id);
  assert.deepEqual(await wait(b.id), { pending: true });
  assert.equal((await left).outcome, 'gone');
  assert.deepEqual(await reason(b.id), [404, 'claude']);
  // the board stopped offering it: Claude stopped waiting here
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const c = asksMod.createAsk(request());
  t.mock.timers.tick(asksMod.ASK_LIFETIME_MS);
  t.mock.timers.reset();
  assert.deepEqual(asksMod.askFate(c.id), { state: 'ended', outcome: 'expired' });
  assert.deepEqual(await reason(c.id), [404, 'expired']);
  // a request the board never had — it was restarted since: the answer says when the board started
  const r = await answer('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d', { behavior: 'allow' });
  assert.deepEqual([r.statusCode, r.json().reason, r.json().started_at], [404, 'unknown', asksMod.STARTED_AT]);
  asksMod.resetAsks();
});

test('the page can ask what became of one request', async () => {
  const fate = (id) => app.inject({ method: 'GET', url: `/api/asks/${id}` });
  const a = (await ask()).json();
  assert.deepEqual((await fate(a.id)).json(), { state: 'pending' });
  await answer(a.id, { behavior: 'deny' });
  assert.deepEqual((await fate(a.id)).json(), { state: 'answered' }, 'an answer the hook has not taken yet');
  await wait(a.id);
  assert.deepEqual((await fate(a.id)).json(), { state: 'ended', outcome: 'decided' });
  const unknown = await fate('9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d');
  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { error: unknown.json().error, reason: 'unknown', started_at: asksMod.STARTED_AT });
  asksMod.resetAsks();
  assert.equal((await fate(a.id)).statusCode, 404, 'the board kept what became of requests after it forgot them');
});

test('the card says why a request is over in its own words, on the Russian board too', async () => {
  const { missedNote, refusedNote, removalNote } = await import('../public/js/ask-rules.js');
  const BOARD = 'Another tab of the board answered first — Claude has that answer';
  const RESTART = 'The board was restarted and lost this request — answer Claude in its own window';
  const LOST = 'This request is no longer waiting on the board';
  assert.equal(refusedNote('board'), BOARD);
  assert.equal(refusedNote('claude'), removalNote('gone', false));
  assert.equal(refusedNote(undefined), removalNote('gone', false), 'a refusal without a reason — an older board');
  assert.equal(refusedNote('expired'), removalNote('expired', false));
  const asked = '2026-10-06T10:00:00.000Z';
  assert.equal(refusedNote('unknown', { startedAt: '2026-10-06T10:05:00.000Z', createdAt: asked }), RESTART);
  assert.equal(refusedNote('unknown', { startedAt: '2026-10-06T09:00:00.000Z', createdAt: asked }), LOST, 'a request that came after the start was called lost by a restart');
  assert.equal(refusedNote('unknown', {}), LOST);
  // a request missing from the list after the page had no connection
  assert.equal(missedNote(null, { startedAt: '2026-10-06T10:05:00.000Z', createdAt: asked }), RESTART);
  assert.equal(missedNote({ state: 'ended', outcome: 'gone' }), removalNote('gone', false));
  assert.equal(missedNote({ state: 'ended', outcome: 'gone' }, { sentHere: true }), removalNote('gone', true));
  assert.equal(missedNote({ state: 'ended', outcome: 'expired' }), removalNote('expired', false));
  assert.equal(missedNote({ state: 'ended', outcome: 'decided' }), null);
  assert.equal(missedNote({ state: 'pending' }), null);
  const core = readFileSync(fileURLToPath(new URL('../public/js/core.js', import.meta.url)), 'utf8');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  for (const text of [BOARD, RESTART, LOST]) assert.ok(dict.includes(`'${text}':`), `"${text}" stays English on the Russian board`);
  // the card asks these rules: about a refused answer, and about a request missing from the list it reads again
  const page = readFileSync(fileURLToPath(new URL('../public/js/asks.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.match(page, /refusedNote\(e\.body\?\.reason, \{ startedAt: e\.body\?\.started_at, createdAt: a\.created_at \}\)/, 'a refused answer is not told why');
  assert.match(page, /missedNote\(fate, \{ startedAt: body\?\.started_at, createdAt: a\.created_at, sentHere: sending\.has\(a\.id\) \}\)/);
  assert.match(page, /for \(const a of shown\) if \(a\.key === state\.drawerKey && !asks\.some\(\(x\) => x\.id === a\.id\)\) explainMissed\(a\)/, 'a request gone from the list is not explained');
});

// The restart note rests on two lines of explainMissed that the checks above do not hold: a 404 is the board saying it
// does not know the request (only no connection at all says nothing), and that 404 carries when the board started. With
// either line gone the card is silent after a restart, or calls a request lost in a restart one that merely ended.
test('a request a restarted board does not know is explained by the 404 and the start it carries', () => {
  const page = readFileSync(fileURLToPath(new URL('../public/js/asks.js', import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const fn = page.slice(page.indexOf('async function explainMissed'), page.indexOf('export function applyAskEvent'));
  assert.ok(fn.startsWith('async function explainMissed') && fn.length < 1500, 'explainMissed was not found in public/js/asks.js');
  assert.match(fn, /catch \(e\) \{\s*if \(e\.status !== 404\) return;[^\n]*\n\s*body = e\.body;\s*\}/, 'a 404 of a restarted board is not taken as its answer, or the start it carries is dropped');
});

test('what became of a request is kept for half an hour, and only for the latest few hundred', (t) => {
  asksMod.setAskTimings({ hold: 300, gone: 0, early: 0 }); // an answer to a request nobody polls: it leaves as 'gone' at once
  try {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const first = asksMod.createAsk(request());
    assert.equal(asksMod.decide(first.id, { behavior: 'allow' }).reason, 'claude');
    assert.deepEqual(asksMod.askFate(first.id), { state: 'ended', outcome: 'gone' });
    t.mock.timers.tick(29 * 60_000);
    asksMod.decide(asksMod.createAsk(request()).id, { behavior: 'allow' });
    assert.deepEqual(asksMod.askFate(first.id), { state: 'ended', outcome: 'gone' }, 'forgotten before half an hour');
    t.mock.timers.tick(2 * 60_000);
    const later = asksMod.createAsk(request());
    asksMod.decide(later.id, { behavior: 'allow' });
    assert.equal(asksMod.askFate(first.id), null, 'kept past half an hour');
    for (let i = 0; i < 520; i++) asksMod.decide(asksMod.createAsk(request()).id, { behavior: 'allow' });
    assert.equal(asksMod.askFate(later.id), null, 'kept past the latest few hundred');
  } finally {
    t.mock.timers.reset();
    asksMod.setAskTimings({ hold: 300, gone: 400, early: 0 });
    asksMod.resetAsks();
  }
});

test('every answer lands in the task history in the board language, never in GitHub', async () => {
  kvSet('gh.owner', 'octocat'); kvSet('gh.repo', 'hello-world'); // sync on: a comment would be queued
  try {
    kvSet('ui.lang', 'ru');
    const a = (await ask()).json();
    const p = wait(a.id);
    await answer(a.id, { behavior: 'allow' });
    await p;
    assert.deepEqual(history(1).at(-1), { author: 'board', body: 'Разрешено с доски: Bash · npm test' });
    const m = (await ask({ tool_input: { command: 'git status\nrm -rf build\nnpm test' } })).json();
    const mp = wait(m.id);
    await answer(m.id, { behavior: 'allow' });
    await mp;
    assert.equal(history(1).at(-1).body, 'Разрешено с доски: Bash · git status (ещё строк: 2)', 'the record passed a longer command off as its first line');
    kvSet('ui.lang', 'en');
    const b = (await ask({ tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS } })).json();
    const q = wait(b.id);
    await answer(b.id, { behavior: 'allow', answers: { 'Which colour?': 'Red', 'Which sizes?': ['M'] } });
    await q;
    assert.deepEqual(history(1).at(-1), { author: 'board', body: 'Answered from the board: «Which colour?» — Red; «Which sizes?» — M' });
    const c = (await ask()).json();
    const r = wait(c.id);
    await answer(c.id, { behavior: 'deny', message: 'use the test script' });
    await r;
    assert.equal(history(1).at(-1).body, 'Denied from the board: Bash · npm test — reason: use the test script');
    const m2 = (await ask({ tool_input: { command: 'git status\nrm -rf build' } })).json();
    const mp2 = wait(m2.id);
    await answer(m2.id, { behavior: 'allow' });
    await mp2;
    assert.equal(history(1).at(-1).body, 'Allowed from the board: Bash · git status (1 more line)');
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op = 'add_comment'").get().n, 0, 'an answer went to GitHub');
  } finally {
    db.prepare("DELETE FROM kv WHERE key IN ('gh.owner','gh.repo','ui.lang')").run();
    db.prepare('DELETE FROM sync_queue').run();
  }
});

test('the page is told when a request comes and when it goes', async () => {
  events.length = 0;
  const a = (await ask()).json();
  const p = wait(a.id);
  await answer(a.id, { behavior: 'allow' });
  await p;
  assert.deepEqual(events.map((e) => e.type), ['ask.created', 'ask.removed']);
  assert.deepEqual(Object.keys(events[0].data).sort(), ['agent_id', 'created_at', 'id', 'input', 'key', 'kind', 'permission_mode', 'project', 'session_id', 'task_id', 'tool']);
  assert.equal(events[1].data.outcome, 'decided');
});

test('the card decides what it sends: answers, an own answer, a reason', async () => {
  const { answerBody, askSummary, OTHER } = await import('../public/js/ask-rules.js');
  const q = { kind: 'question', input: { questions: QUESTIONS } };
  assert.deepEqual(answerBody(q, true, { picks: [{ checked: ['Red'] }, { checked: ['S', OTHER], other: ' XL ' }] }),
    { behavior: 'allow', answers: { 'Which colour?': 'Red', 'Which sizes?': ['S', 'XL'] } });
  assert.throws(() => answerBody(q, true, { picks: [{ checked: [] }, { checked: ['S'] }] }), /Answer every question/);
  assert.throws(() => answerBody(q, true, { picks: [{ checked: [OTHER], other: '  ' }, { checked: ['S'] }] }), /own answer/);
  assert.deepEqual(answerBody(q, false, { reason: ' later ' }), { behavior: 'deny', message: 'later' });
  assert.deepEqual(answerBody({ kind: 'permission' }, false, {}), { behavior: 'deny' });
  assert.deepEqual(answerBody({ kind: 'plan' }, true, { reason: 'ignored on approve' }), { behavior: 'allow' });
  assert.equal(askSummary({ tool: 'Bash', input: { command: 'git push\n--force', description: 'Push' } }), 'git push\n--force', 'the person must see the whole command');
  assert.equal(askSummary({ tool: 'Write', input: { file_path: '/a/b.js', content: 'x' } }), '/a/b.js');
  // nothing is cut: a long harmless start must not hide the end of a command
  const long = `echo ${'a'.repeat(3000)} && rm -rf ~`;
  assert.equal(askSummary({ tool: 'Bash', input: { command: long } }), long);
  assert.ok(askSummary({ tool: 'mcp__x__y', input: { v: 'z'.repeat(5000) } }).includes('z'.repeat(5000)));
});

test('a list fetched before the latest events does not undo them', async () => {
  const { mergeAsks } = await import('../public/js/ask-rules.js');
  const A = { id: 'a' }; const B = { id: 'b' };
  // the fetch began after event 4; then event 5 removed A and event 6 brought C — the list still has A and B
  const current = [B, { id: 'c', seq: 6 }];
  assert.deepEqual(mergeAsks([A, B], current, new Set(['a']), 4), [B, { id: 'c', seq: 6 }]);
  // a request the page had from before, missing from the list, is over (its removal was missed offline)
  assert.deepEqual(mergeAsks([B], [{ id: 'old', seq: 2 }, B], new Set(), 4), [B]);
  // one the list already has is not doubled
  assert.deepEqual(mergeAsks([B, { id: 'c' }], [{ id: 'c', seq: 6 }], new Set(), 4), [B, { id: 'c' }]);
});

test('a broken question or option is left out, on the card and on the board alike', async () => {
  const { answerBody, questionsOf } = await import('../public/js/ask-rules.js');
  const input = { questions: [null, 'text', { header: 'no text' }, { question: 'Which?', options: [null, { label: 'A' }, { label: '' }, 5, { description: 'no label' }] }] };
  assert.deepEqual(questionsOf({ input }), [{ question: 'Which?', options: [{ label: 'A' }] }]);
  assert.deepEqual(questionsOf({ input: { questions: 'nope' } }), []);
  const body = answerBody({ kind: 'question', input }, true, { picks: [{ checked: ['A'] }] });
  assert.deepEqual(body, { behavior: 'allow', answers: { 'Which?': 'A' } });
  const a = (await ask({ tool_name: 'AskUserQuestion', tool_input: input })).json();
  const p = wait(a.id);
  assert.equal((await answer(a.id, body)).statusCode, 200, 'the board wanted answers to entries the card does not show');
  assert.deepEqual((await p).decision.updatedInput.answers, { 'Which?': 'A' });
});

// kb itself, as Claude Code runs it
function hook(input, env = {}) {
  let child;
  const done = new Promise((resolve) => {
    child = spawn(process.execPath, [KB, 'hook', 'permission'], { env: { ...process.env, KB_URL: base, ...env } });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('close', (code) => resolve({ code, stdout }));
    child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  });
  done.child = child;
  return done;
}
const until = async (fn, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 30)); }
};

test('kb hook permission hands the request to the board and prints the answer for Claude Code', { timeout: 20000 }, async () => {
  asksMod.resetAsks();
  // between two polls of kb: the board counted the hook gone, and the answer was refused (404) or, taken just before,
  // left as 'gone' with kb told so — kb printed nothing. That is the board's rule for a hook that really went away
  // (see 'an answer taken after the hook was gone…'), not a fault: the test only must not mistake a slow kb for one.
  asksMod.setAskTimings({ hold: 300, early: 0 });
  const run = hook(request());
  try {
    const a = await until(() => asksMod.pendingAsks()[0]);
    await new Promise((r) => setTimeout(r, 400)); // at least one poll comes back empty first
    assert.equal((await answer(a.id, { behavior: 'allow' })).statusCode, 200);
    const r = await run;
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  } finally { run.child.kill(); asksMod.setAskTimings({ hold: 300, gone: 400, early: 0 }); }
});

test('kb hook permission steps aside at once: no task, no board, not its event, broken input', { timeout: 20000 }, async () => {
  const posted = askPosts;
  for (const input of [request({ hook_event_name: 'PreToolUse' }), 'not json']) {
    const r = await hook(input);
    assert.equal(r.stdout, '');
  }
  assert.equal(askPosts, posted, 'kb went to the board with something that is not a permission request');
  for (const [input, env] of [[request({ session_id: S2 }), {}], [request(), { KB_URL: 'http://127.0.0.1:9' }],
    [request({ hook_event_name: 'PreToolUse' }), {}], ['not json', {}]]) {
    const r = await hook(input, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, '', `something went to Claude Code for ${JSON.stringify(input).slice(0, 60)}`);
  }
  assert.deepEqual(asksMod.pendingAsks(), []);
});

// A board that does not answer is no board: kb must not hold Claude's dialog on it. A port that takes the connection
// and never answers (a frozen board, another program on it) gets 3 s; a board that took the request and then went
// away gets a few tries a second apart. Either way Claude Code gets nothing and keeps asking in its own dialog.
test('kb hook permission does not wait on a board that does not answer', { timeout: 60000 }, async () => {
  const net = await import('node:net');
  const http = await import('node:http');
  const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
  const within = async (run, ms, what) => {
    let timer;
    const r = await Promise.race([run, new Promise((res) => { timer = setTimeout(() => res('late'), ms); })]);
    clearTimeout(timer);
    if (r === 'late') { run.child.kill('SIGKILL'); await run; assert.fail(`kb still waited after ${ms / 1000} s on ${what}`); }
    return r;
  };
  const sockets = new Set();
  const silent = net.createServer((sock) => { sockets.add(sock); sock.on('error', () => {}); });
  const goneAway = http.createServer((req, res) => {
    if (req.method === 'POST') { res.writeHead(201, { 'content-type': 'application/json' }); res.end('{"id":"x1"}'); return; }
    req.socket.destroy(); // every poll of the wait: the board is not there any more
  });
  try {
    const quiet = await within(hook(request(), { KB_URL: await listen(silent) }), 15000, 'a port that never answers');
    assert.deepEqual([quiet.code, quiet.stdout], [0, '']);
    const gone = await within(hook(request(), { KB_URL: await listen(goneAway) }), 15000, 'a board that went away mid-wait');
    assert.deepEqual([gone.code, gone.stdout], [0, '']);
  } finally {
    for (const sock of sockets) sock.destroy();
    silent.close();
    goneAway.close();
  }
});

test('the person answered in Claude: Claude Code stops the hook and the request leaves the card', { timeout: 20000 }, async () => {
  asksMod.resetAsks();
  const run = hook(request());
  const a = await until(() => asksMod.pendingAsks()[0]);
  const gone = nextEvent('ask.removed', (d) => d.id === a.id, 5000);
  run.child.kill('SIGTERM');
  assert.equal((await gone).outcome, 'gone');
  await run;
});

test('words left in a gone question: each once, a line each, after what the field holds', async () => {
  const { intoField, leftoverWords } = await import('../public/js/ask-rules.js');
  assert.equal(leftoverWords(['  my answer ', '', 'a note', 'my answer', undefined]), 'my answer\na note');
  assert.equal(leftoverWords(['', '  ']), '');
  assert.equal(intoField('', 'my answer'), 'my answer');
  assert.equal(intoField('half a message  \n', 'my answer'), 'half a message\nmy answer');
  assert.equal(intoField('my answer', 'my answer'), 'my answer', 'the same words were put back twice');
  assert.equal(intoField('kept', ''), 'kept');
});
