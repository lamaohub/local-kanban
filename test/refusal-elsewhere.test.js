import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { boardOnly, effortOf, startEffort, checksOnly } from '../public/js/launch-rules.js';
import { canRetry, changedFields, createTurns, createUnsentEdits, errorLine, refusalLine, refusalText } from '../public/js/unsaved.js';

/* ── the server's own refusals outside the card ── */
let app, tmp;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_LOCAL_ROOT = join(tmp, 'projects');
  mkdirSync(join(tmp, 'projects', 'taken'), { recursive: true });
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('demo', 'DM', 'demo', 1, ?)").run(join(tmp, 'nowhere'));
  app = Fastify();
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.ready();
});
after(async () => {
  delete process.env.KB_PREVIEW_TTL_MS;
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// what api() turns a refusal into: the status, and the server's text as the message
async function refusal(method, url, payload, headers) {
  const r = await app.inject({ method, url, payload, headers });
  assert.ok(r.statusCode >= 400, `${method} ${url} was not refused (${r.statusCode})`);
  const body = r.json();
  return { status: r.statusCode, message: String(body.error || r.statusCode), body };
}
const reasonOf = async (...args) => refusalText(await refusal(...args)).reason;

test('the refusals of Settings, the project wizard, the project\'s page and its folder say what they mean', async () => {
  await app.inject({ method: 'POST', url: '/api/categories', payload: { name: 'Work' } });
  const cases = [
    [['POST', '/api/categories', { name: 'Work' }], 'a section with this name already exists'],
    [['POST', '/api/categories', { name: 'x'.repeat(41) }], 'a section name is up to 40 characters'],
    [['DELETE', '/api/categories/Local'], 'this section is built in — it cannot be renamed or deleted'],
    [['PATCH', '/api/categories/Local', { name: 'Mine' }], 'this section is built in — it cannot be renamed or deleted'],
    [['DELETE', '/api/categories/Gone'], 'this section no longer exists'],
    [['POST', '/api/projects', { slug: 'demo', name: 'again' }], 'a project with this key already exists'],
    [['POST', '/api/projects/folders', { name: '.hidden' }], 'a folder name is latin letters, digits, “.”, “-” and “_”, not starting with “.” or “-”'],
    [['POST', '/api/projects/clone', { url: 'ftp://example.com/x.git', name: 'x' }], 'a git address starts with https:// or git@'],
    [['POST', '/api/projects/clone', { url: 'https://example.com/taken.git', name: 'taken' }], 'a folder with this name already exists'],
    [['GET', `/api/fs?path=${encodeURIComponent(join(tmp, 'no-such'))}`], 'no such folder on this computer'],
    [['GET', '/api/projects/demo/docs/CLAUDE.md'], 'the file is not there any more'],
    [['PUT', '/api/projects/demo/docs/CLAUDE.md', { text: 'x' }], 'the project folder is not on this computer'],
    [['POST', '/api/sync/config', { owner: '-x', repo: '' }], 'the owner is latin letters, digits and hyphens, not starting with a hyphen'],
    [['POST', '/api/sync/config', { owner: '', repo: 'nope' }], 'the repository is written as owner/name'],
    [['POST', '/api/backups/restore', Buffer.from('not a database at all, only some text'), { 'content-type': 'application/octet-stream' }], 'this file is not a backup of a board'],
  ];
  for (const [req, reason] of cases) assert.equal(await reasonOf(...req), reason, `${req[0]} ${req[1]}`);
  // the folder made for a project that has one already, and the one a project-folder button takes
  mkdirSync(join(tmp, 'nowhere'));
  assert.equal(await reasonOf('POST', '/api/projects/demo/folder'), 'the project already has a folder');
  assert.equal(await reasonOf('PUT', '/api/projects/demo/docs/CLAUDE.md', { text: 'x', confirm_path: '/elsewhere' }), 'the file on disk is not the one opened here — open it again');
  process.env.KB_PREVIEW_TTL_MS = '60000';
  try {
    assert.equal(await reasonOf('POST', '/api/update'), 'this is a check board opened from a backup — it changes nothing');
    assert.equal(await reasonOf('PUT', '/api/projects/demo/docs/CLAUDE.md', { text: 'x' }), 'this is a check board opened from a backup — it changes nothing');
  } finally { delete process.env.KB_PREVIEW_TTL_MS; }
});

/* ── the rule ── */
test('a known refusal is said by its meaning, an unknown one is still «did not accept»', () => {
  const cases = [
    [{ status: 400, message: 'the "Local" category cannot be renamed' }, 'this section is built in — it cannot be renamed or deleted'],
    [{ status: 500, message: 'could not create the folder (EACCES)' }, 'the computer did not let the board create the folder — the details are in Settings → Errors'],
    [{ status: 400, message: 'not a folder' }, 'this path is not a folder'],
    [{ status: 403, message: 'cannot read the folder: EACCES' }, 'the folder is there, but the board cannot read it — check its permissions'],
    [{ status: 409, message: 'folder is already on the board' }, 'this folder is already on the board'],
    [{ status: 409, message: 'slug is taken' }, 'a project with this key already exists'],
    [{ status: 409, message: 'no free folder name for this project' }, 'there is no free folder name for this project'],
    [{ status: 409, message: 'an update is already running' }, 'an update is already running'],
    [{ status: 409, message: 'too many messages wait for this Claude already' }, 'too many messages already wait for this Claude — take one back or wait until it is free'],
    [{ status: 400, message: 'database is corrupted: row 3 missing from index' }, 'the backup file is damaged'],
    [{ status: 400, message: 'empty file' }, 'the file is empty'],
    [{ status: 409, message: 'another backup is already being opened' }, 'another backup is being opened right now — wait for it'],
    [{ status: 400, message: 'pm2_services: expected a list' }, 'the board did not accept it'],
  ];
  for (const [e, reason] of cases) {
    assert.equal(refusalText(e).reason, reason, e.message); // a sentence of the board — the dictionary has it (below)
  }
  assert.equal(refusalText({ status: 404, message: 'category not found' }).refresh, true, 'a section deleted in another tab stays on screen');
  // the server's text alone, without a status, is the page's own error — not a refusal to read the meaning of
  assert.equal(refusalText({ message: 'slug exists' }).reason, 'the board did not accept it');
});

test('words of the chat that did not reach Claude are said why, not «did not accept»', async () => {
  const { NOT_DELIVERED } = await import('../src/routes/chat.js');
  const said = Object.fromEntries(Object.entries(NOT_DELIVERED).map(([k, message]) => [k, refusalText({ status: 409, message }).reason]));
  assert.match(said['no-box'], /input field is not on its screen/);
  assert.match(said['not-typed'], /nothing was sent, try again/);
  assert.match(said['not-sent'], /press Enter in its terminal/);
});

test('errorLine: the page\'s own error is shown as it is, a refusal of the server in the board\'s words', () => {
  const tr = (s) => `ru:${s}`;
  assert.equal(errorLine('The project is not created', new Error('ru:the project needs a name'), tr), 'ru:the project needs a name');
  assert.equal(errorLine('The project is not created', Object.assign(new Error('slug exists'), { status: 409 }), tr),
    'ru:The project is not created: ru:a project with this key already exists');
  assert.equal(errorLine('could not create it', Object.assign(new Error('Failed to fetch'), { offline: true }), tr),
    'ru:could not create it: ru:no connection to the board — try again');
  assert.equal(errorLine('could not create it', null, tr), 'ru:could not create it');
});

const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
const inDict = (s) => dict.includes(`'${s}':`) || dict.includes(`"${s}":`);
const unsavedSrc = readFileSync(new URL('../public/js/unsaved.js', import.meta.url), 'utf8');
test('every known refusal, the new notes and the names of the actions are in the Russian dictionary', () => {
  const known = [...unsavedSrc.slice(unsavedSrc.indexOf('const KNOWN = ['), unsavedSrc.indexOf('];', unsavedSrc.indexOf('const KNOWN = ['))).matchAll(/, '([^']+)'(?:, \{[^}]*\})?\],/g)].map((m) => m[1]);
  assert.ok(known.length >= 20, `only ${known.length} known refusals read out of unsaved.js`);
  assert.deepEqual(known.filter((s) => !inDict(s)), [], 'a refusal stays English on the Russian board');
  const files = ['drawer.js', 'sse.js', 'review.js', 'project.js', 'settings.js', 'sidebar.js', 'chaos.js', 'chat.js', 'now-terms.js'];
  const heads = files.flatMap((f) => [...readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8').matchAll(/(?:refusalLine|errorLine)\('([^']+)'/g)].map((m) => m[1]));
  assert.ok(heads.length >= 20, `the pages say ${heads.length} refusals after their action`);
  assert.deepEqual([...new Set(heads)].filter((h) => !inDict(h)), [], 'the name of the action stays English on the Russian board');
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const note = drawer.match(/return tr\('(The change is not saved yet: [^']+)'\)/);
  assert.ok(note && inDict(note[1]), 'the note of an edit the server failed is English on the Russian board');
});

/* ── the pages outside the card: the functions themselves ── */
const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const takeFrom = (src, file) => (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const settle = () => new Promise((r) => { setImmediate(r); });
const tr = (s) => `ru:${s}`;
const NO_TASK = () => Object.assign(new Error('task not found'), { status: 404 });
const FAILED = () => Object.assign(new Error('internal error'), { status: 500 });
const OFFLINE = () => Object.assign(new Error('Failed to fetch'), { offline: true });
function fakeEl() {
  const classes = new Set(['hidden']);
  return {
    value: '', textContent: '', innerHTML: '', disabled: false, className: '',
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
    },
    insertAdjacentHTML(where, html) { this.innerHTML = html + this.innerHTML; },
    focus() {},
  };
}

test('starting a check, Chaos and the project\'s page say a refusal in the board\'s words', async () => {
  // «Claude review» → Check: the task of the check is not created
  const alerts = [];
  const rv = { tr, refusalLine, styledAlert: (m) => alerts.push(m), checkDescription: () => 'd', checkWords: () => ({ title: 'Check' }), CHECK_TITLE: 'Check', CHECK_LABEL: 'check',
    last: { groups: [{ project: 'demo', batch: [{ key: 'DM-1' }], running: false }] }, openDrawer: () => {}, renderReview: () => {}, launchInClaude: async () => {},
    taskPromptText: () => '', failure: null, api: async () => { throw rv.failure; } };
  vm.runInNewContext(['async function startCheck(', 'export async function startCheckIn('].map(takeFrom(read('review.js'), 'review.js')).join('\n'), rv);
  for (const [e, said] of [
    [Object.assign(new Error('project not found'), { status: 404 }), 'ru:Could not create the check: ru:the project no longer exists'],
    [FAILED(), 'ru:Could not create the check: ru:the board answered with an error — the details are in Settings → Errors'],
    [OFFLINE(), 'ru:Could not create the check: ru:no connection to the board — try again'],
  ]) {
    rv.failure = e;
    const btn = { dataset: { project: 'demo' }, disabled: false };
    await rv.startCheck(btn);
    assert.equal(alerts.pop(), said);
    assert.equal(btn.disabled, false, 'the button stays off after the refusal');
  }

  // Chaos: the new task is not created
  const els = {};
  const ch = { tr, errorLine, $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; }, selVal: () => 'demo', chaosPending: [], chaosLabel: '', chaosNoclaude: false,
    chaosStatus: 'backlog', chaosPriority: 0, failure: null, api: async () => { throw ch.failure; } };
  vm.runInNewContext(takeFrom(read('chaos.js'), 'chaos.js')('async function chaosCreate('), ch);
  ch.$('chaos-input').value = 'a new task';
  ch.failure = Object.assign(new Error('project not found'), { status: 404 });
  await ch.chaosCreate();
  assert.equal(ch.$('chaos-hint').textContent, 'ru:could not create it: ru:the project no longer exists');
  ch.failure = Object.assign(new Error('labels: unknown label "zzz"'), { status: 400 });
  await ch.chaosCreate();
  assert.equal(ch.$('chaos-hint').textContent, 'ru:could not create it: ru:the board did not accept it');
  assert.equal(ch.$('chaos-create').disabled, false);

  // the project's page: Save
  const flashed = [];
  const ps = { tr, refusalLine, changedFields, currentProject: () => ({ slug: 'demo' }), psSnap: { name: 'demo', path: '' }, readProjectForm: () => ({ name: 'demo', path: '/x' }),
    seg: (s) => s, flashSaved: (m) => flashed.push(m), failure: null, api: async () => { throw ps.failure; } };
  vm.runInNewContext(takeFrom(read('project.js'), 'project.js')('async function saveProjectSettings('), ps);
  ps.failure = Object.assign(new Error('project not found'), { status: 404 });
  await ps.saveProjectSettings();
  ps.failure = Object.assign(new Error('the "Local" category cannot be renamed'), { status: 400 });
  await ps.saveProjectSettings();
  assert.deepEqual(flashed, ['ru:did not save: ru:the project no longer exists', 'ru:did not save: ru:this section is built in — it cannot be renamed or deleted']);
});

test('no page outside the card puts the server\'s text of a refusal on the screen', () => {
  const files = { 'review.js': read('review.js'), 'project.js': read('project.js'), 'chaos.js': read('chaos.js'), 'sidebar.js': read('sidebar.js'), 'sse.js': read('sse.js'), 'onboarding.js': read('onboarding.js') };
  for (const [f, src] of Object.entries(files)) {
    assert.deepEqual([...src.matchAll(/\b(?:e|err)\.message\b/g)].map((m) => src.slice(src.lastIndexOf('\n', m.index) + 1, src.indexOf('\n', m.index)).trim()), [], `${f} shows the server's English`);
  }
  const settings = read('settings.js');
  const raw = settings.split('\n').filter((l) => /\b(?:e|err)\.message\b/.test(l));
  assert.deepEqual(raw, [], 'Settings shows the server\'s English');
});

/* ── the card: actions on a task deleted outside ── */
const drawerSrc = read('drawer.js');
const take = takeFrom(drawerSrc, 'drawer.js');
function card({ open = 'VV-1' } = {}) {
  const calls = { api: [], alerts: [], closed: 0, refreshed: 0, links: [], comments: 0, popClosed: 0, opened: [] };
  const els = {};
  const box = {
    state: { drawerKey: open },
    tr, seg: (s) => encodeURIComponent(String(s)), refusalText, refusalLine,
    answer: () => ({}),
    api: async (method, path, body) => { calls.api.push({ method, path, body }); return box.answer(method, path, body); },
    styledAlert: (m) => { calls.alerts.push(m); },
    styledConfirm: async () => true,
    closeDrawer: () => { calls.closed++; box.state.drawerKey = null; },
    refresh: async () => { calls.refreshed++; },
    renderDrawerLinks: (l) => { calls.links.push(l); },
    renderComments: async () => { calls.comments++; },
    renderChecklist: () => {},
    paintChecklistItem: () => {}, showSaveNote: (t) => { if (t) calls.notes = [...(calls.notes || []), t]; },
    editRefusedText: (e) => refusalLine('The change is not saved', e, tr), canRetry: (e) => Boolean(e?.offline) || e?.status >= 500,
    noteUnsaved: () => { calls.queued = (calls.queued || 0) + 1; }, dropUnsaved: () => {},
    closeReturnPop: () => { calls.popClosed++; },
    openDrawer: (k) => { calls.opened.push(k); },
    $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; },
    setTimeout: (fn) => { box.pending = fn; return 1; }, clearTimeout: () => {},
    els,
  };
  vm.runInNewContext([
    'var drawerLocked = false; var drawerChecklist = [{ id: 5, text: "a", done: false }]; var clSaveTimers = {}; var clSending = new Set();',
    'const clUnsent = new Map(); let clNoteShown = false; const clQueueKey = (key, id) => `cl:${key}:${id}`;',
    take('function clNote('),
    take('function clSaved('),
    take('function clRefused('),
    take('async function resendChecklistItem('),
    take('async function patchChecklistItem('),
    take('export function sayRefused('),
    take('async function deleteLink('),
    take('async function redrawLinks('),
    take('async function deleteComment('),
    take('async function toggleChecklist('),
    take('function scheduleChecklistSave('),
    take('export async function addChecklistItem('),
    take('async function deleteChecklistItem('),
    take('async function doReturn('),
  ].join('\n'), box);
  return { box, calls, els };
}

test('× of a link, + item, deleting a comment and Send back on a deleted task say so and take its card off the board', async () => {
  const acts = {
    deleteLink: (b) => b.deleteLink(7),
    addChecklistItem: (b) => b.addChecklistItem(),
    deleteComment: (b) => b.deleteComment(3),
    sendBack: (b) => b.doReturn('not right'),
    sendBackEmpty: (b) => b.doReturn(''),
    toggleChecklist: (b) => b.toggleChecklist(5),
    deleteChecklistItem: (b) => b.deleteChecklistItem(5),
    checklistText: async (b) => { b.scheduleChecklistSave(5, 'new text'); await b.pending(); },
  };
  for (const [name, act] of Object.entries(acts)) {
    const c = card();
    c.box.answer = () => { throw NO_TASK(); };
    await act(c.box); // a refusal nobody handles rejects here
    await settle();
    assert.deepEqual(c.calls.alerts, ['ru:This task no longer exists — it was deleted.'], `${name}: nothing is said`);
    assert.equal(c.calls.closed, 1, `${name}: the open card of the deleted task stays`);
    assert.equal(c.calls.refreshed, 1, `${name}: its ghost card stays on the board`);
  }
});

test('the other end of a link is gone, a comment is already deleted, a failure — each in the board\'s words, no card closed', async () => {
  let c = card();
  c.box.answer = (m) => { if (m === 'DELETE') throw Object.assign(new Error('the task to link to was not found'), { status: 404 }); return { links: [{ key: 'VV-3' }] }; };
  await c.box.deleteLink(7);
  await settle();
  assert.deepEqual(c.calls.alerts, ['ru:That task no longer exists — it was deleted.']);
  assert.equal(c.calls.closed, 0, 'the open card closes because the linked task is gone');
  assert.deepEqual(c.calls.links, [[{ key: 'VV-3' }]], 'the link to the deleted task stays in the card');

  c = card();
  c.box.answer = (m) => { if (m === 'DELETE') throw Object.assign(new Error('comment not found'), { status: 404 }); return {}; };
  await c.box.deleteComment(3);
  assert.deepEqual(c.calls.alerts, [], 'a comment deleted in another tab is a failure');
  assert.equal(c.calls.comments, 1, 'the card still shows the comment that is gone');

  c = card();
  c.box.answer = () => { throw FAILED(); };
  await c.box.addChecklistItem();
  await c.box.deleteLink(7);
  assert.deepEqual(c.calls.alerts, ['ru:Not saved: the board answered with an error — the details are in Settings → Errors.', 'ru:Not saved: the board answered with an error — the details are in Settings → Errors.']);
  assert.equal(c.calls.closed, 0);
  // the item's own 404 (deleted in another tab) is still no failure
  c = card();
  c.box.answer = () => { throw Object.assign(new Error('checklist item not found'), { status: 404 }); };
  await c.box.deleteChecklistItem(5);
  await c.box.toggleChecklist(5);
  assert.deepEqual(c.calls.alerts, []);
});

test('Send back refused after its reason was saved: the second try does not post the reason again', async () => {
  const c = card();
  const input = fakeEl();
  input.value = 'not right';
  c.els['return-pop'] = { querySelector: () => input };
  let fail = true;
  c.box.answer = (m) => { if (m === 'PATCH' && fail) throw FAILED(); return {}; };
  await c.box.doReturn(input.value.trim());
  assert.equal(c.calls.alerts.length, 1, 'the refused move is not said');
  assert.equal(c.calls.popClosed, 0, 'the pop with what was typed goes away');
  assert.equal(input.value, '', 'the reason, already saved as a comment, stays in the field to be posted again');
  fail = false;
  await c.box.doReturn(input.value.trim());
  assert.equal(c.calls.api.filter((x) => x.method === 'POST').length, 1, 'the reason is posted twice');
  assert.deepEqual(c.calls.opened, ['VV-1']);
});

test('answering the window of a refusal over Send back keeps the pop and what was typed', () => {
  const box = { closed: 0, closeReturnPop: () => { box.closed++; } };
  vm.runInNewContext(take('function returnPopOutside('), box);
  const inside = (sel) => ({ id: '', closest: (q) => (q.split(',').map((x) => x.trim()).includes(sel) ? {} : null) });
  box.returnPopOutside({ target: inside('.modal-overlay') });
  assert.equal(box.closed, 0, 'the OK of the refusal closed the pop with the reason typed in it');
  box.returnPopOutside({ target: inside('#return-pop') });
  assert.equal(box.closed, 0);
  box.returnPopOutside({ target: inside('#board') });
  assert.equal(box.closed, 1, 'a click outside no longer closes the pop');
});

test('Accept on a deleted task says so and takes the card off; a failure keeps the card', async () => {
  const init = read('init.js');
  const at = init.indexOf("$('d-accept-btn').onclick = async () => {");
  assert.ok(at >= 0, 'the Accept button is wired elsewhere');
  const code = init.slice(at, init.indexOf('\n};\n', at) + 3);
  const run = async (err) => {
    const els = {};
    const calls = { alerts: [], closed: 0, refreshed: 0 };
    const box = {
      $: (id) => { if (!els[id]) els[id] = {}; return els[id]; }, seg: (s) => s, state: { drawerKey: 'VV-1' },
      api: async () => { if (err) throw err; return {}; },
      sayRefused: (e, key) => { const r = refusalText(e); calls.alerts.push(tr(r.text)); if (r.gone && key === box.state.drawerKey) { calls.closed++; box.state.drawerKey = null; } if (r.refresh) calls.refreshed++; },
      closeDrawer: () => { calls.closed++; box.state.drawerKey = null; }, refresh: async () => { calls.refreshed++; },
    };
    vm.runInNewContext(code, box);
    await els['d-accept-btn'].onclick();
    return calls;
  };
  assert.deepEqual(await run(NO_TASK()), { alerts: ['ru:This task no longer exists — it was deleted.'], closed: 1, refreshed: 1 });
  const failed = await run(FAILED());
  assert.equal(failed.closed, 0, 'an accept the server failed closes the card as if it were done');
  assert.equal(failed.alerts.length, 1);
  assert.deepEqual(await run(null), { alerts: [], closed: 1, refreshed: 1 });
});

test('▶ on a deleted task: the right words, and the card and its ghost go', async () => {
  const sse = read('sse.js');
  const takeSse = takeFrom(sse, 'sse.js');
  const calls = { alerts: [], closed: 0, refreshed: 0 };
  const box = {
    tr, refusalLine, refusalText, state: { drawerKey: 'VV-1' },
    styledAlert: (m) => calls.alerts.push(m), flashButton: () => {}, openTerminalOf: () => {}, copyText: async () => true,
    askProjectFolder: async () => false, getSetting: () => 'board', pickedSetting: () => 'board', boardOnly, effortOf, startEffort, checksOnly, launchMode: async () => 'board', manualRefusal: () => ({}),
    closeDrawer: () => { calls.closed++; box.state.drawerKey = null; }, refresh: () => { calls.refreshed++; },
    failure: null, api: async () => { throw box.failure; },
  };
  const BOARD_WHY = sse.slice(sse.indexOf('const BOARD_WHY = {'), sse.indexOf('\n};\n', sse.indexOf('const BOARD_WHY = {')) + 3);
  vm.runInNewContext([takeSse('function refusedManual('), takeSse('function refusedCheck('), takeSse('function startRefused('), takeSse('async function postLaunch('), BOARD_WHY, takeSse('export async function launchInClaude(')].join('\n'), box);
  box.failure = Object.assign(NO_TASK(), { body: {} });
  await box.launchInClaude({ text: 'x', project: 'demo', keys: ['VV-1'] });
  assert.deepEqual(calls, { alerts: ['ru:Could not start Claude: ru:the task no longer exists — it was deleted'], closed: 1, refreshed: 1 });
  box.state.drawerKey = 'VV-1';
  await box.postLaunch({ mode: 'terminal', text: 'x', keys: ['VV-1'] }, null);
  assert.equal(calls.closed, 2, 'a start in the Terminal leaves the card of the deleted task open');
  // another task's card, and a failure that is no deletion, stay
  box.state.drawerKey = 'VV-9';
  await box.launchInClaude({ text: 'x', project: 'demo', keys: ['VV-1'] });
  assert.equal(calls.closed, 2, 'the card of another task closes');
  box.state.drawerKey = 'VV-1';
  box.failure = Object.assign(FAILED(), { body: {} });
  await box.launchInClaude({ text: 'x', project: 'demo', keys: ['VV-1'] });
  assert.equal(calls.closed, 2, 'a failure of the start closes the card');
  // card of a live task of the column stays; the board is read again
  box.failure = Object.assign(NO_TASK(), { body: {} });
  const readBefore = calls.refreshed;
  await box.launchInClaude({ text: 'x', project: 'demo', keys: ['VV-1', 'VV-2'] });
  assert.equal(calls.closed, 2, 'a refused start of the column closed the card of a live task');
  assert.equal(calls.refreshed, readBefore + 1);
});

function openCard({ server = 'up' } = {}) {
  const els = {};
  const calls = { patches: [], alerts: [], closed: 0, refreshed: 0, queued: new Map(), dropped: [] };
  const box = {
    $: (id) => { if (!els[id]) els[id] = fakeEl(); return els[id]; },
    state: { drawerKey: 'VV-1' },
    tr, seg: (s) => s, canRetry, changedFields, refusalText, refusalLine,
    server,
    api: async (method, path, body) => {
      calls.patches.push({ path, body: { ...body } });
      if (box.during) box.during();
      const s = box.server;
      if (s === 'down') throw Object.assign(new Error('Failed to fetch'), { offline: true });
      if (s === 'gone') throw NO_TASK();
      if (s === 'old') throw Object.assign(new Error('cannot go straight from "todo" to "done"'), { status: 400 });
      if (typeof s === 'number') throw Object.assign(new Error(s >= 500 ? 'internal error' : 'title: at most 300 characters'), { status: s });
      return {};
    },
    selVal: (id) => (id === 'd-status' ? 'todo' : '0'),
    styledAlert: (m) => calls.alerts.push(m),
    closeDrawer: () => { calls.closed++; box.state.drawerKey = null; },
    refresh: () => { calls.refreshed++; },
    noteUnsaved: (fn, key) => { calls.queued.set(key, fn); },
    dropUnsaved: (key) => { calls.dropped.push(key); calls.queued.delete(key); },
    setTimeout: () => 1, clearTimeout: () => {},
    unsentEdits: createUnsentEdits(),
    editInTurn: createTurns(),
    descConflicts: new Map(), descConflict() {},
    queuedBase: new Map(), descSending: new Map(), descBaseOf: () => '', descSent() {},
  };
  vm.runInNewContext([
    'var autosaveTimer = null; var drawerLocked = false; var drawerLabels = []; var newFormId = 1; var creatingForm = null; var pendingAttachments = [];',
    'var drawerSnapshot = { title: "found edit", description: "", priority: 0, labels: [], status: "todo" }; var drawerShown = () => true;',
    take('export function sayRefused('),
    take('export async function doAutosave('),
    take('function queueTaskEdit('),
    take('async function resendTaskEdit('),
    take('function editRefusedText('),
    take('function showSaveNote('),
    take('function formToSave('),
    take('async function doAutosaveOnce('),
  ].join('\n'), box);
  box.$('d-title').value = 'found edit';
  const note = () => (els['d-save-note'] && !els['d-save-note'].classList.contains('hidden') ? els['d-save-note'].textContent : null);
  const typed = async (title) => { box.$('d-title').value = title; await box.doAutosave(); await settle(); };
  return { box, calls, note, typed };
}

test('an edit the server fails (5xx) is said in the card, waits behind «not saved» and gets there once the server answers', async () => {
  const c = openCard({ server: 500 });
  await c.typed('found edit more words'); // an unhandled refusal rejects here
  assert.equal(c.note(), 'ru:The change is not saved yet: the board answered with an error — the details are in Settings → Errors. Your next change tries again, or click “not saved” at the top.');
  assert.ok(c.calls.queued.has('task:VV-1'), 'the failed edit is not behind the «not saved» badge');
  assert.equal(c.box.$('d-title').value, 'found edit more words', 'the typed text left the field');
  c.box.server = 'up';
  await c.calls.queued.get('task:VV-1')(); // a click on «not saved»
  assert.deepEqual(c.calls.patches.at(-1).body, { title: 'found edit more words' }, 'the resend does not carry the edit');
  assert.equal(c.note(), null, 'the note stays once the edit got there');
  assert.equal(c.box.unsentEdits.size, 0);
});

test('an edit the server refuses (4xx) is said with its reason, is not queued, and the next change tries again', async () => {
  const c = openCard({ server: 400 });
  await c.typed('found edit more words');
  assert.equal(c.note(), 'ru:The change is not saved: ru:the board did not accept it');
  assert.equal(c.calls.queued.size, 0, 'a refusal waits in the queue forever');
  c.box.server = 'up';
  await c.typed('found edit more words!');
  assert.deepEqual(c.calls.patches.at(-1).body, { title: 'found edit more words!' });
  assert.equal(c.note(), null, 'the note of the refusal stays over a saved edit');
});

test('an edit of a task deleted outside closes the card and its ghost; without a connection it waits quietly as before', async () => {
  let c = openCard({ server: 'gone' });
  await c.typed('x');
  assert.deepEqual(c.calls.alerts, ['ru:This task no longer exists — it was deleted.']);
  assert.equal(c.calls.closed, 1);
  assert.equal(c.calls.refreshed, 1, 'the ghost of the deleted task stays on the board');
  assert.equal(c.note(), null);
  c = openCard({ server: 'down' });
  await c.typed('x');
  assert.ok(c.calls.queued.has('task:VV-1'));
  assert.equal(c.note(), null, 'no connection is said by the badge, not by the card');
  assert.deepEqual(c.calls.alerts, []);
});

test('a status move from an old column: the card says it and reads the board again; a refusal for a card left behind names its task', async () => {
  let c = openCard({ server: 'old' });
  await c.typed('x');
  assert.equal(c.note(), 'ru:The change is not saved: ru:the task has to go through work first');
  assert.equal(c.calls.refreshed, 1, 'the card keeps showing the old column');
  c = openCard({ server: 400 });
  c.box.during = () => { c.box.state.drawerKey = 'VV-2'; };
  await c.typed('x');
  assert.deepEqual(c.calls.alerts, ['VV-1: ru:The change is not saved: ru:the board did not accept it']);
  assert.equal(c.note(), null, 'the note of VV-1 shows over the card of VV-2');
});

test('a refused status goes back in the card, and the next edit is not refused for it', async () => {
  const c = openCard({ server: 'old' });
  const shown = { status: 'done' };
  Object.assign(c.box, {
    drawerStatus: 'review',
    selVal: (id) => (id === 'd-status' ? shown.status : '0'),
    buildStatusSelect: (status) => { shown.status = status; },
  });
  c.box.drawerSnapshot.status = 'review';
  await c.typed('x');
  assert.equal(c.calls.patches.at(-1).body.status, 'done');
  assert.equal(shown.status, 'review', 'the refused status stayed in the picker');
  c.box.server = 'up';
  await c.typed('x and more');
  assert.deepEqual(c.calls.patches.at(-1).body, { title: 'x and more' }, 'the next edit carries the refused status again');
});

test('CK-829: an edit of the checklist the server did not take waits to be sent and is said; a gone item leaves with a word', async () => {
  for (const [name, act] of Object.entries({
    text: async (b) => { b.scheduleChecklistSave(5, 'new text'); await b.pending(); },
    tick: (b) => b.toggleChecklist(5),
    remove: (b) => b.deleteChecklistItem(5),
  })) {
    for (const failure of [Object.assign(new Error('boom'), { status: 500 }), Object.assign(new Error('Failed to fetch'), { offline: true })]) {
      const c = card();
      c.box.answer = () => { throw failure; };
      await act(c.box);
      await settle();
      assert.equal(c.calls.queued, 1, `${name}: a change lost to ${failure.message} is not queued to be sent again`);
      assert.equal((c.calls.notes || []).length, 1, `${name}: the card says nothing about ${failure.message}`);
      assert.deepEqual(c.calls.alerts, []);
    }
  }
  const c = card();
  c.box.answer = () => { throw Object.assign(new Error('checklist item not found'), { status: 404 }); };
  c.box.scheduleChecklistSave(5, 'new text'); await c.box.pending(); await settle();
  assert.equal(c.calls.queued, undefined, 'an edit of a deleted item is sent again and again');
  assert.deepEqual(c.calls.notes, ['ru:This item of the checklist was deleted elsewhere — your change to it is not saved.']);
});
