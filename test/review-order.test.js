import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CHECK_LABEL, LIVE_CHECK, checkDescription, checkState, checkingFirst, holdsCheck, reviewGroups, sidebarOrder } from '../public/js/review-rules.js';

const CHECK = 'Check the tasks in Review with different tests and simulate failures, then move them to Done';
const P = (slug, pinned = 0) => ({ slug, name: slug, pinned });

test('the projects come in the order of the sidebar: its first place for a project shown twice, the unseen last', () => {
  const server = [P('aqua'), P('kanban', 1), P('shop'), P('villa', 1), P('quiet')];
  // the sidebar: special entries, then Pinned (kanban, villa), then the sections — where the pinned stand again
  const shown = ['#dash', '#now', '#review', '*', 'kanban', 'villa', 'kanban', 'shop', 'villa', 'aqua'];
  assert.deepEqual(sidebarOrder(server, shown).map((p) => p.slug), ['kanban', 'villa', 'shop', 'aqua', 'quiet']);
  assert.deepEqual(server.map((p) => p.slug), ['aqua', 'kanban', 'shop', 'villa', 'quiet'], 'the list of the board is reordered in place');
  assert.deepEqual(sidebarOrder(server, []).map((p) => p.slug), server.map((p) => p.slug), 'with no sidebar the server order goes');
});

test('a running check says what it does: Claude took it, it waits for an answer in the terminal, or nothing runs', () => {
  assert.equal(checkState(null, null), null);
  assert.equal(checkState({ key: 'CK-7', status: 'doing' }, null), 'checking');
  assert.equal(checkState({ key: 'CK-7', status: 'prep' }, { session: 's', dead: false }), 'checking');
  assert.equal(checkState({ key: 'CK-7', status: 'todo' }, { session: 's', dead: false }), 'answer', 'a started Claude reads as a check waiting to start');
  assert.equal(checkState({ key: 'CK-7', status: 'todo' }, { session: 's', dead: true }), 'waiting', 'a Claude that exited reads as one waiting for an answer');
  assert.equal(checkState({ key: 'CK-7', status: 'todo' }, { session: null }), 'waiting');
  assert.equal(checkState({ key: 'CK-7', status: 'todo' }, undefined), 'waiting');
  assert.equal(checkState({ key: 'CK-7', status: 'prep' }, { session: 's', dead: false, question: true }), 'answer', 'a Claude at a question reads as checking');
  assert.equal(checkState({ key: 'CK-7', status: 'doing' }, { session: 's', dead: false, question: true }), 'answer');
  assert.equal(checkState({ key: 'CK-7', status: 'prep' }, { session: 's', dead: false, question: false }), 'checking');
  assert.equal(checkState({ key: 'CK-7', status: 'prep' }, { session: 's', dead: true, question: true }), 'closed', 'the last screen of a Claude that exited reads as a question');
});

test('a check whose Claude is gone says its session is closed, not that Claude is checking', () => {
  const prep = { key: 'CK-7', status: 'prep' };
  assert.equal(checkState(prep, null, 'gone'), 'closed', 'a Claude started in Terminal or the app that exited reads as checking');
  assert.equal(checkState({ key: 'CK-7', status: 'doing' }, null, 'gone'), 'closed');
  assert.equal(checkState(prep, { session: 's', dead: true }), 'closed');
  // still checking
  assert.equal(checkState(prep, { session: 's', dead: false }, 'gone'), 'checking', 'a live terminal of the board is outweighed by the registry');
  assert.equal(checkState(prep, { session: 's', dead: true }, 'busy'), 'checking', 'a session taken up again elsewhere reads as closed');
  assert.equal(checkState(prep, { session: 's', dead: true }, 'idle'), 'checking', 'a session taken up again elsewhere, at its prompt, reads as closed');
  assert.equal(checkState(prep, null, 'waiting'), 'checking');
  assert.equal(checkState(prep, null, 'starting'), 'checking', 'a Claude being started reads as closed');
  assert.equal(checkState(prep, null), 'checking', 'a check with no session to tell of reads as closed');
  // a check still in To do keeps its own words
  assert.equal(checkState({ key: 'CK-7', status: 'todo' }, null, 'gone'), 'waiting');
});

