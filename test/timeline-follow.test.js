import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const syncSrc = readFileSync(new URL('../public/drawer-sync.js', import.meta.url), 'utf8');
const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const settle = () => new Promise((r) => { setImmediate(r); });
const el = () => ({ classList: { contains: () => false, toggle: () => {}, add: () => {}, remove: () => {} } });

function card(status = 'todo') {
  const calls = { gets: 0, drawn: [] };
  const els = {};
  const box = {
    state: { drawerKey: 'VV-1', tasks: [{ key: 'VV-1', status, labels: [] }] },
    $: (id) => { if (!els[id]) els[id] = el(); return els[id]; },
    seg: (s) => s,
    server: { status, events: [] }, failGet: false, during: null,
    api: async () => {
      calls.gets++;
      if (box.during) box.during();
      if (box.failGet) throw Object.assign(new Error('internal error'), { status: 500 });
      return { key: 'VV-1', labels: [], description: '', ...box.server };
    },
    renderTimeline: (t) => { calls.drawn.push((t.events || []).map((e) => e.status)); },
    refreshDrawerFields: async () => {}, renderIssueRow: () => {}, buildStatusSelect: () => {}, renderLaunchButtons: () => {},
    setDrawerLock: () => {}, doAutosave: async () => {}, styledAlert: () => {}, closeDrawer: () => {},
    selVal: () => box.state.tasks[0]?.status,
  };
  vm.runInNewContext([
    'var self = globalThis;', syncSrc, // window.DrawerSync, as the page loads it
    `var drawerStatus = ${JSON.stringify(status)}; var drawerSnapshot = null; var drawerLabels = []; var drawerPinned = 0; var drawerLocked = false; var autosaveTimer = null;`,
    take('let timelineStatus = null;').split('\n')[0],
    take('function drawTimeline('),
    take('async function followTimeline('),
    take('export async function syncOpenDrawerStatus('),
  ].join('\n'), box);
  box.drawTimeline({ status, events: [] }); // the card opened
  calls.drawn.length = 0;
  const moved = (s, events) => { box.state.tasks[0] = { ...box.state.tasks[0], status: s }; box.server = { status: s, events }; };
  return { box, calls, moved };
}

test('a status changed outside reads the status log of the open card again — once per change', async () => {
  const c = card('todo');
  await c.box.syncOpenDrawerStatus(); // an event that changed no status: a comment, a tick of the checklist
  await settle();
  assert.equal(c.calls.gets, 0, 'an event that changed no status reads the log');
  c.moved('prep', [{ status: 'prep' }]);
  await c.box.syncOpenDrawerStatus();
  await settle();
  assert.deepEqual(c.calls.drawn, [['prep']], 'the log does not show the move made outside');
  assert.equal(c.calls.gets, 1);
  await c.box.syncOpenDrawerStatus(); // a refresh, another event of the same task
  await settle();
  assert.equal(c.calls.gets, 1, 'the log is read again with no change of status');
  c.moved('doing', [{ status: 'prep' }, { status: 'doing' }]);
  await Promise.all([c.box.syncOpenDrawerStatus(), c.box.syncOpenDrawerStatus()]); // two events of one move
  await settle();
  assert.equal(c.calls.gets, 2, 'two events of one move read the log twice');
  assert.deepEqual(c.calls.drawn.at(-1), ['prep', 'doing']);
});

test('a failed read is tried again by the next event; a card switched meanwhile is not drawn over', async () => {
  let c = card('todo');
  c.moved('prep', [{ status: 'prep' }]);
  c.box.failGet = true;
  await c.box.syncOpenDrawerStatus();
  await settle();
  assert.deepEqual(c.calls.drawn, []);
  c.box.failGet = false;
  await c.box.syncOpenDrawerStatus();
  await settle();
  assert.deepEqual(c.calls.drawn, [['prep']], 'a log that failed to load stays old until the card is opened again');

  c = card('todo');
  c.moved('prep', [{ status: 'prep' }]);
  c.box.during = () => { c.box.state.drawerKey = 'VV-2'; };
  await c.box.followTimeline('VV-1', { status: 'prep' });
  assert.deepEqual(c.calls.drawn, [], 'the log of VV-1 is drawn into the card of VV-2');
});

