// fix taken back and green with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { prMark } from '../public/js/branch-rules.js';

const read = (rel) => readFileSync(new URL(`../public/${rel}`, import.meta.url), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const css = code(read('style.css'));
const board = code(read('js/board.js'));
const drawer = code(read('js/drawer.js'));
const fnOf = (src, head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /gm, '');
};

test('CK-867: reduced motion stops the fade of the link lines too, not only of the board', () => {
  const blocks = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]);
  assert.ok(blocks.some((b) => /\.link-lines[^{]*[,{]/.test(b) && /animation: none/.test(b)), 'the lines fade with reduced motion on');
});

test('CK-899: the theme before the first paint calls a phone what onPhone does — a tablet starts light', () => {
  const src = read('boot-fallback.js');
  const themeOf = (w, h) => {
    let theme = null;
    vm.runInNewContext(src, {
      setTimeout() {}, location: { search: '', origin: 'http://x' }, URLSearchParams,
      window: { addEventListener() {} }, sessionStorage: { getItem: () => null, removeItem() {} },
      localStorage: { getItem: () => null },
      matchMedia: (q) => ({ matches: q.includes('pointer: coarse') }),
      screen: { width: w, height: h },
      document: { documentElement: { classList: { add() {}, remove() {}, contains: () => false }, setAttribute: (k, v) => { if (k === 'data-theme') theme = v; } } },
    });
    return theme;
  };
  assert.equal(themeOf(820, 1180), 'light', 'a tablet flashes dark before applyTheme makes it light');
  assert.equal(themeOf(599, 900), 'dark');
  assert.equal(themeOf(600, 900), 'light');
});

test('CK-905: the form «+» remembers the task it became, or a picture picked after that goes nowhere', () => {
  assert.match(drawer, /formCreated = \{ form: formId, key: created\.key \}/);
});

test('CK-832: one\'s own comment brings the field into sight, once more when the picture has loaded', () => {
  const src = fnOf(drawer, 'export function showOwnComment(');
  const run = ({ open = 'CK-1', shown = true, complete = false, key = 'CK-1' }) => {
    const box = { calls: [], load: null };
    const form = { offsetParent: shown ? {} : null, scrollIntoView: (o) => box.calls.push(o) };
    const img = { complete, addEventListener: (type, fn) => { box.load = fn; } };
    const ctx = {
      state: { drawerKey: open },
      $: (id) => (id === 'c-input' ? { closest: () => form } : { querySelector: () => img }),
      globalThis: { matchMedia: () => ({ matches: false }) }, CSS: { escape: String },
    };
    vm.runInNewContext(`${src}; this.show = showOwnComment;`, ctx);
    ctx.show(key, 7);
    return { box, ctx };
  };
  assert.equal(run({}).box.calls.length, 1, 'the card did not scroll to the new comment');
  assert.equal(run({}).box.calls[0].block, 'end');
  assert.equal(run({ key: 'CK-2' }).box.calls.length, 0, 'a comment of another card moved the open one');
  assert.equal(run({ shown: false }).box.calls.length, 0, 'the card scrolled to a field that is not on screen');
  const slow = run({});
  assert.equal(typeof slow.box.load, 'function', 'a picture that loads later does not scroll the card again');
  slow.box.load();
  assert.equal(slow.box.calls.length, 2);
  slow.ctx.state.drawerKey = 'CK-2';
  slow.box.load();
  assert.equal(slow.box.calls.length, 2, 'the picture of a closed card moved the one open now');
  assert.equal(run({ complete: true }).box.load, null);
  assert.match(fnOf(drawer, 'export async function uploadCommentImage('), /showOwnComment\(key, sent\?\.id\)/, 'the clip no longer scrolls to its picture');
});

