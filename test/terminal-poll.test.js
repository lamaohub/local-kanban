import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { wholeAnswer } from '../public/js/term-delta.js';
import { holdUntil, reprinted } from '../public/js/term-reprint.js';
import { createScreens } from '../src/term-screens.js';

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

const takeFn = (head) => src.slice(src.indexOf(head), src.indexOf('\n}\n', src.indexOf(head)) + 3);
function terminalCard(term) {
  const screens = createScreens();
  const asked = []; // { seen, delta } of every look
  const kinds = []; // what came: same, delta or whole
  const box = {
    term, tamper: null, drawn: null,
    state: { drawerKey: 'CK-1' }, document: { hidden: false }, URLSearchParams, Date, seg: String,
    wholeAnswer, holdUntil, reprinted, termCols: () => null, stopTermPoll: () => {},
    renderTerminal: (r) => { box.drawn = r; },
    api: async (method, path) => {
      const q = new URL(path, 'http://x').searchParams;
      asked.push({ seen: q.get('seen'), delta: q.get('delta') });
      const r = screens.answer(box.term, { seen: q.get('seen') ?? undefined, delta: q.get('delta') === '1' });
      kinds.push(r.same ? 'same' : r.delta ? 'delta' : 'whole');
      return box.tamper ? box.tamper(r) : r;
    },
  };
  vm.runInNewContext(`let termKey = 'CK-1'; let termReq = 0; let termSeen = null; let termBase = null; let termWinOf = null; let termWin = null;
let termHold = 0; let termScreen = null; let termFollow = true; var termInfo = null;
${takeFn('async function pollTerminal(')}${takeFn('function heldScreen(')}
this.look = pollTerminal;`, box);
  return { box, asked, kinds, look: box.look };
}
const history = (n = 300) => Array.from({ length: n }, (_, i) => `line ${i} of the conversation`).join('\n');
const screenOf = (screen, wraps = []) => ({ session: 's', dead: false, cols: 45, screen, wraps });

test('the card builds the screen of the server out of what changed, look after look, new wraps included', async () => {
  const c = terminalCard(screenOf(`${history()}\nstatus 0`));
  await c.look();
  assert.equal(c.box.drawn.screen, c.box.term.screen);
  c.box.term = screenOf(`${history()}\nstatus 1`);
  await c.look();
  assert.equal(c.box.drawn.screen, c.box.term.screen, 'a delta was drawn as an empty terminal');
  c.box.term = screenOf(`${history()}\nstatus 2`, [3, 4]);
  await c.look();
  assert.equal(c.box.drawn.screen, c.box.term.screen, 'the second delta was applied to the first screen');
  assert.deepEqual([...c.box.drawn.wraps], [3, 4], 'the copy of the screen joins the rows by the old wraps');
  c.box.term = screenOf(`${history()}\nstatus 3`, [3, 4]);
  await c.look();
  assert.deepEqual([...c.box.drawn.wraps], [3, 4], 'wraps that did not change were lost');
  await c.look();
  assert.deepEqual(c.kinds, ['whole', 'delta', 'delta', 'delta', 'same']);
  assert.deepEqual(c.asked[1], { seen: c.asked[1].seen, delta: '1' });
  assert.ok(c.asked[1].seen, 'the second look does not say what the card has');
});

test('a delta made against another screen is not drawn, and the next look gets the whole screen', async () => {
  const c = terminalCard(screenOf(`${history()}\nstatus 0`));
  await c.look();
  const had = c.box.drawn;
  c.box.term = screenOf(`${history()}\nstatus 1`);
  c.box.tamper = (r) => ({ ...r, delta: { ...r.delta, was: r.delta.was + 1 } });
  await c.look();
  assert.equal(c.box.drawn, had, 'a screen built on the wrong base was drawn');
  c.box.tamper = null;
  await c.look();
  assert.equal(c.asked[2].seen, null, 'the card asks against the screen it could not use, and gets the same delta for good');
  assert.equal(c.kinds[2], 'whole');
  assert.equal(c.box.drawn.screen, c.box.term.screen);
});

// over a Claude at work), and the next answer goes on from the same screen
test('a look tmux did not answer is not drawn — the card keeps what it shows', async () => {
  const c = terminalCard(screenOf(`${history()}\nstatus 0`));
  await c.look();
  const had = c.box.drawn;
  c.box.tamper = () => ({ session: 's', unknown: true });
  await c.look();
  assert.equal(c.box.drawn, had, 'a silence of tmux was drawn as a terminal that is not running');
  c.box.tamper = null;
  c.box.term = screenOf(`${history()}\nstatus 1`);
  await c.look();
  assert.equal(c.box.drawn.screen, c.box.term.screen);
});
