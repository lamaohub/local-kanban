// acceptance; these keep its shape, as test/stability-small.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');

test('CK-856: the page paints the state of the link, after a grace of 5 s', () => {
  const src = read('sse.js');
  assert.match(src, /createLink\(\{[\s\S]*?onState: sayLink[\s\S]*?probe: roomFull/, 'the state of the link reaches no notice');
  assert.match(src, /const LINK_SAY_MS = 5000;/);
  assert.match(src, /const left = LINK_SAY_MS - \(Date\.now\(\) - st\.since\);/, 'a restart of the server would flash the notice');
});

test('CK-855: a first list of projects that failed is said where the projects would be', () => {
  const src = read('sidebar.js');
  const body = src.slice(src.indexOf('function sayProjectsFailed'), src.indexOf('export async function loadProjects'));
  const box = { innerHTML: 'x', querySelector: () => null, appendChild(el) { this.child = el; } };
  const el = { querySelector: () => ({}) };
  const badge = { dataset: {}, classList: { remove(c) { badge.gone = c; } } };
  const ctx = { $: (id) => (id === 'load-badge' ? badge : box), document: { createElement: () => el }, esc: String, tr: String, refresh: async () => {} };
  vm.runInNewContext(`${body}\nsayProjectsFailed({ status: 500 });`, ctx);
  assert.equal(box.child, el, 'the sidebar stays empty');
  assert.match(el.innerHTML, /did not load/);
  assert.equal(badge.gone, 'hidden', 'on a phone the sidebar is closed and nothing else says it');
  assert.ok(badge.dataset.projects, 'the task list that comes next takes the word away');
});

test('CK-857: the window calls off the request of an earlier word', () => {
  const src = read('search.js');
  const body = src.slice(src.indexOf('async function ask'), src.indexOf('function projectName'));
  assert.match(body, /open\.req\?\.abort\(\);[\s\S]*new AbortController\(\)[\s\S]*signal: req\.signal/, 'every word runs to its end');
});

test('CK-824: a typed address goes through esc into the row of Settings', () => {
  const src = read('share.js');
  const body = src.slice(src.indexOf('const REFUSED_WHY'), src.indexOf('const POLL_MS'));
  const ctx = { esc: (s) => String(s).replace(/</g, '&lt;'), tr: String, row: () => '' };
  const html = vm.runInNewContext(`${body}\nrefusedHTML([{ at: '2026-10-31T10:00:00Z', ip: '10.0.0.1', why: 'host', host: '<img src=x>', n: 1 }]);`, ctx);
  assert.ok(!html.includes('<img'), 'an address typed by a stranger reaches the owner\'s page as markup');
});

test('CK-857: brotli stays at a fast level: the default 11 takes seconds on a big list', () => {
  const src = readFileSync(new URL('../src/compress.js', import.meta.url), 'utf8');
  const q = Number(src.match(/BROTLI_PARAM_QUALITY\]: (\d+)/)?.[1]);
  assert.ok(q >= 1 && q <= 5, `quality ${q}`);
});
