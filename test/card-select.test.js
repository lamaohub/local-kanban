import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};

function board(answer) {
  const cards = {};
  const mk = (id) => {
    const classes = new Set();
    return cards[id] = { id, classes, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) } };
  };
  mk(1); mk(2);
  const alerts = [];
  const box = {
    state: { drawerKey: 'CK-2', openingKey: null, tasks: [{ id: 1, key: 'CK-1' }, { id: 2, key: 'CK-2' }] },
    selectedIds: new Set(), clearSelection() {}, autosaveTimer: null,
    seg: (s) => s, tr: (s) => s,
    styledAlert: (m) => alerts.push(m),
    api: typeof answer === 'function' ? answer : () => answer,
    openSeq: 0, refresh() {}, closeDrawer() {}, fullNext: null, setDrawerFull() {}, endLeave() {}, flushChecklistSaves() {},
    $: (id) => (id === 'board'
      ? { querySelector: (sel) => cards[Number(/data-id="(\d+)"/.exec(sel)[1])] || null }
      : null),
    document: { querySelectorAll: (sel) => (sel === '.card.selected' ? Object.values(cards).filter((c) => c.classes.has('selected')) : []) },
  };
  vm.createContext(box);
  vm.runInContext(`${take('function markSelectedCard(')}\n${take('export function openDrawer(')}`, box);
  box.markSelectedCard();
  return { box, cards, alerts };
}

test('the clicked card is marked open at once, before the board answers', () => {
  const { box, cards } = board(new Promise(() => {}));
  assert.ok(cards[2].classes.has('selected'), 'the card open before is marked');
  box.openDrawer('CK-1');
  assert.ok(cards[1].classes.has('selected'), 'the clicked card waits for the answer to get its ring');
  assert.ok(!cards[2].classes.has('selected'), 'two cards are marked open');
});

test('a card that did not open gives the ring back to the open one', async () => {
  const { box, cards, alerts } = board(Promise.reject(Object.assign(new Error('down'), { status: 500 })));
  box.openDrawer('CK-1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(alerts.length, 1);
  assert.ok(cards[2].classes.has('selected'), 'the open card lost its ring');
  assert.ok(!cards[1].classes.has('selected'), 'the card that did not open stays marked');
});

test('a board redrawn while the card is opening keeps the ring on the clicked card', () => {
  const { box, cards } = board(new Promise(() => {}));
  box.openDrawer('CK-1');
  box.markSelectedCard();
  assert.ok(cards[1].classes.has('selected'), 'a redraw gave the ring back to the card open before');
  assert.ok(!cards[2].classes.has('selected'));
  const board_ = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  assert.match(board_, /\(state\.openingKey \?\? state\.drawerKey\) === t\.key \? ' selected'/,
    'cardEl marks the open card by drawerKey alone');
});

test('the answer to an earlier, slower click does not take the card back', async () => {
  const answers = {};
  const { box, cards } = board((m, path) => new Promise((res, rej) => { answers[path] = { res, rej }; }));
  box.state.tasks.push({ id: 3, key: 'CK-3' });
  cards[3] = { id: 3, classes: new Set() };
  cards[3].classList = { add: (c) => cards[3].classes.add(c), remove: (c) => cards[3].classes.delete(c) };
  box.openDrawer('CK-1');
  box.openDrawer('CK-3');
  answers['/api/tasks/CK-1'].res({ key: 'CK-1', status: 'todo' });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(box.state.drawerKey, 'CK-2', 'the slower answer of the first click opened its card over the last click');
  assert.equal(box.state.openingKey, 'CK-3');
  assert.ok(cards[3].classes.has('selected') && !cards[1].classes.has('selected'));
  box.openDrawer('CK-1'); box.openDrawer('CK-3');
  answers['/api/tasks/CK-1'].rej(Object.assign(new Error('down'), { status: 500 }));
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(cards[3].classes.has('selected'), 'a late refusal of the first click moved the ring off the last click');
});

test('a card that is gone gives the ring back to the open one', async () => {
  const { box, cards, alerts } = board(Promise.reject(Object.assign(new Error('gone'), { status: 404 })));
  box.openDrawer('CK-1');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(alerts.length, 1);
  assert.ok(cards[2].classes.has('selected'), 'the open card lost its ring');
  assert.ok(!cards[1].classes.has('selected'));
  assert.equal(box.state.openingKey, null);
});

test('closing the open card does not drop the card being opened', () => {
  const src2 = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const close = src2.slice(src2.indexOf('export function closeDrawer('), src2.indexOf('\n}\n', src2.indexOf('export function closeDrawer(')));
  assert.ok(close.length > 100, 'closeDrawer is gone from drawer.js');
  assert.doesNotMatch(close, /openSeq\+\+|openingKey = null/, 'closing a card throws away the answer to the last click');
});
