// the shapes Claude Code 2.1.300 writes (the owner's transcripts of RP-9, IS-25 and TBF-107, 15.10.2026), values made up.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'kb-own-wait-'));
process.env.KB_CLAUDE_DIR = join(root, 'claude');
process.env.KB_DATA_DIR = join(root, 'data');
const { ownWaitIn, waitsOwnWork, isService, OWN_WAIT_MAX_MS } = await import('../src/own-wait.js');

const T0 = Date.parse('2026-10-15T17:06:00Z');
let n = 0;
const at = () => new Date(T0 + (n += 1) * 1000).toISOString();
const human = (text) => JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: text } });
const skill = () => JSON.stringify({ type: 'user', isMeta: true, timestamp: at(), message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: …' }] } });
const bg = (id, command, name = 'Bash') => JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: name === 'Bash' ? { command, run_in_background: true } : { prompt: command, run_in_background: true } }] } });
const tool = (id, command) => JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
const result = (id, text) => JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const says = (text) => JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
const note = (id) => `<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
const queued = (id) => JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: note(id) });
const system = () => JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at() });

after(() => rmSync(root, { recursive: true, force: true }));

test('a turn that started a command of its own in the background waits for it (RP-9)', () => {
  const lines = [human('measure the modes'), skill(), bg('toolu_A', 'zsh bench2.sh ~/v'), result('toolu_A', 'Command running in background with ID: bb4zv7ban.'),
    says('The second round runs, 15–20 minutes. When it is done I will sum it up.'), system()];
  assert.equal(ownWaitIn(lines)?.own, true, 'a Claude waiting for its measurement is said to wait for you');
  assert.ok(ownWaitIn(lines).at > T0, 'no time of the end of the turn');
});

test('a background agent of the turn counts too', () => {
  assert.equal(ownWaitIn([human('go'), bg('toolu_G', 'review the diff', 'Agent'), result('toolu_G', 'Async agent launched'), says('The agent reviews.')])?.own, true);
});

test('a background agent flagged with the string "true" counts too', () => {
  const agent = JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_S', name: 'Agent', input: { description: 'check', prompt: 'x', run_in_background: 'true' } }] } });
  assert.equal(ownWaitIn([human('go'), agent, result('toolu_S', 'Async agent launched'), says('Waiting for the helpers.')])?.own, true, 'a Claude waiting for its helpers is said to wait for you');
});

test('a tunnel, a server, a tail — Claude keeps them running and does not wait for them (IS-25)', () => {
  const lines = [human('connect the accounts'), bg('toolu_S', 'ssh -o ExitOnForwardFailure=yes -N -L 3250:127.0.0.1:3250 root@10.0.0.2'),
    result('toolu_S', 'Command running in background with ID: x1.'), says('Paste the tokens and write "done".')];
  assert.equal(ownWaitIn(lines)?.own, false, 'a Claude asking for tokens with a tunnel open is said to work');
  for (const c of ['ssh -L 8080:localhost:80 host', 'ssh -fN host', 'tail -f logs/out.log', 'npm run dev', 'pnpm dev', 'npx vite', 'python3 -m http.server 8000', 'pm2 logs bot'])
    assert.equal(isService(c), true, `${c} is taken for work that ends`);
  for (const c of ['zsh bench.sh', 'until grep -q done out.log; do sleep 30; done', 'node --test', 'ssh root@10.0.0.2 "grep x log"', 'npm run build'])
    assert.equal(isService(c), false, `${c} is taken for a service`);
});

test('work of the turn that already ended is not waited for — also when its notification came in the turn', () => {
  const ended = [human('go'), bg('toolu_A', 'zsh bench.sh'), result('toolu_A', 'running'), queued('toolu_A'), tool('toolu_B', 'cat out'), result('toolu_B', 'vmaf=91'), says('Done: here is the table.')];
  assert.equal(ownWaitIn(ended)?.own, false, 'a finished measurement keeps Claude "working"');
});

test('a turn woken by a notification that started nothing waits for the person, whatever older work runs (TBF-107)', () => {
  const lines = [human('check the payment'), bg('toolu_P', 'for i in $(seq 1 180); do ssh h "grep id log" && break; sleep 30; done'), result('toolu_P', 'running'),
    says('I watch the log.'), human(note('toolu_Q')), says('Pay 150 ₽ by the link — I will see it in the log at once.')];
  assert.equal(ownWaitIn(lines)?.own, false, 'a Claude asking to pay is said to work');
  // and the person asking something after it does not bring the older loop back
  assert.equal(ownWaitIn([...lines, human('how long?'), says('Until you pay.')])?.own, false, 'a question after the notification turn counted the loop before it');
});

// answered, and the card said "waiting for you · commands in the background" though the run went on
test('a question of the person while Claude waits does not end the wait (TRA-5)', () => {
  const lines = [human('do TRA-5'), bg('toolu_A', 'python transcribe.py audio.wav > run.log'), result('toolu_A', 'Command running in background with ID: b32v35tj7.'),
    says('The run is alive. I wait for its notification.'), system()];
  const end = Date.parse(JSON.parse(lines.at(-1)).timestamp);
  const asked = [...lines, human('how long to wait?'), tool('toolu_C', 'cat run.log | tail'), result('toolu_C', '80 min done'), says('About 35–40 minutes more.')];
  assert.equal(ownWaitIn(asked)?.own, true, 'a Claude answering the person mid-wait is said to wait for you');
  assert.equal(ownWaitIn(asked).at, end, 'the two hours start anew with every question of the person');
  assert.equal(ownWaitIn([...asked, human('and now?'), says('Still running.')])?.own, true, 'two questions ended the wait');
  // the work ends: its notification wakes Claude, and what it says then is for the person
  assert.equal(ownWaitIn([...asked, human(note('toolu_A')), says('Done: 5 joints of 22 lost speech before.')])?.own, false);
  // a turn a notification woke that started new work, then a question: the new work is waited for
  assert.equal(ownWaitIn([human('go'), bg('toolu_A', 'zsh a.sh'), result('toolu_A', 'running'), says('Runs.'), human(note('toolu_A')),
    bg('toolu_B', 'zsh b.sh'), result('toolu_B', 'running'), says('Round two.'), human('what now?'), says('Round two runs.')])?.own, true);
});

test('background work Claude stopped itself is not waited for', () => {
  const lines = [human('go'), bg('toolu_W', 'until ! pgrep -qf transcribe; do sleep 30; done'), result('toolu_W', 'Command running in background with ID: ba4wlmn4i.'),
    JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_S', name: 'TaskStop', input: { task_id: 'ba4wlmn4i' } }] } }),
    result('toolu_S', 'Successfully stopped task: ba4wlmn4i'), says('The run is alive.')];
  assert.equal(ownWaitIn(lines)?.own, false, 'a stopped loop is said to run on');
  // the id Claude Code also puts in the result's toolUseResult
  const withId = lines.map((l) => (l.includes('"toolu_W","content"') ? JSON.stringify({ ...JSON.parse(l), toolUseResult: { backgroundTaskId: 'ba4wlmn4i' } }) : l));
  assert.equal(ownWaitIn(withId.map((l) => l.replace('with ID: ba4wlmn4i.', 'running')))?.own, false);
  assert.equal(ownWaitIn(lines.filter((l) => !l.includes('TaskStop')))?.own, true);
});

test('a skill text Claude Code puts in, or a tool answer, does not start a turn; no turn start read — null', () => {
  assert.equal(ownWaitIn([human('go'), bg('toolu_A', 'zsh x.sh'), skill(), result('toolu_A', 'running'), says('Runs.')])?.own, true, 'the skill text cut the turn');
  assert.equal(ownWaitIn([bg('toolu_A', 'zsh x.sh'), result('toolu_A', 'running'), says('Runs.')]), null);
  assert.equal(ownWaitIn(['{broken', human('go'), says('Done.')])?.own, false);
});

test('the board reads the transcript of a session — again when it grows, and forgets a wait longer than two hours', async () => {
  const sid = '11111111-2222-4333-8444-555555555555';
  const dir = join(process.env.KB_CLAUDE_DIR, 'projects', '-Users-me-site');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  writeFileSync(file, `${'x'.repeat(300 * 1024)}\n${[human('go'), bg('toolu_A', 'zsh bench.sh'), result('toolu_A', 'running'), says('Runs, 20 minutes.')].join('\n')}\n`);
  const end = T0 + n * 1000;
  assert.equal(await waitsOwnWork(sid, end + 60_000), true, 'a Claude waiting for its command is said to wait for you');
  assert.equal(await waitsOwnWork(sid, end + OWN_WAIT_MAX_MS + 1000), false, 'a wait of hours with no word keeps the person uncalled');
  appendFileSync(file, `${human(note('toolu_A'))}\n${says('Here is the table.')}\n`);
  assert.equal(await waitsOwnWork(sid, end + 60_000), false, 'the grown transcript was not read again');
  assert.equal(await waitsOwnWork('99999999-2222-4333-8444-555555555555'), false, 'a session with no transcript');
});

// answered «waiting for the second» — the chain ended on that woken turn and read it as waiting for the person
test('a helper that ended does not end the wait for the other one still running', () => {
  const agentNote = (id) => `<task-notification>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n</task-notification>`;
  const two = [human('review it from two sides'), bg('toolu_H1', 'side one', 'Agent'), result('toolu_H1', 'Async agent launched successfully.'),
    bg('toolu_H2', 'side two', 'Agent'), result('toolu_H2', 'Async agent launched successfully.'), says('Two helpers are at it.'), system()];
  const launchEnd = Date.parse(JSON.parse(two.at(-1)).timestamp);
  const woke = [...two, human(agentNote('toolu_H1')), says('The first is back; waiting for the second.'), system()];
  assert.equal(ownWaitIn(woke)?.own, true, 'a Claude waiting for its second helper is said to wait for you');
  assert.equal(ownWaitIn(woke).at, launchEnd, 'the two hours count from the turn that started the helper');
  // a question of the person after it does not change that
  assert.equal(ownWaitIn([...woke, human('how long?'), says('A few minutes.')])?.own, true);
  // the second ends too: what Claude says then is for the person
  assert.equal(ownWaitIn([...woke, human(agentNote('toolu_H2')), says('Both are back: here is the summary.')])?.own, false);
  // a workflow counts as a helper does
  const wf = [human('go'), JSON.stringify({ type: 'assistant', timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_W', name: 'Workflow', input: { script: 'x' } }] } }),
    result('toolu_W', 'Workflow launched in background. Task ID: wf1'), bg('toolu_H3', 'one more', 'Agent'), result('toolu_H3', 'Async agent launched successfully.'),
    says('Running.'), human(agentNote('toolu_H3')), says('The helper is back, the workflow runs on.')];
  assert.equal(ownWaitIn(wf)?.own, true, 'a workflow still running was forgotten past the woken turn');
  // a command of an older turn still does not count past a woken turn (TBF-107 stands)
  const cmd = [human('go'), bg('toolu_C', 'zsh long.sh'), result('toolu_C', 'running'), bg('toolu_H4', 'quick look', 'Agent'),
    result('toolu_H4', 'Async agent launched successfully.'), says('Running.'), human(agentNote('toolu_H4')), says('Pay by the link, I will see it.')];
  assert.equal(ownWaitIn(cmd)?.own, false, 'an older command past a woken turn read as Claude\'s own wait');
});

const interim = (id, task) => `<task-notification>\n<task-id>${task}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<status>completed</status>\n`
  + '<summary>Agent "Acceptance: afisha" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running. It may resume on its own when that work completes or reports, and the same task-id notifies again if it does; the result below may be interim.</note>\n'
  + '<result>This agent has not reported yet.</result>\n</task-notification>';
const finished = (task) => `<task-notification>\n<task-id>${task}</task-id>\n<status>completed</status>\n<summary>Agent "Acceptance: afisha" finished</summary>\n</task-notification>`;
const handBack = (task) => `Another Claude session sent a message:\n<agent-message from="${task}">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n</agent-message>`;
const helper = (id, task) => [bg(id, 'accept the afisha', 'Agent'), result(id, `Async agent launched successfully.\nagentId: ${task} (internal ID)`)];

test('a helper waiting on work of its own is not over: its interim notification ends no wait (TIC-126)', () => {
  const lines = [human('accept the batch'), ...helper('toolu_V', 'ae1da76b'), says('The helper accepts the afisha.'), system(),
    human(interim('toolu_V', 'ae1da76b')), says('The afisha check is not over: the helper waits for its run. Waiting for its report.'), system()];
  assert.equal(ownWaitIn(lines)?.own, true, 'a Claude waiting for its helper\'s report is said to wait for you');
  // a question of the person meanwhile does not end it either
  assert.equal(ownWaitIn([...lines, human('are you on it?'), says('Yes, 4 of 5 are back.')])?.own, true);
  // the report handed back is the end …
  assert.equal(ownWaitIn([...lines, human(handBack('ae1da76b')), says('The last report is in.')])?.own, false, 'the report handed back did not end the helper');
  // … and so is the notification that it finished
  assert.equal(ownWaitIn([...lines, human(finished('ae1da76b')), says('Here is the summary.')])?.own, false, 'the helper that finished still holds Claude «at work»');
  // the hand-back as the transcript writes it, quotes escaped in the JSON of the line
  const raw = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: at(), content: handBack('ae1da76b') });
  assert.equal(ownWaitIn([...lines, raw, says('The last report is in.')])?.own, false, 'the escaped quotes of the line hid the hand-back');
});

test('a helper started long before the end that was read still counts: the board reads further back (TIC-126)', async () => {
  const sid = '22222222-2222-4333-8444-555555555555';
  const dir = join(process.env.KB_CLAUDE_DIR, 'projects', '-Users-me-tickets');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  // the helper is started, then 300 KB of the turns of the other helpers — past the first tail the board reads
  const padding = Array.from({ length: 60 }, (_, i) => [tool(`toolu_P${i}`, 'cat big.log'), result(`toolu_P${i}`, 'y'.repeat(5 * 1024))]).flat();
  writeFileSync(file, `${[human('accept the batch'), ...helper('toolu_V2', 'ae1da76c'), says('Five helpers are at it.'), system(),
    human('and?'), ...padding, says('Two of five are back.'), system(),
    human(interim('toolu_V2', 'ae1da76c')), says('Waiting for the afisha report.'), system()].join('\n')}\n`);
  const end = T0 + n * 1000;
  assert.equal(await waitsOwnWork(sid, end + 60_000), true, 'a helper started before the tail read was forgotten');
  // what the tail alone says: read further
  const tail = (await import('../src/own-wait.js')).tailLines;
  const { size } = (await import('node:fs')).statSync(file);
  assert.equal(ownWaitIn(await tail(file, size, 256 * 1024), { whole: false }), null, 'a tail without the helper answered instead of reading further');
  // a tail that already reaches two hours back answers as it is
  const old = [JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: new Date(T0 - OWN_WAIT_MAX_MS - 1000).toISOString() }),
    human('go'), says('Started.'), human(note('toolu_none')), says('Done.')];
  assert.equal(ownWaitIn(old, { whole: false })?.own, false);
});

// chain of their turns reached the first line read, and the helper before it went unseen
test('a helper started long before, then only the person asks: the board reads further back too', async () => {
  const sid = '33333333-2222-4333-8444-555555555555';
  const dir = join(process.env.KB_CLAUDE_DIR, 'projects', '-Users-me-tickets');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${sid}.jsonl`);
  const padding = Array.from({ length: 60 }, (_, i) => [tool(`toolu_Q${i}`, 'cat big.log'), result(`toolu_Q${i}`, 'z'.repeat(5 * 1024))]).flat();
  writeFileSync(file, `${[human('accept the batch'), ...helper('toolu_V3', 'ae1da76d'), says('The helper is at it.'), system(),
    human('and?'), ...padding, says('Still waiting for the helper.'), system(),
    human('how long?'), says('A few minutes more.'), system()].join('\n')}\n`);
  const end = T0 + n * 1000;
  assert.equal(await waitsOwnWork(sid, end + 60_000), true, 'a helper started before the tail read was forgotten when only the person asked');
  const tail = (await import('../src/own-wait.js')).tailLines;
  const { size } = (await import('node:fs')).statSync(file);
  assert.equal(ownWaitIn(await tail(file, size, 256 * 1024), { whole: false }), null, 'a chain of the person\'s turns cut by the tail answered instead of reading further');
  // the helper ends: read whole, Claude waits for the person
  appendFileSync(file, `${human(finished('ae1da76d'))}\n${says('Here is the report.')}\n`);
  assert.equal(await waitsOwnWork(sid, end + 60_000), false);
  // the same chain read whole answers at once; a part of it — only when it reaches two hours back
  const chat = [human('hi'), says('Hello.'), human('and?'), says('Nothing runs.')];
  assert.equal(ownWaitIn(chat)?.own, false);
  assert.equal(ownWaitIn(chat, { whole: false }), null);
  const long = [JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: new Date(T0 - OWN_WAIT_MAX_MS - 1000).toISOString() }), ...chat];
  assert.equal(ownWaitIn(long, { whole: false })?.own, false);
});

// permission check — it never ran, and the Claude explaining that to the person read as at work for two hours
test('background work refused before it ran is not waited for', () => {
  const refused = JSON.stringify({ type: 'user', timestamp: at(), toolUseResult: 'Error: Permission for this action was denied', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_D', is_error: true, content: 'Permission for this action was denied by the Claude Code auto mode classifier.' }] } });
  const lines = [human('ship it'), bg('toolu_D', 'sh deploy.sh 2>&1 | tail -25'), refused, says('The safety check stopped the deploy: run it yourself.'), system()];
  assert.equal(ownWaitIn(lines)?.own, false, 'a refused deploy held Claude «at work in the background»');
  assert.equal(ownWaitIn(lines.map((l) => l.replace('"is_error":true,', '')))?.own, true, 'a launch that ran was dropped');
  const agent = JSON.stringify({ type: 'user', timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_E', is_error: true, content: 'Agent type not found' }] } });
  assert.equal(ownWaitIn([human('go'), bg('toolu_E', 'review', 'Agent'), agent, says('Could not start the helper.')])?.own, false);
});
