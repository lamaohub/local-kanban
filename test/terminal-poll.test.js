import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const from = src.indexOf('function termSchedule(');
const to = src.indexOf('\n}\n', src.indexOf('function termSoon(')) + 3;
const code = src.slice(from, to);

/** The chain with fake timers and a look that answers when the test says so. */
function chain() {
  const timers = new Map();
  let next = 1;
  const looks = []; // the looks out now: call one to answer it
  const box = {
    TERM_POLL_MS: 1000,
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pollTerminal: () => new Promise((answer) => { looks.push(answer); }),
  };
  vm.runInNewContext(`let termTimer = null; let termChain = 0;\n${code}\nout = { startTermPoll, stopTermPoll, termSoon };`, box);
  return { ...box.out, timers, looks, due: () => [...timers.values()].map((t) => t.ms) };
}
const settle = () => new Promise((r) => { setImmediate(r); });
async function fire(c) {
  assert.equal(c.timers.size, 1, `${c.timers.size} looks were due at once`);
  const [[id, t]] = [...c.timers];
  c.timers.delete(id);
  t.fn();
  await settle();
}
async function answer(c) {
  c.looks.shift()();
  await settle();
}

test('the chain of drawer.js is found', () => {
  assert.ok(from > 0 && to > from && /function stopTermPoll\(/.test(code) && /async function termTick\(/.test(code), 'the chain functions moved: this test reads them out of drawer.js');
});

test('a slow look keeps the next one waiting, and a tab left in the middle of a look stops looking', async () => {
  const c = chain();
  c.startTermPoll();
  assert.deepEqual(c.due(), [0], 'the first look is not at once');
  await fire(c);
  assert.equal(c.looks.length, 1);
  assert.equal(c.timers.size, 0, 'the next look was timed before the last one came back — on a busy machine they pile up');
  await answer(c);
  assert.deepEqual(c.due(), [1000], 'the next look is not a second after the answer to the last one');
  await fire(c);
  c.stopTermPoll(); // the person goes to «Comments» while this look is out
  await answer(c);
  assert.equal(c.timers.size, 0, 'the tab that was left goes on looking at the screen every second');
  assert.equal(c.looks.length, 0);
  c.startTermPoll(); // and back: one chain again
  assert.deepEqual(c.due(), [0]);
});

test('a look asked for after typing takes the place of the chain, it does not run beside it', async () => {
  const c = chain();
  c.startTermPoll();
  await fire(c); // a look is out
  c.termSoon(250); // the person typed: look again soon
  assert.deepEqual(c.due(), [250]);
  await answer(c); // the look of the old chain comes back
  assert.deepEqual(c.due(), [250], 'the old chain went on beside the new one');
  await fire(c);
  await answer(c);
  assert.deepEqual(c.due(), [1000]);
  c.stopTermPoll();
  c.termSoon(250); // typed with the tab not on view: no look at all
  assert.equal(c.timers.size, 0, 'typing started a chain on a tab that is not on view');
});
