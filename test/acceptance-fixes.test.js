import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');

test('CK-849: a phone on its side, wider than NARROW, still keeps a step of history for the back gesture', () => {
  const src = read('js/drawer.js');
  const at = src.indexOf('function holdBack()');
  const fn = src.slice(at, src.indexOf('\n}\n', at) + 2);
  const step = (narrow, phone) => {
    const pushed = [];
    const box = { history: { state: null, pushState: (s) => pushed.push(s) }, NARROW: 'n', CARD_STEP: 'kbCard', onPhone: () => phone };
    box.globalThis = { matchMedia: () => ({ matches: narrow }) };
    vm.runInNewContext(`${fn}\nholdBack();`, box);
    return pushed.length;
  };
  assert.equal(step(true, false), 1, 'a narrow window lost its step');
  assert.equal(step(false, true), 1, 'on its side the back gesture leaves the board');
  assert.equal(step(false, false), 0, 'a desktop window piles up history');
});

test('CK-831: the taps of ⋯ and of «sound off» do not overlap on a phone', () => {
  const css = read('style.css');
  const at = css.indexOf('.sound-badge::after { content:');
  assert.ok(at > 0, 'the tap area of the badge is gone');
  assert.match(css.slice(at, at + 300), /\.topbar-right \{ margin-left: 10px; \}/, '⋯ keeps 30 of its 40 points');
});

test('CK-848: a card that left goes first, or every card below it is moved one by one', () => {
  const src = read('js/board.js');
  const gone = src.indexOf('if (!wanted.has(node)) node.remove();');
  assert.ok(gone > 0 && gone < src.indexOf('let ref = body.firstChild;'), 'a move from outside rewrites the whole column');
});

test('CK-829: the saves of one checklist item go one at a time, and the item counts as on its way until the last answer', () => {
  const src = read('js/drawer.js');
  assert.match(src, /const clInTurn = createTurns\(\);/);
  assert.match(src, /await clInTurn\(k, \(\) => patchChecklistItem\(key, id, \{ text \}\)\)/, 'a late answer of an older save takes the newer text off the resend, or lays the old one over it');
  assert.match(src, /if \(left\) clOnWay\.set\(k, left\); else \{ clOnWay\.delete\(k\); clSending\.delete\(k\); \}/, 'an event from elsewhere takes back the text of the second save');
});

test('CK-929: the countdown of a queue is not called a check', () => {
  assert.match(read('js/automations.js'), /tr\(r\.kind === 'todo-queue' \? 'Next batch in' : 'Check in'\)/);
  assert.match(read('js/core.js'), /'Next batch in': '/, 'the Russian board shows English words');
});

test('CK-930: a summary that failed to load is asked for again: eight hours of news are not lost', () => {
  const src = read('js/away.js');
  assert.match(src, /catch \{ try \{ localStore\.setItem\(SEEN_KEY, String\(last\)\);/);
});
