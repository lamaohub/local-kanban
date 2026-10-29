// of the dashboard off the screen — and stay folded on this computer: the dashboard is drawn anew on every event, so the
// choice is read at each drawing, not kept in the page. The real functions of settings.js and dash.js, on stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = (f) => readFileSync(new URL(`../public/js/${f}.js`, import.meta.url), 'utf8');
function take(text, head) {
  const at = text.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  return text.slice(at, text.indexOf('\n}\n', at) + 2).replace(/^export /, '');
}
const settings = src('settings');

function page() {
  const store = new Map();
  const box = {
    localStore: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    tr: (s) => s, esc: (s) => String(s), claudeMeta: () => '',
    wRow: (t) => `<div class="wait-row" data-key="${t.key}"></div>`,
  };
  const line = settings.slice(settings.indexOf('const WAIT_FOLD_KEY'), settings.indexOf('\n', settings.indexOf('const WAIT_FOLD_KEY')));
  vm.runInNewContext([line, take(settings, 'export function waitFolded('), take(settings, 'export function setWaitFolded('),
    take(settings, 'export function waitingHTML('), 'this.api = { waitFolded, setWaitFolded, waitingHTML };'].join('\n'), box);
  return { ...box.api, store };
}
const W = { claude: [], review: [{ key: 'A-1' }, { key: 'A-2' }], blocked: [{ key: 'B-1', reason: 'x' }], stale: [] };
const opened = (html) => Object.fromEntries([...html.matchAll(/<details class="wait-sec" data-sec="(\w+)"( open)?>/g)].map((m) => [m[1], Boolean(m[2])]));

test('every list is unfolded until folded, says its count, and keeps its rows inside', () => {
  const p = page();
  const html = p.waitingHTML(W);
  assert.deepEqual(opened(html), { review: true, blocked: true });
  assert.match(html, /<summary class="wait-sec-h"[^>]*>Check \(2\)<\/summary><div class="wait-row" data-key="A-1"><\/div><div class="wait-row" data-key="A-2"><\/div><\/details>/);
  assert.match(p.waitingHTML({ claude: [], review: [], blocked: [], stale: [] }), /All clear/);
});

test('a folded list stays folded at the next drawing, on its own; unfolding brings it back', () => {
  const p = page();
  p.setWaitFolded('review', true);
  assert.deepEqual(opened(p.waitingHTML(W)), { review: false, blocked: true });
  assert.match(p.waitingHTML(W), /Check \(2\)/, 'a folded list hides its count');
  p.setWaitFolded('blocked', true);
  p.setWaitFolded('review', false);
  assert.deepEqual(opened(p.waitingHTML(W)), { review: true, blocked: false });
  p.store.set('kb.ui.waitFold', '{broken');
  assert.deepEqual(opened(p.waitingHTML(W)), { review: true, blocked: true }, 'a spoilt record breaks the dashboard');
});

test('the dashboard remembers a list folded or unfolded by hand', () => {
  const dash = src('dash');
  const body = take(dash, 'export async function renderDashboard(');
  assert.match(body, /querySelectorAll\('\.wait-sec'\)\.forEach\(\(el\) => \{ el\.ontoggle = \(\) => setWaitFolded\(el\.dataset\.sec, !el\.open\); \}\);/);
});