test('a check started in the Claude app and not sent there says it waits to start in the app; a new start is not closed by an old terminal', () => {
  const prep = { key: 'CK-7', status: 'prep' };
  assert.equal(checkState(prep, null, 'unsent'), 'unsent', 'a check nobody sent in the app reads as Claude checking');
  assert.equal(checkState(prep, { session: 's', dead: true }, 'unsent'), 'unsent', 'the dead terminal of an earlier start outweighs the start in the app');
  assert.equal(checkState(prep, null, 'gone'), 'closed', 'two hours later, still not sent: closed');
  assert.equal(checkState(prep, { session: 's', dead: true }, 'starting'), 'checking', 'a new start reads as closed by the terminal of an earlier one');
  assert.equal(checkState(prep, { session: 's', dead: false, question: true }, 'unsent'), 'answer', 'a live terminal of the board asking something is not the app');
  assert.equal(checkState({ key: 'CK-7', status: 'todo' }, null, 'unsent'), 'waiting');
});

/* ── the page ── */
const src = readFileSync(new URL('../public/js/review.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from review.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const objectAt = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from review.js`);
  return src.slice(at, src.indexOf('\n};\n', at) + 3);
};
const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));

function section({ sidebar, projects, tasks, terminals = {}, live = {} }) {
  const els = {};
  const opened = [];
  const asked = [];
  const box = {
    $: (id) => { if (!els[id]) els[id] = { innerHTML: '', textContent: '', querySelectorAll: () => [] }; return els[id]; },
    document: { querySelectorAll: (sel) => (sel === '#projects .proj[data-slug]' ? sidebar.map((slug) => ({ dataset: { slug } })) : []) },
    state: { slug: '#review', projects, live },
    REVIEW: '#review',
    tr: (s) => s, esc: (s) => String(s), ic: () => '', plural: (n, one, many) => (n === 1 ? one : many),
    titleOf: (t) => t.title, relTime: () => 'now',
    projectLinks: (ts) => ts.map((t) => String(t.project_name)).join(', '), wireProjectLinks: () => {},
    keepFocus: (box, paint) => paint(), wireRows: (box, open) => { for (const el of box.querySelectorAll('.now-row')) el.onclick = () => open(el.dataset.key); },
    CHECK_LABEL, LIVE_CHECK, checkDescription, checkState, checkingFirst, holdsCheck, reviewGroups, sidebarOrder,
    openDrawer: (k) => opened.push(['card', k]), openTerminalOf: (k) => opened.push(['terminal', k]),
    api: async (method, path) => {
      asked.push(path);
      if (path === '/api/tasks') return tasks;
      const key = decodeURIComponent((path.match(/^\/api\/tasks\/([^/]+)\/terminal$/) || [])[1] || '');
      if (key in terminals) return terminals[key];
      throw Object.assign(new Error('x'), { status: 404 });
    },
  };
  vm.runInNewContext([
    'var last = null; var seq = 0;',
    src.slice(src.indexOf('const CHECK_TITLE = '), src.indexOf('\n', src.indexOf('const CHECK_TITLE = ')) + 1),
    objectAt('const CHECK_SAYS = {'),
    src.slice(src.indexOf('const stateOf = '), src.indexOf('\n', src.indexOf('const stateOf = ')) + 1),
    take('function actionHTML('),
    take('function groupHTML('),
    take('function paint('),
    take('function sizeLive('),
    take('export async function renderReview('),
    take('export function repaintReview('),
    take('export function heldWhy('),
  ].join('\n'), box);
  return { box, els, opened, asked };
}
const task = (id, project, key, status, title = `task ${key}`, labels = []) => ({ id, project, key, status, title, labels, updated_at: `2026-10-05 10:00:${String(id).padStart(2, '0')}` });
const check = (id, project, key, status) => task(id, project, key, status, CHECK, [CHECK_LABEL]);

test('the section draws its groups in the order of the sidebar as it stands, pinned projects first', async () => {
  const s = section({
    sidebar: ['#dash', '#now', '#review', '*', 'villa', 'aqua', 'villa', 'shop'],
    projects: [P('aqua'), P('shop'), P('villa', 1)],
    tasks: [task(1, 'aqua', 'AQ-1', 'review'), task(2, 'shop', 'SH-1', 'review'), task(3, 'villa', 'VT-1', 'review')],
  });
  await s.box.renderReview();
  const html = s.els.review.innerHTML;
  const at = (k) => html.indexOf(`data-project="${k}"`);
  assert.ok(at('villa') >= 0 && at('aqua') >= 0 && at('shop') >= 0, 'a group is missing');
  assert.ok(at('villa') < at('aqua') && at('aqua') < at('shop'), 'the groups follow the server\'s list of projects, not the sidebar');
});

