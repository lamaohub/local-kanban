// The chat of a session (src/chat-feed.js, GET /api/tasks/:id/chat) against the transcript shapes Claude Code writes that
// the main chat tests do not feed it: a notification written ONLY as a queue-operation (most real ones), or as a line of
// the user (Claude Code before 2.1.300); background work that failed or could not start; Claude's text longer than a
// screen; the answer to a question of Claude's; and a Claude at its prompt with commands of its own still running.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const SID = 'abcdabcd-7777-4777-8777-abcdabcdabcd';
const SECRET = 'result-text-that-must-stay-on-the-machine';
let app, tmp, claude, dir, chat;

const line = (o) => `${JSON.stringify(o)}\n`;
const at = (s) => `2026-10-22T11:00:${String(s).padStart(2, '0')}.000Z`;
const user = (s, text) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
const said = (s, text) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'text', text }] } });
const call = (s, id, name, input) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (s, id, text, error = false) => line({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] } });
const note = (id, status) => `<task-notification>\n<task-id>t-${id}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>${status}</status>\n<summary>done</summary>\n<result>${SECRET}</result>\n</task-notification>`;
const queued = (s, id, status = 'completed') => line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), content: note(id, status) });
const legacy = (s, id, status = 'completed') => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: note(id, status) } });

let n = 0;
async function chatOf(text) {
  const p = join(dir, `t${++n}.jsonl`);
  writeFileSync(p, text);
  return chat.transcriptChat(p);
}
const steps = (c) => c.turns.flatMap((t) => t.items.filter((i) => i.kind === 'tool'));

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-chat-shapes-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-chat-shapes-claude-'));
  dir = join(claude, 'projects', '-shapes');
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(claude, 'sessions'));
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_CLAUDE_DIR: claude, KB_TMUX_SOCKET: `kb-chat-shapes-${process.pid}` });
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  chat = await import('../src/chat-feed.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('sh','SH','shapes',2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='sh'").get().id;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Shapes','doing')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 11:00:00', '2026-10-22 11:00:09')").run(task, SID);
  writeFileSync(join(dir, `${SID}.jsonl`), user(1, 'Run the suite') + call(2, 'c1', 'Bash', { command: 'npm test', description: 'Run the suite', run_in_background: true })
    + result(3, 'c1', 'Command running in background with ID: b1.') + said(4, 'It runs.') + line({ type: 'system', subtype: 'turn_duration', timestamp: at(5), durationMs: 3000 }));
  app = Fastify();
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const k of ['KB_CLAUDE_DIR', 'KB_TMUX_SOCKET']) delete process.env[k];
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

test('Claude\'s words go whole up to the limit, and longer ones are cut with an ellipsis', async () => {
  const long = 'word '.repeat(1000).trim(); // 4999 characters: several screens, well under the limit
  const huge = 'x'.repeat(chat.CHAT_TEXT_MAX + 500);
  const c = await chatOf(user(1, long) + said(2, long) + said(3, huge));
  const [whole, cut] = c.turns[0].items;
  assert.equal(c.turns[0].user, long, 'the person\'s words are cut');
  assert.equal(whole.text, long, 'Claude\'s words are cut');
  assert.equal(cut.text.length, chat.CHAT_TEXT_MAX);
  assert.ok(cut.text.endsWith('…'));
});

test('the answer to a question of Claude\'s is shown; what any other step returned is not', async () => {
  const c = await chatOf(user(1, 'Pick one')
    + call(2, 'q1', 'AskUserQuestion', { questions: [{ question: 'Which database?' }] })
    + result(3, 'q1', 'User answered: Postgres')
    + call(4, 'b1', 'Bash', { command: 'cat .env', description: 'Read the env' })
    + result(5, 'b1', `KEY=${SECRET}`));
  const [ask, cmd] = steps(c);
  assert.equal(ask.text, 'Which database?');
  assert.equal(ask.answer, 'User answered: Postgres', 'the chat does not show what the person answered');
  assert.equal(cmd.answer, undefined);
  assert.ok(!JSON.stringify(c).includes(SECRET), 'what a command returned is in the chat');
});

