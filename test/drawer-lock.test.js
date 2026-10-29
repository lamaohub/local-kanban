import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyEvents } from '../public/js/live-rules.js';

const drawerSrc = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = drawerSrc.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return drawerSrc.slice(at, drawerSrc.indexOf('\n}\n', at) + 2);
};
const line = (head) => {
  const at = drawerSrc.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return drawerSrc.slice(at, drawerSrc.indexOf('\n', at) + 1);
};

function fakeEl() {
  const classes = new Set();
  return {
    innerHTML: '', disabled: false, onclick: null,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
    },
    querySelectorAll: () => [],
  };
}

const syncSrc = readFileSync(new URL('../public/drawer-sync.js', import.meta.url), 'utf8');

function card() {
  const els = {};
  const calls = { closePicker: 0, autosave: 0, linkPicker: 0, deleteLink: 0, refreshFields: [], closeMenu: 0 };
  const selects = {};
  const box = {
    $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; },
    state: { drawerKey: 'VV-1' },
    tr: (s) => s,
    esc: (s) => String(s),
    labelChip: (n) => `<span class="lbl">${n}</span>`,
    autoGrow: () => {},
    closeLabelPicker: () => { calls.closePicker++; },
    closeDrawerMenu: () => { calls.closeMenu++; },
    fillDrawerMenu: () => { calls.fillMenu = (calls.fillMenu || 0) + 1; },
    openLabelPicker: () => {},
    doAutosave: () => { calls.autosave++; },
    openLinkPicker: () => { calls.linkPicker++; },
    deleteLink: () => { calls.deleteLink++; },
    toggleChecklist: () => {}, scheduleChecklistSave: () => {}, addChecklistItem: () => {}, deleteChecklistItem: () => {},
    growChecklist: () => {}, document: { activeElement: null },
    REL_MARK: {}, REL_TITLE: {},
    // what the open-card sync needs around it
    api: async () => { throw new Error('no server in this test'); },
    styledAlert: () => {}, closeDrawer: () => {}, renderIssueRow: () => {}, renderLaunchButtons: () => {},
    selVal: (id) => selects[id],
    buildStatusSelect: (v) => { selects['d-status'] = v; },
    taskIsNoclaude: (t) => (t.labels || []).includes('noclaude'),
    refreshDrawerFields: async (t) => { calls.refreshFields.push({ locked: box.drawerLocked, status: t.status }); },
    followTimeline: () => {},
  };
  vm.runInNewContext([
    'var self = globalThis;',
    syncSrc,
    'var drawerLocked = false; var drawerLabels = []; var drawerLinks = []; var drawerChecklist = [];',
    'var drawerStatus = null; var drawerSnapshot = null; var drawerPinned = 0; var autosaveTimer = null;',
    line('const LOCKABLE = '),
    'var linkPicker = null; // the picker on screen, as drawer.js keeps it (var: the test sets it)',
    take('function closeLinkPickerOf('),
    take('function setDrawerLock('),
    take('function renderDrawerLabels('),
    take('function renderDrawerLinks('),
    line('const CL_TRASH = '),
    drawerSrc.slice(drawerSrc.indexOf('const clItemHTML = '), drawerSrc.indexOf('function wireChecklistItem(')),
    take('function wireChecklistItem('),
    take('function renderChecklist('),
    take('export async function syncOpenDrawerStatus(').replace(/^export /, ''),
  ].join('\n'), box);
  return { box, els, calls, selects };
}

// what a person can press on the card right now
const controls = ({ els }) => ({
  labelAdd: /id="lbl-add"/.test(els['d-labels'].innerHTML),
  ask: /id="lbl-ask"/.test(els['d-labels'].innerHTML),
  linkAdd: /id="link-add"/.test(els['d-links'].innerHTML),
  linkRemove: /class="link-x"/.test(els['d-links'].innerHTML),
  itemRemove: /class="cl-del"/.test(els['d-checklist'].innerHTML),
  itemAdd: !els['d-checklist-add'].classList.contains('hidden'),
});
const NONE = { labelAdd: false, ask: false, linkAdd: false, linkRemove: false, itemRemove: false, itemAdd: false };
const ALL = { labelAdd: true, ask: true, linkAdd: true, linkRemove: true, itemRemove: true, itemAdd: true };

function openCard() {
  const c = card();
  c.box.drawerLabels = ['bug'];
  c.box.renderDrawerLabels();
  c.box.renderDrawerLinks([{ id: 2, key: 'VV-2', title: 'other', status: 'todo', rel: 'related' }]);
  c.box.renderChecklist([{ id: 1, text: 'item', done: false }]);
  return c;
}

