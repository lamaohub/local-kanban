// a part of it was shown: the turn is over and nothing goes on until the person types (IB-471: found 18 minutes later).
// The board reads the break off the transcript, tells its own Claude to go on, and calls the person when it cannot.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';

const S1 = '88400001-1111-4111-8111-111111111111'; // started by the board
const S2 = '88400002-2222-4222-8222-222222222222'; // started in the Terminal
let app, tmp, claude, db, brk, live;

// the lines as Claude Code 2.1.310 wrote them on a stand API that dropped the stream after a part of the answer
const TS = new Date().toISOString(); // a fresh break: one older than half an hour is the person's (breakState)
const line = (o) => JSON.stringify({ isSidechain: false, timestamp: TS, ...o });
const PROMPT = line({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'once more' }, origin: { kind: 'human' } });
const SAID = line({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Starting to answer, and then' }] } });
const BROKE = line({ type: 'assistant', uuid: 'e1', message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: 'API Error: Connection lost mid-response. The response above may be incomplete.' }] },
  error: 'server_error', truncatedAfterOutput: true, isApiErrorMessage: true, streamCutCause: 'stale_connection' });
const END = line({ type: 'system', subtype: 'turn_duration', durationMs: 900, uuid: 's1' });
const SNAP = line({ type: 'file-history-snapshot', messageId: 'x', snapshot: {} });
const WORDS = line({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'stuck?' }, origin: { kind: 'human' } });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  mkdirSync(join(claude, 'projects', '-demo'), { recursive: true });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  brk = await import('../src/api-break.js');
  live = await import('../src/claude-live.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','AB','Demo board',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const no of [1, 2]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(S1);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
  const move = (url, status, sid) => app.inject({ method: 'PATCH', url, headers: { 'x-claude-session': sid }, payload: { status } });
  await move('/api/tasks/AB-1', 'doing', S1);
  await move('/api/tasks/AB-2', 'doing', S2);
});