test('background work ends with a notification written only as a queue-operation — the shape of most real ones', async () => {
  const c = await chatOf(user(1, 'Check it')
    + call(2, 'h1', 'Agent', { description: 'Check the site', prompt: 'x', run_in_background: 'true' })
    + result(3, 'h1', 'Async agent launched successfully.')
    + said(4, 'Waiting.')
    + queued(20, 'h1'));
  const [helper] = steps(c);
  assert.equal(helper.running, false, 'a helper whose notification came as a queue-operation still runs');
  assert.equal(helper.ms, 18000, 'its time is not the whole run');
  assert.equal(helper.error, false);
  assert.equal(c.turns.length, 1);
  assert.ok(!JSON.stringify(c).includes(SECRET), 'what the helper reported is in the chat');
});

test('a notification written as a line of the user (Claude Code before 2.1.300) ends the work and is not the person\'s words', async () => {
  const c = await chatOf(user(1, 'Build it')
    + call(2, 'c1', 'Bash', { command: 'npm run build', description: 'Build', run_in_background: true })
    + result(3, 'c1', 'Command running in background with ID: b1.')
    + legacy(30, 'c1'));
  const [cmd] = steps(c);
  assert.equal(cmd.running, false, 'a command whose notification came as a user line still runs');
  assert.equal(cmd.ms, 28000);
  assert.equal(c.turns.length, 1, 'the notification began a turn of the person');
  assert.ok(!JSON.stringify(c).includes('task-notification'));
});

test('background work that failed reads as failed — at its end, or already at its start', async () => {
  const c = await chatOf(user(1, 'Go')
    + call(2, 'c1', 'Bash', { command: 'npm test', description: 'Run the suite', run_in_background: true })
    + result(3, 'c1', 'Command running in background with ID: b1.')
    + call(4, 'c2', 'Bash', { command: 'nope', description: 'Start the watcher', run_in_background: true })
    + result(5, 'c2', 'Error: could not start', true)
    + call(6, 'h1', 'Agent', { description: 'Review', prompt: 'x', run_in_background: true })
    + result(7, 'h1', 'Async agent launched successfully.')
    + queued(20, 'c1', 'failed')
    + queued(21, 'h1', 'completed'));
  const [suite, watcher, review] = steps(c);
  assert.equal(suite.running, false);
  assert.equal(suite.error, true, 'background work that failed reads as done well');
  assert.equal(watcher.error, true);
  assert.equal(watcher.running, false, 'background work that could not even start reads as running');
  assert.equal(review.error, false);
});

test('a Claude at its prompt with commands of its own running (`shell` in the registry) is lit; one at rest is not', async () => {
  const { forgetRegistry } = await import('../src/routes/chat.js');
  const look = async (status) => {
    writeFileSync(join(claude, 'sessions', '5150.json'), JSON.stringify({ sessionId: SID, pid: process.pid, status }));
    forgetRegistry();
    const res = await app.inject({ method: 'GET', url: '/api/tasks/SH-1/chat' });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().working;
  };
  assert.equal(await look('shell'), true, 'a Claude waiting for its own command in the background has no light');
  assert.equal(await look('busy'), true);
  assert.equal(await look('idle'), false, 'a Claude at rest is lit');
});

