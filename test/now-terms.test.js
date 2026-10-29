// and the terminal of its Claude. The real termTaskOf of now-terms.js and the real view switch of now.js on stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { REPRINT_HOLD_MS, holdUntil, reprinted } from '../public/js/term-reprint.js';
import { ASK_FRESH_MS, widthFor } from '../src/phantom.js';

const strip = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');

function terms() {
  const box = { setTimeout, clearTimeout, state: {}, document: {} };
  vm.runInNewContext(`${strip('now-terms.js')}\nthis.termTaskOf = termTaskOf;\nthis.askCols = askCols;\nthis.placeColumn = placeColumn;`, box);
  return box;
}

const t = (key, status, focus = false) => ({ key, status, focus });

test('a column shows the terminal of the task its Claude is on, else of one still in work, else of any', () => {
  const { termTaskOf } = terms();
  assert.equal(termTaskOf({ tasks: [t('D-1', 'review'), t('D-3', 'doing'), t('D-2', 'prep', true)] }), 'D-2', 'the task the session is on lost to another');
  assert.equal(termTaskOf({ tasks: [t('D-1', 'review'), t('D-3', 'doing')] }), 'D-3', 'a task handed in was picked over one in work');
  assert.equal(termTaskOf({ tasks: [t('D-1', 'review')] }), 'D-1');
  assert.equal(termTaskOf({ tasks: [] }), null);
});

test('a column lays the window of its terminal out to its width — wider by more than 2 columns, or narrower', () => {
  const { askCols } = terms();
  assert.equal(askCols(62, 45), 62, 'the column stays at the card\'s width with its right part empty');
  assert.equal(askCols(47, 45), null, 'a column or two wider is not worth printing the conversation again (the server ignores it too)');
  assert.equal(askCols(48, 45), 48);
  assert.equal(askCols(45, 45), null);
  assert.equal(askCols(40, 45), 40, 'a window wider than the column is left with lines cut');
  assert.equal(askCols(62, undefined), null, 'the first look, before the width is known, lays the window out');
  assert.equal(askCols(62, null), 62, 'a window whose width the server cannot tell is never fitted to the column');
  assert.equal(askCols(null, 45), null, 'a column not laid out yet asks for a width');
  const cols = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  assert.match(cols, /const n = cardHolds\(c\) \? null : askCols\(fitCols\(c\), c\.win\);/);
  assert.match(cols, /c\.win = r\.cols \|\| null;/, 'the width of the window is not taken from the answer');
  assert.match(cols, /if \(!r\.dead\) c\.hold = holdUntil\(c\.hold, was, c\.win\);/, 'a new width of the window does not hold the old screen');
  const card = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  assert.match(card, /termHold = known \? holdUntil\(termHold, termWin, r\.cols \|\| null\) : 0;/, 'the card\'s Terminal tab shows the conversation printed again');
  assert.match(card, /r = heldScreen\(r\);[^\n]*\n\s*if \(r\.same\) return;/, 'the card draws the screen without the hold'); // no comment: the release strips them
  assert.match(card, /const cols = termWinOf && termWinOf === termInfo\?\.session \? termCols\(\) : null;/, 'the card lays out a window whose width it has not seen — the change is not held');
});

test('the screen of a new width counts as printed once its input box is as wide as the window', () => {
  const box = (w, label = '') => ['● Done.', '', label ? `${'─'.repeat(w - label.length - 3)} ${label} ─` : '─'.repeat(w), '❯ ', '─'.repeat(w), '  ⏵⏵ auto mode on'].join('\n');
  assert.equal(reprinted(box(45), 80), false, 'the box of the old, narrower window let the reprint show');
  assert.equal(reprinted(box(80), 80), true, 'the screen printed for the new width is held on');
  assert.equal(reprinted(box(80, 'CK-1'), 80), true, 'the rule with the task\'s name in it is not taken for the box');
  assert.equal(reprinted(box(120), 80), false, 'the box of the old, wider window let the reprint show');
  assert.equal(reprinted(`${'● line of the conversation\n'.repeat(40)}`, 80), false, 'the conversation half printed counts as printed');
  assert.equal(reprinted(['─'.repeat(80), '❯ 1. Yes', '  2. No'].join('\n'), 80), true);
  assert.equal(reprinted('anything', null), true, 'a window of unknown width holds the screen');
  // tmux wraps the old rule of a window twice as wide in two — its second half sits right above ❯
  assert.equal(reprinted(['● Done.', '─'.repeat(45), '─'.repeat(45), '❯ ', '─'.repeat(45)].join('\n'), 45), false, 'the old rule wrapped in two let the reprint show');
});