after(async () => {
  brk?.setBreakDeps(null);
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

test('the break is the last line of the conversation, and only a passing one', () => {
  const at = (...ls) => brk.breakIn(ls);
  assert.deepEqual(at(PROMPT, SAID, BROKE, END, SNAP), { uuid: 'e1', at: Date.parse(TS), text: 'API Error: Connection lost mid-response. The response above may be incomplete.' },
    'the lines Claude Code writes about the turn after the error are no conversation');
  assert.equal(at(PROMPT, SAID, BROKE, END, WORDS), false, 'someone has spoken since, and Claude has not answered yet');
  assert.equal(at(PROMPT, SAID, BROKE, END, line({ type: 'attachment', attachment: { type: 'queued_command', prompt: 'go' } })), false,
    'words taken in the middle of a turn are words to Claude too');
  assert.equal(at(PROMPT, SAID), null, 'a turn that ended on its words did not break — it is over as it should be');
  assert.equal(at(PROMPT, SAID, BROKE, line({ type: 'assistant', isSidechain: true, uuid: 'h', message: { content: [] } })).uuid, 'e1',
    'a helper\'s line is not the conversation');
  for (const other of [{ error: 'rate_limit' }, { error: 'authentication_failed' }, { error: 'invalid_request' }, { apiError: 'tls_untrusted_ca' }]) {
    assert.equal(at(PROMPT, line({ ...JSON.parse(BROKE), ...other })), null, `${JSON.stringify(other)} — no «go on» mends it`);
  }
  assert.equal(at(SNAP, END), undefined, 'no line of the conversation in what was read: read more');
  assert.equal(at('{"cut in the middle', BROKE).uuid, 'e1', 'a broken line is skipped');
});

test('the board tells its own Claude to go on three times in a row at most; another Claude waits for the person', () => {
  const t0 = Date.now();
  const b = { uuid: 'x1' };
  let cur = 'x1';
  assert.equal(brk.breakState('other', b, { board: false, task: 1 }, t0), 'stuck', 'the board cannot type to a Claude of the Terminal');
  assert.equal(brk.breakState('own', b, { board: true, task: 1 }, t0), 'retrying');
  brk.settleBreak('own');
  // three breaks, each right after the board's «go on»: the third «go on» is the last
  const chain = (uuid, at) => { cur = uuid; return brk.breakState('own', { uuid }, { board: true, task: 1 }, at); };
  const sent = async (at) => {
    let said = 0;
    brk.setBreakDeps({ queued: () => [], atPrompt: async () => 'idle', fieldEmpty: async () => true, breakNow: async () => ({ uuid: cur }),
      task: () => ({ id: 1, key: 'AB-1', status: 'doing' }), say: async () => { said += 1; return { ok: true }; } });
    await brk.recoverDue(at);
    return said;
  };
  return (async () => {
    assert.equal(chain('b1', t0), 'retrying');
    assert.equal(await sent(t0 + 1000), 0, 'not before the pause: the network that broke may still be down');
    assert.equal(await sent(t0 + brk.RECOVER_PAUSES_MS[0]), 1);
    assert.equal(await sent(t0 + brk.RECOVER_PAUSES_MS[0] + 1), 0, 'one «go on» a break');
    assert.equal(chain('b2', t0 + 20_000), 'retrying', 'it broke again right after the «go on»');
    assert.equal(await sent(t0 + 20_000 + brk.RECOVER_PAUSES_MS[1]), 1);
    assert.equal(chain('b3', t0 + 100_000), 'retrying');
    assert.equal(await sent(t0 + 100_000 + brk.RECOVER_PAUSES_MS[2]), 1);
    assert.equal(chain('b4', t0 + 300_000), 'stuck', 'three «go on» did not help: the person is called');
    assert.equal(await sent(t0 + 900_000), 0, 'and nothing is typed any more');
    // the person's words after the call start a chain of their own
    assert.equal(chain('b5', t0 + 1_000_000), 'retrying');
    brk.settleBreak('own');
  })();
});

test('«go on» goes only to an idle Claude with an empty field, and its refusal calls the person', async () => {
  const t0 = Date.now();
  const typed = [];
  const fakes = (o) => brk.setBreakDeps({ queued: () => [], atPrompt: async () => 'idle', fieldEmpty: async () => true,
    breakNow: async (sid) => ({ uuid: `${sid}-1` }), task: () => ({ id: 1, key: 'AB-1', status: 'doing' }),
    say: async (t, sid, what) => { typed.push(what); return { ok: true }; }, ...o });
  const due = t0 + brk.RECOVER_PAUSES_MS[0];
  const fresh = (sid) => { brk.settleBreak(sid); return brk.breakState(sid, { uuid: `${sid}-1` }, { board: true, task: 1 }, t0); };

  fresh('q');
  fakes({ queued: () => [{ id: 'q1' }] });
  await brk.recoverDue(due);
  assert.equal(typed.length, 0, 'words the person queued in the chat go instead');
  fakes({ atPrompt: async () => 'busy' });
  await brk.recoverDue(due);
  assert.equal(typed.length, 0, 'a busy Claude is not typed to');
  fakes({ fieldEmpty: async () => null });
  await brk.recoverDue(due);
  assert.equal(typed.length, 0, 'tmux did not answer: the next look');
  assert.equal(brk.breakState('q', { uuid: 'q-1' }, { board: true, task: 1 }, due), 'retrying');
  fakes({});
  await brk.recoverDue(due);
  assert.deepEqual(typed, [{ text: brk.continueText(), chat: true }], 'the words go as the chat\'s, through the delivery checked on the screen');
  assert.equal(brk.breakState('q', { uuid: 'q-1' }, { board: true, task: 1 }, due + 1000), 'retrying', 'Claude has not taken them yet');
  assert.equal(brk.breakState('q', { uuid: 'q-1' }, { board: true, task: 1 }, due + brk.SENT_WAIT_MS), 'stuck', 'typed and not taken in a minute: the person');

  fresh('f');
  fakes({ fieldEmpty: async () => false });
  await brk.recoverDue(due);
  assert.equal(brk.breakState('f', { uuid: 'f-1' }, { board: true, task: 1 }, due), 'stuck', 'something typed in its field: the person is at it — the board does not wipe it');

  fresh('r');
  fakes({ say: async () => ({ refused: 'not-sent' }) });
  await brk.recoverDue(due);
  assert.equal(brk.breakState('r', { uuid: 'r-1' }, { board: true, task: 1 }, due), 'stuck', 'the words did not reach Claude');

  fresh('x');
  fakes({ say: async () => { throw new Error('tmux went away'); } });
  await brk.recoverDue(due);
  assert.equal(brk.breakState('x', { uuid: 'x-1' }, { board: true, task: 1 }, due), 'stuck', 'a throw while typing calls the person too');

  // review: the person took the task out of work in the pause — typing would move it back to work
  fresh('m');
  fakes({ task: () => ({ id: 1, key: 'AB-1', status: 'review' }) });
  await brk.recoverDue(due);
  assert.equal(typed.length, 1, 'nothing typed to a task out of work');
  assert.equal(brk.breakChain('m'), undefined, 'and its chain is over');

  // review: someone spoke after the break between the look and the typing — it is no longer the last word
  fresh('g');
  fakes({ breakNow: async () => false });
  await brk.recoverDue(due);
  assert.equal(typed.length, 1);
  assert.equal(brk.breakChain('g'), undefined);
  brk.setBreakDeps(null);
  for (const s of ['q', 'f', 'r', 'x']) brk.settleBreak(s);
});

test('a «go on» that never got typed, and a break found long after, are the person\'s', () => {
  const t0 = Date.now();
  assert.equal(brk.breakState('never', { uuid: 'n1' }, { board: true, task: 1 }, t0), 'retrying');
  assert.equal(brk.breakState('never', { uuid: 'n1' }, { board: true, task: 1 }, t0 + brk.RECOVER_PAUSES_MS[0] + brk.SENT_WAIT_MS), 'stuck',
    'its Claude is out of reach of the board (resumed in the Terminal, a question on the screen): the card does not say «going on» for good');
  assert.equal(brk.breakState('old', { uuid: 'o1', at: t0 - 31 * 60_000 }, { board: true, task: 1 }, t0), 'stuck',
    'after a restart of the board an old break is not typed to (and rung) again');
  for (const s of ['never', 'old']) brk.settleBreak(s);
});

test('a card in work says its answer broke off — read off the transcript, not off the registry', async () => {
  const file = (sid) => join(claude, 'projects', '-demo', `${sid}.jsonl`);
  writeFileSync(file(S1), [PROMPT, SAID, BROKE, END, ''].join('\n'));
  writeFileSync(file(S2), [PROMPT, SAID, BROKE, END, ''].join('\n'));
  // the registry says idle, as after any turn
  writeFileSync(join(claude, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: S1, status: 'idle', statusUpdatedAt: 1000 }));
  writeFileSync(join(claude, 'sessions', '202.json'), JSON.stringify({ pid: 202, sessionId: S2, status: 'idle', statusUpdatedAt: 1000 }));
  const alive = (pid) => [101, 202].includes(pid);
  const none = new Map();
  const read = async () => Object.fromEntries((await live.liveTasks(alive, async () => ({ dead: false }), none, new Set(), new Set(), async () => false))
    .map((x) => [x.key, [x.claude, x.broke ?? null]]));
  assert.deepEqual(await read(), { 'AB-1': ['idle', 'retrying'], 'AB-2': ['idle', 'stuck'] },
    'the board goes on with its own Claude, the Claude of the Terminal waits for the person');
  brk.breakChain(S1).tries = 2; // as if the board had typed «go on» twice already
  appendFileSync(file(S1), `${WORDS}\n`);
  assert.deepEqual((await read())['AB-1'], ['idle', null], 'the registry a look behind the «go on» typed');
  assert.equal(brk.breakChain(S1)?.tries, 2, 'review: words not answered yet do not end the chain — or its tries start anew forever');
  writeFileSync(join(claude, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: S1, status: 'busy', statusUpdatedAt: 2000 }));
  assert.deepEqual((await read())['AB-1'], ['busy', null], 'it took words again');
  appendFileSync(file(S1), `${SAID}\n${END}\n`);
  writeFileSync(join(claude, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: S1, status: 'idle', statusUpdatedAt: 3000 }));
  assert.deepEqual((await read())['AB-1'], ['idle', null], 'a turn that ended on its words waits for you as always');
  assert.equal(brk.breakChain(S1), undefined, 'and ends the chain');
});

