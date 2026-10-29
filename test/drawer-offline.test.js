import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canRetry, createUnsentComments, refusalText } from '../public/js/unsaved.js';

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
    textContent: '', innerHTML: '', disabled: false, dataset: {}, scrollTop: 0, scrollHeight: 0, onclick: null,
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c),
      toggle: (c, on) => { const v = on === undefined ? !classes.has(c) : Boolean(on); if (v) classes.add(c); else classes.delete(c); return v; },
    },
    querySelectorAll: () => [], querySelector: () => null,
  };
}

// the comment list of the card: the rows the server gave, then the unsent ones the card paints under them
function commentsBox() {
  let rows = [];
  const unsentRows = () => rows.filter((r) => r.html.includes('class="comment unsent"'));
  return {
    get innerHTML() { return rows.map((r) => r.html).join(''); },
    set innerHTML(h) { rows = h ? [{ html: h }] : []; },
    insertAdjacentHTML(pos, h) { for (const part of h.split(/(?=\s*<div class="comment unsent")/)) if (part.trim()) rows.push({ html: part }); },
    querySelectorAll(sel) {
      if (sel === '.comment.unsent') return unsentRows().map((r) => ({ remove: () => { rows = rows.filter((x) => x !== r); } }));
      if (sel === '.comment.unsent [data-drop]') {
        return unsentRows().map((r) => { r.drop = { dataset: { drop: r.html.match(/data-drop="(\d+)"/)[1] }, onclick: null }; return r.drop; });
      }
      return [];
    },
    unsent: () => unsentRows().map((r) => ({ body: (r.html.match(/<div class="comment-body">([\s\S]*?)<\/div>/) || [])[1], drop: r.drop })),
  };
}

// the Terminal tab of the card, with or without its "working" dot
function terminalTab(withDot) {
  const tab = { html: withDot ? '<span class="term-dot" aria-hidden="true"></span>' : '' };
  tab.querySelector = (sel) => (sel === '.term-dot' && tab.html.includes('term-dot')
    ? { remove: () => { tab.html = tab.html.replace(/<span class="term-dot"[^>]*><\/span>/, ''); } } : null);
  tab.insertAdjacentHTML = (pos, h) => { tab.html += h; };
  return tab;
}

function card() {
  const els = {};
  const calls = { posts: [], noted: [], dropped: [], alerts: [], closed: 0, refreshed: 0, rendered: [] };
  const box = {
    $: (id) => { if (!els[id]) els[id] = id === 'comments' ? commentsBox() : fakeEl(); return els[id]; },
    state: { drawerKey: 'VV-1' },
    tr: (s) => `ru:${s}`,
    esc: (s) => String(s),
    ic: () => '',
    seg: (s) => encodeURIComponent(String(s)),
    canRetry, createUnsentComments, refusalText,
    server: { mode: 'up' },
    api: async (method, path, body) => {
      calls.posts.push({ method, path, body });
      const m = box.server.mode;
      if (m === 'down') throw Object.assign(new Error('Failed to fetch'), { offline: true });
      if (typeof m === 'number') throw Object.assign(new Error('task not found'), { status: m });
      return { id: 1 };
    },
    noteUnsaved: (retry, key) => { calls.noted.push({ retry, key }); },
    dropUnsaved: (key) => { calls.dropped.push(key); },
    styledAlert: (m) => { calls.alerts.push(m); },
    closeDrawer: () => { calls.closed++; },
    refresh: () => { calls.refreshed++; },
    renderComments: async (key) => { calls.rendered.push(key); },
    commentArrived: (key, c) => { calls.rendered.push(key); calls.arrived = c; },
    // what renderTerminal needs around it
    renderLaunchButtons: () => {}, getSetting: () => 'auto', shortUrl: (u) => u,
    hintCardTerm: () => {},
    looks: 0,
    pollTerminal: () => { box.looks++; return new Promise((r) => { box.looked = r; }); },
    termUntrusted: new Set(),
  };
  vm.runInNewContext([
    'var termInfo = null; var drawerTask = null; var termKey = null; var termScreen = null; var termFollow = true; var termTimer = null; var termPressed = false; var termScreenOf = null;',
    line('let termPeek = '),
    take('export function peekTerminal('),
    line('const COMMENT_AUTHORS = '),
    line('const unsentComments = '),
    take('export function queueComment('),
    take('async function resendComment('),
    take('function paintUnsent('),
    take('function dropUnsentComment('),
    take('export function sayRefused('),
    line('const LOGIN_NEEDED = '),
    line('const LOGIN_DONE = '),
    line('const AUTO_OFFER = '),
    line('const BARE_MODE = '),
    line('const bareMode = '),
    take('function autoOffer('),
    take('function needsLogin('),
    take('function markTermTab('),
    take('function selectingIn('),
    src.slice(src.indexOf('const TERM_ACTIVITY = {'), src.indexOf('\n};\n', src.indexOf('const TERM_ACTIVITY = {')) + 3),
    take('export function endedWords('),
    take('function renderTerminal('),
    take('function rolledBy('),
  ].join('\n'), box);
  return { box, els, calls };
}
const settle = () => new Promise((r) => setImmediate(r));

