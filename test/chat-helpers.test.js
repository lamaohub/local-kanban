// chats said «Claude works in the background…» with nothing under it while three and two helpers were at work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, claude, dir, chat, wait;
let n = 0;

const line = (o) => `${JSON.stringify(o)}\n`;
const T0 = Date.parse('2026-11-02T13:00:00.000Z');
const at = (s) => new Date(T0 + s * 1000).toISOString();
const user = (s, text) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
const said = (s, text) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'text', text }] } });
const call = (s, id, name, input) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const answer = (s, id, text, toolUseResult) => line({ type: 'user', timestamp: at(s), toolUseResult, message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] } });
const launched = (s, id, agent) => answer(s, id, `Async agent launched successfully. (internal)\nagentId: ${agent} (internal ID)\nThe agent is working in the background.`, { isAsync: true, status: 'async_launched', agentId: agent, description: 'x' });
const resumed = (s, id, agent) => answer(s, id, `{"success":true,"message":"Resuming agent ${agent.slice(0, 7)}"}`, { success: true, message: `Resuming agent ${agent.slice(0, 7)}`, resumedAgentId: agent, revivedAgentId: agent });
const note = (s, agent, status, id) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(s), content: `<task-notification>\n<task-id>${agent}</task-id>\n${id ? `<tool-use-id>${id}</tool-use-id>\n` : ''}<status>${status}</status>\n<summary>Agent</summary>\n</task-notification>` });
const end = (s) => line({ type: 'system', subtype: 'turn_duration', durationMs: 1000, timestamp: at(s) });
const sideAt = (when, name, text) => line({ type: 'assistant', isSidechain: true, timestamp: when, message: { content: [{ type: 'tool_use', id: `s${when}`, name, input: { description: text, command: text } }] } });
const side = (s, name, text) => sideAt(at(s), name, text);
const sideNow = (text) => sideAt(new Date().toISOString(), 'Bash', text);

function session(text, helpers = {}) {
  const base = `s${++n}`;
  const p = join(dir, `${base}.jsonl`);
  writeFileSync(p, text);
  mkdirSync(join(dir, base, 'subagents'), { recursive: true });
  for (const [agent, [toolUseId, lines]] of Object.entries(helpers)) {
    writeFileSync(join(dir, base, 'subagents', `agent-${agent}.meta.json`), JSON.stringify({ toolUseId }));
    writeFileSync(join(dir, base, 'subagents', `agent-${agent}.jsonl`), lines);
  }
  return p;
}
const tools = (c) => c.turns.flatMap((t) => t.items.filter((i) => i.kind === 'tool'));
const agent = (c) => tools(c).find((i) => i.tool === 'Agent');

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-chat-helpers-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-chat-helpers-claude-'));
  dir = join(claude, 'projects', '-helpers');
  mkdirSync(dir, { recursive: true });
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_CLAUDE_DIR: claude });
  chat = await import('../src/chat-feed.js');
  wait = await import('../src/own-wait.js');
});
after(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(claude, { recursive: true, force: true });
});

test('a helper launched with no flag runs until its notification', async () => {
  const start = user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'Check the app', prompt: 'x' }) + launched(3, 'h1', 'a1') + said(4, 'Waiting.') + end(5);
  let c = await chat.transcriptChat(session(start, { a1: ['h1', side(6, 'Bash', 'Open the page')] }));
  assert.equal(agent(c).running, true, 'the launch read as a step of a second');
  assert.equal(agent(c).ms, undefined);
  assert.deepEqual(agent(c).helper, { steps: 1, now: { tool: 'Bash', text: 'Open the page' } });
  c = await chat.transcriptChat(session(start + note(90, 'a1', 'completed', 'h1'), { a1: ['h1', side(6, 'Bash', 'Open the page')] }));
  assert.equal(agent(c).running, false);
  assert.equal(agent(c).ms, 88_000);
});

