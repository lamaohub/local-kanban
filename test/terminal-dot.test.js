import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const line = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('\n', at) + 1);
};
const constant = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return src.slice(at, src.indexOf('];\n', at) + 3);
};

function card() {
  const el = () => ({ innerHTML: '', value: '', placeholder: '', title: '', onclick: null, onkeydown: null, oninput: null, onscroll: null, querySelectorAll: () => [], setAttribute: () => {} });
  const els = {};
  const box = {
    $: (id) => { if (!els[id]) els[id] = el(); return els[id]; },
    state: { drawerKey: 'VV-1' },
    tr: (s) => s, esc: (s) => String(s), autoGrow: () => {}, termSend: async () => true, termStop: async () => {},
    intervals: [],
    setInterval: (fn, ms) => { box.intervals.push({ fn, ms }); return box.intervals.length; },
    looks: 0,
    pollTerminal: () => { box.looks++; return Promise.resolve(); },
    initTermGrip: () => {},
    wireTermCopy: () => {},
    wireTermImages: () => {}, growTermInput: () => {}, takeTermHint: () => false,
    ic: () => '', setClaudeView: () => {},
  };
  vm.runInNewContext([
    'var termKey = null; var termInfo = null; var termTimer = null; var termFollow = true; var termPeek = null;',
    line('const TERM_PEEK_MS = '),
    constant('const TERM_KEYS = ['),
    take('export function peekTerminal('),
    take('export function initTerminal('),
    'out = { TERM_PEEK_MS };',
  ].join('\n'), box);
  return box;
}
const settle = () => new Promise((r) => { setImmediate(r); });

test('the card looks at the terminal on its own every few seconds — that is how it learns a Claude out of work exited', async () => {
  const c = card();
  c.initTerminal();
  assert.equal(c.intervals.length, 1, 'nothing looks at the terminal while another tab is on screen and no event comes');
  const [{ fn, ms }] = c.intervals;
  assert.equal(ms, c.out.TERM_PEEK_MS);
  assert.ok(ms >= 2000 && ms <= 10000, `a look every ${ms} ms: the dot stays lit too long, or the server is asked too often`);
  fn(); // nothing runs on this card
  assert.equal(c.looks, 0, 'a card without a board Claude asks the server');
  c.termKey = 'VV-1';
  c.termInfo = { session: 's1', dead: false };
  fn();
  assert.equal(c.looks, 1, 'the look does not reach the terminal of the open card');
  await settle();
  c.termInfo = { session: 's1', dead: true, exit: 3 }; // the look saw it exit: no more asking
  fn();
  c.termInfo = { session: 's1', dead: false };
  c.termTimer = 9; // the Terminal tab is on screen and polled every second anyway
  fn();
  assert.equal(c.looks, 1, 'a look went out that nothing needed');
});