test('the hold counts from the first change of width — a window that keeps changing does not freeze the screen', () => {
  assert.equal(holdUntil(0, 45, 45, 1000), 0);
  assert.equal(holdUntil(0, undefined, 45, 1000), 0, 'the first answer is no change');
  assert.equal(holdUntil(0, null, 45, 1000), 0);
  assert.equal(holdUntil(0, 45, 80, 1000), 1000 + REPRINT_HOLD_MS);
  assert.equal(holdUntil(1000 + REPRINT_HOLD_MS, 80, 62, 5000), 1000 + REPRINT_HOLD_MS, 'a second change pushed the end of the hold');
});

test('of the viewers of one terminal the narrowest width wins while it keeps looking', () => {
  assert.equal(widthFor('s', 62, 0), 62);
  assert.equal(widthFor('s', 45, 500), 45);
  assert.equal(widthFor('s', 62, 1000), 45, 'a wider column took the window from the card looking at it');
  assert.equal(widthFor('s', 45, 1500), 45);
  assert.equal(widthFor('s', 62, 1500 + ASK_FRESH_MS + 1), 62, 'the card closed, and the column stays narrow');
  assert.equal(widthFor('t', 80, 1000), 80, 'another terminal took the width of this one');
});

function nowWith(saved) {
  const store = new Map(saved ? [['kb.ui.nowView', saved]] : []);
  const box = {
    tr: (s) => s, esc: (s) => String(s), ic: () => '', state: {}, NOW: '#now', STATUS_LABELS: {}, SHORT_MONTHS: [],
    localStore: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, setInterval() {}, document: { hidden: true }, onPhone: () => false, PHONE_NOW_VIEW: 'terms',
  };
  vm.runInNewContext(`${strip('now.js')}\nthis.viewSwitch = viewSwitch;`, box);
  return box.viewSwitch();
}

test('the section remembers the view: the list by default, the terminals once picked', () => {
  assert.match(nowWith(null), /class="dr-btn active" data-view="list"/, 'the list is not the default view');
  assert.match(nowWith('terms'), /class="dr-btn active" data-view="terms"/, 'the terminals picked before are forgotten on reload');
  assert.match(nowWith('bogus'), /class="dr-btn active" data-view="list"/, 'an unknown saved view is not read as the list');
  assert.match(nowWith('broken'), /class="dr-btn active" data-view="broken"/, 'the broken terminals picked before are forgotten on reload');
});

test('the broken terminals are their own view: out of «Terminals», each with its count on the switch', () => {
  const store = new Map();
  const box = {
    tr: (s) => s, esc: (s) => String(s), ic: () => '', state: {}, NOW: '#now', STATUS_LABELS: {}, SHORT_MONTHS: [],
    localStore: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }, setInterval() {}, document: { hidden: true }, onPhone: () => false, PHONE_NOW_VIEW: 'terms',
  };
  vm.runInNewContext(`${strip('now.js')}\nthis.runsOf = runsOf; this.viewSwitch = viewSwitch;`, box);
  const runs = [
    { session: 'live', claude: 'busy', stale: false },
    { session: 'lost', claude: 'gone', stale: false, ended: { exit: null, interrupted: true, lost: true } },
    { session: 'cut', claude: 'gone', stale: false, ended: { exit: 143, interrupted: true } },
    { session: 'own', claude: 'gone', stale: true, ended: { exit: 0, interrupted: false } },
    { session: 'closed', claude: 'gone', stale: true },
  ];
  assert.deepEqual(box.runsOf('terms', runs).map((r) => r.session), ['live'], 'a broken run stands among the live terminals');
  assert.deepEqual(box.runsOf('broken', runs).map((r) => r.session), ['lost', 'cut', 'own'], 'a run with «Continue» is missing from the broken terminals');
  assert.match(box.viewSwitch({ runs }), /data-view="broken"[^>]*><span class="now-view-long">Broken terminals<\/span><span class="now-view-short">Broken<\/span> <span class="now-view-n">3<\/span>/, 'the switch does not say how many are broken');
  assert.doesNotMatch(box.viewSwitch({ runs: runs.slice(0, 1) }), /now-view-n/, 'a count of none is drawn');
});

