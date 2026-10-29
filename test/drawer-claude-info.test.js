import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const sse = read('sse.js');
const drawer = read('drawer.js');
const take = (src, head, end = '\n}\n') => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  return src.slice(at, src.indexOf(end, at) + end.length).replace(/^export /, '');
};
const lineOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n', at) + 1).replace(/^export /, ''); };

function el(id) {
  const classes = new Set();
  const kids = {};
  return {
    id, innerHTML: '', style: {}, onclick: null, kids,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    querySelector(sel) {
      if (sel === '.dm-claude') return /class="dm-claude"/.test(this.innerHTML) ? (kids.claude ||= { innerHTML: '' }) : null;
      const m = /data-act="(\w+)"/.exec(sel);
      if (m) return this.innerHTML.includes(`data-act="${m[1]}"`) ? (kids[m[1]] ||= { onclick: null }) : null;
      return null;
    },
    getBoundingClientRect: () => ({ bottom: 10, right: 300 }),
  };
}

function page({ show = true } = {}) {
  const els = { 'd-timeline': el('d-timeline'), 'drawer-menu': el('drawer-menu') };
  let menu = null;
  const box = {
    state: { drawerKey: 'CK-1' },
    $: (id) => (id === 'drawer-menu-pop' ? menu : els[id]),
    esc: (s) => String(s), tr: (s) => s, ic: () => '', plural: (n, one, many) => (n === 1 ? one : many),
    fmtDate: (s) => `@${s}`, STATUS_LABELS: { todo: 'To do', doing: 'In progress' },
    getSetting: (k) => (k === 'showUsage' ? show : undefined),
    usageLine: (u) => (u ? { text: `Usage · ${u.total} tokens`, title: 'notes' } : null), usageFmt: {},
    oneFlight: (fn) => fn,
    usageAnswer: { usage: null },
    api: async () => box.usageAnswer, seg: (s) => s,
    document: {
      createElement: () => { const m = el('drawer-menu-pop'); m.remove = () => { if (menu === m) menu = null; }; menu = m; return m; },
      body: { appendChild() {} }, addEventListener() {}, removeEventListener() {},
    },
    window: { innerWidth: 1280 }, requestAnimationFrame: () => {}, setTimeout: () => {},
    pushLayer() {}, popLayer() {}, drawerPinned: 0, drawerLocked: false,
    openLinkPicker() {}, togglePinTask() {}, cancelTask() {}, deleteTask() {},
  };
  vm.createContext(box);
  vm.runInContext([
    lineOf(sse, 'const TL_KEEP = '), lineOf(sse, 'const TL_MAX = '),
    take(sse, 'const usageHTML = ', '\n};\n'),
    lineOf(sse, 'let cardClaude = '),
    take(sse, 'export function claudeInfoHTML('),
    lineOf(sse, 'let claudeInfoListener = '),
    lineOf(sse, 'export function onClaudeInfo('),
    lineOf(sse, 'function repaintClaudeInfo('),
    lineOf(sse, 'const menuOpen = '),
    lineOf(sse, 'export function askUsageNow('),
    'let usageAt = 0; let usageTimer = null; const USAGE_EVERY_MS = 10000;',
    take(sse, 'const usageFlight = ', '\n});\n'),
    take(sse, 'export function refreshUsage('),
    take(sse, 'export function renderTimeline('),
    take(drawer, 'function closeDrawerMenu('),
    take(drawer, 'function drawerMenuOutside('),
    take(drawer, 'export function openDrawerMenu('),
    take(drawer, 'function fillDrawerMenu('),
    lineOf(drawer, 'onClaudeInfo(() => fillDrawerMenu());'),
    'this.menu = () => $("drawer-menu-pop"); this.usageFlight = usageFlight; this.fill = fillDrawerMenu;',
  ].join('\n'), box);
  return { box, els };
}
const TASK = {
  key: 'CK-1', status: 'doing', created_at: 'c', events: [{ status: 'doing', created_at: 'e' }],
  sessions: [{ session_id: 's-1', last_seen: '2026-10-08 15:57:00' }], usage: { total: 27 },
};

test('the log of statuses no longer shows Claude; the ⋯ menu does, sessions first, then usage', () => {
  const { box, els } = page();
  box.renderTimeline(TASK);
  assert.doesNotMatch(els['d-timeline'].innerHTML, /Claude ·|Usage ·/, 'the log of statuses still shows Claude');
  box.openDrawerMenu();
  const html = box.menu().innerHTML;
  const s = html.indexOf('Claude · 1 session · latest @2026-10-08 15:57:00');
  const u = html.indexOf('Usage · 27 tokens');
  assert.ok(s >= 0 && u > s, `the menu lacks the lines about Claude: ${html}`);
  assert.ok(html.indexOf('data-act="subtask"') > u, 'the lines about Claude are not on top of the actions');
  assert.match(html, /data-act="delete"/);
});

