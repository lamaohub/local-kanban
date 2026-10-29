// itself, and a skill forked off runs there as a helper; both end with a notification. The board took the first for a
// step of two minutes: a test run hung in the background for 35 minutes, the chat lit «Claude works in the background…»
// with nothing under it, and Claude, asked, said nothing ran. The lines are of the shapes Claude Code 2.1.309 writes (the
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kb-bg-moved-'));
process.env.KB_CLAUDE_DIR = join(root, 'claude');
process.env.KB_DATA_DIR = join(root, 'data');
const { ownWaitIn, wentBackground } = await import('../src/own-wait.js');
const { chatItems, chatTurns } = await import('../src/chat-feed.js');
after(() => rmSync(root, { recursive: true, force: true }));

const T0 = Date.parse('2026-10-22T23:00:00Z');
let n = 0;
const at = () => new Date(T0 + (n += 1) * 1000).toISOString();
const human = (text) => JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: text } });
const tool = (id, name, input) => JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const answer = (id, text, toolUseResult) => JSON.stringify({ type: 'user', timestamp: at(), toolUseResult, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: false }] } });
const says = (text) => JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const turnEnd = () => JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(), durationMs: 60_000 });
const note = (id, task, status = 'completed') => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>Background command "Run the tests" ${status}</summary>\n</task-notification>`;
const queued = (id, task, status) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: note(id, task, status) });
const woke = (id, task, status) => JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: note(id, task, status) } });

const MOVED_TEXT = 'Command did not complete within its 120s timeout and was moved to the background (ID: bys253wdo). Output is being written to: /tmp/x/tasks/bys253wdo.output. You will be notified when it completes.';
const MOVED_RESULT = { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: 'bys253wdo', timedOutAfterMs: 120000 };
const moved = (id = 'toolu_M') => [
  tool(id, 'Bash', { command: 'node --test test/chat*.test.js | head -20', description: 'Run chat tests' }),
  answer(id, MOVED_TEXT, MOVED_RESULT),
];
const FORK_TEXT = 'Skill "code-review" launched (forked execution, running in the background).\n\nRunning in the background as @code-review';
const forked = (id = 'toolu_F') => [
  tool(id, 'Skill', { skill: 'code-review', args: 'low a..HEAD' }),
  answer(id, FORK_TEXT, { success: true, commandName: 'code-review', status: 'forked', background: true, agentId: 'a8d7665e', result: 'Running in the background as @code-review' }),
];

test('an answer that says its step went to the background names that work; any other answer — null', () => {
  const line = (raw) => JSON.parse(raw);
  const block = (d) => d.message.content[0];
  const m = line(moved()[1]);
  assert.equal(wentBackground(m, block(m)), 'bys253wdo');
  const f = line(forked()[1]);
  assert.equal(wentBackground(f, block(f)), 'a8d7665e');
  // the text alone is enough — a line of several answers has nobody's toolUseResult
  assert.equal(wentBackground({ message: { content: [block(m), block(m)] }, toolUseResult: MOVED_RESULT }, block(m)), 'bys253wdo');
  assert.equal(wentBackground({ message: { content: [] } }, { content: FORK_TEXT }), '', 'a fork with no id of its own is not background work');
  const plain = line(answer('x', 'ok', { stdout: 'ok', stderr: '' }));
  assert.equal(wentBackground(plain, block(plain)), null, 'a command that ended is said to run in the background');
  assert.equal(wentBackground({ message: { content: [] } }, { content: 'grep found "moved to the background" in a file' }), null, 'words in the output are taken for the move');
});

// work — the card said «works in the background» for two hours, the chat kept the Read «in the background» for good
test('a step whose output only quotes the words of a move is not work in the background', () => {
  const quoted = [human('read the test'),
    tool('toolu_R', 'Read', { file_path: '/x/test/background-moved.test.js' }),
    answer('toolu_R', `     1→const MOVED_TEXT = '${MOVED_TEXT}';`, { type: 'text', file: { filePath: '/x/test/background-moved.test.js', content: MOVED_TEXT } }),
    tool('toolu_C', 'Bash', { command: 'cat note.txt' }),
    answer('toolu_C', MOVED_TEXT, { stdout: MOVED_TEXT, stderr: '', interrupted: false }), // Claude Code's own word: it ended
    tool('toolu_G', 'Grep', { pattern: 'forked execution' }),
    JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_G', content: [{ type: 'text', text: `a.md:1:${FORK_TEXT}` }] }] } }),
    says('Read it.'), turnEnd()];
  assert.equal(ownWaitIn(quoted)?.own, false, 'a Claude that read the words of a move is said to wait for its own work');
  const steps = chatTurns(quoted.flatMap((l) => chatItems(JSON.parse(l)))).flatMap((t) => t.items).filter((i) => i.kind === 'tool');
  assert.deepEqual(steps.map((x) => Boolean(x.running)), [false, false, false], 'a step that only quoted the words runs in the background for good');
});

test('Claude whose command was moved to the background waits for it — till its notification', () => {
  const lines = [human('run the tests'), ...moved(), says('The run went to the background; I wait for it.'), turnEnd()];
  assert.equal(ownWaitIn(lines)?.own, true, 'a Claude waiting for its moved command is said to wait for the person');
  assert.equal(ownWaitIn([...lines, queued('toolu_M', 'bys253wdo', 'killed')])?.own, false, 'a command killed still runs');
  assert.equal(ownWaitIn([...lines, tool('toolu_K', 'TaskStop', { task_id: 'bys253wdo' })])?.own, false, 'a command Claude stopped itself still runs');
  // a service moved there is kept running, not waited for
  const tunnel = [human('open the tunnel'), tool('toolu_T', 'Bash', { command: 'ssh -N -L 9101:localhost:9101 srv' }),
    answer('toolu_T', MOVED_TEXT.replace('bys253wdo', 'btun'), { ...MOVED_RESULT, backgroundTaskId: 'btun' }), says('Tunnel up.')];
  assert.equal(ownWaitIn(tunnel)?.own, false, 'a tunnel moved to the background is waited for');
});

test('a skill forked off to the background is waited for as a helper is', () => {
  const lines = [human('review the diff'), ...forked(), says('The review runs in the background; I wait for it.'), turnEnd()];
  assert.equal(ownWaitIn(lines)?.own, true, 'a Claude waiting for its forked review is said to wait for the person');
  assert.equal(ownWaitIn([...lines, queued('toolu_F', 'a8d7665e')])?.own, false);
});

// asked «are you still working?» — the run of an older turn is not Claude's wait: it waits for the person
test('a command left running from a turn before the one a notification woke is not Claude\'s wait', () => {
  const lines = [human('do the batch'), ...moved(), ...forked(), says('Waiting for the review.'), turnEnd(),
    queued('toolu_F', 'a8d7665e'), woke('toolu_F', 'a8d7665e'), says('All seven are in Review.'), turnEnd(),
    human('are you still working?'), says('No, nothing runs.'), turnEnd()];
  assert.equal(ownWaitIn(lines)?.own, false);
});

test('the chat shows a step moved to the background as running till its notification, and a forked skill as well', () => {
  const lines = [human('do the batch'), ...moved(), ...forked(), says('Waiting for the review.'), turnEnd()];
  const steps = (ls) => chatTurns(ls.flatMap((l) => chatItems(JSON.parse(l)))).flatMap((t) => t.items).filter((i) => i.kind === 'tool');
  let [cmd, review] = steps(lines);
  assert.equal(cmd.running, true, 'a command moved to the background reads as a step of two minutes');
  assert.equal(cmd.ms, undefined, 'the move is shown as the command\'s whole time');
  assert.equal(review.running, true, 'a forked skill reads as done');
  [cmd, review] = steps([...lines, queued('toolu_F', 'a8d7665e'), queued('toolu_M', 'bys253wdo', 'killed')]);
  assert.equal(cmd.running, false, 'a killed command still runs');
  assert.equal(cmd.error, false, 'a command killed is said to have failed');
  assert.ok(cmd.ms > 0);
  assert.equal(review.running, false);
  // Claude stopped it itself: no notification follows
  [cmd] = steps([...lines, tool('toolu_K', 'TaskStop', { task_id: 'bys253wdo' })]);
  assert.equal(cmd.running, false, 'a moved command Claude stopped runs forever');
  // an ordinary step stays an ordinary step
  const [plain] = steps([human('go'), tool('toolu_P', 'Bash', { command: 'ls' }), answer('toolu_P', 'a b', { stdout: 'a b' })]);
  assert.equal(plain.running, undefined);
  assert.ok(plain.ms >= 0);
});

test('the light over a chat: Claude done with commands left running waits for the person, and says since when they run', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', plural: (k, a, b) => (k === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    wireTermImages: () => {}, chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [],
    document: { addEventListener: () => {} }, setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false,
    setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false,
    copyText: async () => true, plainLabel: (x) => String(x),
  };
  vm.runInNewContext(`${src}\nthis.workingLine = workingLine; this.liveHTML = liveHTML;`, box);
  const started = new Date(2026, 9, 23, 6, 4).toISOString();
  const cmd = { kind: 'tool', tool: 'Bash', text: 'Run chat tests', running: true, bg: true, at: started };
  const turn = { at: 't', user: 'are you still working?', items: [{ kind: 'text', text: 'No.' }], ms: 7000, open: false };
  const left = { at: 's', user: 'do the batch', items: [cmd], ms: 60_000, open: false };
  const live = box.liveHTML({ working: true, own: false, turns: [left, turn] });
  assert.match(live, /Waits for you · commands in the background/, 'a Claude done, with a command left running, is said to work');
  assert.doesNotMatch(live, /Claude works/);
  assert.match(live, /Run chat tests/, 'the command left running is not named over the field');
  assert.match(live, /in the background since 06:04/, 'since when it runs is not said');
  // it waits for that command of its own (the rule of the card's head) — it works
  assert.match(box.workingLine({ working: true, own: true, turns: [left] }), /Claude works in the background…/);
  // a forked skill is a helper: Claude works
  const review = { kind: 'tool', tool: 'Skill', text: 'code-review', running: true, at: started };
  assert.match(box.workingLine({ working: true, own: false, turns: [{ ...left, items: [review] }] }), /Claude works in the background… · helpers at work: 1/);
  // nothing known in the background, or an older board without `own` — the words as before
  assert.match(box.workingLine({ working: true, own: false, turns: [turn] }), /Claude works in the background…/);
  assert.match(box.workingLine({ working: true, turns: [left] }), /Claude works in the background…/);
});

// line, an older version) the text alone decides, and only from its first words
test('words of a move quoted inside a result, with no toolUseResult, are not a move', () => {
  const none = (content) => wentBackground({ message: { content: [{ type: 'tool_result', content }] } }, { content });
  assert.equal(none(`     1→const MOVED_TEXT = '${MOVED_TEXT}';`), null, 'a Read quoting the words of a move is taken for one');
  assert.equal(none(`log: ${MOVED_TEXT}`), null);
  assert.equal(none([{ type: 'text', text: `note\n${FORK_TEXT}` }]), null);
  assert.equal(none(MOVED_TEXT), 'bys253wdo', 'Claude Code\'s own words, alone, are no longer a move');
});

test('a moved command is Claude\'s wait for two hours from the end of its turn, then the person\'s', async () => {
  const { waitsOwnWork } = await import('../src/own-wait.js');
  const { mkdirSync, writeFileSync } = await import('node:fs');
  const lines = [human('run the tests'), ...moved('toolu_W'), says('Waiting for it.'), turnEnd()];
  const dir = join(root, 'claude', 'projects', '-two-hours');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'abcdabcd-1111-4111-8111-abcdabcdabcd.jsonl');
  writeFileSync(path, `${lines.join('\n')}\n`);
  const end = Date.parse(JSON.parse(lines.at(-1)).timestamp);
  assert.equal(await waitsOwnWork('abcdabcd-1111-4111-8111-abcdabcdabcd', end + 2 * 3600_000 - 1000, path), true);
  assert.equal(await waitsOwnWork('abcdabcd-1111-4111-8111-abcdabcdabcd', end + 2 * 3600_000, path), false, 'the wait outlives two hours');
});

// «Claude works in the background» and «waits for you · commands in the background»
test('the chat route says a Claude waits for its moved command, and not while a turn goes on', async () => {
  const { mkdirSync, writeFileSync, appendFileSync } = await import('node:fs');
  const { db } = await import('../src/db.js');
  const Fastify = (await import('fastify')).default;
  const routes = await import('../src/routes/chat.js');
  const SID = 'cdcdcdcd-1111-4111-8111-cdcdcdcdcdcd';
  const fresh = (ls) => ls.map((l, i) => JSON.stringify({ ...JSON.parse(l), timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString() }));
  const dir = join(root, 'claude', 'projects', '-route');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, `${fresh([human('run the tests'), ...moved('toolu_R2'), says('Waiting for it.'), turnEnd()]).join('\n')}\n`);
  mkdirSync(join(root, 'claude', 'sessions'), { recursive: true });
  writeFileSync(join(root, 'claude', 'sessions', '515151.json'), JSON.stringify({ sessionId: SID, pid: process.pid, status: 'busy' }));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('bgm','BGM','bg',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='bgm'").get().id;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Moved','doing')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, datetime('now'), datetime('now'))").run(task, SID);
  const app = Fastify();
  await app.register(routes.default);
  await app.ready();
  try {
    routes.forgetRegistry();
    let r = (await app.inject({ method: 'GET', url: '/api/tasks/BGM-1/chat' })).json();
    assert.equal(r.working, true);
    assert.equal(r.own, true, 'a Claude waiting for its moved command is said to wait for the person');
    // the person asks something: a turn goes on — Claude is at work, not waiting for anything of its own
    appendFileSync(path, `${fresh([human('are you done?')]).join('\n')}\n`);
    routes.forgetRegistry();
    r = (await app.inject({ method: 'GET', url: '/api/tasks/BGM-1/chat' })).json();
    assert.equal(r.turns.at(-1).open, true);
    assert.equal(r.own, false, 'a turn going on is read as a wait for its own work');
  } finally { await app.close(); }
});
