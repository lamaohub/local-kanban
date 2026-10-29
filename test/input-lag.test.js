// thousand rows each. Two things laid the screens out anew on every letter: the field reset its height to `auto` to
// measure itself, and the screens took their height from flex. The real autoGrow of sse.js and the real sizeScreen of
// now-terms.js on stand-ins; the timings themselves were taken in Chromium and WebKit, a key went from 22–28 ms to 9 ms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

function autoGrowBox() {
  const sse = read('js/sse.js');
  const from = sse.indexOf('const grown = new WeakMap()');
  const fnAt = sse.indexOf('export function autoGrow(el)');
  const body = sse.slice(from, sse.indexOf('\n}\n', fnAt) + 2).replace(/^export /m, '');
  const box = { WeakMap };
  vm.runInNewContext(`${body}\nthis.autoGrow = autoGrow;`, box);
  return box.autoGrow;
}

// a textarea of 20 letters a row, 18px a row, 2px of border: `auto` shows its content, a height in px is kept as set
function field(value = '') {
  const writes = [];
  let height = '';
  const el = {
    isConnected: true, offsetParent: {}, offsetWidth: 300, value,
    get rows() { return Math.max(1, el.value.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / 20)), 0)); },
    get scrollHeight() { return el.rows * 18; },
    get clientHeight() { return height && height !== 'auto' ? parseFloat(height) - 2 : el.scrollHeight; },
    get offsetHeight() { return el.clientHeight + 2; },
    style: {},
  };
  Object.defineProperty(el.style, 'height', { get: () => height, set: (v) => { writes.push(v); height = v; } });
  return { el, writes };
}

test('typing grows the field without collapsing it to auto first — no letter lays the page out twice', () => {
  const autoGrow = autoGrowBox();
  const { el, writes } = field();
  autoGrow(el);
  assert.deepEqual(writes, ['auto', '20px'], 'the first look at a field measures it in full');
  writes.length = 0;
  for (const ch of 'hello there, this is a long answer') { el.value += ch; autoGrow(el); }
  assert.ok(!writes.includes('auto'), 'a typed letter collapsed the field to measure it — the whole column laid out anew');
  assert.deepEqual(writes, ['38px'], 'the field set its height on letters that did not add a row');
  el.value = `${el.value.slice(0, 5)}X${el.value.slice(5)}`; // a letter typed in the middle is typing too
  writes.length = 0;
  autoGrow(el);
  assert.deepEqual(writes, []);
});

test('anything but typing — a deletion, a replaced selection, another width — measures the field in full again', () => {
  const autoGrow = autoGrowBox();
  const { el, writes } = field('a'.repeat(45));
  autoGrow(el);
  assert.equal(el.style.height, '56px');
  writes.length = 0;
  el.value = 'a'.repeat(5);
  autoGrow(el);
  assert.deepEqual(writes, ['auto', '20px'], 'a deleted row left the field tall');
  writes.length = 0;
  el.value = 'b'.repeat(6); // the selection replaced by a longer text — not an insertion into the old one
  autoGrow(el);
  assert.deepEqual(writes, ['auto', '20px']);
  writes.length = 0;
  el.offsetWidth = 200;
  el.value += 'c';
  autoGrow(el);
  assert.deepEqual(writes, ['auto', '20px'], 'a field of another width was not measured anew');
});

function sizer({ boxH = 600, keysH = 30, formH = 40, follow = true } = {}) {
  const terms = read('js/now-terms.js');
  const at = terms.indexOf('function sizeScreen(c)');
  const fn = terms.slice(at, terms.indexOf('\n}\n', at) + 2);
  const observed = [];
  let callback = null;
  const vars = {};
  const classes = new Set();
  const pre = {
    scrollTop: 0, scrollHeight: 9000,
    style: { getPropertyValue: (k) => vars[k] || '', setProperty: (k, v) => { vars[k] = v; } },
    classList: { add: (c) => classes.add(c), contains: (c) => classes.has(c) },
  };
  const keys = { offsetHeight: keysH };
  const form = { offsetHeight: formH };
  const scr = { classList: { add: (c) => classes.add(`scr:${c}`) }, querySelector: (s) => (s === '.now-col-screen' ? pre : null) };
  const box = { clientHeight: boxH, children: [scr, keys, form], querySelector: (s) => (s === '.now-col-scr' ? scr : form) };
  const c = { follow, el: { querySelector: () => box } };
  const ctx = {
    getComputedStyle: () => ({ rowGap: '6px' }),
    ResizeObserver: class { constructor(f) { callback = f; } observe(e) { observed.push(e); } },
  };
  vm.runInNewContext(`${fn}\nthis.sizeScreen = sizeScreen;`, ctx);
  ctx.sizeScreen(c);
  return { c, pre, box, keys, form, observed, fire: () => callback([]), vars, classes };
}

test('a column screen gets its height in pixels: what its box leaves after the keys and the field', () => {
  const s = sizer();
  assert.deepEqual(s.observed, [s.box, s.form], 'the screen does not follow the column or the growing field');
  s.fire();
  assert.equal(s.vars['--scr-h'], `${600 - 30 - 40 - 12}px`);
  assert.ok(s.classes.has('sized'));
  assert.ok(s.classes.has('scr:sized'), 'the wrapper of the screen still takes its share of the column by flex');
  assert.equal(s.pre.scrollTop, 9000, 'the field grew over the screen and hid its last rows');
  s.pre.scrollTop = 0;
  s.fire();
  assert.equal(s.pre.scrollTop, 0, 'a look that changed nothing moved the screen');
  s.form.offsetHeight = 100;
  s.fire();
  assert.equal(s.vars['--scr-h'], `${600 - 30 - 100 - 12}px`, 'a taller field did not shrink the screen');
  const still = sizer({ follow: false });
  still.fire();
  assert.equal(still.pre.scrollTop, 0, 'a screen scrolled up by the person was sent to the bottom');
  const hidden = sizer({ boxH: 0 });
  hidden.fire();
  assert.ok(!hidden.classes.has('sized'), 'a column not laid out yet got a screen of no height');
});

test('the pixel height holds only in the side-by-side columns; stacked on a phone the screen keeps its own', () => {
  const css = read('style.css');
  assert.match(css, /\.now-col \.term-screen\.sized \{ flex: none; height: var\(--scr-h\); \}/);
  assert.match(css, /@media \(max-width: 760px\) \{[\s\S]*?\.now-col \.term-screen, \.now-col \.term-screen\.sized \{ flex: none; height: 55vh; \}/,
    'on a phone the column height would come from a screen measured for side-by-side columns');
  const terms = read('js/now-terms.js');
  assert.match(terms, /sizeScreen\(c\);/, 'the columns are not sized');
  assert.match(terms, /const drop = \(c\) => \{ if \(fullCol === c\) setColumnFull\(c, false, \{ quiet: true \}\); sight\?\.unobserve\(c\.el\); c\.sizer\?\.disconnect\(\); c\.chat\?\.destroy\(\); c\.el\.remove\(\); \};/, 'a dropped column keeps its observer or its chat');
  assert.ok(!/\bc\.el\.remove\(\)/.test(terms.replace(/const drop = [^\n]*/, '')), 'a column is removed past `drop`, its observer left on');
});
