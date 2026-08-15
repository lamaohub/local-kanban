import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8');
const sse = read('sse.js');
const init = read('init.js');

const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('SSE events are queued, not overwritten by the last one', () => {
  const src = code(sse);
  assert.match(src, /sseQueue\.push\(/, 'sse.js no longer queues incoming events');
  assert.match(src, /for\s*\(const ev of batch\)/, 'sse.js no longer applies the whole batch');
  assert.match(src, /setTimeout\(flushSseQueue,/, 'the debounce timer no longer flushes the queue');
});

test('a flush in flight is not started twice', () => {
  const src = code(sse);
  assert.match(src, /if \(sseFlushing\) return;/, 'concurrent flushes are no longer guarded');
  assert.match(src, /while \(sseQueue\.length\)/, 'the flush no longer re-reads the queue, so late events are dropped');
});

test('stream liveness is checked on a timer, not only on tab events', () => {
  assert.match(code(sse), /export function ensureSSE\(/, 'ensureSSE is no longer exported');
  assert.match(code(init), /setInterval\(ensureSSE,/, 'init.js no longer polls the SSE liveness');
});

test('a stream that healed on its own still catches up', () => {
  const src = code(sse);
  assert.match(src, /export const SSE_STALE_MS = \d+/, 'the liveness threshold is no longer a named constant');
  const onmessage = src.slice(src.indexOf('es.onmessage'), src.indexOf('es.onerror'));
  assert.match(onmessage, /gap > SSE_STALE_MS/, 'onmessage no longer notices a gap in the stream');
  assert.match(onmessage, /refresh\(\)/, 'a gap in the stream no longer triggers a full refresh');
});
