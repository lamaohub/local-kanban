import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FIRST_LOAD_RETRY_MS, loadUntilDone } from '../public/js/live-rules.js';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8');
const sse = read('sse.js');
const init = read('init.js');

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('SSE events go into the queue and the flush applies everything it takes, batch by batch', () => {
  const src = code(sse);
  assert.match(src, /const sseQueue = eventQueue\(\)/, 'sse.js no longer keeps its events in the queue of live-rules.js');
  assert.match(src, /sseQueue\.push\(ev\)/, 'sse.js no longer queues incoming events');
  assert.match(src, /const batch = sseQueue\.take\(\);\s*await applyBatch\(batch\)/, 'the flush no longer applies the whole batch it took');
  assert.match(src, /applyEvents\(state\.tasks, batch,/, 'a batch is no longer applied by the tested rule');
  assert.match(src, /setTimeout\(flushSseQueue,/, 'the debounce timer no longer flushes the queue');
});

test('a flush in flight is not started twice', () => {
  const src = code(sse);
  assert.match(src, /if \(sseFlushing \|\| !boardLoaded\) return;/, 'concurrent flushes are no longer guarded');
  assert.match(src, /while \(sseQueue\.size\)/, 'the flush no longer re-reads the queue, so late events are dropped');
});

test('stream liveness is checked on a timer, by the tested rule', () => {
  const src = code(sse);
  const ensure = src.slice(src.indexOf('export function ensureSSE('), src.indexOf('document.addEventListener(\'visibilitychange\', ensureSSE)'));
  assert.match(ensure, /link\.ensure\(/, 'ensureSSE no longer asks the link whether the stream went silent');
  const link = code(read('live-link.js'));
  assert.match(link, /streamDead\(es, lastAt, now\(\)\)/, 'the link no longer asks whether the stream went silent');
  assert.match(code(init), /setInterval\(ensureSSE,/, 'init.js no longer polls the SSE liveness');
});

test('a stream that healed on its own still catches up', () => {
  const src = code(sse);
  const onmessage = src.slice(src.indexOf('function streamMessage('), src.indexOf('const LINK_SAY_MS'));
  assert.match(onmessage, /silentTooLong\(lastSseAt, Date\.now\(\)\)/, 'onmessage no longer notices a gap in the stream');
  assert.match(onmessage, /refresh\(\)/, 'a gap in the stream no longer triggers a full refresh');
});

test('the first load of the board waits for the stream, and only a reconnect refreshes from onopen', () => {
  const src = code(sse);
  const onopen = src.slice(src.indexOf('function linkOpened('), src.indexOf('function streamMessage('));
  assert.match(onopen, /streamOpen\(\);/, 'the start of the board no longer learns that the stream is open');
  assert.match(onopen, /if \(boardLoadStarted\) refresh\(\)(;|\.catch\()/, 'onopen refreshes the board on the very first connection again');
  assert.match(code(init), /Promise\.all\(\[loadLabelPalette\(\)\.catch\(\(\) => \{\}\), streamOrLate\]\)\.then\(\(\) => loadUntilDone\(refresh\)\)/,
    'the first load no longer waits for the stream to open, or no longer retries when it fails');
});

test('a batch still refreshes the project counters, task.live re-reads only the dashboard and the Claude sections, the minute timer skips a hidden board', () => {
  const src = code(sse);
  const batch = src.slice(src.indexOf('async function applyBatch('), src.indexOf('export function connectSSE('));
  assert.match(batch, /if \(plan\.counters\) await refreshProjectCounters\(\);/, 'a batch no longer refreshes the project counters in the sidebar');
  const live = src.slice(src.indexOf("if (ev.type === 'task.live')"), src.indexOf('\n', src.indexOf("if (ev.type === 'task.live')")));
  assert.match(live, /if \(state\.slug === DASH \|\| state\.slug === NOW \|\| state\.slug === REVIEW\) loadTasks\(\)/,
    'task.live on the dashboard, on "Claude now" or on "Claude review" reads the whole board again, not that section alone');
  assert.match(code(init), /setInterval\(\(\) => \{ if \(!document\.hidden && !\$\('board'\)\.classList\.contains\('hidden'\)\) renderBoard\(\); \}, 60000\)/,
    'the minute timer redraws the board while it is hidden behind the dashboard');
});

test('a first load that failed is tried again until it succeeds, and the start does not wait for it', async () => {
  let now = 0;
  const due = new Map();
  let next = 1;
  const timers = {
    setTimeout(fn, ms) { const id = next++; due.set(id, { at: now + ms, fn }); return id; },
    advance(ms) { now += ms; for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { due.delete(id); t.fn(); } },
  };
  const flush = () => new Promise((r) => setImmediate(r));
  let calls = 0;
  const load = () => { calls++; return calls < 3 ? Promise.reject(new Error('HTTP 500')) : Promise.resolve('loaded'); };
  await assert.rejects(loadUntilDone(load, { timers }), /HTTP 500/, 'the start must go on after a failed first attempt, as before');
  assert.equal(calls, 1);
  await flush();
  timers.advance(FIRST_LOAD_RETRY_MS); await flush();
  assert.equal(calls, 2, 'a failed first load is not tried again');
  timers.advance(FIRST_LOAD_RETRY_MS); await flush();
  assert.equal(calls, 3);
  timers.advance(FIRST_LOAD_RETRY_MS * 5); await flush();
  assert.equal(calls, 3, 'the load goes on after it succeeded');
  let ok = 0;
  assert.equal(await loadUntilDone(() => { ok++; return Promise.resolve('loaded'); }, { timers }), 'loaded');
  timers.advance(FIRST_LOAD_RETRY_MS * 5); await flush();
  assert.equal(ok, 1, 'a load that succeeded at once is repeated');
});