test('a check whose Claude waits in the terminal says so, and opens on the Terminal tab of its card', async () => {
  const s = section({
    sidebar: ['villa', 'shop', 'aqua', 'kanban'],
    projects: [P('villa'), P('shop'), P('aqua'), P('kanban')],
    tasks: [
      task(1, 'villa', 'VT-1', 'review'), check(2, 'villa', 'VT-9', 'todo'),  // started, at the trust question
      task(3, 'shop', 'SH-1', 'review'), check(4, 'shop', 'SH-9', 'todo'),    // made, its start failed
      task(5, 'aqua', 'AQ-1', 'review'), check(6, 'aqua', 'AQ-9', 'doing'),   // taken by Claude
      task(7, 'kanban', 'CK-1', 'review'), check(8, 'kanban', 'CK-9', 'prep'), // ▶ moved it at once; Claude asks
    ],
    terminals: {
      'VT-9': { session: 's1', dead: false, screen: 'Do you trust the files in this folder?' }, 'SH-9': { session: null },
      'AQ-9': { session: 's3', dead: false, question: false }, 'CK-9': { session: 's2', dead: false, question: true },
    },
  });
  await s.box.renderReview();
  const html = s.els.review.innerHTML;
  const button = (key) => (html.match(new RegExp(`<button class="btn-ghost rv-open"[^>]*data-key="${key}"[^>]*>[\\s\\S]*?</button>`)) || [''])[0];
  assert.match(button('VT-9'), /Claude is waiting for an answer/, 'a Claude at the trust question reads as a check waiting to start');
  assert.match(button('VT-9'), /data-terminal="1"/);
  assert.match(button('VT-9'), /card-live live-wait/);
  assert.match(button('SH-9'), /The check is waiting to start/);
  assert.doesNotMatch(button('SH-9'), /data-terminal/);
  assert.match(button('AQ-9'), /Claude is checking/);
  assert.doesNotMatch(button('AQ-9'), /data-terminal/);
  assert.match(button('CK-9'), /Claude is waiting for an answer/, 'a check in Preparation whose Claude asks reads as checking');
  assert.match(button('CK-9'), /data-terminal="1"/);
  assert.deepEqual(s.asked.filter((p) => p.endsWith('/terminal')).sort(),
    ['/api/tasks/AQ-9/terminal', '/api/tasks/CK-9/terminal', '/api/tasks/SH-9/terminal', '/api/tasks/VT-9/terminal'],
    'the terminal is not asked of every running check: its column no longer says whether Claude waits (CK-530)');
  for (const says of ['Claude is waiting for an answer', 'Open the terminal of the check — Claude asks something there']) {
    assert.ok(dict.includes(`'${says}':`), `${says} stays English on the Russian board`);
  }
  // the click: the card of the check on its Terminal tab, where the question is answered
  const buttons = [];
  s.els.review.querySelectorAll = (sel) => (sel === '.rv-open'
    ? [...html.matchAll(/<button class="btn-ghost rv-open"[^>]*data-key="([^"]+)"([^>]*)>/g)].map((m) => {
      const b = { dataset: { key: m[1], ...(/data-terminal="1"/.test(m[0]) ? { terminal: '1' } : {}) }, onclick: null };
      buttons.push(b);
      return b;
    }) : []);
  s.box.paint();
  for (const b of buttons) b.onclick();
  assert.deepEqual(s.opened.sort(), [['card', 'AQ-9'], ['card', 'SH-9'], ['terminal', 'CK-9'], ['terminal', 'VT-9']].sort(),
    'the check waiting for an answer opens on the comments, or the others on the terminal');
});

test('the button of a check whose Claude is gone says the session is closed and leads to the card, not the terminal', async () => {
  const s = section({
    sidebar: ['villa', 'shop'],
    projects: [P('villa'), P('shop')],
    tasks: [
      task(1, 'villa', 'VT-1', 'review'), check(2, 'villa', 'VT-9', 'prep'), // Claude started in Terminal, exited
      task(3, 'shop', 'SH-1', 'review'), check(4, 'shop', 'SH-9', 'prep'),   // the board's Claude, its terminal dead
    ],
    terminals: { 'VT-9': { session: null }, 'SH-9': { session: 's4', dead: true, question: false } },
    live: { 2: { claude: 'gone' }, 4: { claude: 'gone' } },
  });
  await s.box.renderReview();
  const html = s.els.review.innerHTML;
  const button = (key) => (html.match(new RegExp(`<button class="btn-ghost rv-open"[^>]*data-key="${key}"[^>]*>[\\s\\S]*?</button>`)) || [''])[0];
  for (const key of ['VT-9', 'SH-9']) {
    assert.match(button(key), /session closed/, `${key}: a check whose Claude is gone reads as Claude checking`);
    assert.match(button(key), /card-live live-gone/, `${key}: the dot of a closed session`);
    assert.doesNotMatch(button(key), /data-terminal|live-busy/);
  }
  assert.ok(dict.includes("'session closed':"), 'session closed stays English on the Russian board');
});

