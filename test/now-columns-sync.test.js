// «Claude now» → Terminals: the real syncColumns of public/js/now-terms.js run on a stand-in DOM. It guards what the
// source-text checks of now-terms.test.js and chat.test.js do not: a column whose neighbour before it goes is not moved
// and keeps its chat's scroll, a gone column leaves the page, the shutter over a column's tasks shows the one task at work
// with «Show all tasks (N)» and opens or closes every column, and the chat-or-terminal setting repaints the columns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
const strip = (file) => source(file).replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');

// A node of the stand-in DOM. A part of a column is looked up by the last class of its selector and exists when that
// class is in the HTML the column was given (the chat's list exists once a chat is mounted into the column).
function node(world, html = '') {
  const n = {
    parent: null, hidden: false, title: '', dataset: {}, attrs: {}, value: '', onclick: null,
    scrollTop: 0, scrollHeight: 0, clientHeight: 0, classes: new Set(), parts: new Map(), rows: [], chat: false,
    style: { setProperty() {}, getPropertyValue: () => '' },
    children: [],
    _html: html,
    get innerHTML() { return this._html; },
    set innerHTML(v) {
      this._html = v;
      // a list of a run's tasks: its rows, by key
      this.rows = [...v.matchAll(/class="now-row( now-row-cur)?" data-key="([^"]+)"/g)].map(([, cur, key]) => {
        const r = node(world);
        r.dataset.key = key;
        if (cur) r.classes.add('now-row-cur');
        return r;
      });
    },
    get nextSibling() {
      if (!this.parent) return null;
      const all = this.parent.children;
      return all[all.indexOf(this) + 1] ?? null;
    },
    get firstChild() { return this.children[0] ?? null; },
    setAttribute(k, v) { this.attrs[k] = v; },
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } },
    contains(el) { return this.children.includes(el); },
    insertBefore(el, at) {
      if (el.parent === this) {
        world.moved.push(el);
        // what both engines do to a node moved in the page: everything in it scrolls back to its top
        for (const p of el.parts.values()) if (p) p.scrollTop = 0;
      }
      el.remove();
      const i = at ? this.children.indexOf(at) : -1;
      if (i < 0) this.children.push(el); else this.children.splice(i, 0, el);
      el.parent = this;
      return el;
    },
    querySelector(sel) {
      const cls = sel.trim().split(/[\s.]+/).filter(Boolean).at(-1);
      if (cls === 'now-row') return this.rows[0] ?? null;
      const here = cls === 'chat-log' ? this.chat : this._html.includes(cls);
      if (!here) return null;
      if (!this.parts.has(cls)) this.parts.set(cls, node(world));
      return this.parts.get(cls);
    },
    querySelectorAll(sel) {
      if (sel.trim() === '.now-row') return this.rows;
      return sel.split(',').map((s) => (s.includes('term-key') ? null : this.querySelector(s))).filter(Boolean);
    },
  };
  n.classList = {
    toggle(c, on) { if (on === undefined ? !n.classes.has(c) : on) n.classes.add(c); else n.classes.delete(c); },
    add(c) { n.classes.add(c); },
    remove(c) { n.classes.delete(c); },
    contains(c) { return n.classes.has(c); },
  };
  return n;
}