/* ── the page ─────────────────────────────────────────────────────────────────── */
const pub = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const take = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2); };

test('the page rings once the board cannot go on — not while it goes on by itself', () => {
  const sse = pub('js/sse.js');
  const notes = [];
  let rang = 0;
  const box = {
    playReviewSound: () => { rang += 1; }, getSetting: () => true, tr: (s) => s,
    Notification: Object.assign(function N(title, o) { notes.push({ title, ...o }); }, { permission: 'granted' }),
    window: {}, openTaskFromNotification() {},
  };
  vm.runInNewContext(`${take(sse, 'function maybeWaitingAlert(')}\nthis.run = maybeWaitingAlert;`, box);
  box.run([{ id: 1, key: 'AB-1', title: 'T', claude: 'idle', from: 'busy', broke: 'retrying', fromBroke: null }]);
  assert.equal(rang, 0, 'the board tells its Claude to go on: a blink of the network is not the person\'s');
  box.run([{ id: 1, key: 'AB-1', title: 'T', claude: 'idle', from: 'idle', broke: 'stuck', fromBroke: 'retrying' }]);
  assert.equal(rang, 1, 'the board gave up: the person is called');
  assert.equal(notes.at(-1).title, "Claude's answer broke off");
  assert.equal(notes.at(-1).renotify, true, 'the second notification of a task replaced the first silently');
  box.run([{ id: 2, key: 'AB-2', title: 'T', claude: 'idle', from: 'busy', broke: 'stuck', fromBroke: null }]);
  assert.equal(rang, 2, 'a Claude of the Terminal broke: called at once');
  box.run([{ id: 3, key: 'AB-3', title: 'T', claude: 'idle', from: 'busy' }]);
  assert.equal(notes.at(-1).title, 'Claude is waiting for you');
  assert.equal(notes.at(-1).renotify, true);
  assert.match(take(sse, 'function maybeQuestionAlert('), /renotify: true/, 'a question asked again is silent too');
  const board = pub('js/board.js');
  assert.match(board, /if \(was !== x\.claude \|\| wasBroke !== \(x\.broke \?\? null\)\) changes\.push\(\{ \.\.\.x, from: was, fromBroke: wasBroke \}\);/,
    'giving up changes no state of Claude: without its own change it would never ring');
  const core = pub('js/core.js');
  for (const w of ['connection lost · going on', 'answer broke off'])
    assert.ok(core.includes(`'${w}': '`), `no Russian for "${w}"`);
  assert.ok(core.includes(`"Claude's answer broke off": '`));
});

