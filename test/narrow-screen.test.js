// columns of Claude now — they had 170 and the page ran off the side (the card stretched it to 580, a column of
// Terminals was 154 wide, 84 on 320). There the sidebar is a panel over the page, opened by ☰, and the card stands over
// the board the window wide. Walked in Chromium and WebKit at 390, 320 and 1280: nothing past the side, the card the
// window wide, a column 374 and 304, Settings in the window, a wide window as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
const css = read('style.css');
const sidebar = read('js/sidebar.js');
const html = read('index.html');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };

test('the width of a narrow screen is one: the code and the styles agree', () => {
  const narrow = sidebar.match(/export const NARROW = '\(max-width: (\d+)px\)';/);
  assert.ok(narrow, 'NARROW is gone from sidebar.js');
  const block = css.indexOf(`@media (max-width: ${narrow[1]}px) {\n  html[data-design="v3"] .sidebar {`);
  assert.ok(block >= 0, `the sidebar panel is not at the width of NARROW (${narrow[1]}px)`);
});

test('on a narrow screen the sidebar is a panel over the page, ☰ shows, the card stands over the board', () => {
  assert.match(css, /\.side-open-btn, \.side-scrim \{ display: none; \}/, '☰ or the dim shows on a wide screen');
  assert.match(css, /html\[data-design="v3"\] \.sidebar \{\s*position: fixed;[^}]*transform: translateX\(-101%\);/, 'the sidebar stands beside the page again');
  assert.match(css, /html\[data-design="v3"\]\.side-open \.sidebar \{ transform: none;/);
  assert.match(css, /html\.side-open \.side-scrim \{ opacity: 1; pointer-events: auto; \}/, 'the dim does not take the click that closes');
  assert.match(css, /html\[data-design="v3"\] \.drawer:not\(\.drawer-full\):not\(\.drawer-ghost\) \{ position: fixed; inset: 0; width: auto;/, 'the card is 360 beside the board again');
  assert.match(css, /\.drawer\.is-empty, \.drawer-place \{ display: none !important; \}/, 'a card pinned open with nothing in it covers the board');
  assert.match(html, /<button id="side-open" type="button" class="btn-icon side-open-btn"><\/button>/);
  assert.match(html, /<div id="side-scrim" class="side-scrim"><\/div>/);
});

test('a pick in the panel closes it: a section or project, Settings, the search', () => {
  assert.match(fnOf(sidebar, 'export function selectProject('), /^function selectProject\(slug, \{ settings = false, asked = false \} = \{\}\) \{\n {2}openSide\(false\);/);
  assert.match(sidebar, /setEl\.onclick = \(\) => \{ openSide\(false\); openSettingsModal\(\); \};/);
  assert.match(sidebar, /openSide\(false\); openSearch\(\); \};/);
});

test('openSide: the class on the page and a layer of the stack — Esc closes the panel, a second open adds no layer', () => {
  const classes = new Set();
  const layers = [];
  const box = {
    document: { documentElement: { classList: { contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } } },
    pushLayer: (key, close) => { layers.push({ key, close }); },
    popLayer: (key) => { const i = layers.findIndex((l) => l.key === key); if (i >= 0) layers.splice(i, 1); },
  };
  vm.runInNewContext(`${fnOf(sidebar, 'export function openSide(on)')}\nthis.openSide = openSide;`, box);
  box.openSide(true);
  box.openSide(true);
  assert.ok(classes.has('side-open'));
  assert.equal(layers.length, 1, 'a second open put a second layer on the stack');
  layers.pop().close(); // Esc: closeTopLayer pops the layer and calls its close
  assert.ok(!classes.has('side-open'), 'Esc left the panel open');
  box.openSide(true);
  box.openSide(false);
  assert.equal(layers.length, 0, 'a closed panel left its layer on the stack — the next Esc would close nothing');
});

// the whole narrow block is read here, and wireSide runs on stand-ins
const narrowBlock = () => {
  const at = css.indexOf('@media (max-width: 760px) {\n  html[data-design="v3"] .sidebar {');
  assert.ok(at >= 0, 'the narrow block is gone');
  return css.slice(at, css.indexOf('\n}\n', at));
};

test('on a narrow screen ☰ and the dim show, and the week\'s count leaves the title its room', () => {
  const block = narrowBlock();
  assert.match(block, /\n {2}\.side-open-btn \{ display: inline-flex;/, '☰ never shows on a phone — the sidebar cannot be opened');
  assert.match(block, /\n {2}\.side-scrim \{ display: block; position: fixed; inset: 0;/, 'the dim is not over the page');
  assert.match(block, /\n {2}#week-stats \{ display: none; \}/, 'the week\'s count runs over the title on 320');
  assert.match(css, /\.comment-body \{ white-space: pre-wrap; overflow-wrap: anywhere; \}/, 'a long line of a comment runs past the card');
});

test('a closed panel is out of the keyboard\'s way: it is not focusable off the side', () => {
  const block = narrowBlock();
  // a closed sidebar is translated off the window — without visibility: hidden Tab walked into it and the focus was unseen
  assert.match(block, /html\[data-design="v3"\] \.sidebar \{[^}]*visibility: hidden;[^}]*\}/, 'the closed panel keeps its buttons in the Tab order');
  assert.match(block, /html\[data-design="v3"\]\.side-open \.sidebar \{[^}]*visibility: visible;/, 'the opened panel stays hidden');
});

test('wireSide: ☰ opens, the dim closes, a window grown wide closes; a narrow change leaves it', () => {
  const classes = new Set();
  const layers = [];
  const els = { 'side-open': { dataset: {}, setAttribute() {} }, 'side-scrim': {} };
  let listener = null;
  const box = {
    document: { documentElement: { classList: { contains: (c) => classes.has(c), toggle: (c, on) => { if (on) classes.add(c); else classes.delete(c); } } } },
    pushLayer: (key, close) => { layers.push({ key, close }); },
    popLayer: (key) => { const i = layers.findIndex((l) => l.key === key); if (i >= 0) layers.splice(i, 1); },
    $: (id) => els[id], ic: () => '<svg></svg>', tr: (s) => s,
    matchMedia: (q) => ({ addEventListener: (type, fn) => { assert.equal(q, '(max-width: 760px)'); assert.equal(type, 'change'); listener = fn; } }),
  };
  box.globalThis = box;
  vm.runInNewContext(`const NARROW = '(max-width: 760px)';\n${fnOf(sidebar, 'export function openSide(on)')}\n${fnOf(sidebar, 'function wireSide()')}\nwireSide();`, box);
  els['side-open'].onclick();
  assert.ok(classes.has('side-open'), '☰ does not open the panel');
  els['side-scrim'].onclick();
  assert.ok(!classes.has('side-open'), 'the dim does not close the panel');
  els['side-open'].onclick();
  assert.ok(listener, 'nothing listens to the width of the window');
  listener({ matches: true });
  assert.ok(classes.has('side-open'), 'a change that stays narrow closed the panel');
  listener({ matches: false });
  assert.ok(!classes.has('side-open'), 'a window grown wide keeps the panel and its dim over the page');
  assert.equal(layers.length, 0, 'the layer of a closed panel stayed on the stack');
});

// keep their title, the buttons of a project's settings wrap, the card's head and tabs stay on top, taps are ~40 points
const drawer = read('js/drawer.js');

test('dashboard rows on a phone: the title on its own line, the project and time under it', () => {
  const at = css.indexOf('@media (max-width: 640px) {\n  .wait-row, .feed-row {');
  assert.ok(at >= 0, 'the rows of Waiting for you and Recent events are one line on a phone again — the title gets 0 points on 320');
  const block = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(block, /\.wait-row::after, \.feed-row::after \{ content: ''; order: 2; flex-basis: 100%;/, 'nothing breaks the row after the title');
  assert.match(block, /\.wr-proj, \.wr-meta, \.fr-proj, \.fr-arrow, \.fr-time \{ order: 3;/, 'the project, status or time stay on the title line');
  assert.match(block, /\.wr-title, \.fr-title \{[^}]*white-space: normal;/, 'a long title is cut to one line again');
});

test('the buttons of a project settings wrap — on 320 the third went past the edge', () => {
  assert.match(css, /\.ps-actions \{ display: flex; align-items: center; flex-wrap: wrap; gap: 8px; \}/);
  assert.match(css, /\.ps-actions > button \{ white-space: nowrap; \}/, 'a button breaks its words into a column');
});

test('the corner under ≡ stays free of the description in v3 too', () => {
  const v3pad = css.indexOf('html[data-design="v3"] .d-desc { border-radius: 12px; padding: 10px 12px; }');
  const keep = css.indexOf('html[data-design="v3"] .desc-wrap .d-desc { padding-right: 34px; }');
  assert.ok(v3pad >= 0 && keep > v3pad, 'the v3 padding of the description runs under the ≡ button again');
});

// 1259 points above the screen at 1280
test('the card on any width: the head with ✕ and the tabs stick on top, the head one line high', () => {
  const block = css;
  assert.doesNotMatch(narrowBlock(), /\.drawer-head \{\s*position: sticky/, 'the sticky head is back inside the narrow block: a computer loses ✕ under the chat');
  assert.match(block, /\.drawer:not\(\.drawer-ghost\) > \.drawer-head \{\s*position: sticky; top: -16px;[^}]*min-height: 44px;/, '✕ scrolls away with the card');
  assert.match(block, /\.drawer:not\(\.drawer-ghost\) \.d-tabs:not\(\.hidden\) \{\s*position: sticky; top: 28px;/, 'the tabs scroll away or stand under the head');
  assert.match(block, /\.drawer-key \{[^}]*white-space: nowrap; \}/, 'the key line wraps and the head grows over the tabs');
});

test('the back gesture of a phone closes the card and stays on the page; ✕ takes the entry back out', () => {
  let state = { kbCard: true }; // left by a reload
  const pushed = [];
  let backs = 0;
  let shown = false;
  let popstate = null;
  let narrowed = null;
  const layers = [];
  const box = {
    NARROW: '(max-width: 760px)',
    history: { get state() { return state; }, pushState: (s) => { pushed.push(s); state = s; }, replaceState: (s) => { state = s; }, back: () => { backs += 1; } },
    matchMedia: () => ({ matches: true, addEventListener: (type, fn) => { narrowed = fn; } }),
    window: { addEventListener: (type, fn) => { assert.equal(type, 'popstate'); popstate = fn; } },
    drawerShown: () => shown,
    closeTopLayer: () => { const top = layers.pop(); if (!top) return false; top(); return true; },
    closeDrawer: () => { shown = false; box.dropBack(); },
    document: { querySelector: () => null }, closeOpenSelect: () => {},
    watchLayers: () => {}, layersOpen: () => false,
  };
  box.globalThis = box;
  const at = drawer.indexOf("const CARD_STEP = 'kbCard';");
  assert.ok(at >= 0, 'the card no longer keeps an entry in the history');
  const src = drawer.slice(at, drawer.indexOf('\nexport function closeDrawer()', at)).replace(/^export /gm, '');
  vm.runInNewContext(`${src}\nthis.holdBack = holdBack; this.dropBack = dropBack; wireCardBack();`, box);
  assert.equal(state, null, 'the entry a reload left makes the first back gesture do nothing');
  shown = true; box.holdBack(); box.holdBack();
  assert.equal(pushed.length, 1, 'a second card (or the arrows) pushed a second entry — back would need two gestures');
  state = null; popstate(); // the gesture: the browser is on the entry before
  assert.ok(!shown, 'back left the card open');
  assert.equal(backs, 0, 'closing by back went back once more — off the page');
  shown = true; box.holdBack();
  box.closeDrawer();
  assert.equal(backs, 1, '✕ left the entry: the next back would do nothing');
  shown = true; // a card opened before the popstate of ✕ came
  state = null; popstate();
  assert.ok(shown, 'the popstate of ✕ closed the next card');
  assert.equal(pushed.length, 3, 'the next card lost its entry');
  // a picture (or a menu, a question) over the card: back closes it, the card and its entry stay
  let pictureOpen = true;
  layers.push(() => { pictureOpen = false; });
  state = null; popstate();
  assert.ok(!pictureOpen && shown, 'back closed the card under an open picture and left the picture over the board');
  assert.equal(pushed.length, 4, 'the card lost its entry to the picture');
  // ✕, a card opened and closed again before that popstate: back once, not twice off the page
  backs = 0;
  box.closeDrawer(); shown = true; box.closeDrawer();
  assert.equal(backs, 1, 'two closes before the popstate went back twice');
  state = null; popstate();
  // a window narrowed under an open card gets its entry
  shown = true; narrowed({ matches: true });
  assert.equal(pushed.length, 5, 'a card opened wide and then narrowed has no entry: back leaves the page');
  box.matchMedia = () => ({ matches: false });
  state = null; vm.runInNewContext('holdBack()', box);
  assert.equal(pushed.length, 5, 'a wide window put an entry for a card beside the board');
});

test('taps of a phone: ✕ ▶ ⋯, the buttons of a column, ☰, the tabs and «sound off» take ~40 points', () => {
  const block = narrowBlock();
  for (const sel of ['#side-open::after', '#project-menu::after', '.drawer-head-actions .btn-icon::after', '.col-sort::after', '.sound-badge::after', '.dr-btn::after', '.wait-sec-h::after']) {
    assert.ok(block.includes(sel), `${sel} lost its wider tap`);
  }
  assert.match(block, /\.drawer-head-actions, \.col-head \{ gap: 12px; \}/, 'the taps of neighbour icons overlap');
});

test('CK-849: the ☰ panel, Settings, the search keep a step too — back closes them, not the page', () => {
  let state = null;
  const pushed = [];
  let backs = 0;
  let popstate = null;
  let watch = null;
  const layers = [];
  let closed = 0;
  const box = {
    NARROW: '(max-width: 760px)',
    history: { get state() { return state; }, pushState: (s) => { pushed.push(s); state = s; }, replaceState: (s) => { state = s; }, back: () => { backs += 1; } },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    window: { addEventListener: (type, fn) => { popstate = fn; } },
    drawerShown: () => false,
    closeTopLayer: () => { const top = layers.pop(); if (!top) return false; watch(layers.length); top(); return true; },
    closeDrawer: () => { closed += 1; },
    document: { querySelector: () => null }, closeOpenSelect: () => {},
    watchLayers: (fn) => { watch = fn; }, layersOpen: () => layers.length > 0,
  };
  box.globalThis = box;
  const at = drawer.indexOf("const CARD_STEP = 'kbCard';");
  const src = drawer.slice(at, drawer.indexOf('\nexport function closeDrawer()', at)).replace(/^export /gm, '');
  vm.runInNewContext(`${src}\nwireCardBack();`, box);
  assert.equal(typeof watch, 'function', 'the card does not listen to the layers');
  let menuOpen = true;
  layers.push(() => { menuOpen = false; }); watch(1); // ☰ opened
  assert.equal(pushed.length, 1, 'an open menu leaves no step: back leaves the page');
  state = null; popstate(); // the gesture
  assert.ok(!menuOpen, 'back did not close the menu');
  assert.deepEqual([closed, backs], [0, 0], 'back closed a card that was not there, or went back off the page');
  // Settings opened, then closed by Esc (not by back): the step goes back out
  layers.push(() => {}); watch(1);
  assert.equal(pushed.length, 2);
  layers.pop(); watch(0);
  assert.equal(backs, 1, 'a layer closed by Esc left its step: the next back would do nothing');
  state = null; popstate(); // the popstate of that back
  assert.equal(pushed.length, 2, 'the step came back with nothing open');
});
