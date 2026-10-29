// them at once as a `queue-operation` `enqueue`, and as the person's words only when it takes them — the chat said
// «sending…» for a minute and dropped them, and the owner sent the same words again (IB-541). The chat now tells the
// words waiting in Claude Code's queue from the rest. The lines are of the shapes Claude Code 2.1.310 wrote in IB-541.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transcriptChat, waitStep } from '../src/chat-feed.js';

const dir = mkdtempSync(join(tmpdir(), 'kb-chat-wait-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const SID = '15b21acf-3b75-429f-b78e-9be9178c9335';
const line = (o) => `${JSON.stringify({ sessionId: SID, ...o })}\n`;
const user = (at, text) => line({ type: 'user', timestamp: at, uuid: `u-${at}`, message: { role: 'user', content: text } });
const tool = (at, id) => line({ type: 'assistant', timestamp: at, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm run checks' } }] } });
const enqueue = (at, content) => line({ type: 'queue-operation', operation: 'enqueue', timestamp: at, content });
const absorbed = (at, content) => line({ type: 'queue-operation', operation: 'remove', timestamp: at, content, reason: 'absorbed_mid_turn' });
const queuedCmd = (at, prompt) => line({ type: 'attachment', timestamp: at, attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } } });
const A = 'did you take Shop ID:    instrument-social?';
const B = 'Shop ID:    instrument-social is that the one?';
const NOTE = '<task-notification>\n<task-id>b1</task-id>\n<tool-use-id>toolu_x</tool-use-id>\n<status>completed</status>\n</task-notification>';

test('words in Claude Code\'s queue wait until it takes them, and only the person\'s words', async () => {
  const path = join(dir, `${SID}.jsonl`);
  writeFileSync(path, user('2026-10-28T18:04:00.000Z', 'Do the tasks IB-541') + tool('2026-10-28T18:14:00.000Z', 'toolu_long')
    + enqueue('2026-10-28T18:16:14.143Z', A) + enqueue('2026-10-28T18:17:00.000Z', NOTE) + enqueue('2026-10-28T18:18:32.459Z', B));
  let chat = await transcriptChat(path);
  assert.deepEqual(chat.waiting.map((w) => w.text), [A, B], 'the words Claude Code holds are not told from words that never got to it');
  assert.equal(chat.waiting[0].at, '2026-10-28T18:16:14.143Z');
  assert.equal(chat.turns.flatMap((t) => t.items).filter((it) => it.kind === 'said').length, 0, 'not the person\'s words in the chat yet');

  // the command ends: Claude Code takes both into the turn going on
  appendFileSync(path, absorbed('2026-10-28T18:19:57.590Z', A) + absorbed('2026-10-28T18:19:57.590Z', B)
    + queuedCmd('2026-10-28T18:16:14.110Z', A) + queuedCmd('2026-10-28T18:18:32.436Z', B));
  chat = await transcriptChat(path);
  assert.deepEqual(chat.waiting, [], 'words Claude took still read as waiting');
  assert.deepEqual(chat.turns.flatMap((t) => t.items).filter((it) => it.kind === 'said').map((it) => it.text), [A, B]);
});

test('a queue taken whole at the start of a turn, or put back into the field, waits no more', () => {
  const list = [];
  const step = (d, items = []) => waitStep(list, d, items);
  step({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-28T18:00:00Z', content: 'first words' });
  // a dequeue names nothing — the line of the person after it takes the words
  step({ type: 'queue-operation', operation: 'dequeue', timestamp: '2026-10-28T18:00:01Z' });
  assert.equal(list.length, 1);
  step({}, [{ kind: 'user', text: 'first   words' }]);
  assert.deepEqual(list, []);

  step({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-28T18:01:00Z', content: 'some' });
  step({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-28T18:01:01Z', content: 'others' });
  step({ type: 'queue-operation', operation: 'popAll', timestamp: '2026-10-28T18:01:02Z', content: 'some\nothers' });
  assert.deepEqual(list, [], 'words put back into the field of Claude Code are not in its queue');

  step({ type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-28T18:02:00Z', content: '<agent-message from="a1">hi</agent-message>' });
  assert.deepEqual(list, [], 'a message of another session is not the person\'s');
});

// a long message that holds it; a turn over leaves no words waiting (a Claude that exited with them writes no `remove`)
test('words leave the queue by the line that holds them, all of them, and none stay past the end of a turn', () => {
  const list = [];
  const enq = (content) => waitStep(list, { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-10-28T18:00:00Z', content }, []);
  enq('first'); enq('second');
  waitStep(list, {}, [{ kind: 'user', text: 'first\n\nsecond' }]);
  assert.deepEqual(list, [], 'Claude Code joined two waiting words into one line, and one of them waited on');
  enq('ok, and also rerun the migrations');
  waitStep(list, {}, [{ kind: 'said', text: 'ok' }]);
  assert.equal(list.length, 1, 'a short «ok» took the long words that hold it');
  waitStep(list, {}, [{ kind: 'end', ms: 1000 }]);
  assert.deepEqual(list, []);
});