test('the button of a check nobody sent in the Claude app says it waits to start there', async () => {
  const s = section({
    sidebar: ['villa'], projects: [P('villa')],
    tasks: [task(1, 'villa', 'VT-1', 'review'), check(2, 'villa', 'VT-9', 'prep')],
    terminals: { 'VT-9': { session: null } },
    live: { 2: { claude: 'unsent' } },
  });
  await s.box.renderReview();
  const html = s.els.review.innerHTML;
  assert.match(html, /The check is waiting to start in the Claude app/, 'a check nobody sent in the app reads as Claude checking');
  assert.match(html, /card-live live-wait/);
  assert.doesNotMatch(html, /data-terminal|live-busy/);
  assert.ok(dict.includes("'The check is waiting to start in the Claude app':"), 'the words stay English on the Russian board');
});

test('the section is read again when a Claude starts, ends a turn or exits, as the dashboard and Claude now are', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  const line = sse.split('\n').find((l) => l.includes("ev.type === 'task.live'"));
  assert.ok(line, 'the task.live branch is gone from sse.js');
  assert.match(line, /state\.slug === REVIEW/, 'the section keeps saying Claude is checking after its Claude has exited');
  const at = sse.indexOf('async function loadLive(');
  assert.ok(at >= 0, 'loadLive is gone from sse.js');
  assert.match(sse.slice(at, sse.indexOf('\n}\n', at)), /applyLive\(live\.tasks\)[\s\S]*repaintReview\(\)/,
    'the states of the sessions arrive after the section is drawn, and nothing draws it again');
});

test('a fresh page draws the section before the states of the sessions arrive, and draws it again once they do', async () => {
  const s = section({
    sidebar: ['villa'], projects: [P('villa')],
    tasks: [task(1, 'villa', 'VT-1', 'review'), check(2, 'villa', 'VT-9', 'prep')],
    terminals: { 'VT-9': { session: null } },
  });
  await s.box.renderReview();
  assert.match(s.els.review.innerHTML, /Claude is checking/, 'with no state of the session yet the check reads as checking');
  s.box.state.live = { 2: { claude: 'gone' } }; // loadLive
  s.box.repaintReview();
  assert.match(s.els.review.innerHTML, /session closed/, 'the section keeps saying Claude is checking once the states have come');
  assert.equal(s.asked.filter((p) => p === '/api/tasks').length, 1, 'drawing it again from the last answer asked the server again');
  s.box.state.slug = '#dash';
  s.els.review.innerHTML = 'the dashboard';
  s.box.repaintReview();
  assert.equal(s.els.review.innerHTML, 'the dashboard', 'the section was drawn while another view is shown');
});

test('an answer that comes after a newer request is not drawn over it', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const s = section({ sidebar: ['villa'], projects: [P('villa')], tasks: [] });
  const older = [task(1, 'villa', 'VT-1', 'review'), check(2, 'villa', 'VT-9', 'prep')];
  const newer = [task(1, 'villa', 'VT-1', 'review'), task(3, 'villa', 'VT-2', 'review')];
  let n = 0;
  s.box.api = async (method, path) => {
    if (path === '/api/tasks') { n += 1; return n === 1 ? slow.then(() => older) : newer; }
    return { session: null };
  };
  const first = s.box.renderReview(); // the older request, its answer slow
  await s.box.renderReview();         // a newer one, drawn
  release();
  await first;                        // the older answer comes last
  assert.match(s.els.review.innerHTML, /Check in Claude/, 'the older answer was drawn over the newer one');
  assert.doesNotMatch(s.els.review.innerHTML, /VT-9/);
});