test('background work Claude stopped itself ends at the stop: no notification ever follows a TaskStop or KillShell', async () => {
  const c = await chatOf(user(1, 'Wait for DNS')
    + call(2, 'w1', 'Bash', { command: 'until dig +short x; do sleep 5; done', description: 'Wait for DNS', run_in_background: true })
    + result(3, 'w1', 'Command running in background with ID: bmx1.')
    + call(4, 'w2', 'Bash', { command: 'sleep 600', description: 'Sleep long', run_in_background: 'true' })
    + line({ type: 'user', timestamp: at(5), toolUseResult: { backgroundTaskId: 'bmx2' }, message: { content: [{ type: 'tool_result', tool_use_id: 'w2', content: 'started' }] } })
    + call(6, 'w3', 'Bash', { command: 'npm run build', description: 'Build', run_in_background: true })
    + result(7, 'w3', 'Command running in background with ID: bmx3.')
    + call(9, 'k1', 'TaskStop', { task_id: 'bmx1' })
    + result(10, 'k1', '{"message":"Successfully stopped task: bmx1"}')
    + call(12, 'k2', 'KillShell', { shell_id: 'bmx2' })
    + result(13, 'k2', 'killed')
    + said(14, 'Stopped them.') + line({ type: 'system', subtype: 'turn_duration', timestamp: at(15), durationMs: 14000 }));
  const [dns, nap, build] = steps(c).filter((s) => s.bg);
  assert.equal(dns.running, false, 'work stopped with TaskStop runs forever in the chat');
  assert.equal(dns.ms, 7000, 'the time of stopped work is not from its launch to its stop');
  assert.equal(nap.running, false, 'work stopped with KillShell (its id from toolUseResult) runs forever in the chat');
  assert.equal(build.running, true, 'a stop of other work ended work that still runs');
  assert.ok(!c.turns.some((t) => t.items.some((i) => i.kind === 'halt')), 'a stop went out to the page as an item');
});

test('a question answered gives its pairs of question and answer, from the line Claude Code writes or from its text', async () => {
  const Q1 = 'IB-194: the upload hangs at 40%. Go through inst.bot?';
  const Q2 = 'IB-192: caching. What do we do?';
  const asked = { questions: [{ question: Q1, header: 'IB-194', options: [] }, { question: Q2, header: 'IB-192', options: [] }] };
  const structured = line({ type: 'user', timestamp: at(3), toolUseResult: { questions: asked.questions, answers: { [Q1]: 'Through inst.bot', [Q2]: ['Skeletons', 'Cache'] } },
    message: { content: [{ type: 'tool_result', tool_use_id: 'q1', content: 'User has answered your questions: …' }] } });
  let [ask] = steps(await chatOf(user(1, 'Go') + call(2, 'q1', 'AskUserQuestion', asked) + structured));
  assert.deepEqual(ask.answers, [{ q: Q1, h: 'IB-194', a: 'Through inst.bot' }, { q: Q2, h: 'IB-192', a: 'Skeletons, Cache' }]);
  assert.equal(ask.asked, undefined, 'what the chat matched the answers by goes out');
  // no structured line: the pairs of the result's text
  [ask] = steps(await chatOf(user(1, 'Go') + call(2, 'q1', 'AskUserQuestion', asked)
    + result(3, 'q1', `User has answered your questions: "${Q1}"="Through inst.bot", "${Q2}"="Skeletons". You can now continue with the user's answers in mind.`)));
  assert.deepEqual(ask.answers.map((x) => [x.h, x.a]), [['IB-194', 'Through inst.bot'], ['IB-192', 'Skeletons']]);
  // declined: no pairs, the step stays a step with its answer
  [ask] = steps(await chatOf(user(1, 'Go') + call(2, 'q1', 'AskUserQuestion', asked) + result(3, 'q1', 'The user declined to answer', true)));
  assert.equal(ask.answers, undefined);
});

test('the chat names the model of the newest answer of the session, a helper\'s left out', async () => {
  const answer = (s, model, extra = {}) => line({ type: 'assistant', timestamp: at(s), ...extra, message: { model, content: [{ type: 'text', text: 'ok' }] } });
  let c = await chatOf(user(1, 'Go') + answer(2, 'claude-opus-5-5') + answer(3, 'claude-haiku-5-5', { isSidechain: true }));
  assert.equal(c.model, 'claude-opus-5-5');
  c = await chatOf(user(1, 'Go') + answer(2, 'claude-opus-5-5') + user(3, 'switch') + answer(4, 'claude-sonnet-5-5'));
  assert.equal(c.model, 'claude-sonnet-5-5');
  c = await chatOf(user(1, 'Go') + answer(2, '<synthetic>'));
  assert.equal(c.model, null, 'the board\'s own synthetic line names a model');
});