test('the section wires the columns in: it keeps them between repaints and the page has their words in Russian', () => {
  const now = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8');
  assert.match(now, /syncColumns\(wide\.querySelector\('\.now-cols'\), live,/, 'the columns are not laid out from the live runs');
  assert.match(now, /dropColumns\(\);/, 'the list view leaves the columns polling their terminals');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const k of ['List', 'Terminals', 'Open in the card']) assert.match(core, new RegExp(`\\n  '?${k}'?: '`), `no Russian for «${k}»`);
});

// timers and its requests in the hands of the test.
test('a look asked for after typing waits for the look on its way instead of running beside it', async () => {
  const timers = [];
  const pending = [];
  const box = {
    state: { slug: '#now', drawerKey: null }, NOW: '#now', document: { hidden: false },
    $: () => ({ classList: { contains: () => false } }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    api: () => new Promise((resolve) => pending.push(resolve)),
    seg: (s) => s, URLSearchParams,
  };
  vm.runInNewContext(`${strip('now-terms.js')}\nthis.cols = cols; this.start = start; this.soon = soon;`, box);
  const fire = () => { const t = timers.filter((x) => x.fn).at(-1); const fn = t.fn; t.fn = null; fn(); };
  box.cols.set('s1', { el: { querySelector: () => ({ clientWidth: 0 }) }, key: 'D-1', seen: null, req: 0 });
  box.start();
  fire(); // the first look goes out
  assert.equal(pending.length, 1);
  box.soon(250); // the person typed while the look is on its way
  assert.equal(timers.filter((x) => x.fn).length, 0, 'typing scheduled a second look beside the one on its way');
  pending[0]({ same: true });
  await new Promise((r) => setImmediate(r));
  const next = timers.filter((x) => x.fn).at(-1);
  assert.equal(next?.ms, 0, 'the look asked for by typing was dropped, or waits a whole second');
  fire();
  assert.equal(pending.length, 2, 'the chain did not go on after the look came back');
});

// the columns stopped looking at all while a card showed its terminal. Now each column looks; only the column of the
// terminal the card shows leaves out the width (the card lays that window out), the others keep theirs.
test('while the card shows a terminal, the columns still look — without a width only at the terminal of the card', async () => {
  const timers = [];
  const asked = [];
  let termTab = true;
  const box = {
    state: { slug: '#now', drawerKey: 'D-1' }, NOW: '#now', document: { hidden: false },
    $: (id) => ({ classList: { contains: (c) => (id === 'term-block' && c === 'hidden' ? !termTab : false) } }),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].fn = null; },
    api: (m, url) => { asked.push(url); return Promise.resolve({ same: true }); },
    cardTermSession: () => 's1', seg: (s) => s, URLSearchParams, getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0' }),
  };
  vm.runInNewContext(`${strip('now-terms.js')}\nthis.cols = cols; this.start = start;`, box);
  const pre = { clientWidth: 400, appendChild() {} };
  const col = (id, key) => ({ id, el: { querySelector: () => pre }, key, win: 60, seen: null, req: 0, fit: { width: 400, cols: 50 } });
  box.cols.set('s1', col('s1', 'D-2')); // the card shows D-1, a task of the same session
  box.cols.set('s2', col('s2', 'D-7'));
  const round = async () => {
    asked.length = 0;
    const t = timers.filter((x) => x.fn).at(-1); const fn = t.fn; t.fn = null; fn();
    await new Promise((r) => setImmediate(r));
    return asked.slice().sort();
  };
  box.start();
  assert.deepEqual(await round(), ['/api/tasks/D-2/terminal?', '/api/tasks/D-7/terminal?cols=50'],
    'the columns stopped looking while the card shows a terminal, or the column of that terminal laid its window out');
  termTab = false; // the card went to its comments: the window is the column's again
  assert.deepEqual(await round(), ['/api/tasks/D-2/terminal?cols=50', '/api/tasks/D-7/terminal?cols=50']);
});

