import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { columnComparator, DEFAULT_SORT, orderColumn, slotBefore, sortMode, SORT_MODES, taskNumber } from '../public/js/order.js';

const task = (id, key, extra = {}) => ({ id, key, priority: 0, position: id, pinned: 0, ...extra });
const keys = (list) => list.map((t) => t.key);

const column = () => [
  task(1, 'VT-186', { priority: 3, position: 5 }),
  task(2, 'VT-225', { position: 1 }),
  task(3, 'VT-9', { position: 2 }),
  task(4, 'VT-1040', { priority: 2, position: 3 }),
  task(5, 'VT-40', { position: 4 }),
];

test('the default order is what the board always had: priority, then the hand-made order', () => {
  assert.deepEqual(keys(orderColumn(column(), 'manual')), ['VT-186', 'VT-1040', 'VT-225', 'VT-9', 'VT-40']);
  assert.equal(DEFAULT_SORT, 'manual');
});

test('sorting by number compares numbers, not text', () => {
  assert.deepEqual(keys(orderColumn(column(), 'num-asc')), ['VT-9', 'VT-40', 'VT-186', 'VT-225', 'VT-1040']);
  assert.deepEqual(keys(orderColumn(column(), 'num-desc')), ['VT-1040', 'VT-225', 'VT-186', 'VT-40', 'VT-9']);
});

test('sorting by number ignores priority and the hand-made order', () => {
  const list = [task(1, 'A-1', { priority: 0, position: 9 }), task(2, 'A-2', { priority: 3, position: 1 })];
  assert.deepEqual(keys(orderColumn(list, 'num-asc')), ['A-1', 'A-2']);
});

test('a pinned card stays on top in every order', () => {
  const list = column();
  list[2].pinned = 1; // VT-9
  for (const mode of SORT_MODES) {
    assert.equal(orderColumn(list, mode)[0].key, 'VT-9', `a pinned card sank in the “${mode}” order`);
  }
  assert.deepEqual(keys(orderColumn(list, 'num-desc')), ['VT-9', 'VT-1040', 'VT-225', 'VT-186', 'VT-40']);
});

test('the input list is not reordered in place', () => {
  const list = column();
  orderColumn(list, 'num-asc');
  assert.deepEqual(keys(list), ['VT-186', 'VT-225', 'VT-9', 'VT-1040', 'VT-40']);
});

test('an unknown or missing mode falls back to the default order', () => {
  for (const bad of [undefined, null, '', 'num', 'NUM-ASC', 42, {}]) assert.equal(sortMode(bad), 'manual');
  assert.deepEqual(keys(orderColumn(column(), 'no-such-mode')), keys(orderColumn(column(), 'manual')));
});

test('the task number is the tail of the key', () => {
  assert.equal(taskNumber({ key: 'VT-186' }), 186);
  assert.equal(taskNumber({ key: 'CK-7' }), 7);
  assert.equal(taskNumber({ key: '' }), 0);
  assert.equal(taskNumber({}), 0);
});

test('on the all-projects board “by number” means the order the tasks were created in', () => {
  const list = [task(10, 'VT-400'), task(30, 'CK-5'), task(20, 'TR-77')];
  assert.deepEqual(keys(orderColumn(list, 'num-asc', { mixed: true })), ['VT-400', 'TR-77', 'CK-5']);
  assert.deepEqual(keys(orderColumn(list, 'num-desc', { mixed: true })), ['CK-5', 'TR-77', 'VT-400']);
  assert.deepEqual(keys(orderColumn(list, 'num-asc')), ['CK-5', 'TR-77', 'VT-400']);
});