test('Claude takes the open task: the add and remove controls go away with the lock', () => {
  const c = openCard();
  assert.deepEqual(controls(c), ALL, 'an unlocked card has to offer them');
  c.box.setDrawerLock(true);
  assert.deepEqual(controls(c), NONE, 'a locked card still offers controls that save nothing or bypass the lock');
  assert.equal(c.els['d-title'].disabled, true);
  assert.match(c.els['d-checklist'].innerHTML, /readonly/, 'checklist items stay editable on a locked card');
  assert.equal(c.calls.closePicker, 1, 'the label picker stays open over a locked card');
});

test('the task leaves work while open: the controls come back without reopening the card', () => {
  const c = openCard();
  c.box.setDrawerLock(true);
  c.box.setDrawerLock(false);
  assert.deepEqual(controls(c), ALL, 'an unlocked card lost its controls until it is reopened');
  assert.match(c.els['d-links'].innerHTML, /VV-2/, 'the links are drawn from what the card holds');
  assert.equal(c.calls.fillMenu, 1, 'the ⋯ menu is not drawn again when the card unlocks');
});

test('opening a card draws everything itself, so the lock there does not redraw the previous task', () => {
  const c = openCard();
  c.box.setDrawerLock(true, { redraw: false });
  assert.deepEqual(controls(c), ALL, 'redraw:false must leave the drawing to the caller');
  assert.equal(c.box.drawerLocked, true);
});

test('a control left over from before the lock does nothing', () => {
  const c = openCard();
  const ask = c.els['lbl-ask'].onclick;
  const addLink = c.els['link-add'].onclick;
  c.box.drawerLocked = true; // the lock came, the old chip is still under the pointer
  ask();
  addLink();
  assert.deepEqual(c.box.drawerLabels, ['bug'], 'ask? toggled a label that a locked card will not save');
  assert.equal(c.calls.autosave, 0);
  assert.equal(c.calls.linkPicker, 0, '+ link opened the picker on a locked card');
});

// the open card is synced with the task as the board list has it now (a move made outside)
async function moveOutside(c, status, labels = ['bug']) {
  c.box.state.tasks = [{ key: 'VV-1', status, labels, pinned: 0 }];
  await c.box.syncOpenDrawerStatus();
}
function openOn(status, labels = ['bug']) {
  const c = openCard();
  c.box.drawerStatus = status;
  c.selects['d-status'] = status;
  c.box.drawerSnapshot = { title: 'x', description: '', priority: 0, labels, status };
  c.box.setDrawerLock(c.box.DrawerSync.cardLocked(status, labels));
  return c;
}

test('Claude takes the task while its card is open: the card locks already in prep', async () => {
  const c = openOn('todo');
  await moveOutside(c, 'prep');
  assert.equal(c.box.drawerLocked, true, 'kb take puts the task in prep, and the open card stayed editable');
  assert.deepEqual(controls(c), NONE);
  await moveOutside(c, 'doing');
  assert.equal(c.box.drawerLocked, true);
});

test('the task leaves work while its card is open: it unlocks and takes in what changed meanwhile', async () => {
  const c = openOn('doing');
  assert.equal(c.box.drawerLocked, true);
  await moveOutside(c, 'review');
  assert.equal(c.box.drawerLocked, false);
  assert.deepEqual(controls(c), ALL, 'the card unlocked without its controls');
  const after = c.calls.refreshFields.filter((r) => !r.locked);
  assert.equal(after.length, 1, 'fields Claude changed while the card was locked wait for the next event — typing into the stale text overwrites them');
});

test('a manual task in work stays open to edit when it moves outside', async () => {
  const c = openOn('todo', ['noclaude']);
  await moveOutside(c, 'doing', ['noclaude']);
  assert.equal(c.box.drawerLocked, false, 'a manual (noclaude) task got locked');
  assert.deepEqual(controls(c), ALL);
});

test('the card and its sync take the lock from one rule', () => {
  const open = take('export function openDrawer(');
  assert.match(open, /setDrawerLock\(DrawerSync\.cardLocked\(t\.status, t\.labels\), \{ redraw: false \}\)/, 'openDrawer decides the lock by itself again');
  // taking noclaude off a task in work locks the card — the change has to go out before that
  const picker = take('function openLabelPicker(');
  const saved = picker.indexOf('doAutosave();');
  const locked = picker.indexOf('setDrawerLock(DrawerSync.cardLocked(drawerStatus, drawerLabels))');
  assert.ok(saved > 0 && locked > 0, 'the label picker no longer saves or no longer relocks');
  assert.ok(saved < locked, 'the picker locks before saving: noclaude taken off a task in work never reaches the server');
});

