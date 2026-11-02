// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { brotliCompressSync } from 'node:zlib';
import { applyDelta, screenDelta, wholeAnswer } from '../public/js/term-delta.js';

const lines = (n, from = 0) => Array.from({ length: n }, (_, i) => `line ${from + i} of the conversation, with a few more words on it`);
const both = (was, now) => { const d = screenDelta(was, now, 'v1'); assert.ok(d, 'no delta'); assert.equal(applyDelta(was, d), now); return d; };

test('a line changed near the end is that line and nothing else', () => {
  const a = lines(1000);
  const b = [...a]; b[997] = 'status: thinking for 12 s';
  const d = both(a.join('\n'), b.join('\n'));
  assert.deepEqual(d.add, ['status: thinking for 12 s']);
  assert.equal(d.keep, 997);
  assert.equal(d.tail, 2);
});

test('lines added at the end, a screen cut shorter, nothing changed', () => {
  const a = lines(500);
  assert.deepEqual(both(a.join('\n'), [...a, 'new one', 'and another'].join('\n')).add, ['new one', 'and another']);
  assert.deepEqual(both(a.join('\n'), a.slice(0, 480).join('\n')).add, []);
  assert.deepEqual(both(a.join('\n'), a.join('\n')).add, []);
});

test('the full window rolled: the same lines stand higher, and they do not come again', () => {
  const a = lines(1000);
  const b = lines(1000, 3);
  const d = both(a.join('\n'), b.join('\n'));
  assert.equal(d.drop, 3);
  assert.equal(d.add.length, 3);
});

test('a roll with repeated blank lines takes the longest run', () => {
  const a = [...Array(30).fill(''), ...lines(200)];
  const b = [...a.slice(7), 'x', 'y', 'z', 'q', 'r', 's', 't'];
  const d = both(a.join('\n'), b.join('\n'));
  assert.equal(d.drop, 7);
});

test('another screen goes whole: a delta would be no smaller', () => {
  assert.equal(screenDelta(lines(100).join('\n'), lines(100, 5000).join('\n'), 'v1'), null);
  assert.equal(screenDelta(undefined, 'x', 'v1'), null);
});

test('a delta on the wrong screen is refused, not drawn', () => {
  const was = lines(50).join('\n');
  const d = screenDelta(was, `${was}\nmore`, 'v1');
  assert.equal(applyDelta(`${was}!`, d), null);
  assert.equal(applyDelta(undefined, d), null);
  assert.equal(wholeAnswer({ delta: d, v: 'v2' }, { screen: `${was}!` }, 'v1'), null);
  assert.equal(wholeAnswer({ delta: d, v: 'v2' }, { screen: was }, 'v0'), null, 'against another mark');
});

test('an answer comes whole out of it, the wraps following the base unless new ones came', () => {
  const was = lines(50).join('\n');
  const d = screenDelta(was, `${was}\nmore`, 'v1');
  const r = wholeAnswer({ delta: d, v: 'v2', session: 's' }, { screen: was, wraps: [3] }, 'v1');
  assert.deepEqual(r, { v: 'v2', session: 's', screen: `${was}\nmore`, wraps: [3] });
  assert.deepEqual(wholeAnswer({ delta: d, v: 'v2', wraps: [4] }, { screen: was, wraps: [3] }, 'v1').wraps, [4]);
  const plain = { screen: 'x', v: 'v9' };
  assert.equal(wholeAnswer(plain, null, null), plain, 'a whole answer stands as it is');
});

test('what travels: a changed status line of a long screen is a small part of it, compressed as the board sends it', () => {
  let seed = 1;
  const word = () => { seed = (seed * 48271) % 2147483647; return seed.toString(36); };
  const a = Array.from({ length: 1000 }, () => `${word()} ${word()} ${word()} ${word()}`);
  const b = [...a]; b[997] = 'status: thinking for 12 s';
  const whole = brotliCompressSync(JSON.stringify({ screen: b.join('\n') })).length;
  const delta = brotliCompressSync(JSON.stringify({ delta: screenDelta(a.join('\n'), b.join('\n'), 'v1') })).length;
  assert.ok(delta * 20 < whole, `${delta} bytes against ${whole}`);
});
