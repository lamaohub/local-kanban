import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AWAY_MS, awayDue, hasNews } from '../public/js/away-rules.js';

test('due after eight hours of silence, and not on a first visit', () => {
  assert.equal(AWAY_MS, 8 * 3600_000);
  const now = 1e12;
  assert.equal(awayDue(now - AWAY_MS, now), true);
  assert.equal(awayDue(now - AWAY_MS + 1, now), false);
  assert.equal(awayDue(0, now), false, 'a first visit has nothing to tell');
  assert.equal(awayDue(Number('x'), now), false, 'a broken note in the browser');
});

test('a summary with nothing in it opens no window', () => {
  const none = { n: 0, tasks: [] };
  assert.equal(hasNews({ handed: none, accepted: none, returned: none, stuck: none }), false);
  assert.equal(hasNews({ handed: none, accepted: none, returned: none, stuck: { n: 1, tasks: [] } }), true);
  assert.equal(hasNews(null), false);
});