test('an answer whose terminal comes after a newer request is not drawn over it either', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const s = section({ sidebar: ['villa'], projects: [P('villa')], tasks: [] });
  const older = [task(1, 'villa', 'VT-1', 'review'), check(2, 'villa', 'VT-9', 'prep')];
  const newer = [task(1, 'villa', 'VT-1', 'review'), task(3, 'villa', 'VT-2', 'review')];
  let n = 0;
  s.box.api = async (method, path) => {
    if (path === '/api/tasks') { n += 1; return n === 1 ? older : newer; }
    return slow.then(() => ({ session: 's', dead: false })); // the terminal of the check answers late
  };
  const first = s.box.renderReview(); // the older request: its list is in, its terminal is slow
  await new Promise((r) => { setImmediate(r); });
  await s.box.renderReview();         // a newer one, drawn: the check has been handed in meanwhile
  release();
  await first;
  assert.match(s.els.review.innerHTML, /Check in Claude/, 'the older answer was drawn once its terminal came');
  assert.doesNotMatch(s.els.review.innerHTML, /VT-9/);
});

test('the group being checked goes on top and shimmers; the others keep the sidebar order and do not', async () => {
  const s = section({
    sidebar: ['aqua', 'shop', 'villa', 'kanban'],
    projects: [P('aqua'), P('shop'), P('villa'), P('kanban')],
    tasks: [
      task(1, 'aqua', 'AQ-1', 'review'),
      task(2, 'shop', 'SH-1', 'review'), check(3, 'shop', 'SH-9', 'todo'),   // made, not started
      task(4, 'villa', 'VT-1', 'review'), check(5, 'villa', 'VT-9', 'doing'), // Claude checks it
      task(6, 'kanban', 'CK-1', 'review'), check(7, 'kanban', 'CK-9', 'prep'), // its Claude is gone
    ],
    terminals: { 'VT-9': { session: 's1', dead: false, question: false }, 'SH-9': { session: null } },
    live: { 7: { claude: 'gone' } },
  });
  await s.box.renderReview();
  const html = s.els.review.innerHTML;
  const panels = [...html.matchAll(/<div class="panel now-run rv-group([^"]*)">[\s\S]*?data-key="([A-Z]+)-/g)].map((m) => [m[2], m[1].trim()]);
  assert.deepEqual(panels.map((p) => p[0]), ['VT', 'AQ', 'SH', 'CK'], 'the group being checked is not on top');
  assert.deepEqual(panels.filter((p) => p[1] === 'rv-live').map((p) => p[0]), ['VT'], 'only the group being checked shimmers');
});

test('checkingFirst keeps the order inside both parts', () => {
  const g = (k, st) => ({ k, st });
  const order = checkingFirst([g('a', null), g('b', 'checking'), g('c', 'waiting'), g('d', 'answer'), g('e', 'closed')], (x) => x.st);
  assert.deepEqual(order.map((x) => x.k), ['b', 'd', 'a', 'c', 'e']);
  assert.deepEqual([...LIVE_CHECK].sort(), ['answer', 'checking']);
});

test('the hold of a check follows the states of the Claude sessions that arrive after the section is drawn, and names its tasks', async () => {
  const old = new Date(Date.now() - 3 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const fresh = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const s = section({
    sidebar: ['alpha'],
    projects: [P('alpha')],
    tasks: [
      task(1, 'alpha', 'AL-1', 'review'),
      { ...task(2, 'alpha', 'AL-2', 'doing'), updated_at: fresh }, // its session closed a minute ago
      { ...task(3, 'alpha', 'AL-3', 'doing'), updated_at: old },   // a busy Claude, no move for three hours
    ],
  });
  await s.box.renderReview();
  const held = () => (s.els.review.innerHTML.match(/<button class="btn-primary rv-go"[^>]*>/) || [''])[0];
  assert.match(held(), /aria-disabled="true"/);
  assert.match(held(), /AL-2/, 'with no state yet, a task that moved in the last two hours holds');
  s.box.state.live = { 2: { claude: 'gone' }, 3: { claude: 'busy' } };
  s.box.repaintReview();
  assert.match(held(), /aria-disabled="true"/, 'the busy Claude does not hold the check once its state is known');
  assert.match(held(), /AL-3/, 'the held button does not name the task a busy Claude is on');
  assert.doesNotMatch(held(), /AL-2/, 'a task whose session closed still holds the check after the states came');
  s.box.state.live = { 2: { claude: 'gone' }, 3: { claude: 'gone' } };
  s.box.repaintReview();
  assert.doesNotMatch(held(), /aria-disabled/, 'nothing holds the check, yet the button stays held');
});
