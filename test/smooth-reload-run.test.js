// A change of language reloads the page smoothly: smoothReload (public/js/core.js) runs here as written, against a fake
// page — it leaves its colour for the next page, covers the page first, and reloads only once the language reached the
// server and the fade had its time; liftCurtain fades the cover and then takes it off. Callers hand the language request
// to it, and the cover stands over everything the board draws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const core = read('js/core.js');

function load({ calm = false } = {}) {
  const from = core.indexOf('export const CURTAIN_KEY');
  const lift = core.indexOf('export function liftCurtain', from);
  assert.ok(from >= 0 && lift > from, 'smoothReload and liftCurtain are not where the guard looks');
  const end = core.indexOf('\n}\n', lift);
  const code = core.slice(from, end + 2).replace(/^export /gm, '');
  const classes = new Set();
  const props = {};
  const store = new Map();
  const timers = [];
  const page = { reloads: 0 };
  const ctx = {
    document: {
      documentElement: {
        classList: { contains: (c) => classes.has(c), add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)) },
        style: { setProperty: (k, v) => { props[k] = v; } },
      },
      body: {},
    },
    getComputedStyle: () => ({ backgroundColor: 'rgb(20, 20, 20)' }),
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    get sessionStore() { return this.sessionStorage; },
    window: { matchMedia: () => ({ matches: calm }) },
    location: { reload: () => { page.reloads += 1; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    Promise,
  };
  vm.runInNewContext(`${code}\nthis.smoothReload = smoothReload; this.liftCurtain = liftCurtain; this.CURTAIN_KEY = CURTAIN_KEY;`, ctx);
  const tick = () => new Promise((resolve) => { setImmediate(resolve); });
  // the cap on the language request (seconds) runs only when a test asks for it; the fade's timers run at once
  const CAP = 1000;
  const runTimers = (cap = false) => {
    const due = timers.filter((t) => (t.ms >= CAP) === cap);
    due.forEach((t) => timers.splice(timers.indexOf(t), 1));
    due.forEach((t) => t.fn());
    return due;
  };
  return { ctx, classes, props, store, timers, page, tick, runTimers };
}

test('the page covers itself in its colour, leaves it for the next page, and reloads only after the language and the fade', async () => {
  const p = load();
  let answer;
  const sent = new Promise((resolve) => { answer = resolve; });
  p.ctx.smoothReload(sent);
  assert.equal(p.store.get(p.ctx.CURTAIN_KEY), 'rgb(20, 20, 20)', 'the next page does not know the colour to come up under');
  assert.equal(p.props['--curtain'], 'rgb(20, 20, 20)');
  assert.ok(p.classes.has('kb-curtain') && p.classes.has('kb-curtain-in'), 'the page does not fade into its background before the reload');
  await p.tick();
  assert.equal(p.page.reloads, 0, 'the page reloaded at once, with no fade');
  const fade = p.runTimers();
  assert.ok(fade.some((t) => t.ms > 0), 'the fade has no time of its own');
  await p.tick();
  assert.equal(p.page.reloads, 0, 'the page reloaded before the language reached the server');
  answer();
  await p.tick(); await p.tick();
  assert.equal(p.page.reloads, 1, 'the page does not reload after the language and the fade');
});

test('a failed language request still reloads, and reduced motion does not wait for a fade', async () => {
  const p = load({ calm: true });
  p.ctx.smoothReload(Promise.reject(new Error('offline')));
  await p.tick();
  p.timers.filter((t) => t.ms < 1000).forEach((t) => assert.equal(t.ms, 0, 'reduced motion waits for a fade'));
  p.runTimers();
  await p.tick(); await p.tick();
  assert.equal(p.page.reloads, 1, 'a refused language request leaves the page covered without a reload');
});

test('liftCurtain fades the cover out and then takes it off, and does nothing without one', () => {
  const p = load();
  p.ctx.liftCurtain();
  assert.equal(p.classes.size, 0);
  assert.equal(p.timers.length, 0);
  p.classes.add('kb-curtain');
  p.ctx.liftCurtain();
  assert.ok(p.classes.has('kb-curtain-out'), 'the cover goes without a fade');
  assert.ok(p.classes.has('kb-curtain'), 'the cover is taken off before it faded');
  p.ctx.liftCurtain();
  assert.equal(p.timers.length, 1, 'a second lift starts a second removal');
  p.runTimers();
  assert.equal(p.classes.size, 0, 'the cover stays on the page after it faded');
});

test('the language goes to the server through the smooth reload, from Settings and from the wizard', () => {
  assert.match(read('js/settings.js'), /setSetting\('lang', v\); smoothReload\(syncLangToServer\(v\)\);/, 'Settings reloads without sending the language');
  const onb = read('js/onboarding.js');
  assert.match(onb, /const sent = syncLangToServer\(lang\);/);
  assert.match(onb, /smoothReload\(sent\);/, 'the wizard reloads without sending the language');
});

test('the cover stands over everything the board draws and fades in from nothing', () => {
  const css = read('style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const cover = css.match(/html\.kb-curtain::after \{([^}]*)\}/);
  assert.ok(cover, 'no cover');
  const z = Number(cover[1].match(/z-index:\s*(\d+)/)?.[1]);
  const others = [...css.replace(cover[0], '').matchAll(/z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(z > Math.max(...others), 'something of the board is drawn over the cover');
  const fadeIn = css.match(/html\.kb-curtain-in::after \{ animation: ([\w-]+) /);
  assert.ok(fadeIn, 'the cover comes at once, not fading in');
  assert.match(css, new RegExp(`@keyframes ${fadeIn[1]} \\{ from \\{ opacity: 0; \\}`), 'the fade-in of the cover does not start from nothing');
});

test('a language request that never answers does not leave the page a solid colour for good', async () => {
  const p = load();
  p.ctx.smoothReload(new Promise(() => {}));
  p.runTimers();
  await p.tick(); await p.tick();
  assert.equal(p.page.reloads, 0, 'the page reloaded before the language request had its chance');
  const cap = p.runTimers(true);
  assert.ok(cap.length === 1 && cap[0].ms <= 5000, `the wait for the language request has no cap of a few seconds: ${JSON.stringify(cap.map((t) => t.ms))}`);
  await p.tick(); await p.tick();
  assert.equal(p.page.reloads, 1, 'a request that never answers keeps the page covered without a reload');
});