test('a task in work keeps ⋯: its menu says of Claude and offers no actions', () => {
  const { box } = page();
  box.renderTimeline(TASK);
  box.drawerLocked = true;
  box.openDrawerMenu();
  const html = box.menu().innerHTML;
  assert.match(html, /Usage · 27 tokens/);
  assert.doesNotMatch(html, /data-act=/, 'a locked card offers actions in its menu');
  box.openDrawerMenu(); // a second press closes it
  box.renderTimeline({ ...TASK, key: 'CK-1', sessions: [], usage: null });
  box.openDrawerMenu();
  assert.match(box.menu().innerHTML, /actions come back once it hands it in/, 'an empty menu of a locked card says nothing');
});

test('a short shape keeps what the card knew of Claude; another task does not inherit it', () => {
  const { box } = page();
  box.renderTimeline(TASK);
  box.renderTimeline({ key: 'CK-1', status: 'review', created_at: 'c', events: [] }); // the list's shape: no sessions
  assert.match(box.claudeInfoHTML(), /1 session/, 'the short shape wiped the sessions of the open task');
  box.state.drawerKey = 'CK-2';
  box.renderTimeline({ key: 'CK-2', status: 'todo', created_at: 'c', events: [] });
  assert.equal(box.claudeInfoHTML(), '', 'another task shows the Claude of the one before');
});

test('the usage line of an open menu follows Claude at work; switched off, it is not shown', async () => {
  const { box } = page();
  box.renderTimeline(TASK);
  box.openDrawerMenu();
  box.usageAnswer = { usage: { total: 31 } };
  await box.usageFlight('CK-1');
  assert.match(box.menu().innerHTML, /Usage · 31 tokens/, 'the open menu kept the old usage');
  const off = page({ show: false });
  off.box.renderTimeline(TASK);
  assert.doesNotMatch(off.box.claudeInfoHTML(), /Usage/, 'a switched-off usage is in the menu');
});

test('lines that come after the menu opened show in it; a locked menu never goes blank', async () => {
  const { box } = page();
  box.renderTimeline({ ...TASK, sessions: [], usage: null });
  box.usageAnswer = { usage: { total: 40 } }; // the line the opening asks for, not there yet when the menu is drawn
  box.openDrawerMenu();
  await new Promise((r) => setTimeout(r, 0));
  assert.match(box.menu().innerHTML, /Usage · 40 tokens/, 'the usage that came after the menu opened is not in it');
  assert.match(box.menu().innerHTML, /data-act="delete"/, 'the actions went with the redraw');
  box.openDrawerMenu();
  box.drawerLocked = true;
  box.renderTimeline({ ...TASK, sessions: [], usage: null });
  box.openDrawerMenu();
  box.renderTimeline({ ...TASK, status: 'deploy', sessions: [], usage: null }); // the log followed a status change
  assert.match(box.menu().innerHTML, /actions come back once it hands it in/, 'a locked menu went blank');
  box.drawerLocked = false;
  box.fill();
  assert.match(box.menu().innerHTML, /data-act="pin"/, 'an unlocked card keeps a menu with no actions');
});

test('the usage is not fetched while the menu is closed', async () => {
  const { box } = page();
  box.renderTimeline(TASK);
  let asked = 0;
  box.api = async () => { asked++; return { usage: { total: 1 } }; };
  box.refreshUsage('CK-1');
  assert.equal(asked, 0, 'a closed menu still fetches the usage on every turn of Claude');
  box.openDrawerMenu();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, 1, 'opening the menu does not fetch its usage');
});

test('a fetch put off by the ten-second rule is dropped once the menu closes', async () => {
  const { box } = page();
  box.renderTimeline(TASK);
  let asked = 0;
  const timers = [];
  box.api = async () => { asked++; return { usage: { total: 1 } }; };
  box.setTimeout = (fn, ms) => { if (ms > 1000) timers.push(fn); return timers.length; }; // the ten-second wait only
  box.openDrawerMenu();
  await new Promise((r) => setTimeout(r, 0));
  box.refreshUsage('CK-1'); // within ten seconds: put off
  assert.equal(timers.length, 1, 'a fetch within ten seconds was not put off');
  const before = asked;
  box.closeDrawerMenu();
  timers.shift()();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(asked, before, 'the fetch put off went out for a closed menu');
});