function columnsModule({ view = 'terminal' } = {}) {
  const world = { moved: [], store: new Map(), view };
  const noop = () => {};
  const ctx = {
    world,
    setTimeout: () => 0, clearTimeout: noop, // no looks at the terminals: nothing runs on its own
    document: { createElement: () => node(world), hidden: false, getSelection: () => null },
    localStore: { getItem: (k) => world.store.get(k) ?? null, setItem: (k, v) => world.store.set(k, String(v)) },
    getComputedStyle: () => ({}),
    state: { slug: '#now' }, NOW: '#now', $: () => node(world),
    esc: (s) => String(s), tr: (s) => s, ic: () => '', seg: (s) => s, api: async () => ({}),
    getSetting: (k) => (k === 'chatView' ? world.view : undefined),
    mountChat: () => ({ show: noop, setKey: noop, destroy: noop }),
    TERM_ACTIVITY: {}, TERM_KEYS: [], cardTermSession: () => null, growTermInput: noop, openTerminalOf: noop, rolledBy: () => 0,
    sayRefused: noop, setTermHint: noop, takeTermHint: () => false, wireTermImages: noop, styledAlert: noop,
    styledConfirm: async () => true, refusalLine: () => '', refusalText: () => ({}), wireTermCopy: noop,
    holdUntil: () => 0, reprinted: () => true,
    IMAGE_ACCEPT: 'image/png',
  };
  vm.runInNewContext(`${strip('now-terms.js')}
this.syncColumns = syncColumns; this.repaintColumnViews = repaintColumnViews; this.cols = cols;`, ctx);
  // every column has a chat list to scroll (in the browser it is drawn by mountChat inside .now-col-chat)
  const sync = (box, runs) => {
    ctx.syncColumns(box, runs, {
      head: () => '',
      tasks: (run) => run.tasks.map((t) => `<div class="now-row" data-key="${t.key}"></div>`).join(''),
    });
    for (const c of ctx.cols.values()) c.el.chat = true;
  };
  return { ctx, world, sync, box: node(world) };
}

const task = (key, status, focus = false) => ({ key, status, focus });
const run = (session, tasks, board = false) => ({ session, board, stale: false, tasks });
const colOf = (ctx, sid) => ctx.cols.get(sid);
const logOf = (ctx, sid) => colOf(ctx, sid).el.querySelector('.now-col-chat .chat-log');

test('a column whose neighbour before it goes is not moved, keeps its chat where it was read, and the gone one leaves', () => {
  const { ctx, world, sync, box } = columnsModule();
  const A = run('a', [task('A-1', 'doing', true)]);
  const B = run('b', [task('B-1', 'doing', true)]);
  const C = run('c', [task('C-1', 'doing', true)]);
  sync(box, [A, B, C]);
  assert.deepEqual(box.children, [A, B, C].map((r) => colOf(ctx, r.session).el));
  const goneEl = colOf(ctx, 'b').el;
  logOf(ctx, 'c').scrollTop = 700;
  world.moved.length = 0;
  sync(box, [A, C]);
  assert.ok(!box.children.includes(goneEl), 'the column of a run that went is still on the page');
  assert.equal(ctx.cols.has('b'), false);
  assert.deepEqual(box.children, [colOf(ctx, 'a').el, colOf(ctx, 'c').el]);
  assert.deepEqual(world.moved, [], 'a column was moved when the one before it went (a move drops its scroll)');
  assert.equal(logOf(ctx, 'c').scrollTop, 700, 'the chat of the next column flew to its first words');
  // the runs change places: the column that has to move keeps its scroll
  sync(box, [C, A]);
  assert.deepEqual(box.children, [colOf(ctx, 'c').el, colOf(ctx, 'a').el]);
  assert.equal(logOf(ctx, 'c').scrollTop, 700, 'a column moved into its place lost the scroll of its chat');
  // a repaint with nothing changed moves nothing
  world.moved.length = 0;
  sync(box, [C, A]);
  assert.deepEqual(world.moved, [], 'a column standing in its place was moved anyway');
});

