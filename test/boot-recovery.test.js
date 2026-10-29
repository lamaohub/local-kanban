import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const bootCode = readFileSync(new URL('../public/boot-fallback.js', import.meta.url), 'utf8');
const swCode = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const initCode = readFileSync(new URL('../public/js/init.js', import.meta.url), 'utf8');
const ORIGIN = 'http://127.0.0.1:3101';

// One page load: boot-fallback.js runs against a fake page. `store` is the tab's sessionStorage,
// which survives the reload, so passing the same Map models the next load in the same tab.
// Like a browser, the fake window hands a script's runtime error (an ErrorEvent at window) to every
// error listener, and an element that failed to load only to the listeners of the capture phase:
// that event is dispatched at the element and does not bubble.
function load({ store = new Map(), booting = true, storage = true } = {}) {
  const listeners = [];
  const classes = new Set(booting ? ['booting'] : []);
  const timers = [];
  const state = { reloads: 0 };
  const sessionStorage = storage
    ? { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); } }
    : { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('SecurityError'); } };
  vm.runInNewContext(bootCode, {
    window: { addEventListener: (type, fn, opts) => { if (type === 'error') listeners.push({ fn, capture: opts === true || Boolean(opts?.capture) }); } },
    document: { documentElement: { classList: { contains: (c) => classes.has(c), remove: (c) => { classes.delete(c); } } } },
    location: { origin: ORIGIN, reload: () => { state.reloads += 1; } },
    sessionStorage,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  });
  return {
    state,
    store,
    error(filename) { for (const l of listeners) l.fn({ filename, target: {} }); },
    failedToLoad(target) { for (const l of listeners) if (l.capture) l.fn({ target }); },
    // the reload waits a moment for the error log; the 8-second skeleton timer is not part of it
    settle() { for (const t of timers.splice(0)) if (t.ms < 8000) t.fn(); else timers.push(t); },
    finishBoot() { classes.delete('booting'); },
  };
}

test('a script of the board failing while it loads reloads the page once', () => {
  const page = load();
  page.error(`${ORIGIN}/js/init.js`);
  assert.equal(page.state.reloads, 0, 'the reload waits for the error log');
  page.settle();
  assert.equal(page.state.reloads, 1);
  page.error(`${ORIGIN}/js/drawer.js`); // a second error of the same load
  page.settle();
  assert.equal(page.state.reloads, 1, 'one load reloads at most once');
});

test('the same failure after the reload is a real bug: no second reload', () => {
  const first = load();
  first.error(`${ORIGIN}/js/init.js`);
  first.settle();
  const second = load({ store: first.store }); // the same tab after the reload
  second.error(`${ORIGIN}/js/init.js`);
  second.settle();
  assert.equal(second.state.reloads, 0, 'a reload loop on a broken build');
});

test('a load that got through re-arms it, so the next mix-up in this tab recovers too', () => {
  const store = new Map();
  const first = load({ store });
  first.error(`${ORIGIN}/js/init.js`);
  first.settle();
  // init.js bootDone() of the next, successful load clears the flag
  const key = bootCode.match(/var KEY = '([^']+)'/)[1];
  store.delete(key);
  const later = load({ store });
  later.error(`${ORIGIN}/js/init.js`);
  later.settle();
  assert.equal(later.state.reloads, 1);
});

test('bootDone in init.js clears exactly the flag boot-fallback.js sets', () => {
  const key = bootCode.match(/var KEY = '([^']+)'/)?.[1];
  assert.ok(key, 'boot-fallback.js no longer names its flag as `var KEY = ...`');
  const bootDone = initCode.match(/function bootDone\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(bootDone, 'bootDone() not found in init.js');
  assert.ok(bootDone.includes(`sessionStore.removeItem('${key}')`),
    `bootDone() does not clear ${key}: after one recovery the tab would never recover again`);
  // before the early return: the 8-second timer may have removed `booting` already
  assert.ok(bootDone.indexOf('removeItem') < bootDone.indexOf("contains('booting')"),
    'the flag is cleared only when bootDone() is the one to remove the skeleton');
});

test('an error after the board has loaded does not reload', () => {
  const page = load();
  page.finishBoot();
  page.error(`${ORIGIN}/js/board.js`);
  page.settle();
  assert.equal(page.state.reloads, 0);
});

