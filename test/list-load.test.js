import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { latestRequest, LIST_NOTICE, listErrorDelay, listFailure, listNotice, listRetry, sameScreen, SWITCH_SKELETON_MS } from '../public/js/live-rules.js';

const src = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from sidebar.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const line = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from sidebar.js`);
  return src.slice(at, src.indexOf('\n', at) + 1);
};

const LISTS = {
  alpha: [{ id: 1, key: 'AL-1' }, { id: 2, key: 'AL-2' }],
  beta: [{ id: 7, key: 'BE-7' }],
};
const down = () => Object.assign(new Error('Failed to fetch'), { offline: true });

function board() {
  const els = {};
  const fake = () => {
    const classes = new Set(['hidden']);
    return {
      textContent: '', title: '', onclick: null,
      classList: { contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } },
    };
  };
  const calls = { alerts: [], views: [], requests: [], boards: 0, projects: 0, notes: [] };
  const store = {};
  // the page's timers, in the test's hands: a skeleton and a retry happen when the test says so
  const timers = new Map();
  let nextTimer = 1;
  const page = new Set();
  const box = {
    openSide: () => {},
    setTimeout: (fn, ms) => { const id = nextTimer++; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    document: { documentElement: { classList: { add: (c) => page.add(c), remove: (c) => page.delete(c), contains: (c) => page.has(c) } } },
    $: (id) => { if (!els[id]) els[id] = fake(); return els[id]; },
    state: { slug: 'alpha', projSettings: null, search: '', tasks: [], projects: [] },
    tr: (s) => `ru:${s}`,
    ALL: '*', DASH: '#dash', NOW: '#now', REVIEW: '#review', DONE: '#done', AUTO: '#auto', HEALTH: '#health', HORIZON: '#horizon', CALENDAR: '#calendar', CHAOS: '#chaos', SETTINGS: '#settings',
    latestRequest, LIST_NOTICE, listErrorDelay, listFailure, listNotice, listRetry, sameScreen, SWITCH_SKELETON_MS,
    server: { mode: 'up' }, // 'up' | 500 | 'down'
    api: async (method, path, body, opts) => {
      calls.requests.push(path);
      const mode = box.server.mode;
      if (mode === 'down') throw down();
      if (typeof mode === 'number') throw Object.assign(new Error('x'), { status: mode });
      const slug = decodeURIComponent((path.match(/project=([^&]+)/) || [])[1] || '');
      if (opts && opts.signal && opts.signal.aborted) throw Object.assign(new Error('aborted'), { aborted: true });
      return LISTS[slug] || [];
    },
    showView: (v) => { calls.views.push(v); return true; },
    renderBoard: () => { calls.boards++; calls.notes.push(box.state.listNote ? box.state.listNote.text : null); },
    renderSidebar: () => {}, renderTopbar: () => {},
    renderDashboard: async () => {}, renderNow: async () => {}, renderReview: async () => {}, renderDone: async () => {}, renderAutomations: async () => {}, renderHealth: async () => {},
    renderHorizon: async () => {}, renderCalendar: async () => {}, renderChaos: async () => {}, renderProjectSettings: async () => {},
    loadProjects: async () => { calls.projects++; },
    styledAlert: (m) => { calls.alerts.push(m); },
    localStore: { setItem: (k, v) => { store[k] = v; } },
    sessionStore: { setItem: (k, v) => { store[`session:${k}`] = v; } },
    encodeURIComponent,
  };
  vm.runInNewContext([
    'var shownScreen = null; var pendingLoad = null;',
    line('const tasksRequest = latestRequest();'),
    line('let switchTimer = null;'),
    take('function showSwitching('),
    line('let errorRetry = '),
    take('function retryLater('),
    take('function retryNoMore('),
    line('const currentScreen = '),
    line('const SECTION_VIEW = '),
    line('const viewOf = '),
    take('export async function loadTasks('),
    take('function screenShown('),
    take('function listFailed('),
    take('function putScreenBack('),
    take('function showLoadNotice('),
    take('export function retryLoad('),
    take('export function resumeSwitch('),
    take('export function selectProject('),
    take('function rememberScreen('),
  ].join('\n'), box);
  const notice = () => (els['load-badge'] && !els['load-badge'].classList.contains('hidden') ? els['load-badge'].textContent : null);
  const due = () => [...timers.values()].map((t) => t.ms);
  // fire the one timer due after `ms` (the page has at most one of each kind waiting)
  const fire = async (ms) => {
    const hit = [...timers].find(([, t]) => t.ms === ms);
    assert.ok(hit, `no timer of ${ms} ms is waiting (waiting: ${due().join(', ') || 'none'})`);
    timers.delete(hit[0]);
    hit[1].fn();
    await settle(); await settle();
  };
  return { box, els, calls, store, notice, due, fire, page };
}

async function opened() {
  const b = board();
  await b.box.loadTasks();
  assert.equal(b.box.state.tasks.length, 2, 'the first load did not land');
  return b;
}
const settle = () => new Promise((r) => setImmediate(r));

test('a project switch the server does not answer keeps the previous project and its list, and says so once', async () => {
  for (const mode of [500, 'down']) {
    const b = await opened();
    b.box.server.mode = mode;
    b.box.selectProject('beta');
    await settle();
    assert.equal(b.box.state.slug, 'alpha', `${mode}: the selected project was dropped or left on the one that never loaded`);
    assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['AL-1', 'AL-2'], `${mode}: the board was emptied`);
    assert.equal(b.store['kb.ui.project'], 'alpha', 'a reload of the page would open the project that never loaded');
    assert.equal(b.notice(), `ru:${LIST_NOTICE.project.label}`);
    assert.equal(b.calls.alerts.length, 1, 'a click that went nowhere is not said in words');
    // the same switch failing again (another click, or the retry) does not ask the person again
    b.box.selectProject('beta');
    await settle();
    assert.equal(b.calls.alerts.length, 1, 'every failed retry pops the same message up again');
    assert.equal(b.box.state.slug, 'alpha');
  }
});

test('when the server answers again, the switch that failed is made — and the notice goes', async () => {
  const b = await opened();
  b.box.server.mode = 'down';
  b.box.selectProject('beta');
  await settle();
  b.box.server.mode = 'up';
  // the stream reconnected: es.onopen first resumes the switch, then its refresh loads the list
  b.box.resumeSwitch();
  assert.equal(b.box.state.slug, 'beta', 'the switch that failed for lack of a connection is not made when it is back');
  await b.box.loadTasks();
  assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['BE-7']);
  assert.equal(b.notice(), null, 'the notice outlives the failure');
  assert.equal(b.store['kb.ui.lastProject'], 'beta');
});

test('a click on the notice tries again at once', async () => {
  const b = await opened();
  b.box.server.mode = 500;
  b.box.selectProject('beta');
  await settle();
  b.box.server.mode = 'up';
  b.box.retryLoad();
  await settle(); await settle();
  assert.equal(b.box.state.slug, 'beta');
  assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['BE-7']);
  assert.equal(b.notice(), null);
});

test('a search the server does not answer keeps the list and the project, without a modal', async () => {
  const b = await opened();
  b.box.server.mode = 'down';
  b.box.state.search = 'click';
  await b.box.loadTasks();
  assert.equal(b.box.state.slug, 'alpha', 'a failed search drops the project');
  assert.equal(b.box.state.tasks.length, 2, 'a failed search empties the board');
  assert.equal(b.notice(), `ru:${LIST_NOTICE.search.label}`);
  assert.equal(b.calls.alerts.length, 0, 'typing in the search must not be stopped by a modal');
  b.box.server.mode = 'up';
  await b.box.loadTasks(); // the refresh of a reconnect, or the next search
  assert.equal(b.notice(), null);
});

test('a person who moved on is not taken back to the switch that failed', async () => {
  const b = await opened();
  b.box.server.mode = 'down';
  b.box.selectProject('beta');
  await settle();
  b.box.server.mode = 'up';
  b.box.selectProject('#dash'); // went to the dashboard meanwhile
  await settle();
  assert.equal(b.notice(), null, 'the notice of the old switch stays over a newer screen');
  b.box.resumeSwitch();
  assert.equal(b.box.state.slug, '#dash', 'the reconnect took the person to the project they left');
});

test('a request overtaken by a newer one is not a failure, whatever it ends with', async () => {
  for (const end of ['cancelled', 'failed late']) {
    const b = await opened();
    const slow = [];
    b.box.api = (method, path, body, opts) => new Promise((resolve, reject) => {
      slow.push({ resolve, reject });
      if (end === 'cancelled' && opts && opts.signal) opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { aborted: true })));
    });
    b.box.state.search = 'c';
    const first = b.box.loadTasks();
    b.box.state.search = 'click';
    const second = b.box.loadTasks();
    // the newer answer lands; the old request ends after it — cancelled, or with an error that raced the cancel
    slow[1].resolve([{ id: 2, key: 'AL-2' }]);
    await second;
    if (end === 'failed late') slow[0].reject(Object.assign(new Error('x'), { status: 500 }));
    await first;
    assert.equal(b.notice(), null, `${end}: an overtaken search raised the notice`);
    assert.equal(b.calls.alerts.length, 0);
    assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['AL-2']);
  }
});

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('the reconnect of the stream makes the switch first, its refresh loads it; the notice is on the page', () => {
  const sse = code(readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8'));
  const onopen = sse.slice(sse.indexOf('function linkOpened('), sse.indexOf('function streamMessage('));
  assert.match(onopen, /if \(boardLoadStarted\) resumeSwitch\(\);\s*if \(boardLoadStarted\) refresh\(\)(;|\.catch\()/,
    'the switch that failed for lack of a connection is not made when the stream comes back');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="load-badge" class="load-badge hidden"><\/button>/, 'the notice is gone from the topbar');
});

test('a project the server refuses empties the board, as a gone project did before', async () => {
  const b = board();
  b.box.server.mode = 404;
  b.box.state.slug = 'gone-project';
  await b.box.loadTasks();
  assert.equal(b.box.state.slug, null);
  assert.equal(b.box.state.tasks.length, 0);
  assert.equal(b.notice(), null);
});

test('a switch the server answers with an error says so, and the board tries again by itself until it opens', async () => {
  const b = await opened();
  b.box.server.mode = 500;
  b.box.selectProject('beta');
  await settle();
  assert.deepEqual(b.calls.alerts, [`ru:${LIST_NOTICE.project.alertError}`], 'an error is said as «not responding, once the connection is back»');
  assert.equal(b.els['load-badge'].title, `ru:${LIST_NOTICE.project.error}`);
  assert.deepEqual(b.due(), [listErrorDelay(0)], 'nothing is going to try the switch again');
  await b.fire(listErrorDelay(0)); // still failing: the next try waits longer, and says nothing new
  assert.equal(b.box.state.slug, 'alpha');
  assert.deepEqual(b.due(), [listErrorDelay(1)], 'a server that keeps failing is asked as often as at first');
  assert.equal(b.calls.alerts.length, 1, 'every retry pops the message up again');
  b.box.server.mode = 'up';
  await b.fire(listErrorDelay(1));
  assert.equal(b.box.state.slug, 'beta', 'the board does not open the project once the server answers');
  assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['BE-7']);
  assert.equal(b.notice(), null);
  assert.deepEqual(b.due(), [], 'a retry is still waiting after the project opened');
  // the next error starts again from the first, short wait
  b.box.server.mode = 503;
  b.box.selectProject('alpha');
  await settle();
  assert.deepEqual(b.due(), [listErrorDelay(0)]);
});

test('no connection leaves the retry to the reconnect of the stream, and says so', async () => {
  const b = await opened();
  b.box.server.mode = 'down';
  b.box.selectProject('beta');
  await settle();
  assert.deepEqual(b.calls.alerts, [`ru:${LIST_NOTICE.project.alert}`]);
  assert.equal(b.els['load-badge'].title, `ru:${LIST_NOTICE.project.title}`);
  assert.deepEqual(b.due(), [], 'without a connection the board knocks on a dead server on a timer');
  // an error that came first, then the connection dropped: the timer of the error goes
  b.box.server.mode = 500;
  b.box.retryLoad();
  await settle(); await settle();
  assert.deepEqual(b.due(), [listErrorDelay(0)]);
  b.box.server.mode = 'down';
  await b.fire(listErrorDelay(0));
  assert.deepEqual(b.due(), [], 'a timer of the error outlives it');
});

test('the first load of a board the server fails draws its columns with a note, and tries again by itself', async () => {
  for (const mode of [500, 'down']) {
    const b = board();
    b.box.server.mode = mode;
    await b.box.loadTasks();
    const said = listNotice('first', mode === 500).title;
    assert.equal(b.box.state.slug, 'alpha');
    assert.equal(b.calls.boards, 1, `${mode}: the board is left without its columns`);
    assert.deepEqual(b.calls.notes, [said], `${mode}: the empty columns do not say the tasks did not load`);
    assert.equal(b.notice(), `ru:${LIST_NOTICE.first.label}`);
    assert.equal(b.calls.alerts.length, 0);
    assert.deepEqual(b.due(), mode === 500 ? [listErrorDelay(0)] : []);
    // the note's own button tries now
    b.box.server.mode = 'up';
    b.box.state.listNote.retry();
    await settle(); await settle();
    assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['AL-1', 'AL-2']);
    assert.equal(b.box.state.listNote, null, `${mode}: the note stays over the list that came`);
    assert.equal(b.calls.notes.at(-1), null);
    assert.equal(b.notice(), null);
    assert.deepEqual(b.due(), [], `${mode}: a retry is still waiting after the list came`);
  }
});

test('a slow switch shows the skeleton instead of the cards left behind; a quick one never does; a search never does', async () => {
  const b = await opened();
  let answer = null;
  b.box.api = (method, path) => new Promise((resolve) => { answer = () => resolve(path.includes('beta') ? LISTS.beta : LISTS.alpha); });
  b.box.selectProject('beta');
  assert.deepEqual(b.due(), [SWITCH_SKELETON_MS], 'a switch does not wait to show the skeleton');
  assert.equal(b.page.has('switching'), false, 'the skeleton blinks on a quick switch');
  await b.fire(SWITCH_SKELETON_MS);
  assert.equal(b.page.has('switching'), true, 'the cards of the project left behind stay under the new title');
  answer();
  await settle(); await settle();
  assert.equal(b.page.has('switching'), false, 'the skeleton outlives the answer');
  assert.deepEqual(b.box.state.tasks.map((t) => t.key), ['BE-7']);
  // quick: the answer comes before the wait is over
  b.box.selectProject('alpha');
  answer();
  await settle(); await settle();
  assert.deepEqual(b.due(), [], 'the wait for the skeleton outlives a quick answer');
  assert.equal(b.page.has('switching'), false);
  // a search on the same board keeps its cards — the prefilter shows them at once
  b.box.state.search = 'x';
  const searching = b.box.loadTasks();
  assert.deepEqual(b.due(), [], 'a search hides the board behind the skeleton');
  answer();
  await searching;
});

test('a switch that fails puts the previous board back from under the skeleton', async () => {
  const b = await opened();
  let fail = null;
  b.box.api = () => new Promise((resolve, reject) => { fail = () => reject(Object.assign(new Error('x'), { status: 500 })); });
  b.box.selectProject('beta');
  await b.fire(SWITCH_SKELETON_MS);
  assert.equal(b.page.has('switching'), true);
  fail();
  await settle(); await settle();
  assert.equal(b.page.has('switching'), false, 'the board stays hidden behind the skeleton after the switch failed');
  assert.equal(b.box.state.slug, 'alpha');
});

test('the note of a failed first load is drawn at the top of the first column, and its button tries again', () => {
  const boardSrc = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  const at = boardSrc.indexOf('function drawListNote(');
  assert.ok(at >= 0, 'drawListNote is gone from board.js');
  const made = [];
  const firstColumn = { prepended: [], prepend(el) { this.prepended.push(el); } };
  const box = {
    state: { listNote: null },
    tr: (s) => `ru:${s}`,
    esc: (s) => String(s).replace(/</g, '&lt;'),
    document: {
      createElement: () => {
        const button = { onclick: null };
        const el = { className: '', innerHTML: '', querySelector: (sel) => (sel === 'button' ? button : null), button };
        made.push(el);
        return el;
      },
    },
  };
  vm.runInNewContext(boardSrc.slice(at, boardSrc.indexOf('\n}\n', at) + 2), box);
  const board = { querySelector: (sel) => (sel === '.col-body' ? firstColumn : null) };
  box.drawListNote(board);
  assert.equal(firstColumn.prepended.length, 0, 'a board whose list came gets the note');
  let retried = 0;
  box.state.listNote = { text: LIST_NOTICE.first.error, retry: () => { retried++; } };
  box.drawListNote(board);
  assert.equal(firstColumn.prepended.length, 1);
  const el = firstColumn.prepended[0];
  assert.equal(el.className, 'board-note');
  assert.ok(el.innerHTML.includes(`ru:${LIST_NOTICE.first.error}`), 'the note does not say why the board is empty');
  assert.ok(el.innerHTML.includes('ru:Try now'));
  el.button.onclick();
  assert.equal(retried, 1, 'the button of the note does not try again');
  const render = code(boardSrc).slice(code(boardSrc).indexOf('export function renderBoard('));
  assert.match(render.slice(0, render.indexOf('\n}\n')), /drawListNote\(board\);/, 'the board is drawn without the note');
});

test('the page hides the board and shows the skeleton while a switch is slow', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(css, /html\.switching #board, html\.switching #link-lines \{ display: none !important; \}/, 'the cards of the project left behind stay on screen');
  assert.match(css, /html\.switching #boot \{ display: flex;[^}]*\}/, 'nothing stands in for the board while the switch is slow');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {\n  .boot,'));
  assert.match(reduced.slice(0, reduced.indexOf('\n}\n')), /html\.switching #boot \{ animation: none; \}/, 'the skeleton fades in for a person who asked for less motion');
});
