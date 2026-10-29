import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockZoom } from '../public/js/no-zoom.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A document that keeps its listeners and fires a fake event at them, as a browser does. */
function fakeDoc() {
  const on = new Map();
  return {
    on,
    addEventListener(type, fn, opts) { on.set(type, { fn, opts }); },
    fire(type, init = {}) {
      const e = { type, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...init };
      on.get(type)?.fn(e);
      return e.defaultPrevented;
    },
  };
}

test('a pinch or Ctrl with the wheel does not zoom the board, a plain scroll still scrolls', () => {
  const doc = fakeDoc();
  blockZoom(doc);
  assert.equal(doc.fire('wheel', { ctrlKey: true }), true, 'a trackpad pinch (wheel with ctrlKey) zoomed the page');
  assert.equal(doc.fire('wheel', { ctrlKey: false }), false, 'a plain scroll was stopped');
  for (const g of ['gesturestart', 'gesturechange', 'gestureend']) assert.equal(doc.fire(g), true, `Safari's ${g} zoomed the page`);
  assert.equal(doc.fire('touchmove', { touches: [{}, {}] }), true, 'a two-finger pinch on a screen zoomed the page');
  assert.equal(doc.fire('touchmove', { touches: [{}] }), false, 'a one-finger swipe was stopped');
  // a listener the browser marks passive cannot cancel anything, and the document's wheel and touch ones are passive by default
  for (const type of ['wheel', 'touchmove', 'gesturestart', 'gesturechange']) assert.equal(doc.on.get(type).opts?.passive, false, `${type} is passive`);
});

test('the board blocks zoom where it starts, and the page asks the browser for no zoom and no double-tap zoom', () => {
  assert.match(read('public/js/init.js'), /^blockZoom\(document\);/m, 'init.js does not block the zoom');
  assert.match(read('public/index.html'), /<meta name="viewport" content="[^"]*maximum-scale=1[^"]*user-scalable=no/, 'the viewport still lets the page zoom');
  assert.match(read('public/style.css'), /^html \{ touch-action: manipulation; \}/m, 'a double tap still zooms');
});
