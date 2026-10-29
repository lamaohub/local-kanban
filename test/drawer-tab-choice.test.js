// of the board is alive opens on its Terminal — there are no comments yet, the terminal is what goes on. The real
// renderWorkTabs / refreshWork / repaintWorkTabs of drawer.js, on a stand-in page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
function take(head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
}
const line = (head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n', at)); };

function card({ view, saved = 'comments' } = {}) {
  const tabs = { innerHTML: '', classList: { add() { tabs.hidden = true; }, remove() { tabs.hidden = false; } }, hidden: true, querySelectorAll: () => [] };
  const seen = { shown: [], hidden: 0, fetched: [], terminal: 0 };
  const comments = { hidden: true, classList: { add() { comments.hidden = true; }, remove() { comments.hidden = false; }, toggle(c, on) { comments.hidden = on; } } };
  const box = {
    $: (id) => (id === 'd-tabs' ? tabs : id === 'comments-block' ? comments : { classList: { add() {}, remove() {}, toggle() {} } }),
    tr: (s) => s, state: { drawerKey: 'K-1' }, WORKING: new Set(['prep', 'doing', 'deploy']),
    getSetting: (k) => (k === 'chatView' ? view : undefined),
    savedTab: () => saved, saveTab: () => {}, showWorkTab: (t) => seen.shown.push(t), hideWorkTabs: () => { seen.hidden++; tabs.hidden = true; },
    renderTerminal: () => { seen.terminal++; }, workFlight: (k) => seen.fetched.push(k),
  };
  vm.runInNewContext(['let workKey = null; let termKey = null; let termScreen = null; let termFollow = true;',
    'let termInfo = null; let termSeen = null; let termOpenNext = null;',
    line('export const claudeView = ').replace(/^export /, ''), line('let chatTab = '), line('let tabsTask = '),
    take('function renderWorkTabs('), take('export function refreshWork('), take('export function repaintWorkTabs('),
    'this.api = { renderWorkTabs, refreshWork, repaintWorkTabs };'].join('\n'), box);
  return { ...box.api, tabs, seen, box, comments };
}
const live = { session: 's', dead: false };

test('a Claude the board did not start: the chat, whatever the setting — and it is read', () => {
  for (const view of ['terminal', 'chat', undefined]) {
    const c = card({ view });
    c.renderWorkTabs({ key: 'K-1', sessions: [{}], status: 'review', terminal: null });
    assert.match(c.tabs.innerHTML, /data-tab="comments"[\s\S]*data-tab="chat"/, `${view}: no chat tab`);
    assert.doesNotMatch(c.tabs.innerHTML, /data-tab="terminal"/);
    assert.deepEqual(c.seen.fetched, ['K-1']);
  }
});

test('the board\'s own Claude: one tab — the terminal or the chat, as the setting says', () => {
  const t = card({ view: 'terminal' });
  t.renderWorkTabs({ key: 'K-1', sessions: [{}], status: 'review', terminal: live });
  assert.match(t.tabs.innerHTML, /data-tab="terminal"/);
  assert.doesNotMatch(t.tabs.innerHTML, /data-tab="chat"/, 'both Claude tabs are drawn');
  assert.deepEqual(t.seen.fetched, [], 'the chat is read while the card shows the terminal');
  assert.equal(t.seen.terminal, 1);
  const c = card({ view: 'chat' });
  c.renderWorkTabs({ key: 'K-1', sessions: [{}], status: 'review', terminal: live });
  assert.match(c.tabs.innerHTML, /data-tab="chat" role="tab"><span class="d-tab-l">Chat<\/span><span class="term-dot"/, 'the chat of a live Claude has no dot');
  assert.doesNotMatch(c.tabs.innerHTML, /data-tab="terminal"/, 'both Claude tabs are drawn');
  assert.equal(c.seen.terminal, 0);
  assert.deepEqual(c.seen.fetched, ['K-1']);
});

test('no session and no terminal: no tabs at all, the comments are the card', () => {
  const c = card({ view: 'chat' });
  c.renderWorkTabs({ key: 'K-1', sessions: [], status: 'todo', terminal: null });
  assert.equal(c.seen.hidden, 1);
  assert.equal(c.comments.hidden, false);
  c.refreshWork('K-1');
  assert.deepEqual(c.seen.fetched, [], 'a task.work event reads a chat that is not there');
});

test('CK-597: a task in work with its Claude alive opens on Claude — its terminal or its chat; otherwise the remembered tab', () => {
  for (const [view, tab] of [['terminal', 'terminal'], ['chat', 'chat']]) {
    for (const status of ['prep', 'doing', 'deploy']) {
      const c = card({ view, saved: 'comments' });
      c.renderWorkTabs({ key: 'K-1', sessions: [{}], status, terminal: live });
      assert.deepEqual(c.seen.shown, [tab], `${view}, ${status}: the card opens on the remembered tab, not on Claude`);
    }
  }
  for (const [status, terminal] of [['review', live], ['todo', live], ['doing', { session: 's', dead: true }]]) {
    const c = card({ view: 'terminal', saved: 'comments' });
    c.renderWorkTabs({ key: 'K-1', sessions: [{}], status, terminal });
    assert.deepEqual(c.seen.shown, ['comments'], `${status}, dead ${terminal.dead}: the remembered tab is overruled`);
  }
  for (const view of ['terminal', 'chat']) {
    const c = card({ view, saved: 'comments' });
    c.renderWorkTabs({ key: 'K-1', sessions: [{}], status: 'doing', terminal: { session: 's', dead: true, exit: 143, interrupted: true } });
    assert.deepEqual(c.seen.shown, [view], `${view}: the card of an interrupted Claude opens on the remembered tab`);
  }
});

test('the setting redraws the open card at once, and only it', () => {
  const c = card({ view: 'terminal' });
  c.renderWorkTabs({ key: 'K-1', sessions: [{}], status: 'doing', terminal: live });
  const before = c.seen.shown.length;
  c.box.state.drawerKey = 'K-2';
  c.repaintWorkTabs();
  assert.equal(c.seen.shown.length, before, 'another card is redrawn');
  c.box.state.drawerKey = 'K-1';
  c.box.getSetting = (k) => (k === 'chatView' ? 'chat' : undefined);
  c.repaintWorkTabs();
  assert.equal(c.seen.shown.length, before + 1, 'the open card is not redrawn');
  assert.match(c.tabs.innerHTML, /data-tab="chat"/, 'the card did not follow the setting');
});

test('the terminal is the default; a tab remembered from the work feed opens the chat', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings.slice(settings.indexOf('const SETTINGS_DEFAULTS = {'), settings.indexOf('};', settings.indexOf('const SETTINGS_DEFAULTS = {'))),
    /\bchatView: 'terminal'/);
  assert.doesNotMatch(settings, /data-set="showChat"/, 'a second switch for the chat is back in Settings');
  assert.match(line('const savedTab = '), /v === 'work' \|\| v === 'chat' \? 'chat'/);
});