test('a closed column keeps only the latest tasks, whatever the order', () => {
  const list = Array.from({ length: 8 }, (_, i) => task(i + 1, `A-${i + 1}`, { pinned: i === 0 ? 1 : 0, priority: i === 5 ? 3 : 0 }));
  const opts = { closed: true, limit: 3 };
  assert.deepEqual(keys(orderColumn(list, 'manual', opts)), ['A-6', 'A-8', 'A-7']);
  assert.deepEqual(keys(orderColumn(list, 'num-desc', opts)), ['A-8', 'A-7', 'A-6']);
  assert.deepEqual(keys(orderColumn(list, 'num-asc', opts)), ['A-6', 'A-7', 'A-8']);
});

test('the drop slot is where the number puts the card, not where the cursor is', () => {
  const list = column();
  const incoming = task(9, 'VT-200');
  assert.equal(slotBefore(list, incoming, 'num-asc'), 2, 'VT-200 goes right before VT-225');
  assert.equal(slotBefore(list, incoming, 'num-desc'), 1, 'VT-200 goes right before VT-186');
  assert.equal(slotBefore(list, task(9, 'VT-5000'), 'num-asc'), null, 'the largest number goes to the end');
  assert.equal(slotBefore(list, list[0], 'num-asc'), 2);
});

test('the comparator is a consistent order', () => {
  for (const mode of SORT_MODES) {
    const cmp = columnComparator(mode);
    const list = column();
    for (const a of list) {
      for (const b of list) assert.ok(Math.sign(cmp(a, b)) + Math.sign(cmp(b, a)) === 0, `${mode}: ${a.key} vs ${b.key}`);
      for (const b of list) if (a !== b) assert.notEqual(cmp(a, b), 0, `${mode}: ${a.key} and ${b.key} tie, the order would depend on the engine`);
    }
  }
});

const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const order = readFileSync(new URL('../public/js/order.js', import.meta.url), 'utf8');

test('the ordering module stays a leaf that node can import', () => {
  assert.doesNotMatch(order, /^\s*import\s/m, 'order.js grew an import: this test and the board would stop sharing one module');
  assert.doesNotMatch(order, /\b(document|window|localStorage)\b/, 'order.js touches the browser: it has to stay pure');
});

test('the board and the keyboard do not spell the order out again', () => {
  for (const [name, src] of [['board.js', board], ['drawer.js', drawer]]) {
    assert.doesNotMatch(src, /a\.position - b\.position/, `${name} compares positions by hand again instead of asking order.js`);
  }
  assert.match(board, /orderColumn\(state\.tasks\.filter\(/, 'the board no longer orders a column through order.js');
});

test('a column sorted by number is not reordered by hand', () => {
  assert.match(board, /if \(fixedOrder && t\.status === status\) \{ dropPh\.remove\(\); return; \}/,
    'a drop inside a sorted column would write a position nobody can see');
  assert.match(board, /fixedOrder \? \{ status \} : \{ status, position:/,
    'a group drop into a sorted column writes positions again');
  assert.match(drawer, /if \(colSort\(t\.status\) !== DEFAULT_SORT\) return;/,
    'Shift+arrows move a card inside a sorted column, and nothing on the screen shows it');
});

test('the choice is kept under the namespaced key, per board and column', () => {
  assert.match(board, /const SORT_KEY = 'kb\.ui\.colSort';/);
  assert.match(board, /`\$\{state\.slug\}:\$\{status\}`/, 'the choice is no longer kept per board and column');
});

// but the Claude session that holds the task, and a manual (noclaude) card is reordered in Prep by hand
test('a drop sends the status only when the card changes column', async () => {
  const { dropPatch } = await import('../public/js/order.js');
  assert.deepEqual(dropPatch('prep', 'prep', 1.5), { position: 1.5 }, 'a reorder inside Prep is sent as a second take');
  assert.deepEqual(dropPatch('todo', 'backlog', 2.5), { status: 'backlog', position: 2.5 });
  assert.deepEqual(dropPatch('todo', 'backlog', undefined), { status: 'backlog' }, 'a column sorted by number got a position');
  assert.match(board, /const patch = dropPatch\(t\.status, status, position\);/, 'the drop no longer asks order.js what to send');
});