// its terminal (the DELETE of the card's "Stop"), and the column goes at once: the answer of /api/now still has the run
// for a few seconds, until the server looks at the terminals again.
test('a column closed by its ✕ stays gone while /api/now still has the run, and comes back with a new run', () => {
  const box = { setTimeout, clearTimeout, state: {}, document: {} };
  vm.runInNewContext(`${strip('now-terms.js')}\nthis.openRuns = openRuns; this.closed = closed;`, box);
  const runs = [{ session: 's1', tasks: [] }, { session: 's2', tasks: [] }, { session: null, tasks: [] }];
  box.closed.set('s1', 1000);
  assert.deepEqual(box.openRuns(runs, 2000).map((r) => r.session), ['s2', null], 'the closed column came back on the next repaint');
  assert.deepEqual(box.openRuns(runs, 1000 + 61000).map((r) => r.session), ['s1', 's2', null], 'a run the server still has a minute later is hidden for good');
  box.closed.set('s1', 1000);
  box.openRuns([{ session: 's2', tasks: [] }], 2000);
  assert.equal(box.closed.has('s1'), false, 'a closed session the server dropped is remembered on');
  const src = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  assert.match(src, /now-col-close[\s\S]*now-col-open/, 'the ✕ is not left of "Open in the card"');
  assert.match(src, /api\('DELETE', `\/api\/tasks\/\$\{seg\(c\.key\)\}\/terminal`/, 'the ✕ does not close the terminal');
  assert.match(src, /if \(!c\.ended && !await styledConfirm\(/, 'a live Claude is stopped without asking');
  const now = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8');
  assert.match(now, /const live = openRuns\(runsOf\(view, d\.runs\)\)/, 'the section draws the closed column again');
});

// stopped a working Claude without a word passed the suite. The real closeColumn on stand-ins.
test('the ✕ of a column asks before it stops a live Claude, and closes an ended one at once', async () => {
  const asked = [];
  const calls = [];
  let answer = false;
  const box = {
    setTimeout, clearTimeout, state: {}, document: {}, tr: (s) => s, seg: (s) => s,
    styledConfirm: async (msg) => { asked.push(msg); return answer; },
    api: async (method, path) => { calls.push(`${method} ${path}`); },
    refusalText: () => ({}), sayRefused() {}, styledAlert() {}, refusalLine: () => '',
  };
  vm.runInNewContext(`${strip('now-terms.js')}\nthis.closeColumn = closeColumn; this.cols = cols;`, box);
  const column = (ended) => { const c = { id: `s${box.cols.size}`, key: 'CK-1', ended, el: { remove() { c.removed = true; } } }; box.cols.set(c.id, c); return c; };
  const live = column(false);
  await box.closeColumn(live);
  assert.equal(asked.length, 1, 'a live Claude is stopped without asking');
  assert.deepEqual(calls, [], 'a "no" to the question stopped Claude all the same');
  assert.equal(live.removed, undefined, 'a "no" took the column away');
  answer = true;
  await box.closeColumn(live);
  assert.deepEqual(calls, ['DELETE /api/tasks/CK-1/terminal']);
  assert.equal(live.removed, true);
  const ended = column(true);
  await box.closeColumn(ended);
  assert.equal(asked.length, 2, 'a Claude that has ended is asked about');
  assert.equal(ended.removed, true);
  assert.match(strip('now-terms.js'), /c\.live = live;\s*c\.ended = !live;/, 'the column does not learn whether its Claude has ended from the look');
});

test('the ✕ of a column is as tall as «Open in the card» and level with it', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = (sel) => (css.match(new RegExp(`\\n${sel.replace(/\./g, '\\.')} \\{([^}]*)\\}`)) || [])[1] || '';
  assert.match(rule('.now-col-acts'), /align-items: stretch/, 'the ✕ is not stretched to the height of its row');
  const close = rule('.now-col-close');
  assert.doesNotMatch(close, /line-height: 1\b/);
  assert.match(close, /display: inline-flex; align-items: center; justify-content: center/, 'the glyph is not centred in the taller button');
});

// `display: inline-flex` beats the `hidden` attribute — without the [hidden] rule it stood on every screen for good.
test('the ↓ of a column shows while its screen is scrolled up and hides at the end', () => {
  const src = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  const fn = (head) => src.slice(src.indexOf(head), src.indexOf('\n}\n', src.indexOf(head)));
  const wire = fn('function wire(c)');
  const onscroll = wire.slice(wire.indexOf('pre.onscroll = () => {'));
  assert.match(onscroll.slice(0, onscroll.indexOf('};')), /down\.hidden = c\.follow;/, 'scrolling the screen up does not show ↓');
  assert.match(wire, /down\.onclick = \(\) => \{ c\.follow = true; pre\.scrollTop = pre\.scrollHeight;[^}]*down\.hidden = true; \};/, '↓ does not take the screen to its end');
  assert.match(fn('function paintTerm(c, r)'), /\.now-col-down'\)\.hidden = c\.follow;/, 'a redraw at the end leaves ↓ standing');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.now-col-down \{[^}]*display: inline-flex/);
  assert.match(css, /\.now-col-down\[hidden\] \{ display: none; \}/, 'the hidden ↓ is still drawn: its display beats the attribute');
});

// column was moved whenever a column before it went: the chat of the next one jumped to its first words for good.
test('a column moved into its place keeps the scroll of its chat, screen and tasks; gone columns go before any move', () => {
  const { placeColumn } = terms();
  const scrolled = (top) => ({ scrollTop: top });
  const parts = [scrolled(640), scrolled(120), scrolled(30)];
  const el = { querySelectorAll: (sel) => (sel === '.chat-log, .now-col-screen, .now-col-tasks' ? parts : []) };
  let moved = 0;
  // what both engines do: the moved node comes back with its scroll at 0
  const host = { insertBefore: (node) => { moved++; for (const p of parts) p.scrollTop = 0; return node; } };
  placeColumn(host, el, null);
  assert.equal(moved, 1);
  assert.deepEqual(parts.map((p) => p.scrollTop), [640, 120, 30], 'a moved column shows its chat from the first words');
  const src = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  const sync = src.slice(src.indexOf('export function syncColumns'), src.indexOf('\n}\n', src.indexOf('export function syncColumns')));
  assert.ok(sync.indexOf('drop(c); cols.delete(id);') < sync.indexOf('for (const run of runs)'), 'the next column is moved into the place of one still on the page');
  assert.doesNotMatch(sync, /box\.insertBefore\(c\.el/, 'a column is moved without its scroll');
});

test('CK-880: a column off the screen is not looked at, its chat does not ask, one coming into sight looks at once', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  const look = src.slice(src.indexOf('async function look(c) {'), src.indexOf('\n}\n', src.indexOf('async function look(c) {')));
  assert.match(look, /if \(!c\.key \|\| !c\.el\.querySelector\('\.now-col-screen'\) \|\| !inSight\(c\)\) return;/, 'every column is looked at every second again, in sight or not');
  assert.match(src, /const inSight = \(c\) => !c\.away \|\| fullCol === c;/, 'a column on the full screen is taken for one off the screen');
  assert.match(src, /c\.chat\?\.show\(!away && c\.view === 'chat'\);/, 'the chat of a column off the screen goes on asking');
  assert.match(src, /if \(!away\) \{ c\.lookedAt = 0; back = true; \}[\s\S]{0,40}if \(back\) soon\(0\);/, 'a column coming into sight waits for the next round');
  assert.match(src, /sight\?\.observe\(el\);/);
  assert.match(src, /sight\?\.unobserve\(c\.el\);/, 'a dropped column stays observed');
});