test('the words of the launch say it when no record follows the answer', () => {
  const b = (text) => ({ content: [{ type: 'text', text }] });
  assert.equal(wait.wentBackground({}, b('Async agent launched successfully. (x)\nagentId: a7 (internal)')), 'a7');
  assert.equal(wait.wentBackground({}, b('Workflow launched in background. Task ID: w1\nSummary: y')), 'w1');
  assert.equal(wait.wentBackground({}, b('A file quoting: Async agent launched successfully.')), null, 'a quote read as a launch');
  assert.equal(wait.wentBackground({ message: { content: [{ type: 'tool_result' }] }, toolUseResult: { success: true, message: 'Message queued for delivery' } }, b('x')), null, 'a message to a running helper read as a launch');
});

test('a helper stopped and brought back through SendMessage runs again under its row, then ends', async () => {
  const start = user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'Check the app', prompt: 'x', run_in_background: 'true' }) + launched(3, 'h1', 'a1')
    + call(100, 'stop', 'TaskStop', { task_id: 'a1' }) + note(101, 'a1', 'killed', 'h1')
    + answer(102, 'stop', '{"message":"Successfully stopped task"}', { message: 'Successfully stopped task', task_id: 'a1' }) + end(103);
  const helper = { a1: ['h1', side(50, 'Bash', 'First run')] };
  const stopped = await chat.transcriptChat(session(start, helper));
  assert.equal(agent(stopped).running, false, 'a stopped helper still runs');
  const back = start + user(1000, 'Go on') + call(1001, 'b1', 'SendMessage', { to: 'a1', message: 'Go on' }) + resumed(1002, 'b1', 'a1');
  let c = await chat.transcriptChat(session(back, helper));
  assert.equal(agent(c).running, true, 'a helper brought back reads as ended: the chat said nothing of it');
  assert.equal(agent(c).since, at(1002), 'in the background since when it came back');
  assert.equal(agent(c).ms, undefined);
  const msg = tools(c).find((i) => i.tool === 'SendMessage');
  assert.ok(!msg.running && msg.ms === 1000, 'the message itself is a step of a moment');
  // the end comes under the step that brought it back: the id of the SendMessage, not of the Agent
  c = await chat.transcriptChat(session(back + note(1500, 'a1', 'completed', 'b1'), helper));
  assert.equal(agent(c).running, false, 'the end named by the SendMessage did not reach the helper');
  assert.equal(agent(c).ms, 99_000 + 498_000, 'its time is its two runs, not the pause between them');
});

