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
const line = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n', at) + 1);
};

function fakeEl() {
  const classes = new Set();
  return {
    innerHTML: '', textContent: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
    },
  };
}

// the card as the "+" form leaves it: the parts of an existing task are hidden, the previous task was pinned
function form({ labels = [], status = 'todo' } = {}) {
  const els = {};
  const calls = { statusSelect: [], links: [], issue: [], timeline: [], created: [] };
  const answer = {};
  const box = {
    $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; },
    state: { drawerKey: null, drawerProject: 'vv', slug: 'vv' },
    setTimeout: () => 0,
    api: async (method, path, body) => {
      assert.equal(`${method} ${path}`, 'POST /api/tasks');
      if (answer.wait) await answer.wait;
      const t = { id: 9, key: 'VV-9', project: 'vv', title: body.title, description: body.description, priority: body.priority, status: body.status, labels: body.labels, pinned: 0, created_at: '2026-10-05 14:29:00', gh_issue_number: null };
      calls.created.push(t);
      return t;
    },
    queueCreate: () => {}, dropUnsaved: () => {}, setDrawerId: () => {}, renderComments: () => {}, renderChecklist: () => {},
    canRetry, refusalLine, tr: (s) => s,
    uploadAttachment: async () => {}, clearPending: () => {}, setScrollToNewCardId: () => {}, refresh: async () => {},
    fieldsSnapshot: (t) => ({ title: t.title, description: t.description, priority: t.priority, labels: [...t.labels], status: t.status }),
    selVal: (id) => (id === 'd-status' ? box.formStatus : undefined),
    formStatus: status,
    buildStatusSelect: (value, isNew, allowDirect) => { calls.statusSelect.push({ value, isNew, allowDirect }); },
    renderDrawerLinks: (links) => { calls.links.push(links); },
    renderIssueRow: (t) => { calls.issue.push(t.key); },
    renderTimeline: (t) => { calls.timeline.push(t.key); },
  };
  vm.runInNewContext([
    'var newFormId = 1; var creatingForm = null; var pendingAttachments = []; var createFailedForm = null;',
    'var drawerStatus = null; var drawerSnapshot = null; var drawerPinned = 1;',
    `var drawerLabels = ${JSON.stringify(labels)};`,
    'var termKey = null; var termInfo = null;',
    'var drawerShown = () => true;',
    line('const unsentCreates = '),
    line('let drawerTask = ').replace(/^let /, 'var '),
    take('function renderLaunchButtons('),
    take('function createRefusedText('),
    take('function showSaveNote('),
    'var timelineStatus = null;', take('function drawTimeline('),
    take('async function createTask('),
  ].join('\n'), box);
  // what openDrawerNew leaves: nothing to start yet
  box.$('d-launch').classList.add('hidden');
  box.$('d-session').classList.add('hidden');
  return { box, els, calls, answer };
}

test('a task made with "+" can be started in Claude at once — the card is the one you get by opening it again', async () => {
  const c = form();
  await c.box.createTask(1, { project: 'vv', title: 'check the link', description: '', priority: 0, labels: [], status: 'todo' }, []);
  assert.equal(c.box.state.drawerKey, 'VV-9');
  assert.equal(c.els['d-launch'].classList.contains('hidden'), false, '▶ appears only after the card is closed and opened again');
  assert.equal(c.els['d-session'].classList.contains('hidden'), true, 'a task no Claude has worked on offers to open its session');
  assert.equal(c.box.drawerTask.key, 'VV-9', '▶ would start another task');
  assert.deepEqual(c.calls.statusSelect.at(-1), { value: 'todo', isNew: false, allowDirect: false },
    'the status picker stays the one of a new task: "Cancelled" cannot be picked until the card is opened again');
  // the array comes from the card's realm: compared by its contents
  assert.equal(JSON.stringify(c.calls.links), '[[]]', '"+ link" appears only after the card is opened again');
  assert.deepEqual(c.calls.issue, ['VV-9'], 'the issue line stays empty until the card is opened again');
  assert.deepEqual(c.calls.timeline, ['VV-9'], 'the status log appears only after the card is opened again');
  assert.equal(c.box.drawerPinned, 0, 'the menu ⋯ offers to unpin the new task because the previous one was pinned');
});

test('a manual task (noclaude) made with "+" gets no ▶, and its statuses are all open to the person', async () => {
  const c = form({ labels: ['noclaude'] });
  await c.box.createTask(1, { project: 'vv', title: 'by hand', description: '', priority: 0, labels: ['noclaude'], status: 'todo' }, []);
  assert.equal(c.els['d-launch'].classList.contains('hidden'), true, 'a manual task offers to be started in Claude');
  assert.deepEqual(c.calls.statusSelect.at(-1), { value: 'todo', isNew: false, allowDirect: true });
});

test('a status picked while the task was being made stays picked, and ▶ follows it', async () => {
  const c = form({ status: 'todo' });
  let go;
  c.answer.wait = new Promise((r) => { go = r; });
  const made = c.box.createTask(1, { project: 'vv', title: 'later', description: '', priority: 0, labels: [], status: 'todo' }, []);
  c.box.formStatus = 'backlog'; // picked while the request was on its way
  go();
  await made;
  assert.equal(c.calls.statusSelect.at(-1).value, 'backlog', 'the card took the status the person had just picked back');
  assert.equal(c.els['d-launch'].classList.contains('hidden'), false);
  assert.equal(c.box.drawerTask.status, 'backlog');
});

test('a form closed before the answer came leaves the card alone', async () => {
  const c = form();
  let go;
  c.answer.wait = new Promise((r) => { go = r; });
  const made = c.box.createTask(1, { project: 'vv', title: 'closed', description: '', priority: 0, labels: [], status: 'todo' }, []);
  c.box.newFormId = 2; // the card went on to another "+" form (or was closed)
  go();
  await made;
  assert.equal(c.calls.created.length, 1, 'the task is made anyway');
  assert.equal(c.box.state.drawerKey, null);
  assert.equal(c.els['d-launch'].classList.contains('hidden'), true, 'the other form got ▶ of the task made from a closed one');
  assert.equal(c.calls.statusSelect.length, 0);
  assert.equal(c.calls.links.length + c.calls.timeline.length + c.calls.issue.length, 0);
  assert.equal(c.box.drawerTask, null);
});
