import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { pullExternal } from '../public/js/unsaved.js';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const line = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n', at) + 1);
};
const arrow = (head) => { // a `const x = () => ({ … });` over several lines
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n});\n', at) + 5);
};

function fakeEl(extra = {}) {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '', value: '', style: {}, children: [],
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
    },
    appendChild(ch) { this.children.push(ch); },
    querySelector: () => ({ checked: false }),
    getBoundingClientRect: () => ({ left: 0, bottom: 0 }),
    ...extra,
  };
}

// the card open on VV-1 in To do, nothing started there yet
function card({ status = 'todo', labels = [] } = {}) {
  const els = {};
  const calls = { autosave: 0, lock: [], statusSelect: [] };
  const box = {
    $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; },
    state: { drawerKey: 'VV-1' },
    document: { createElement: () => fakeEl(), body: fakeEl(), addEventListener() {}, removeEventListener() {}, activeElement: null },
    window: { innerWidth: 1280 },
    setTimeout: () => 0,
    LABEL_SELECTABLE: ['bug', 'ui', 'noclaude'], LABEL_COLORS: {}, TITLE_LABEL_WORDS: { noclaude: 'noclaude', bug: 'bug' },
    esc: (s) => String(s), tr: (s) => s,
    pushLayer() {}, closeLabelPicker() {}, renderDrawerLabels() {}, autoGrow() {}, buildPrioritySelect() {},
    doAutosave: () => { calls.autosave++; },
    buildStatusSelect: (v, isNew, allowDirect) => { calls.statusSelect.push({ v, allowDirect }); },
    setDrawerLock: (locked) => { calls.lock.push(locked); },
    DrawerSync: { cardLocked: (st, ls) => ['prep', 'doing', 'deploy'].includes(st) && !ls.includes('noclaude') },
    selVal: (id) => ({ 'd-status': status, 'd-priority': '0' })[id],
    pullExternal, descFollows() {},
  };
  vm.runInNewContext([
    `var drawerLabels = ${JSON.stringify(labels)}; var drawerLocked = false; var drawerStatus = ${JSON.stringify(status)};`,
    'var drawerSnapshot = null; var drawerFresh = null; var termKey = null; var termInfo = null;',
    line('let drawerTask = ').replace(/^let /, 'var '),
    arrow('const drawerForm = () => ({'),
    take('function renderLaunchButtons('),
    take('function launchFollowsLabels('),
    take('export function applyTitleLabelShortcut('),
    take('function openLabelPicker('),
    take('function applyDrawerFresh('),
  ].join('\n'), box);
  box.$('d-title').value = 'call the supplier';
  box.renderLaunchButtons({ key: 'VV-1', project: 'vv', sessions: [], status, labels }); // what openDrawer draws
  return { box, els, calls };
}
const launch = (c) => (c.els['d-launch'].classList.contains('hidden') ? 'hidden' : 'shown');
const pickerOption = (c, name) => {
  c.box.openLabelPicker();
  const picker = c.box.document.body.children.at(-1);
  return picker.children.find((o) => o.innerHTML.includes(name));
};

test('the label picker: noclaude put on the open task takes ▶ away at once, taken off — gives it back', () => {
  const c = card();
  assert.equal(launch(c), 'shown');
  pickerOption(c, 'noclaude').onclick();
  assert.deepEqual([...c.box.drawerLabels], ['noclaude']);
  assert.equal(launch(c), 'hidden', '▶ stays on a manual task — and starts Claude on a task the person does by hand');
  pickerOption(c, 'noclaude').onclick();
  assert.equal(launch(c), 'shown', 'the label is off, and ▶ comes back only after the card is opened again');
});

test('another label in the picker leaves ▶ as it is', () => {
  const c = card();
  pickerOption(c, 'bug').onclick();
  assert.equal(launch(c), 'shown');
});

test('the word at the start of the title that makes the task manual takes ▶ away too', () => {
  const c = card();
  c.box.$('d-title').value = 'noclaude call the supplier';
  c.box.applyTitleLabelShortcut();
  assert.equal(c.box.$('d-title').value, 'call the supplier');
  assert.equal(launch(c), 'hidden', 'the title made the task manual, and ▶ stayed');
});

test('noclaude put on from outside (kb lbl) reaches ▶ of the open card, and so does taking it off', () => {
  const c = card();
  c.box.drawerSnapshot = { title: 'call the supplier', description: '', priority: 0, labels: [], status: 'todo' };
  c.box.drawerFresh = { title: 'call the supplier', priority: 0, labels: ['noclaude'] };
  c.box.applyDrawerFresh();
  assert.equal(launch(c), 'hidden', 'kb lbl +noclaude left ▶ on the open card');
  c.box.drawerFresh = { title: 'call the supplier', priority: 0, labels: [] };
  c.box.applyDrawerFresh();
  assert.equal(launch(c), 'shown', 'kb lbl -noclaude did not bring ▶ back');
});

test('▶ is drawn for the open task only, and a task in work gets none whatever its labels', () => {
  const c = card();
  c.box.state.drawerKey = 'VV-2'; // the card went on to another task before the change landed
  c.box.drawerLabels = ['noclaude'];
  c.box.launchFollowsLabels();
  assert.equal(launch(c), 'shown', 'the labels of one task decided ▶ of another');
  const w = card({ status: 'doing', labels: ['noclaude'] });
  pickerOption(w, 'noclaude').onclick(); // a manual task in work loses noclaude
  assert.equal(launch(w), 'hidden', 'a task in work offers ▶');
});