const sseSrc = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
function batchRunner(slug, tasks, drawerKey) {
  const calls = { sync: 0, refresh: 0, render: 0 };
  const box = {
    applyEvents,
    state: { slug, tasks, search: '', searchHits: null, drawerKey },
    ALL: '*', SPECIAL_VIEWS: ['#dash', '#now', '#review', '#horizon', '#calendar', '#chaos', '#settings'],
    refresh: async () => { calls.refresh++; },
    renderBoard: () => { calls.render++; },
    patchCard: () => true,
    refreshProjectCounters: async () => {},
    syncOpenDrawerStatus: async () => { calls.sync++; },
    reloadSearchSoon: () => {},
  };
  const at = sseSrc.indexOf('async function applyBatch(');
  assert.ok(at >= 0, 'applyBatch is gone from sse.js');
  vm.runInNewContext(sseSrc.slice(at, sseSrc.indexOf('\n}\n', at) + 2), box);
  return { box, calls };
}
const onBoard = (id, status) => ({ id, key: `VV-${id}`, project: 'vv', title: `Task ${id}`, preview: '', labels: [], status, priority: 0, position: id, pinned: 0 });

test('the event of Claude taking the open task reaches the card: the board syncs it after the batch', async () => {
  const { box, calls } = batchRunner('vv', [onBoard(1, 'todo'), onBoard(2, 'todo')], 'VV-1');
  await box.applyBatch([{ type: 'task.updated', data: { ...onBoard(1, 'prep') } }]);
  assert.equal(calls.refresh, 0, 'a move on its own board is applied in place, not by a full refresh');
  assert.equal(box.state.tasks[0].status, 'prep');
  assert.equal(calls.sync, 1, 'the open card was not synced after the event — Claude takes the task and the card stays editable');
});

test('the card locks: the ⋯ menu and the link picker of its task close; a picker of another task stays', () => {
  const c = openCard();
  const closed = [];
  c.box.linkPicker = { key: 'VV-1', close: () => { closed.push('VV-1'); } };
  c.box.setDrawerLock(true);
  assert.equal(c.calls.closeMenu, 1, 'the ⋯ menu opened before the lock stays, and Pin, Cancel and Delete still work');
  assert.deepEqual(closed, ['VV-1'], 'the link picker opened before the lock stays, and still links');
  // a picker opened from the right click on another card has nothing to do with this lock
  c.box.setDrawerLock(false);
  c.box.linkPicker = { key: 'VV-2', close: () => { closed.push('VV-2'); } };
  c.box.setDrawerLock(true);
  assert.deepEqual(closed, ['VV-1'], 'the lock of one card closed the picker of another task');
  // unlocking closes nothing
  const menus = c.calls.closeMenu;
  c.box.setDrawerLock(false);
  assert.equal(c.calls.closeMenu, menus, 'unlocking the card closes its menu');
});

test('the lock that comes by an event closes them too', async () => {
  const c = openOn('todo');
  const closed = [];
  c.box.linkPicker = { key: 'VV-1', close: () => { closed.push('VV-1'); } };
  const menus = c.calls.closeMenu;
  await moveOutside(c, 'prep');
  assert.equal(c.box.drawerLocked, true);
  assert.equal(c.calls.closeMenu, menus + 1, 'Claude took the task by an event and its ⋯ menu stayed open');
  assert.deepEqual(closed, ['VV-1'], 'Claude took the task by an event and its link picker stayed open');
});

test('the link picker tells the card which task it links, and forgets it once closed', () => {
  const open = take('function openLinkPicker(');
  assert.match(open, /const close = overlayLayer\(overlay, \{ onClose: \(\) => \{ if \(linkPicker\?\.close === close\) linkPicker = null; \} \}\);\s*linkPicker = \{ key, close \};/,
    'the picker on screen is not known to the lock, or stays known after it closed');
});

test('a card Claude takes keeps its ⋯ menu', () => {
  const c = openCard();
  c.box.setDrawerLock(true);
  assert.ok(!c.els['drawer-menu'].classList.contains('hidden'), 'the ⋯ menu with Claude\'s lines is gone from a card in work');
  c.box.state.drawerKey = null;
  c.box.setDrawerLock(false);
  assert.ok(c.els['drawer-menu'].classList.contains('hidden'), 'a form of a new task has a ⋯ menu');
});