test('a stop of the first run does not end the second; a late note of the first neither', async () => {
  const start = user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'x', prompt: 'x' }) + launched(3, 'h1', 'a1')
    + call(10, 'stop', 'TaskStop', { task_id: 'a1' }) + call(20, 'b1', 'SendMessage', { to: 'a1', message: 'Go on' }) + resumed(21, 'b1', 'a1');
  let c = await chat.transcriptChat(session(start));
  assert.equal(agent(c).running, true, 'a stop before the helper came back ended the run after it');
  // Claude Code writes the attachment when it takes the notification, with the moment it came
  const late = line({ type: 'attachment', timestamp: at(11), attachment: { type: 'queued_command', prompt: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>h1</tool-use-id>\n<status>killed</status>\n</task-notification>', commandMode: 'task-notification' } });
  c = await chat.transcriptChat(session(start + late));
  assert.equal(agent(c).running, true, 'a note of the run before ended this one');
});

test('a helper that ended and writes on runs again; a notification with no step ends it', async () => {
  const start = user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'x', prompt: 'x' }) + launched(3, 'h1', 'a1') + note(100, 'a1', 'completed', 'h1');
  const first = side(50, 'Bash', 'Run');
  const c0 = await chat.transcriptChat(session(start, { a1: ['h1', first] }));
  assert.equal(agent(c0).running, false, 'a helper that wrote nothing after its end still runs');
  // the same, an hour on: it woke and went with its Claude, and no second end ever comes
  const gone = await chat.transcriptChat(session(start, { a1: ['h1', first + side(150, 'Bash', 'Woke and died')] }));
  assert.equal(agent(gone).running, false, 'a helper silent for hours reads as at work for ever');
  // no wake after a stop or a failure: the last line of a helper killed may come a moment after the note
  const killed = await chat.transcriptChat(session(start.replace('completed', 'killed'), { a1: ['h1', first + sideNow('Last words')] }));
  assert.equal(agent(killed).running, false, 'a helper killed read as woken');
  const woken = { a1: ['h1', first + sideNow('Woke on its own run')] };
  const c = await chat.transcriptChat(session(start, woken));
  assert.equal(agent(c).running, true, 'a helper writing past its notification read as ended');
  assert.equal(agent(c).ms, undefined);
  assert.deepEqual(agent(c).helper, { steps: 2, now: { tool: 'Bash', text: 'Woke on its own run' } });
  // ended again: Claude Code names only the helper, no step
  const again = await chat.transcriptChat(session(start + line({ type: 'queue-operation', operation: 'enqueue', timestamp: new Date(Date.now() + 60_000).toISOString(), content: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n</task-notification>' }), woken));
  assert.equal(agent(again).running, false, 'an end naming no step was thrown away');
  assert.equal(chat.notification({ type: 'queue-operation', operation: 'enqueue', content: '<task-notification>\n<status>completed</status>\n</task-notification>' }), null);
});

test('a workflow is a helper in the background, named by its launch, ended by its notification', async () => {
  const start = user(1, 'Go') + call(2, 'w1', 'Workflow', { script: 'export const meta = {}' })
    + answer(3, 'w1', 'Workflow launched in background. Task ID: wf1\nSummary: Audit of the board', { status: 'async_launched', taskId: 'wf1', taskType: 'local_workflow', summary: 'Audit of the board' });
  const step = (c) => tools(c).find((i) => i.tool === 'Workflow');
  let c = await chat.transcriptChat(session(start));
  assert.equal(step(c).running, true);
  assert.equal(step(c).text, 'Audit of the board');
  c = await chat.transcriptChat(session(start + note(90, 'wf1', 'completed', 'w1')));
  assert.equal(step(c).running, false);
});

test('a helper at work in a turn past the shown ones is still said', async () => {
  let text = user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'Old helper', prompt: 'x' }) + launched(3, 'h1', 'a1') + call(4, 'h2', 'Agent', { description: 'Dead helper', prompt: 'x' }) + launched(5, 'h2', 'a2') + end(6);
  for (let i = 0; i < chat.TURNS_DEFAULT + 2; i += 1) text += user(10 + i * 2, `Turn ${i}`) + said(11 + i * 2, 'ok') + end(11 + i * 2);
  // now, and hours ago: a helper Claude never heard of again is not at work for ever
  const live = line({ type: 'assistant', isSidechain: true, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'x', name: 'Bash', input: { description: 'Live step' } }] } });
  const c = await chat.transcriptChat(session(text, { a1: ['h1', live], a2: ['h2', side(40, 'Bash', 'Long ago')] }));
  assert.ok(!tools(c).some((i) => i.tool === 'Agent'), 'the turn is past the shown ones');
  assert.deepEqual(c.going.map((i) => i.text), ['Old helper'], 'a helper silent for hours counted, or a live one was lost');
  assert.deepEqual(c.going[0].helper.now, { tool: 'Bash', text: 'Live step' });
  assert.ok(!JSON.stringify(c.going).includes('"id"'), 'the ids of the steps went to the page');
  // ended, then woke, past the shown turns; the note came a minute ago
  const ago = new Date(Date.now() - 60_000).toISOString();
  const ended = line({ type: 'queue-operation', operation: 'enqueue', timestamp: ago, content: '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>h1</tool-use-id>\n<status>completed</status>\n</task-notification>' });
  const woke = await chat.transcriptChat(session(text + ended, { a1: ['h1', live] }));
  assert.deepEqual(woke.going?.map((i) => i.text), ['Old helper'], 'a helper that woke past the shown turns was lost');
  const quiet = await chat.transcriptChat(session(text + ended, { a1: ['h1', side(40, 'Bash', 'Before the end')] }));
  assert.equal(quiet.going, undefined, 'a helper that ended stayed at work');
});