test('CK-848: all that a card shows is in its signature, and a kept node reads the task as it is now', () => {
  const src = fnOf(board, 'function cardParts(');
  const ctx = {
    state: { tasks: [], live: {}, slug: 'x' }, WORKING: new Set(), DRAG_LOCKED: new Set(), PRI_ICON: {}, ALL: '*',
    staleHours: (t) => t.stale || 0, atLimit: () => false, taskIsNoclaude: () => false, liveBadge: () => '', workTimer: () => '',
    labelChip: (x) => x, ic: () => '', esc: (x) => x, tr: (x) => x, showsShip: () => true, SHIP_WORDS: { branch: 'only in a branch' }, SHIP_TITLES: {}, prMark,
  };
  ctx.state.shipped = {};
  vm.runInNewContext(`${src}; this.parts = cardParts;`, ctx);
  const t = { id: 1, key: 'A-1', status: 'todo', title: 'one', labels: [], preview: '', priority: 0 };
  assert.equal(ctx.parts(t).sig, ctx.parts({ ...t }).sig);
  for (const change of [{ title: 'two' }, { comments_n: 1 }, { labels: ['bug'] }, { attachments_n: 2 }, { pinned: 1 }, { stale: 3 }, { pr: { number: 7, state: 'OPEN', url: 'u' } }]) {
    assert.notEqual(ctx.parts({ ...t, ...change }).sig, ctx.parts(t).sig, `${Object.keys(change)} does not reach the screen by a render`);
  }
  const plain = ctx.parts(t).sig;
  ctx.state.shipped = { 'A-1': 'branch' };
  assert.notEqual(ctx.parts(t).sig, plain, 'CK-895: the mark does not reach the screen by a render');
  ctx.state.shipped = {};
  const open = ctx.parts({ ...t, status: 'review', pr: { number: 7, state: 'OPEN', url: 'u' } }).html;
  assert.match(open, /class="card-pr pr-open"[^>]*>PR #7<\/span>/);
  assert.match(ctx.parts({ ...t, status: 'review', pr: { number: 7, state: 'MERGED', url: 'u' } }).html, />PR #7 · merged<\/span>/);
  assert.doesNotMatch(ctx.parts({ ...t, status: 'done', pr: { number: 7, state: 'MERGED', url: 'u' } }).html, /card-pr/);
  assert.match(fnOf(board, 'function cardEl('), /openDrawer\(now\(\)\.key\)/, 'a kept card opens the key it was drawn with');
});

test('CK-860: a drop that goes to the server keeps the held render until the answer', () => {
  for (const head of ['async function onDrop(', 'async function onDropGroup(']) {
    const src = fnOf(board, head);
    const set = src.indexOf('dropSends = true');
    assert.ok(set >= 0 && set < src.indexOf("await api('PATCH'"), `${head}: the render comes at dragend with the card back in its old column`);
  }
});

test('CK-847: a frame with nothing moved writes neither the layer nor the lines', () => {
  const src = fnOf(board, 'export function drawLinks(');
  const writes = { box: 0, lines: 0 };
  const svg = { dataset: {}, style: {}, setAttribute: () => { writes.box += 1; } };
  const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top });
  const card = (id, r) => ({ dataset: { id: String(id) }, getBoundingClientRect: () => r });
  const cards = [card(1, rect(10, 10, 100, 60)), card(2, rect(300, 10, 400, 60))];
  const brd = {
    getBoundingClientRect: () => rect(0, 0, 800, 600), parentElement: { getBoundingClientRect: () => rect(0, 0, 800, 600) },
    querySelectorAll: (q) => (q === '.card' ? cards : []), querySelector: () => null,
  };
  const ctx = {
    $: (id) => (id === 'link-lines' ? svg : brd), getSetting: () => true, ic: () => '', writeLines: () => { writes.lines += 1; }, lineOutOfSight: () => false,
    state: { tasks: [{ id: 1, linked_ids: [2] }, { id: 2, linked_ids: [1] }] },
  };
  vm.runInNewContext(`${src}; this.draw = drawLinks;`, ctx);
  ctx.draw(); ctx.draw(); ctx.draw();
  assert.equal(writes.box, 1, 'the same layer was written again'); // what the lines write: test/link-lines.test.js
});

// the real stack of sidebar.js and the real steps of drawer.js in one room, with a history that answers back() later
function stand() {
  const side = read('js/sidebar.js');
  const stack = code(side.slice(side.indexOf('let layerWatch = null;'), side.indexOf('\n}\n', side.indexOf('export function closeTopLayer(')) + 3));
  const raw = code(read('js/drawer.js'));
  const at = raw.indexOf("const CARD_STEP = 'kbCard';");
  const steps = raw.slice(at, raw.indexOf('\nexport function closeDrawer()', at));
  const log = { pushed: 0, backs: 0 };
  let states = [null];
  let queue = [];
  let popstate = null;
  const box = {
    NARROW: '(max-width: 760px)',
    history: {
      get state() { return states[states.length - 1]; },
      pushState: (s) => { log.pushed += 1; states.push(s); },
      replaceState: (s) => { states[states.length - 1] = s; },
      back: () => { log.backs += 1; queue.push(() => { states.pop(); popstate(); }); },
    },
    matchMedia: () => ({ matches: true, addEventListener() {} }),
    window: { addEventListener: (type, fn) => { popstate = fn; } },
    drawerShown: () => false, closeDrawer() {}, closeOpenSelect() {}, document: { querySelector: () => null },
  };
  box.globalThis = box;
  vm.runInNewContext(`const openLayers = [];\n${stack.replace(/^export /gm, '')}\n${steps.replace(/^export /gm, '')}\nwireCardBack();
    this.layers = { pushLayer, popLayer, closeTopLayer, layersOpen };`, box);
  return { ...box.layers, log, steps: () => states.filter(Boolean).length, flush: () => { const q = queue; queue = []; q.forEach((f) => f()); },
    gesture: () => { states.pop(); popstate(); } };
}

test('CK-849: the stack tells the history — a step for the first layer, none for a reopened one, back given when the last goes', () => {
  const s = stand();
  s.pushLayer('side', () => {});
  assert.equal(s.steps(), 1, 'an open layer keeps no step: back leaves the page');
  s.pushLayer('side', () => {}); // reopened: no fewer layers, nothing given back
  s.flush();
  assert.deepEqual([s.log.backs, s.steps()], [0, 1], 'a layer opened again gave its step back');
  s.closeTopLayer();
  assert.equal(s.log.backs, 1, 'a layer closed by Esc left its step: the next back would do nothing');
  s.flush();
  assert.equal(s.steps(), 0);
});

test('CK-849: ☰ giving way to Settings keeps the step, its back arriving after Settings opened', () => {
  const s = stand();
  s.pushLayer('side', () => {});
  s.popLayer('side'); // «Settings» of the panel: the panel closes first…
  s.pushLayer('settings', () => {}); // …and Settings open in the same tick
  s.flush(); // the popstate of the step the panel gave back
  assert.equal(s.steps(), 1, 'Settings opened from ☰ hold no step: back leaves the page');
  let closed = false;
  s.closeTopLayer();
  s.flush();
  s.pushLayer('settings', () => { closed = true; });
  s.gesture();
  assert.ok(closed, 'back did not close Settings');
});