test('a comment sent without a connection stays in the card as not sent, and goes once it is back', async () => {
  const c = card();
  c.box.queueComment('VV-1', 'please check the login');
  const shown = c.els.comments.unsent();
  assert.equal(shown.length, 1, 'the comment is gone from the card: the person types it again');
  assert.equal(shown[0].body, 'please check the login');
  assert.match(c.els.comments.innerHTML, /ru:not sent — goes out once the connection is back/);
  assert.equal(c.calls.noted.length, 1);
  assert.match(c.calls.noted[0].key, /^comment:VV-1:\d+$/);
  // the connection is back: the queue runs the resend
  await c.calls.noted[0].retry();
  assert.deepEqual(JSON.parse(JSON.stringify(c.calls.posts.map((p) => p.body))), [{ body: 'please check the login', author: 'me' }]);
  assert.equal(c.els.comments.unsent().length, 0, 'the sent comment still says it is not sent');
  assert.deepEqual(c.calls.rendered, ['VV-1'], 'the card does not show the delivered comment');
  assert.deepEqual(c.calls.arrived, { id: 1 }, 'the card is not given the comment the server took');
});

test('the same text sent again while it waits is not a second comment', async () => {
  const c = card();
  c.box.queueComment('VV-1', 'ok, merge it');
  c.box.queueComment('VV-1', 'ok, merge it');
  assert.equal(c.els.comments.unsent().length, 1, 'the card shows the comment twice');
  const jobs = c.calls.noted.filter((n) => n.retry);
  assert.equal(jobs.length, 1, 'the same text is queued twice and arrives twice');
  assert.equal(c.calls.noted.length, 2, 'the badge is not kept up for the second send');
  await jobs[0].retry();
  assert.equal(c.calls.posts.length, 1);
});

test('a resend that fails again keeps the comment; one the server refuses is dropped', async () => {
  const c = card();
  c.box.queueComment('VV-1', 'first try');
  c.box.server.mode = 'down';
  await assert.rejects(c.calls.noted[0].retry(), (e) => e.offline === true);
  assert.equal(c.els.comments.unsent().length, 1, 'a comment still waiting vanished from the card');
  c.box.server.mode = 404;
  await assert.rejects(c.calls.noted[0].retry(), (e) => e.status === 404);
  assert.equal(c.els.comments.unsent().length, 0, 'a comment that will never go (the task is gone) says it will');
});