test('the answer of a helper brought back is read from its words too, and a line of several answers names nobody', async () => {
  assert.equal(wait.wentBackground({}, { content: '{"success":true,"message":"Resuming agent a7","resumedAgentId":"a7xyz","pin":{}}' }), 'a7xyz');
  const two = line({ type: 'user', timestamp: at(3), toolUseResult: { status: 'async_launched', taskId: 'wf1', summary: 'Whose name is this' }, message: { content: [
    { type: 'tool_result', tool_use_id: 'h1', content: 'Async agent launched successfully. (x)\nagentId: a1 (y)' },
    { type: 'tool_result', tool_use_id: 'w1', content: 'Workflow launched in background. Task ID: wf1' },
  ] } });
  const c = await chat.transcriptChat(session(user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'Check', prompt: 'x' }) + call(2, 'w1', 'Workflow', { name: 'audit' }) + two));
  assert.equal(agent(c).text, 'Check', 'a step took the name of another');
  assert.equal(tools(c).find((i) => i.tool === 'Workflow').text, 'audit');
  assert.ok(tools(c).every((i) => i.running), 'one of two launched in a line read as a step of a moment');
});

test('Claude waits for a helper launched with no flag, and for one it brought back', () => {
  const ln = (s) => s.trim().split('\n');
  const start = user(1, 'Go') + call(2, 'h1', 'Agent', { description: 'x', prompt: 'x' }) + launched(3, 'h1', 'a1');
  assert.equal(wait.ownWaitIn(ln(start + said(4, 'Waiting.')))?.own, true, 'a Claude with a helper at work reads as waiting for the person');
  assert.equal(wait.ownWaitIn(ln(start + said(4, 'Waiting.') + note(90, 'a1', 'completed', 'h1')))?.own, false);
  const stopped = wait.ownWaitIn(ln(start + call(4, 'stop', 'TaskStop', { task_id: 'a1' }) + said(5, 'Stopped.')));
  assert.equal(stopped?.own, false, 'a helper Claude stopped itself is waited for');
  const back = user(1, 'Go on') + call(2, 'b1', 'SendMessage', { to: 'a1', message: 'Go on' }) + resumed(3, 'b1', 'a1') + said(4, 'Waiting.');
  assert.equal(wait.ownWaitIn(ln(back))?.own, true, 'a helper brought back is not waited for');
  assert.equal(wait.ownWaitIn(ln(back + note(90, 'a1', 'completed', 'b1')))?.own, false);
  const told = user(1, 'Tell it') + call(2, 'b1', 'SendMessage', { to: 'a1', message: 'x' }) + answer(3, 'b1', '{"success":true}', { success: true, message: 'Message queued for delivery to a1 at its next tool round.' }) + said(4, 'Told it.');
  assert.equal(wait.ownWaitIn(ln(told))?.own, false, 'a message to a helper at work read as work started');
  const stop = call(2, 'stop', 'TaskStop', { task_id: 'a1' }) + answer(2, 'stop', '{}', {});
  const again = user(1, 'Go on') + stop + call(3, 'b1', 'SendMessage', { to: 'a1', message: 'Go on' }) + resumed(4, 'b1', 'a1') + said(5, 'Waiting.');
  assert.equal(wait.ownWaitIn(ln(again))?.own, true, 'a stop before the helper came back counted for the run after it');
  assert.equal(wait.ownWaitIn(ln(again + note(90, 'a1', 'completed')))?.own, false, 'an end naming only the helper was not seen');
});