test('closed, a column shows the one task at work with «Show all tasks (N)»; the button opens and closes every column', () => {
  const { ctx, world, sync, box } = columnsModule();
  const many = run('m', [task('M-1', 'review'), task('M-2', 'review'), task('M-5', 'doing', true), task('M-6', 'todo'), task('M-7', 'todo')]);
  const one = run('o', [task('O-1', 'doing', true)]);
  const handed = run('h', [task('H-1', 'review'), task('H-2', 'review')]);
  sync(box, [many, one, handed]);
  const el = (sid) => colOf(ctx, sid).el;
  const more = (sid) => el(sid).querySelector('.now-col-more');
  const cur = (sid) => el(sid).querySelector('.now-col-tasks').rows.filter((r) => r.classes.has('now-row-cur')).map((r) => r.dataset.key);
  for (const sid of ['m', 'o', 'h']) assert.ok(el(sid).classes.has('tasks-closed'), 'a column opens with all its tasks');
  assert.deepEqual(cur('m'), ['M-5'], 'closed, the list does not keep the task at work, and only it');
  assert.deepEqual(cur('h'), ['H-1'], 'a run with everything handed in keeps no task in sight');
  assert.equal(more('m').hidden, false, 'a run of many tasks has no button to show them');
  assert.match(more('m').innerHTML, /Show all tasks \(5\)/, 'the button does not say how many tasks there are');
  assert.equal(more('m').attrs['aria-expanded'], 'false');
  assert.equal(more('o').hidden, true, 'a run of one task offers to show all of it');
  assert.equal(more('h').hidden, false);
  // a chat read at its end stays at its end when the list over it opens
  const log = logOf(ctx, 'h');
  Object.assign(log, { scrollTop: 400, scrollHeight: 1000, clientHeight: 600 });
  more('m').onclick();
  assert.equal(world.store.get('kb.ui.nowColTasks'), 'open');
  for (const sid of ['m', 'o', 'h']) assert.equal(el(sid).classes.has('tasks-closed'), false, `the column ${sid} did not open with the others`);
  assert.match(more('m').innerHTML, /Collapse/);
  assert.match(more('h').innerHTML, /Collapse/, 'another column kept saying «Show all tasks»');
  assert.equal(more('m').attrs['aria-expanded'], 'true');
  assert.equal(log.scrollTop, 1000, 'a chat read at its end left its end when the list over it grew');
  more('h').onclick();
  assert.ok(el('m').classes.has('tasks-closed'));
  // the run grows: the count follows on the next repaint
  sync(box, [{ ...many, tasks: [...many.tasks, task('M-8', 'todo')] }, one, handed]);
  assert.match(more('m').innerHTML, /Show all tasks \(6\)/, 'the count stayed as it was');
  // the session moves on to another task: that one is in sight
  sync(box, [{ ...many, tasks: many.tasks.map((t) => ({ ...t, focus: t.key === 'M-6' })) }, one, handed]);
  assert.deepEqual(cur('m'), ['M-6']);
  // the list was left open: a new column opens with it open
  more('m').onclick();
  sync(box, [many, one, handed, run('n', [task('N-1', 'doing', true), task('N-2', 'todo')])]);
  assert.equal(el('n').classes.has('tasks-closed'), false, 'a new column ignores the open list of the others');
});

test('one setting shows the board\'s Claude as a chat or a terminal, at once; a Claude the board did not start is a chat', () => {
  const { ctx, world, sync, box } = columnsModule({ view: 'terminal' });
  sync(box, [run('b', [task('B-1', 'doing', true)], true), run('t', [task('T-1', 'doing', true)], false)]);
  const shows = (sid) => {
    const el = colOf(ctx, sid).el;
    return { chat: !el.querySelector('.now-col-chat').classes.has('hidden'), term: el.querySelector('.now-col-term') ? !el.querySelector('.now-col-term').classes.has('hidden') : null };
  };
  assert.deepEqual(shows('b'), { chat: false, term: true });
  assert.deepEqual(shows('t'), { chat: true, term: null }, 'a Claude in the Terminal app is not shown as its chat');
  world.view = 'chat';
  ctx.repaintColumnViews();
  assert.deepEqual(shows('b'), { chat: true, term: false }, 'the columns waited for the next repaint to follow the setting');
  world.view = 'terminal';
  ctx.repaintColumnViews();
  assert.deepEqual(shows('b'), { chat: false, term: true });
  assert.deepEqual(shows('t'), { chat: true, term: null });
  // the setting's own control repaints the columns (Settings → Claude Code)
  assert.match(source('settings.js'), /buildSelect\(\$\('sel-chatView'\),[^\n]*onChange: \(v\) => setClaudeView\(v\)/, 'the setting\'s control does not go through setClaudeView');
  assert.match(source('settings.js'), /export function setClaudeView\(v\) \{[^}]*repaintWorkTabs\(\);[^}]*repaintColumnViews\(\);/, 'a change of the setting leaves the columns as they were');
});
