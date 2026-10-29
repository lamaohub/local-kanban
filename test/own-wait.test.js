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