test('a waiting comment can be taken back with its ×, and then it is not sent', async () => {
  const c = card();
  c.box.queueComment('VV-1', 'never mind');
  const retry = c.calls.noted[0].retry;
  const [row] = c.els.comments.unsent();
  row.drop.onclick();
  assert.equal(c.els.comments.unsent().length, 0);
  assert.deepEqual(c.calls.dropped, [c.calls.noted[0].key], 'the badge waits for a comment that was taken back');
  await retry();
  assert.equal(c.calls.posts.length, 0, 'a comment taken back went to the server');
});

test('a comment of another task is not painted into the open card', () => {
  const c = card();
  c.box.state.drawerKey = 'VV-2';
  c.box.queueComment('VV-1', 'for the first task');
  assert.equal(c.box.$('comments').unsent().length, 0);
  c.box.state.drawerKey = 'VV-1';
  c.box.paintUnsent('VV-1');
  assert.equal(c.box.$('comments').unsent().length, 1, 'the card of that task does not show it when opened');
});

test('a refusal is said in the words of the board; a task that is gone leaves the board and the card', () => {
  const c = card();
  c.box.sayRefused(Object.assign(new Error('task not found'), { status: 404 }), 'VV-1');
  assert.equal(c.calls.alerts.length, 1);
  assert.doesNotMatch(c.calls.alerts[0], /task not found/, 'the English of the server reaches the Russian board');
  assert.equal(c.calls.closed, 1, 'the open card of a deleted task stays (its sync would say "gone" again)');
  assert.equal(c.calls.refreshed, 1, 'the ghost card stays on the board');
  c.box.sayRefused(Object.assign(new Error('task not found'), { status: 404 }), 'VV-7'); // right click on another card
  assert.equal(c.calls.closed, 1, 'the card of another task was closed');
  c.box.sayRefused(Object.assign(new Error('priority: an integer 0-3'), { status: 400 }), 'VV-1');
  assert.equal(c.calls.refreshed, 2);
  assert.doesNotMatch(c.calls.alerts[2], /priority/);
});

test('the dot of the Terminal tab follows the screen: it goes out when Claude has exited', () => {
  const c = card();
  const tab = terminalTab(true);
  c.els['d-tabs'] = Object.assign(fakeEl(), { querySelector: (sel) => (sel === '[data-tab="terminal"]' ? tab : null) });
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'working…' });
  assert.match(tab.html, /term-dot/);
  c.box.renderTerminal({ session: 's1', dead: true, exit: 0, screen: 'bye' });
  assert.doesNotMatch(tab.html, /term-dot/, 'the tab still says Claude works after it has exited');
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'again' });
  assert.equal((tab.html.match(/term-dot/g) || []).length, 1, 'a running Claude has no dot, or two');
  c.box.renderTerminal({ session: null });
  assert.doesNotMatch(tab.html, /term-dot/, 'a Claude that is gone keeps the dot');
});

// «Close»; the session is said interrupted, and «Continue» brings it back in this terminal
test('a Claude stopped from outside reads «Session interrupted» with its code, and «Continue» shows only while it has exited', () => {
  const c = card();
  c.box.renderTerminal({ session: 's1', dead: true, exit: 143, interrupted: true, screen: 'bye' });
  assert.equal(c.els['term-state'].textContent, 'ru:Session interrupted', 'the code of a signal pushed «Continue» off the line in Russian');
  assert.equal(c.els['term-state'].title, 'ru:Session interrupted · ru:code 143', 'the code is gone from the title too');
  assert.equal(c.els['term-resume'].classList.contains('hidden'), false, 'no «Continue» under an exited Claude');
  c.box.renderTerminal({ session: 's1', dead: true, exit: 0, interrupted: false, screen: 'bye' });
  assert.equal(c.els['term-state'].textContent, 'ru:Finished · ru:code 0', 'a Claude that ended itself reads interrupted');
  assert.equal(c.els['term-resume'].classList.contains('hidden'), false);
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'again' });
  assert.equal(c.els['term-resume'].classList.contains('hidden'), true, '«Continue» over a running Claude');
  c.box.renderTerminal({ session: null });
  assert.equal(c.els['term-resume'].classList.contains('hidden'), true, '«Continue» with no terminal at all');
});

