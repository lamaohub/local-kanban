// The real module on stand-ins of the page, counting canvases and their sizes.
// Run: node --test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const made = [];
const listeners = {};
let on = true;
let timers = [];
let g;

function canvas() {
  const c = { width: 300, height: 150, id: '', setAttribute() {},
    getContext: () => ({ setTransform() {}, measureText: () => ({ width: 6 }), clearRect() {}, drawImage() {}, fillText() {}, set font(v) {}, set textBaseline(v) {} }) };
  made.push(c);
  return c;
}

before(async () => {
  Object.assign(globalThis, {
    innerWidth: 1000, innerHeight: 600, window: { devicePixelRatio: 2 },
    addEventListener: (ev, fn) => { (listeners[ev] ||= []).push(fn); },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
  });
  globalThis.document = {
    hidden: false, documentElement: { dataset: { design: 'v3' } }, body: { prepend() {} },
    createElement: canvas, addEventListener() {},
  };
  g = await import('../public/js/glyphs.js');
});

const big = () => made.filter((c) => c.width > 0 && c.height > 0);
const fire = () => { const t = timers; timers = []; t.forEach((x) => x.fn()); };

test('off from the start it holds no canvas of the size of the window', () => {
  on = false;
  g.initGlyphs({ enabled: () => on });
  assert.equal(big().length, 0, 'a switched-off background holds video memory');
});

test('on it makes its canvases, off it gives them back, on again uses the same ones', () => {
  on = true;
  g.syncGlyphs();
  assert.equal(big().length, 4, 'the screen and three layers');
  assert.equal(made[0].width, 2000);
  const n = made.length;
  on = false;
  g.syncGlyphs();
  assert.equal(big().length, 0, 'switching off keeps the canvases');
  on = true;
  g.syncGlyphs();
  assert.equal(big().length, 4);
  assert.ok(made.length <= n + 3, 'a canvas more than the layers');
});

test('a series of resizes is one count, and makes no new canvas', () => {
  const n = made.length;
  for (let i = 0; i < 10; i++) { globalThis.innerWidth = 900 + i; listeners.resize.forEach((fn) => fn()); }
  assert.equal(made.length, n, 'a canvas made while the window is being dragged');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, g.RESIZE_QUIET_MS);
  fire();
  assert.equal(made.length, n, 'the layers were made anew instead of resized in place');
  assert.equal(made[0].width, 1818, 'the last size of the window');
  assert.equal(big().length, 4);
});

test('a resize while it is off does not bring the canvases back', () => {
  on = false;
  g.syncGlyphs();
  listeners.resize.forEach((fn) => fn());
  fire();
  assert.equal(big().length, 0);
});