test('errors of scripts that are not the board do not reload', () => {
  const page = load();
  for (const f of ['', undefined, 'safari-web-extension://abc/content.js', 'http://example.com/x.js',
    `${ORIGIN}9/js/init.js`]) page.error(f);
  page.settle();
  assert.equal(page.state.reloads, 0);
});

test('a script of the board that could not even be fetched (a 404 of a module) reloads the page once', () => {
  const page = load();
  page.failedToLoad({ tagName: 'SCRIPT', src: `${ORIGIN}/app.js` }); // a module of its graph answered 404
  page.settle();
  assert.equal(page.state.reloads, 1, 'a script that failed to load is heard only in the capture phase, and nothing listens there');
  const again = load({ store: page.store }); // the same tab after the reload: the module is still not there
  again.failedToLoad({ tagName: 'SCRIPT', src: `${ORIGIN}/app.js` });
  again.settle();
  assert.equal(again.state.reloads, 0, 'a module that is gone for good reloads the page in a loop');
});

test('an image, a stylesheet or a script of another site that fails to load does not reload', () => {
  const page = load();
  page.failedToLoad({ tagName: 'IMG', src: `${ORIGIN}/no-such.png` });
  page.failedToLoad({ tagName: 'LINK', href: `${ORIGIN}/style.css` });
  page.failedToLoad({ tagName: 'SCRIPT', src: 'https://cdn.example.com/x.js' });
  page.settle();
  assert.equal(page.state.reloads, 0);
});

test('without session storage it does not reload: nothing would stop a loop', () => {
  const page = load({ storage: false });
  page.error(`${ORIGIN}/js/init.js`);
  page.settle();
  assert.equal(page.state.reloads, 0);
});

test('the skeleton timer still lifts the placeholder after 8 seconds', () => {
  const timers = [];
  const classes = new Set(['booting']);
  vm.runInNewContext(bootCode, {
    window: { addEventListener() {} },
    document: { documentElement: { classList: { contains: (c) => classes.has(c), remove: (c) => { classes.delete(c); } } } },
    location: { origin: ORIGIN, reload() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  });
  const skeleton = timers.find((t) => t.ms === 8000);
  assert.ok(skeleton);
  skeleton.fn();
  assert.equal(classes.has('booting'), false);
});

// sw.js against a fake worker scope: what its fetch handler does with a request.
function worker({ network = async () => new Response('page'), offline = new Response('offline page') } = {}) {
  const handlers = {};
  const calls = [];
  vm.runInNewContext(swCode, {
    self: { addEventListener: (t, fn) => { handlers[t] = fn; }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { open: async () => ({ add: async () => {} }), keys: async () => [], delete: async () => true, match: async () => offline ?? undefined },
    fetch: (...args) => { calls.push(args); return network(...args); },
    Response,
  });
  const dispatch = (request) => {
    let responded = null;
    handlers.fetch({ request, respondWith: (p) => { responded = p; } });
    return responded;
  };
  return { calls, dispatch };
}

test('the service worker takes a page only from the network, past the HTTP cache', async () => {
  const sw = worker();
  const req = { mode: 'navigate', url: `${ORIGIN}/`, cache: 'force-cache' }; // a restored window / back-forward
  const res = await sw.dispatch(req);
  assert.equal(await res.text(), 'page');
  assert.equal(sw.calls.length, 1);
  assert.equal(sw.calls[0][0], req);
  assert.deepEqual({ ...sw.calls[0][1] }, { cache: 'no-store' },
    'a plain fetch(req) honours force-cache and answers with the page the browser kept');
});

test('the service worker leaves everything but navigations alone', () => {
  const sw = worker();
  for (const mode of ['cors', 'same-origin', 'no-cors']) {
    assert.equal(sw.dispatch({ mode, url: `${ORIGIN}/api/events` }), null, mode);
  }
  assert.equal(sw.calls.length, 0);
});

test('with the board down a navigation still gets the offline page, or a plain 503', async () => {
  const down = async () => { throw new TypeError('Load failed'); };
  const cached = await worker({ network: down }).dispatch({ mode: 'navigate', url: `${ORIGIN}/` });
  assert.equal(await cached.text(), 'offline page');
  const evicted = await worker({ network: down, offline: null }).dispatch({ mode: 'navigate', url: `${ORIGIN}/` });
  assert.equal(evicted.status, 503);
});
