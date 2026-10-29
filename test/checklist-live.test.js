// DOM in — they run on stand-ins): a list from the event replaces the shown one except what the person is changing
// here; the heights of all items are measured in one pass (one layout, not one per item), and the card measures them
// again once it is shown — a list drawn in a hidden card stood cut to one line per item.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const fnOf = (head) => { const at = drawer.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return drawer.slice(at, drawer.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };

function card({ shown, timers = {}, sending = [], focusedId = null }) {
  const box = {
    drawn: null, state: { drawerKey: 'CK-1' }, String, Boolean, Object, Set, Map, Array,
    document: { activeElement: focusedId == null ? null : { closest: () => ({ dataset: { id: String(focusedId) } }) } },
  };
  vm.runInNewContext(`let drawerChecklist = ${JSON.stringify(shown)}; const clSaveTimers = ${JSON.stringify(timers)};
const clSending = new Set(${JSON.stringify(sending)});
const renderChecklist = (list) => { this.drawn = list; drawerChecklist = list; };
${fnOf('export function applyChecklist(')}
this.apply = applyChecklist;`, box);
  return box;
}
const shown = [{ id: 1, text: 'one', done: false }, { id: 2, text: 'two', done: false }];

test('a list from elsewhere is drawn: a tick, a new item, a deleted one, a reworded one', () => {
  const c = card({ shown });
  c.apply('CK-1', [{ id: 1, text: 'one!', done: true }, { id: 3, text: 'three', done: false }]);
  assert.deepEqual(c.drawn.map((x) => [x.id, x.text, x.done]), [[1, 'one!', true], [3, 'three', false]]);
});

test('the item under the cursor, waiting or on its way keeps the text typed here', () => {
  for (const opts of [{ focusedId: 2 }, { timers: { 2: {} } }, { sending: ['2'] }]) {
    const c = card({ shown: [{ id: 1, text: 'one', done: false }, { id: 2, text: 'two, typed here', done: false }], ...opts });
    c.apply('CK-1', [{ id: 1, text: 'one', done: true }, { id: 2, text: 'two', done: false }]);
    assert.deepEqual(c.drawn.map((x) => x.text), ['one', 'two, typed here'], `${JSON.stringify(opts)}: the event took the person's text back`);
    assert.equal(c.drawn[0].done, true);
  }
});

test('another task, the same list, a list missing — nothing is redrawn', () => {
  const c = card({ shown });
  c.apply('CK-2', [{ id: 9, text: 'x', done: false }]);
  c.apply('CK-1', shown.map((x) => ({ ...x })));
  c.apply('CK-1', undefined);
  assert.equal(c.drawn, null);
});

test('the heights of all items: every write first, then every read — one layout', () => {
  const log = [];
  const ta = (i) => ({
    style: { set height(v) { log.push(`w${i}:${v}`); } },
    get scrollHeight() { log.push(`r${i}`); return 40 + i; }, offsetHeight: 22, clientHeight: 20,
  });
  const tas = [ta(0), ta(1), ta(2)];
  const box = { tas, $: () => ({ offsetParent: {}, querySelectorAll: () => tas }) };
  vm.runInNewContext(`${fnOf('export function growChecklist(')} this.grow = growChecklist;`, box);
  box.grow();
  assert.deepEqual(log, ['w0:auto', 'w1:auto', 'w2:auto', 'r0', 'r1', 'r2', 'w0:42px', 'w1:43px', 'w2:44px'],
    'a read between writes makes a layout per item (300 items — 3 s on a phone)');
  log.length = 0;
  vm.runInNewContext(`${fnOf('export function growChecklist(')} this.grow = growChecklist;`, Object.assign(box, { $: () => ({ offsetParent: null, querySelectorAll: () => tas }) }));
  box.grow();
  assert.deepEqual(log, [], 'a hidden list was measured (to nothing)');
});

test('the card measures its checklist once it is shown, and a tick does not redraw the list', () => {
  const at = drawer.indexOf("$('drawer').classList.remove('hidden');\n    endLeave();\n    growChecklist();");
  assert.ok(at > drawer.indexOf('renderChecklist(t.checklist);'), 'the list is not measured after the card is shown');
  const toggle = fnOf('async function toggleChecklist(');
  assert.match(toggle, /paintChecklistItem\(item\)/);
  assert.doesNotMatch(toggle, /renderChecklist\(/, 'a tick redraws the whole list again');
});
