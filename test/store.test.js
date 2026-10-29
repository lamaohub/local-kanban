// very access to `localStorage` (the board stopped at its first line: an empty sidebar, no word why), a full storage
// or an old private Safari throws on a write (a click on a project left the dashboard on screen). The board goes to
// the storage only through public/js/store.js; here it runs against fake storages, and the rest of the page is
// checked for a direct access as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/** A fresh copy of store.js over the given globals (it reads `globalThis[name]` on every call). */
async function storeWith(globals) {
  for (const [k, v] of Object.entries(globals)) Object.defineProperty(globalThis, k, { configurable: true, ...v });
  return import(`../public/js/store.js?${Math.random()}`);
}
const memory = () => {
  const m = new Map();
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
};
const deny = () => { throw Object.assign(new Error('The operation is insecure.'), { name: 'SecurityError' }); };

test('a storage the browser forbids: nothing read, what is written lives in the tab', async () => {
  const { localStore, sessionStore } = await storeWith({ localStorage: { get: deny }, sessionStorage: { get: deny } });
  assert.equal(localStore.getItem('kb.set.theme'), null);
  localStore.setItem('kb.set.theme', JSON.stringify('dark'));
  assert.equal(localStore.getItem('kb.set.theme'), '"dark"', 'a setting picked in the tab did not take');
  localStore.removeItem('kb.set.theme');
  assert.equal(localStore.getItem('kb.set.theme'), null);
  sessionStore.setItem('kb.session.slug', 'demo');
  assert.equal(sessionStore.getItem('kb.session.slug'), 'demo');
  assert.equal(localStore.getItem('kb.session.slug'), null, 'the two storages share their memory');
});

test('a full storage: the write that failed is read back from the tab, a later one that works from the storage', async () => {
  const area = memory();
  let full = true;
  const quota = { ...area, setItem: (k, v) => { if (full) throw Object.assign(new Error('quota'), { name: 'QuotaExceededError' }); area.setItem(k, v); } };
  const { localStore } = await storeWith({ localStorage: { get: () => quota }, sessionStorage: { get: () => memory() } });
  area.m.set('kb.ui.project', 'old');
  localStore.setItem('kb.ui.project', 'new');
  assert.equal(localStore.getItem('kb.ui.project'), 'new', 'the board read back the value the storage refused');
  full = false;
  localStore.setItem('kb.ui.project', 'newer');
  assert.equal(area.m.get('kb.ui.project'), 'newer');
  area.m.set('kb.ui.project', 'from another tab');
  assert.equal(localStore.getItem('kb.ui.project'), 'from another tab', 'a value stored fine is not shadowed by the tab\'s memory');
});

test('a working storage is used as it is', async () => {
  const area = memory();
  const { localStore } = await storeWith({ localStorage: { get: () => area }, sessionStorage: { get: () => memory() } });
  localStore.setItem('kb.set.sound', true);
  assert.equal(area.m.get('kb.set.sound'), 'true');
  localStore.removeItem('kb.set.sound');
  assert.equal(area.m.has('kb.set.sound'), false);
});

test('the page goes to the storage only through store.js', () => {
  const dir = new URL('../public/js/', import.meta.url);
  const raw = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js') && x !== 'store.js')) {
    const code = readFileSync(new URL(f, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of code.matchAll(/\b(?:local|session)Storage\b/g)) raw.push(`${f}: ${code.slice(m.index, m.index + 40)}`);
  }
  for (const f of ['../public/app.js']) {
    const code = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    if (/\b(?:local|session)Storage\b/.test(code)) raw.push(f);
  }
  assert.deepEqual(raw, [], 'a direct access throws where the browser forbids storage and stops the page');
});
