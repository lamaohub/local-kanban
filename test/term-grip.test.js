// keys — drag, ↑/↓, double-click back to the usual height — and the height is remembered on this computer. The real
// grip code of drawer.js on a stand-in page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const drawer = read('js/drawer.js');
const block = drawer.slice(drawer.indexOf("const TERM_H_KEY = 'kb.ui.termHeight';"), drawer.indexOf('export function initTerminal() {')).replace(/^export /gm, '');

function page(saved = null) {
  const store = new Map(saved == null ? [] : [['kb.ui.termHeight', String(saved)]]);
  const node = () => ({ style: {}, attrs: {}, classList: { set: new Set(), add(c) { this.set.add(c); }, remove(c) { this.set.delete(c); } }, setAttribute(k, v) { this.attrs[k] = v; } });
  const pre = node(); pre.scrollTop = 0; pre.scrollHeight = 2000;
  pre.getBoundingClientRect = () => ({ height: pre.style.height ? parseFloat(pre.style.height) : 464 });
  const grip = node(); grip.setPointerCapture = () => {};
  const byId = { 'term-screen': pre, 'term-grip': grip };
  const box = {
    $: (id) => byId[id], tr: (s) => `ru:${s}`, termFollow: true, termOwnTop: -1, innerHeight: 800,
    localStore: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) },
  };
  box.globalThis = box;
  vm.runInNewContext(`let termFollow = true; let termOwnTop = -1;\n${block}\nthis.init = initTermGrip; this.heightFor = termHeightFor;`, box);
  return { box, pre, grip, store };
}
const ev = (o) => ({ button: 0, pointerId: 1, preventDefault() {}, stopPropagation() {}, ...o });

test('the asked height stays within reach', () => {
  const { box } = page();
  assert.equal(box.heightFor(30, 800), 90, 'the screen shrinks to nothing');
  assert.equal(box.heightFor(2000, 800), 680, 'the screen grows past the window');
  assert.equal(box.heightFor(264.4, 800), 264);
});

test('dragging the grip shrinks the screen, keeps it at the bottom and remembers the height', () => {
  const { box, pre, grip, store } = page();
  box.init();
  assert.equal(grip.title, 'ru:Drag to shrink or grow the terminal · double-click — the usual height');
  grip.onpointerdown(ev({ clientY: 700 }));
  grip.onpointermove(ev({ clientY: 500 }));
  assert.equal(pre.style.height, '264px', 'the screen did not follow the grip');
  assert.equal(pre.style.maxHeight, 'none', 'the max-height of the stylesheet caps the dragged height');
  assert.equal(pre.scrollTop, 2000, 'a screen at the bottom is left above it');
  assert.equal(store.get('kb.ui.termHeight'), undefined, 'the height is written on every move');
  grip.onpointerup(ev({}));
  assert.equal(store.get('kb.ui.termHeight'), '264', 'the height is not remembered');
  grip.onkeydown(ev({ key: 'ArrowDown' }));
  assert.equal(pre.style.height, '288px', '↓ does not grow the screen');
  grip.ondblclick();
  assert.equal(pre.style.height, '', 'a double click does not give back the usual height');
  assert.equal(store.has('kb.ui.termHeight'), false, 'the usual height is not remembered as such');
});

// the comments next to the grip are not there on the published snapshot (scripts/release.js strips them) — not required
test('a remembered height is there when the board opens, and the grip is in the dock over the keys', () => {
  const { box, pre } = page(300);
  box.init();
  assert.equal(pre.style.height, '300px', 'the remembered height is lost on reload');
  assert.match(read('index.html'), /<div class="term-dock">\s*(?:<!--[^>]*-->\s*)?<div id="term-grip" class="term-grip" role="separator"/, 'the grip is not the first row of the dock');
  assert.match(drawer, /initTermGrip\(\);/, 'the grip is not wired');
  const css = read('style.css');
  assert.match(css, /\.term-grip \{[^}]*cursor: ns-resize; touch-action: none;/, 'the grip does not look draggable or scrolls the page under a finger');
  const core = read('js/core.js');
  for (const w of ['Drag to shrink or grow the terminal · double-click — the usual height', 'Terminal height']) assert.ok(core.includes(`'${w}': '`), `no Russian for "${w}"`);
});