test('the words over the terminal say what its Claude does, and only work makes the dot pulse', () => {
  const c = card();
  c.els['d-tabs'] = Object.assign(fakeEl(), { querySelector: () => terminalTab(false) });
  const state = c.els['term-state'] || c.box.$('term-state');
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'x', activity: 'idle' });
  assert.equal(state.textContent, 'ru:Waits for you', 'a Claude at its prompt is said to work');
  assert.ok(state.classList.contains('live') && state.classList.contains('calm'), 'a waiting Claude pulses as one at work');
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'x', activity: 'background' });
  assert.equal(state.textContent, 'ru:Waits for you · commands in the background');
  assert.ok(!state.classList.contains('calm'), 'commands in the background do not pulse');
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'x', activity: 'busy' });
  assert.equal(state.textContent, 'ru:Working');
  assert.ok(!state.classList.contains('calm'));
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'x', activity: 'question' });
  assert.equal(state.textContent, 'ru:Waits for your answer');
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'x' }); // an older board: no activity in the answer
  assert.equal(state.textContent, 'ru:Running');
  assert.ok(!state.classList.contains('calm'), 'a Claude of unknown activity is taken for one waiting');
});

test('the card explains the bare mode instead of offering a sign-in that cannot work', () => {
  const c = card();
  const opened = [];
  const btn = { onclick: null };
  c.box.openSettingsModal = (sec) => opened.push(sec);
  c.els['term-note'] = Object.assign(fakeEl(), { querySelector: (sel) => (sel === '.term-login' ? btn : null) });
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'Not logged in · Please run /login\n❯ /login\n  Bare mode doesn\'t use the sign-in from /login. It reads ANTHROPIC_API_KEY' });
  assert.equal(c.els['term-note'].dataset.kind, 'bare');
  assert.match(c.els['term-note'].innerHTML, /CLAUDE_CODE_SIMPLE/);
  btn.onclick();
  assert.deepEqual(opened, ['claude']);
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'Not logged in · Please run /login' });
  assert.equal(c.els['term-note'].dataset.kind, 'login', 'a plain sign-in is still offered');
});

const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
test('the comment list, the right-click menu and duplicate go through these', () => {
  const drawer = code(src);
  const list = drawer.slice(drawer.indexOf('function drawComments('), drawer.indexOf('function commentHTML('));
  assert.match(list, /paintUnsent\(key\);/, 'the comment list drops the unsent comments whenever it is read again');
  const menu = drawer.slice(drawer.indexOf('export function openCardMenu('), drawer.indexOf('async function copyTaskLink('));
  assert.match(menu, /if \(e\?\.offline\) \{ queueTaskEdit\(t\.key, body\); return 'queued'; \}\s*sayRefused\(e, t\.key\);/,
    'a right-click change refused by the server shows its English text again');
  const dup = drawer.slice(drawer.indexOf('async function duplicateTask('), drawer.indexOf('export async function deleteTask('));
  assert.match(dup, /else sayRefused\(e, key\);/, 'a duplicate of a deleted task shows the English text of the server again');
});

test('while another tab is on screen, an event of the task looks at the terminal once — and only for a running Claude', async () => {
  const c = card();
  c.box.termKey = 'VV-1';
  c.box.termInfo = { session: 's1', dead: false };
  c.box.peekTerminal();
  c.box.peekTerminal(); // a burst of events while the look is on its way
  assert.equal(c.box.looks, 1, 'a burst of events piles up looks at the terminal (each is a tmux process on the server)');
  c.box.looked();
  await settle();
  c.box.peekTerminal();
  assert.equal(c.box.looks, 2, 'after the look came back, the next event cannot look again');
  c.box.looked();
  await settle();
  c.box.termTimer = 7; // the Terminal tab is on screen: it is polled anyway
  c.box.peekTerminal();
  c.box.termTimer = null;
  c.box.termInfo = { session: 's1', dead: true, exit: 0 }; // already known to have exited
  c.box.peekTerminal();
  c.box.termInfo = { session: 's1', dead: false };
  c.box.state.drawerKey = 'VV-2'; // the card shows another task
  c.box.peekTerminal();
  assert.equal(c.box.looks, 2, 'a look went out that nothing needed');
});