test('on a screen without the board the sync\'s own full card draws the log — no second request', async () => {
  const c = card('todo');
  c.box.$('board').classList.contains = (k) => k === 'hidden'; // the dashboard, Chaos, …
  c.moved('review', [{ status: 'review' }]);
  await c.box.syncOpenDrawerStatus();
  await settle();
  assert.equal(c.calls.gets, 1, 'the log is read a second time next to the full card');
  assert.deepEqual(c.calls.drawn, [['review']]);
});

/* openDrawer itself needs the whole card around it to run; that it notes the status its log is drawn at is held
   here by its code: a card opened without it would never follow a move made outside. */
test('opening a card and creating a task note the status the log was drawn at', () => {
  const body = (head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n}\n', at)); };
  for (const head of ['export function openDrawer(', 'async function createTask(']) {
    const b = body(head);
    assert.match(b, /\bdrawTimeline\((t|created)\)/, `${head} draws the log without noting its status`);
    assert.doesNotMatch(b, /\brenderTimeline\(/, `${head} draws the log without noting its status`);
  }
  assert.match(body('export function closeDrawer('), /timelineStatus = null;/, 'a closed card keeps the status of its log');
});

test('a move outside that ends where the log was drawn still reads the log again, once', async () => {
  const c = card('review');
  c.moved('review', [{ status: 'deploy' }, { status: 'review' }]);
  await c.box.syncOpenDrawerStatus({ moved: true });
  await settle();
  assert.equal(c.calls.gets, 1, 'the log missed a move that ended where it began');
  assert.deepEqual(c.calls.drawn.at(-1), ['deploy', 'review']);
  await c.box.syncOpenDrawerStatus(); // a comment after it
  await settle();
  assert.equal(c.calls.gets, 1, 'an event with no move read the log');
});

test('a batch of events tells the open card whether its status moved — also when it ended where it began', async () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const at = sse.indexOf('async function applyBatch(');
  assert.ok(at >= 0, 'applyBatch is gone from sse.js');
  const told = [];
  const box = {
    state: { tasks: [], drawerKey: 'VV-1', slug: 'vv', search: '' }, ALL: '__all__', SPECIAL_VIEWS: [],
    applyEvents: (tasks) => ({ refresh: false, tasks, render: false, changed: new Map(), loud: new Set(), counters: false, drawer: true, unhit: new Set(), searchStale: false }),
    syncOpenDrawerStatus: async (o) => { told.push(Boolean(o?.moved)); },
    renderBoard() {}, patchCard() { return true; }, refreshProjectCounters: async () => {}, reloadSearchSoon() {}, refresh: async () => {},
  };
  vm.runInNewContext(sse.slice(at, sse.indexOf('\n}\n', at) + 2), box);
  const ev = (key, prev, status) => ({ type: 'task.updated', data: { id: 1, key, project: 'vv', prev_status: prev, status } });
  await box.applyBatch([ev('VV-1', 'review', 'deploy'), ev('VV-1', 'deploy', 'review')]);
  await box.applyBatch([ev('VV-1', 'review', 'review')]); // a description edited: the status stays
  await box.applyBatch([ev('VV-2', 'prep', 'doing')]);    // another task moved
  assert.deepEqual(told, [true, false, false]);
});

// of a task, and the batch went to the full refresh before `moved` was looked at — two moves that ended where they began
// were lost there, the very screens where the person watches Claude move a task
test('a batch that needs a full refresh still tells the open card its status moved', async () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const at = sse.indexOf('async function applyBatch(');
  const told = [];
  const box = {
    state: { tasks: [], drawerKey: 'VV-1', slug: '__dash__', search: '' }, ALL: '__all__', SPECIAL_VIEWS: ['__dash__'],
    applyEvents: () => ({ refresh: true }),
    syncOpenDrawerStatus: async (o) => { told.push(Boolean(o?.moved)); },
    refresh: async () => { await box.syncOpenDrawerStatus(); }, // the refresh syncs the open card as it is
  };
  vm.runInNewContext(sse.slice(at, sse.indexOf('\n}\n', at) + 2), box);
  const ev = (prev, status) => ({ type: 'task.updated', data: { id: 1, key: 'VV-1', project: 'vv', prev_status: prev, status } });
  await box.applyBatch([ev('review', 'deploy'), ev('deploy', 'review')]);
  assert.ok(told.includes(true), `the open card was never told its status moved: ${JSON.stringify(told)}`);
  told.length = 0;
  await box.applyBatch([ev('review', 'review')]);
  assert.deepEqual(told, [false], 'an edit that moved no status read the log again');
});
