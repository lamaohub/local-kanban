import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOOK_REST_MAX_MS, LOOK_SLOW_MS, lookPause, timed } from '../public/js/look-pace.js';

const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');

test('a quick answer keeps the usual pause, a slow one rests twice its time, never past the most', () => {
  assert.equal(lookPause(1000, 120), 1000);
  assert.equal(lookPause(1000, LOOK_SLOW_MS - 1), 1000);
  assert.equal(lookPause(1000, 3000), 6000);
  assert.equal(lookPause(1000, 25_000), LOOK_REST_MAX_MS, 'a 25 s answer kept the page away for 50 s');
  assert.equal(lookPause(1000, 520), 1040);
  assert.equal(lookPause(0, 100), 0, 'a chat asks at once after a quick answer');
  assert.equal(lookPause(0, 2000), 4000);
  assert.equal(lookPause(1000, NaN), 1000);
});

test('the time is reported whatever the look ended with', async () => {
  let took = null;
  assert.equal(await timed(async () => 5, (ms) => { took = ms; }), 5);
  assert.ok(typeof took === 'number' && took >= 0);
  took = null;
  await assert.rejects(timed(async () => { throw new Error('refused'); }, (ms) => { took = ms; }));
  assert.ok(typeof took === 'number' && took >= 0, 'a failed look set no rest: the next came at once');
});

test('the terminal of a card, «Claude now» and the live chat rest after a slow answer', () => {
  assert.match(read('drawer.js'), /termSchedule\(lookPause\(TERM_POLL_MS, took\), chain\)/);
  assert.match(read('now-terms.js'), /schedule\(hurry \? 0 : lookPause\(POLL_MS, took\), n\)/);
  const chat = read('chat.js');
  assert.match(chat, /c\.restUntil = Date\.now\(\) \+ lookPause\(0, ms\)/);
  assert.match(chat, /if \(c\.session === session\) c\.refreshLive\(\);/, 'the stream of events asks the chat past its rest');
  // past the rest, 20 looks a minute with answers of 3 s; only opening the card asks at once
  assert.match(read('sse.js'), /ev\.type === 'task\.work'[^\n]*refreshWork\(state\.drawerKey, \{ live: true \}\)/, '`task.work` asks the card chat past its rest');
  assert.match(read('drawer.js'), /else if \(live\) cardChat\.refreshLive\(\); else cardChat\.refresh\(\);/);
});