test('the events of the open task and the changes of Claude\'s state make the card look at its terminal', () => {
  const sse = code(readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8'));
  const flush = sse.slice(sse.indexOf('async function flushSseQueue('), sse.indexOf('export function connectSSE('));
  assert.match(flush, /if \(state\.drawerKey && batch\.some\(\(ev\) => ev\.data && ev\.data\.key === state\.drawerKey\)\) peekTerminal\(\);/,
    'Claude handed the task in and exited, and the dot of its Terminal tab stays lit on the other tabs');
  const live = sse.slice(sse.indexOf("if (ev.type === 'task.live')"), sse.indexOf("if (ev.type === 'task.live')") + 300);
  assert.match(live, /peekTerminal\(\);/, 'a Claude that exited (task.live) leaves the dot lit on the other tabs');
});

test('reading above a long screen, the text stays put while the window of a thousand lines rolls', () => {
  const c = card();
  const rows = (from, n) => Array.from({ length: n }, (_, i) => `row ${from + i}`).join('\n');
  const pre = c.box.$('term-screen');
  Object.assign(pre, { scrollTop: 0, clientHeight: 400 });
  Object.defineProperty(pre, 'scrollHeight', { get: () => String(pre.textContent || '').split('\n').length * 16, configurable: true });
  c.box.renderTerminal({ session: 's1', dead: false, screen: rows(0, 1040) });
  vm.runInNewContext('termFollow = false;', c.box); // the person scrolled up to read
  pre.scrollTop = 500 * 16;
  c.box.renderTerminal({ session: 's1', dead: false, screen: rows(7, 1040) }); // seven lines printed, seven dropped
  assert.equal(pre.scrollTop, 493 * 16, 'the text under the reader slides up as the window rolls');
  c.box.renderTerminal({ session: 's1', dead: false, screen: 'cleared\nscreen' }); // another screen: no anchor to keep
  assert.equal(pre.scrollTop, 493 * 16);
  assert.equal(c.box.rolledBy(rows(0, 50), rows(0, 50)), 0);
  const lead = ['', '', ...rows(0, 40).split('\n')];
  assert.equal(c.box.rolledBy(lead.join('\n'), lead.slice(1).join('\n')), 1, 'one matching line (a blank one) is taken for the window standing still');
  assert.equal(c.box.rolledBy(['', '', ...Array(40).fill('')].join('\n'), ['', '', ...Array(40).fill('')].join('\n')), 0, 'blank lines read as a roll');
  // and the text under the reader ran with the output (52 lines in 20 s)
  const same = [...Array(100).fill('─'.repeat(40)), ...rows(0, 1000).split('\n')].slice(0, 1000); // more equal lines than the roll
  const after = [...same.slice(52), ...rows(1000, 52).split('\n')];
  assert.equal(c.box.rolledBy(same.join('\n'), after.join('\n')), 52, 'equal lines at the top of the history read as a window standing still');
  after[after.length - 1] = 'the prompt box drawn anew'; // the bottom of the screen changes along with the roll
  assert.equal(c.box.rolledBy(same.join('\n'), after.join('\n')), 52);
  assert.equal(c.box.rolledBy(same.join('\n'), same.join('\n')), 0, 'a screen that did not change rolled');
  const grown = [...same.slice(0, 900), 'new line'];
  assert.equal(c.box.rolledBy(same.slice(0, 900).join('\n'), grown.join('\n')), 0, 'a window not yet full grows at its bottom, its top stands');
});