test('the card and the list of what waits tell a broken answer apart', () => {
  const board = pub('js/board.js');
  const box = { WORKING: new Set(['prep', 'doing', 'deploy']), state: { live: {} }, tr: (s) => s, esc: (s) => String(s), hasAsk: () => false };
  const at = board.indexOf('const LIVE_BADGE = {');
  vm.runInNewContext(`${board.slice(at, board.indexOf('\n};\n', at) + 4)}\n${take(board, 'function liveBadge(')}\nthis.run = liveBadge;`, box);
  const badge = (l) => { box.state.live = { 7: l }; return box.run({ id: 7, status: 'doing' }); };
  assert.match(badge({ claude: 'idle', broke: 'retrying' }), /live-busy[^>]*>.*connection lost · going on/);
  assert.match(badge({ claude: 'idle', broke: 'stuck', background: true }), /live-wait" title="The connection to the API broke off[^"]*did not go on[^"]*">.*answer broke off/);
  assert.match(badge({ claude: 'idle' }), /waiting for you/);

  const src = pub('js/attention.js').replace(/^import .*$/gm, '').replace(/^export /gm, '');
  const page = { state: { live: {
    1: { claude: 'idle', key: 'AB-1', broke: 'retrying' },
    2: { claude: 'idle', key: 'AB-2', broke: 'stuck', since: Date.now() - 5 * 60_000 },
    3: { claude: 'idle', key: 'AB-3', since: Date.now() - 60_000 },
  }, tasks: [] }, tr: (s) => s, esc: (s) => String(s), $: () => null, pendingAsks: () => [], Date };
  vm.runInNewContext(`${src}\nthis.waitingNow = waitingNow; this.whyText = whyText;`, page);
  const items = page.waitingNow();
  assert.deepEqual(Array.from(items, (i) => i.key), ['AB-2', 'AB-3'], 'the board goes on with AB-1 by itself');
  assert.equal(page.whyText(items[0]), 'answer broke off · 5 min');
  assert.match(page.whyText(items[1]), /^waiting for you/);
});

test('the dashboard\'s «Waiting for you» says the same', () => {
  const dash = readFileSync(new URL('../src/routes/dashboard.js', import.meta.url), 'utf8');
  assert.match(dash, /x\.broke !== 'retrying'\)/, 'a Claude the board goes on with does not wait for the person');
  assert.match(dash, /\.\.\.\(x\.broke \? \{ broke: x\.broke \} : \{\}\)/);
  const settings = pub('js/settings.js');
  const box = { tr: (s) => s, Date };
  vm.runInNewContext(`${take(settings, 'function claudeMeta(')}\nthis.run = claudeMeta;`, box);
  assert.equal(box.run({ claude: 'idle', broke: 'stuck', since: Date.now() - 3 * 60_000 }), 'answer broke off · 3 min');
  assert.equal(box.run({ claude: 'idle' }), 'waiting for you');
});
