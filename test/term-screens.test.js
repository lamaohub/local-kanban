import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { setFlagsFromString } from 'node:v8';
import { wholeAnswer } from '../public/js/term-delta.js';
import { createScreens, SCREENS_KEPT, SCREENS_TTL_MS } from '../src/term-screens.js';

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i} of the conversation`).join('\n');
const term = (screen, wraps = []) => ({ session: 's', screen, wraps });

test('the same screen is `same`, a changed one what changed, and without asking the whole of it', () => {
  const s = createScreens();
  const first = s.answer(term(`${lines(300)}\none`));
  assert.equal(first.screen, `${lines(300)}\none`);
  assert.deepEqual(s.answer(term(`${lines(300)}\none`), { seen: first.v, delta: true }), { same: true, v: first.v });
  const d = s.answer(term(`${lines(300)}\ntwo`), { seen: first.v, delta: true });
  assert.equal(d.screen, undefined);
  assert.equal(d.delta.of, first.v);
  assert.equal(s.answer(term(`${lines(300)}\nthree`), { seen: first.v }).screen, `${lines(300)}\nthree`, 'a delta nobody asked for');
  assert.equal(s.answer(term(`${lines(300)}\nfour`), { seen: 'not held', delta: true }).screen, `${lines(300)}\nfour`);
});

test('wraps that changed travel with the delta, and wraps that did not stay at home', () => {
  const s = createScreens();
  const was = term(`${lines(300)}\none`, [1]);
  const first = s.answer(was);
  const moved = s.answer(term(`${lines(300)}\ntwo`, [1, 2]), { seen: first.v, delta: true });
  assert.ok(moved.delta);
  assert.deepEqual(moved.wraps, [1, 2], 'the page goes on joining the rows by the old wraps');
  assert.deepEqual(wholeAnswer(moved, first, first.v).wraps, [1, 2]);
  const still = s.answer(term(`${lines(300)}\nthree`, [1, 2]), { seen: moved.v, delta: true });
  assert.ok(still.delta);
  assert.equal('wraps' in still, false);
});

test('at most SCREENS_KEPT screens, the screen looked at longest ago goes first', () => {
  const s = createScreens();
  const first = s.answer(term(`${lines(300)}\nfirst`));
  const second = s.answer(term(`${lines(300)}\nsecond`));
  for (let i = 0; i < SCREENS_KEPT - 2; i += 1) s.answer(term(`screen ${i}`));
  assert.equal(s.size, SCREENS_KEPT);
  s.answer(term(`${lines(300)}\nfirst`)); // looked at again: now the youngest
  s.answer(term('one more'));
  assert.equal(s.size, SCREENS_KEPT, 'the screens are not bounded');
  assert.equal(s.answer(term(`${lines(300)}\nmore`), { seen: first.v, delta: true }).delta?.of, first.v, 'the screen looked at last was dropped');
  assert.equal(s.answer(term(`${lines(300)}\nand more`), { seen: second.v, delta: true }).delta, undefined, 'the oldest screen is still held');
});

test('nobody looks: a stopped terminal leaves nothing behind, and a screen still looked at stays', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const s = createScreens();
  for (let i = 0; i < 5; i += 1) s.answer(term(`stopped ${i}`));
  assert.equal(s.size, 5);
  t.mock.timers.tick(SCREENS_TTL_MS - 1000);
  s.answer(term('still looked at'));
  t.mock.timers.tick(2000);
  assert.equal(s.size, 1, 'the screens of the stopped terminal stayed behind the one still looked at');
  t.mock.timers.tick(SCREENS_TTL_MS);
  assert.equal(s.size, 0, 'the screens stay until the board restarts');
  s.answer(term('back'));
  t.mock.timers.tick(SCREENS_TTL_MS * 2 + 1);
  assert.equal(s.size, 0, 'the second round of keeping is never swept');
});

test('a kept screen is a copy: the long answer of tmux it was cut from does not stay alive behind it', () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const s = createScreens();
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < SCREENS_KEPT; i += 1) {
    const out = `${i} `.padEnd(1024 * 1024, 'x'); // what tmux answered: both captures, the screen is a part of it
    s.answer(term(out.slice(0, 1000)));
  }
  gc();
  const grew = (process.memoryUsage().heapUsed - before) / 1048576;
  assert.ok(grew < 20, `${SCREENS_KEPT} kept screens of 1000 characters hold ${grew.toFixed(0)} MB (${SCREENS_KEPT} MB when a slice is kept)`);
});

test('the worst case stated in the module holds: 64 screens of 1000 lines of 300 columns in Cyrillic', () => {
  gcNow();
  const s = createScreens();
  const before = process.memoryUsage().heapUsed;
  const row = '\u0448'.repeat(299);
  for (let i = 0; i < SCREENS_KEPT; i += 1) s.answer(term(Array.from({ length: 1000 }, (_, n) => `${i}${row}`.slice(0, 299) + (n % 10)).join('\n')));
  gcNow();
  const grew = (process.memoryUsage().heapUsed - before) / 1048576;
  assert.equal(s.size, SCREENS_KEPT);
  assert.ok(grew < 45, `the comment says about 40 MB, the screens hold ${grew.toFixed(0)} MB`);
});
function gcNow() { setFlagsFromString('--expose-gc'); runInNewContext('gc')(); }
