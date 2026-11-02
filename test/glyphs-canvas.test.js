// The real module on stand-ins of the page, counting canvases and their sizes.
// Run: node --test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const made = [];
const listeners = {};
const onDocument = {};
let on = true;
let timers = [];
let g;
let sizeWrites = 0;
let frames = 0;

function canvas() {
  let width = 300, height = 150;
  const c = { id: '', setAttribute() {},
    get width() { return width; }, set width(v) { sizeWrites += 1; width = v; },
    get height() { return height; }, set height(v) { sizeWrites += 1; height = v; },
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
    requestAnimationFrame: () => { frames += 1; return 1; }, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; },
    clearTimeout: (t) => { timers = timers.filter((x) => x !== t); },
  });
  globalThis.document = {
    hidden: false, documentElement: { dataset: { design: 'v3' } }, body: { prepend() {} },
    createElement: canvas, addEventListener: (ev, fn) => { (onDocument[ev] ||= []).push(fn); },
  };
  g = await import('../public/js/glyphs.js');
});

const big = () => made.filter((c) => c.width > 0 && c.height > 0);
const fire = () => { const t = timers; timers = []; t.forEach((x) => x.fn()); };
const move = () => onDocument.pointermove.forEach((fn) => fn({}));

test('off from the start it holds no canvas of the size of the window', () => {
  on = false;
  g.initGlyphs({ enabled: () => on });
  assert.equal(big().length, 0, 'a switched-off background holds video memory');
});

test('on it makes its canvases, off it gives them back, on again the screen keeps its own and the layers are new', () => {
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
  assert.equal(made[0].width, 2000, 'the screen canvas is the one it had');
  assert.equal(made.length, n + 3, 'the three layers are made anew, nothing else');
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

test('switched off, the mouse moving over the page leaves the canvases alone', () => {
  on = false;
  g.syncGlyphs();
  sizeWrites = 0;
  for (let i = 0; i < 10; i++) move();
  assert.equal(sizeWrites, 0, 'every move of the mouse wrote the sizes of empty canvases');
  assert.equal(big().length, 0);
});

test('a hidden tab keeps its canvases, the last frame is on them, and comes back to the same ones', () => {
  on = true;
  g.syncGlyphs();
  assert.equal(big().length, 4);
  const n = made.length;
  sizeWrites = 0;
  globalThis.document.hidden = true;
  g.syncGlyphs();
  assert.equal(big().length, 4, 'the hidden tab lost its last frame');
  assert.equal(sizeWrites, 0);
  move();
  assert.equal(sizeWrites, 0, 'a move over a hidden tab touched the canvases');
  globalThis.document.hidden = false;
  g.syncGlyphs();
  assert.equal(made.length, n, 'the canvases were made anew');
  assert.equal(sizeWrites, 0, 'the canvases were sized anew');
});

test('a background gone idle keeps its canvases too, and the first move brings it back', (t) => {
  const real = performance.now;
  t.after(() => { delete performance.now; });
  const later = real.call(performance) + g.IDLE_MS + 1000;
  performance.now = () => later;
  g.syncGlyphs();
  assert.equal(big().length, 4, 'going idle lost the last frame');
  const before = frames;
  move();
  assert.equal(frames, before + 1, 'the move did not start the frames again');
  assert.equal(big().length, 4);
});
