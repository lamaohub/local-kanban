// as it opens: the chat scrolls along until its last step is over the field (the card's field stands over the card's
// bottom), a fold taller than the view stops with its head at the top, a fold in view moves nothing — and the move gives
// the end of the chat back when it stops. The real reveal() of public/js/chat.js on a stand-in with a layout: the
// source-text checks of chat.test.js did not see the field left out, the head missed, or the hold kept for good.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');
const fn = /\n {2}function reveal\(head, body, opening\) \{[\s\S]*?\n {2}\}\n/.exec(src)?.[0];

// a scroller FRAME_TOP from the window's top, CLIENT high; an element at `y` of the chat's content, `h` high
function stage({ dock = 0, inCard = true, top = 400, client = 800 } = {}) {
  const FRAME_TOP = 50;
  const frames = [];
  let now = 0;
  const sc = {
    scrollTop: top, clientHeight: client, scrollHeight: 5000,
    getBoundingClientRect: () => ({ top: FRAME_TOP }),
    contains: () => inCard,
  };
  const at = (y, h) => ({ scrollHeight: h, getBoundingClientRect: () => ({ top: FRAME_TOP + y - sc.scrollTop }) });
  const dockEl = { getBoundingClientRect: () => ({ height: dock }) };
  const c = { holds: 0, atEnd: false };
  const ctx = {
    sc, c, box: { querySelector: () => dockEl }, END_GAP: 60, UNFOLD_MS: 180,
    gapToEnd: () => sc.scrollHeight - sc.scrollTop - sc.clientHeight,
    performance: { now: () => now },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
  };
  vm.runInNewContext(`${fn}\nthis.reveal = reveal;`, ctx);
  const run = () => { // the frames of the move, 16 ms apart; the scroll at each
    const seen = [];
    while (frames.length) { now += 16; frames.shift()(now); seen.push(sc.scrollTop); }
    return seen;
  };
  // the fold's head at y, its steps right under it
  const fold = (y, h) => [at(y, 26), at(y + 26, h)];
  return { ctx, sc, c, run, fold, FRAME_TOP };
}

test('reveal() is in the chat', () => assert.ok(fn, 'reveal() of chat.js is not where it was'));

test('a fold opened under the card\'s field comes up until its last step is over the field', () => {
  const { ctx, sc, fold } = stage({ dock: 100 }); // the view over the field: 800 - 100
  const [head, body] = fold(1000, 120); // its steps end at 1146 — 746 in the view, under the field
  ctx.reveal(head, body, false);
  assert.equal(sc.scrollTop, 1146 + 8 - 700, 'the last step stays under the card\'s field');
});

test('a fold taller than the view stops with its head at the top; a column has no field over its list', () => {
  const { ctx, sc, fold, FRAME_TOP } = stage({ inCard: false });
  const [head, body] = fold(1000, 2000);
  ctx.reveal(head, body, false);
  assert.equal(head.getBoundingClientRect().top - FRAME_TOP, 8, 'a long fold scrolled past its head');
});

test('a fold in view moves nothing', () => {
  const { ctx, sc, c, fold } = stage({ dock: 100 });
  const [head, body] = fold(500, 100);
  ctx.reveal(head, body, true);
  assert.equal(sc.scrollTop, 400);
  assert.equal(c.holds, 0, 'a fold in view holds the chat');
});

test('opening, the chat scrolls along smoothly and gives the end back when it stops', () => {
  const { ctx, sc, c, run, fold } = stage({ dock: 100 });
  const [head, body] = fold(1000, 120);
  ctx.reveal(head, body, true);
  assert.equal(c.holds, 1, 'the end pins the chat while it scrolls along');
  const seen = run();
  assert.ok(seen.filter((y) => y > 400 && y < 454).length >= 3, `the chat jumped: ${seen}`);
  assert.ok(seen.every((y, i) => !i || y >= seen[i - 1]), `the chat went back and forth: ${seen}`);
  assert.equal(sc.scrollTop, 454);
  assert.equal(c.holds, 0, 'the chat stays held after the move — the end never pins it again');
});
