import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canRetry, refusalLine } from '../public/js/unsaved.js';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};

function fakeEl() {
  const classes = new Set(['hidden']);
  return {
    value: '', textContent: '', innerHTML: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
    },
  };
}

function form(serverSays) {
  const els = {};
  const calls = { posts: [], queued: [], dropped: [] };
  const timers = new Map();
  let next = 1;
  const box = {
    $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; },
    state: { drawerKey: null, drawerProject: 'vv', slug: 'vv' },
    tr: (s) => `ru:${s}`,
    canRetry, refusalLine,
    server: serverSays,
    api: async (method, path, body) => {
      calls.posts.push(body.title);
      const s = box.server;
      if (s === 'down') throw Object.assign(new Error('Failed to fetch'), { offline: true });
      if (typeof s === 'number') throw Object.assign(new Error(s >= 500 ? 'internal error — details under Settings → Errors' : 'title: at most 300 characters'), { status: s });
      return { id: 9, key: 'VV-9', project: 'vv', title: body.title, description: '', priority: 0, status: 'backlog', labels: [], pinned: 0 };
    },
    setTimeout: (fn, ms) => { const id = next++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    selVal: (id) => (id === 'd-status' ? 'backlog' : id === 'd-priority' ? '0' : undefined),
    queueCreate: (formId, body) => { calls.queued.push(body.title); },
    dropUnsaved: (k) => { calls.dropped.push(k); },
    // what a created task draws in the card — not this test's business
    setDrawerId: () => {}, renderComments: () => {}, renderChecklist: () => {}, buildStatusSelect: () => {}, renderDrawerLinks: () => {},
    renderIssueRow: () => {}, renderTimeline: () => {}, renderLaunchButtons: () => {}, uploadAttachment: async () => {}, clearPending: () => {},
    setScrollToNewCardId: () => {}, refresh: async () => {}, styledAlert: () => {}, closeDrawer: () => {},
    fieldsSnapshot: (t) => ({ ...t }),
    unsentEdits: { supersede: () => true },
  };
  vm.runInNewContext([
    'var newFormId = 1; var creatingForm = null; var createFailedForm = null; var pendingAttachments = []; var autosaveTimer = null;',
    'var drawerLocked = false; var drawerLabels = []; var drawerSnapshot = null; var drawerStatus = null; var drawerPinned = 0;',
    'var drawerShown = () => true; var unsentCreates = new Map();',
    take('function newTaskHasContent('),
    take('export function scheduleAutosave('),
    take('export async function doAutosave('),
    take('function formToSave('),
    take('async function doAutosaveOnce('),
    take('function createRefusedText('),
    take('function showSaveNote('),
    'var timelineStatus = null;', take('function drawTimeline('),
    take('async function createTask('),
  ].join('\n'), box);
  const note = () => (els['d-save-note'] && !els['d-save-note'].classList.contains('hidden') ? els['d-save-note'].textContent : null);
  const fire = async () => {
    const all = [...timers];
    timers.clear();
    for (const [, t] of all) await t.fn();
    await settle();
  };
  return { box, els, calls, note, fire, timers };
}
const settle = () => new Promise((r) => { setImmediate(r); });

// a person typing a title letter by letter into the form «+»
async function typeTitle(f, text) {
  for (const ch of text) {
    f.box.$('d-title').value += ch;
    f.box.scheduleAutosave();
    await settle();
  }
}
const TITLE = 'thirty letters of a task title'; // 30

test('a creation the server fails is said in the form, and the next letters do not send a request each', async () => {
  for (const [server, said, queued] of [
    [500, 'ru:The task is not created yet: the board answered with an error — the details are in Settings → Errors. Your next change tries again, or click “not saved” at the top.', true],
    ['down', 'ru:The task is not created yet: there is no connection to the board. It is created by itself once the connection is back.', true],
    [400, 'ru:The task is not created: ru:the board did not accept it', false],
  ]) {
    const f = form(server);
    await typeTitle(f, TITLE);
    assert.equal(f.calls.posts.length, 1, `${server}: ${f.calls.posts.length} requests for ${TITLE.length} letters`);
    assert.equal(f.note(), said, `${server}: the form does not say why the task is not there`);
    assert.equal(f.calls.queued.length > 0, queued, `${server}: ${queued ? 'a creation the server may get over is not queued' : 'a refusal waits in the queue forever'}`);
    assert.equal([...f.timers.values()].length, 1, 'the next try does not wait for a pause in typing');
    assert.equal([...f.timers.values()][0].ms, 450);
    await f.fire(); // the pause: one more try, with the whole title
    assert.deepEqual(f.calls.posts, ['t', TITLE]);
  }
});

test('a refused creation is no unhandled rejection — the form has said it', async () => {
  for (const server of [500, 400, 'down']) {
    const f = form(server);
    f.box.$('d-title').value = 'x';
    await f.box.doAutosave(); // rejects when nobody handles the refusal
    assert.ok(f.note(), `${server}: nothing said`);
  }
});

test('once the task is created the note goes and the form creates at once again for the next «+»', async () => {
  const f = form(500);
  await typeTitle(f, 'abc');
  assert.ok(f.note());
  f.box.server = 'up';
  await f.fire();
  assert.equal(f.box.state.drawerKey, 'VV-9', 'the server answers again, the form creates nothing');
  assert.equal(f.note(), null, 'the note of the refusal stays over the created task');
  assert.ok(f.calls.dropped.includes('new:1'), 'the «not saved» badge still waits for the form');
  // a new form «+»: its first letter creates at once, as before the refusal
  f.box.state.drawerKey = null;
  f.box.newFormId = 2;
  f.box.$('d-title').value = '';
  const before = f.calls.posts.length;
  await typeTitle(f, 'n');
  assert.equal(f.calls.posts.length, before + 1, 'a new form waits for a pause because an older one failed');
});

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('the note of a refused creation belongs to its form: a new form and an opened task start without it', () => {
  const drawer = code(src);
  const body = (head) => { const at = drawer.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return drawer.slice(at, drawer.indexOf('\n}\n', at)); };
  assert.match(body('export function openDrawerNew('), /showSaveNote\(null\);/, 'a new form «+» shows the refusal of the previous one');
  assert.match(body('export function openDrawer('), /showSaveNote\(null\);/, 'an opened task shows the refusal of a form «+»');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="d-save-note" class="lock-note hidden" role="status"><\/div>/, 'the card has no place for the note');
});
