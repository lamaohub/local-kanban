// The audit of 14.11.2026: the words waiting for a busy Claude lived only in the board's memory, and pm2 restarts the board
// past its memory limit (seven times in two weeks on the owner's board) — every such restart lost them without a word. The
// queue is written to the base on every change and read back at the start.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const S1 = '11111111-aaaa-4aaa-8aaa-111111111111';
const S2 = '22222222-bbbb-4bbb-8bbb-222222222222';
let tmp, db, queue;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-queue-keep-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  queue = await import('../src/chat-queue.js');
});
after(() => { queue?.setQueueDeps(null); queue?.clearQueues(); rmSync(tmp, { recursive: true, force: true }); });

test('the words waiting for Claude outlive a restart of the board, in their order, and go once', async () => {
  const typed = [];
  queue.setQueueDeps({ timer: false, atPrompt: async () => 'idle', gone: async () => false, task: (id) => ({ id, key: `T-${id}` }),
    say: async (t, session, o) => { typed.push([session, o.text, o.images || []]); return { ok: true }; } });
  const a = queue.enqueue(S1, 7, 'first words');
  queue.enqueue(S1, 7, 'second words', ['/pics/one.png']);
  queue.enqueue(S2, 8, 'for the other Claude');
  const takenBack = queue.enqueue(S1, 7, 'taken back');
  queue.unqueue(S1, takenBack.id);
  const before = [queue.queued(S1), queue.queued(S2)];
  queue.clearQueues({ memory: true }); // the board stopped
  assert.deepEqual(queue.queued(S1), []);
  assert.equal(queue.loadQueues(), 3); // and started again
  assert.deepEqual([queue.queued(S1), queue.queued(S2)], before, 'the queue came back other than it was');
  const next = queue.enqueue(S1, 7, 'after the restart');
  assert.notEqual(next.id, a.id, 'an id of the words before the restart was given again');
  // delivered words leave the base: another restart does not type them twice
  await queue.queueTick(1000); // Claude seen at its prompt
  await queue.queueTick(6000); // and still there past QUEUE_IDLE_MS: one message of each queue goes
  assert.deepEqual(typed, [[S1, 'first words', []], [S2, 'for the other Claude', []]]);
  queue.clearQueues({ memory: true });
  queue.loadQueues();
  assert.deepEqual(queue.queued(S1).map((w) => w.text), ['second words', 'after the restart']);
  assert.deepEqual(queue.queued(S2), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_queue WHERE session_id = ?').get(S1).n, queue.queued(S1).length);
  // a terminal gone takes its words with it, from the base too
  queue.setQueueDeps({ timer: false, atPrompt: async () => 'gone', gone: async () => true });
  await queue.queueTick(100_000);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_queue').get().n, 0);
});

test('words waiting for the field, and words marked not delivered, keep their state across a restart; «again» and «take back» keep the base in step', async () => {
  const row = (id) => db.prepare('SELECT tries, stuck, no_box_since AS since, ids FROM chat_queue WHERE id = ?').get(id);
  let answer = { refused: 'no-box' };
  queue.setQueueDeps({ timer: false, atPrompt: async () => 'idle', gone: async () => false, task: (id) => ({ id, key: `T-${id}` }),
    say: async () => answer });
  const w = queue.enqueue(S1, 7, 'waits for the field', ['/pics/a.png'], [42]);
  await queue.queueTick(1000);
  await queue.queueTick(4000); // typed into a Claude with no field: nothing typed, the words wait for it
  assert.equal(row(w.id).since, 4000);
  assert.equal(row(w.id).ids, '[42]');
  queue.clearQueues({ memory: true });
  queue.loadQueues();
  await queue.queueTick(10_000);
  await queue.queueTick(4000 + queue.NO_BOX_HOLD_MS + 5000); // past the hold, counted from before the restart
  assert.equal(queue.queued(S1)[0].stuck, 'no-box', 'the wait for the field began again after the restart');
  queue.clearQueues({ memory: true });
  queue.loadQueues();
  assert.equal(queue.queued(S1)[0].stuck, 'no-box', 'the mark not delivered went with the restart');
  assert.ok(queue.sendAgain(S1, w.id));
  assert.deepEqual(row(w.id), { tries: 0, stuck: null, since: null, ids: '[42]' });
  // a refusal spends a try, and the try is kept
  answer = { refused: 'not-shown' };
  await queue.queueTick(1_000_000);
  await queue.queueTick(1_005_000);
  assert.equal(row(w.id).tries, 1);
  const taken = queue.takeQueued(S1, w.id);
  assert.deepEqual(taken.ids, [42]);
  assert.equal(row(w.id), undefined, 'words taken back stayed in the base');
  queue.clearQueues();
});

test('a busy Claude ends the wait for the field in the base as well: a restart does not bring it back to mark the words at once', async () => {
  const row = (id) => db.prepare('SELECT no_box_since AS since FROM chat_queue WHERE id = ?').get(id);
  let state = 'idle';
  queue.setQueueDeps({ timer: false, atPrompt: async () => state, gone: async () => false, task: (id) => ({ id, key: `T-${id}` }),
    say: async () => ({ refused: 'no-box' }) });
  const w = queue.enqueue(S2, 7, 'waits for the field');
  await queue.queueTick(1000);
  await queue.queueTick(4000);
  assert.equal(row(w.id).since, 4000);
  state = 'busy';
  await queue.queueTick(10_000); // Claude works: its field is there again
  assert.equal(row(w.id).since, null, 'the base kept a wait a busy Claude had ended');
  queue.clearQueues({ memory: true });
  queue.loadQueues();
  state = 'idle';
  const late = 4000 + queue.NO_BOX_HOLD_MS + 60_000;
  await queue.queueTick(late);
  await queue.queueTick(late + 5000); // one no-box after the work: the wait begins now, the words are not marked
  assert.equal(queue.queued(S2)[0].stuck, undefined, 'one look without a field after the work marked the words not delivered');
  queue.clearQueues();
});

test('a check board opened from a backup does not take up the queue of its base', async () => {
  queue.setQueueDeps({ timer: false, atPrompt: async () => 'busy' });
  queue.enqueue(S1, 7, 'kept in the base');
  const run = (env) => spawnSync(process.execPath, ['--input-type=module', '-e',
    "const q = await import('./src/chat-queue.js'); console.log(JSON.stringify(q.queued(process.env.S1).map((w) => w.text))); process.exit(0);"],
  { cwd: new URL('..', import.meta.url), env: { ...process.env, KB_DATA_DIR: tmp, S1, ...env }, encoding: 'utf8' });
  assert.equal(run({ KB_PREVIEW_TTL_MS: '' }).stdout.trim(), '["kept in the base"]');
  assert.equal(run({ KB_PREVIEW_TTL_MS: '60000' }).stdout.trim(), '[]');
  queue.clearQueues();
});
