// successful answer — the list of tasks became `{}`, the board emptied with no word and «state.tasks.some is not a
// function». Here the real api() of public/js/core.js (the module pulls the DOM in — its functions run on stand-ins),
// with a body that breaks in the middle, and the rule that has a cut list asked again by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { listFailure } from '../public/js/live-rules.js';

const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const fnOf = (head) => { const at = core.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return core.slice(at, core.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };
const constOf = (head) => { const at = core.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return core.slice(at, core.indexOf('\n};\n', at) + 3).replace(/^export /, ''); };

function page(answer) {
  const box = { reported: [], fetch: async () => answer(), Error, JSON, Object, String };
  vm.runInNewContext(`const reportError = (scope, msg) => this.reported.push(msg); let warned = null;
${fnOf('export function apiError(')}${fnOf('async function answerOf(')}${constOf('export const api = async')}
this.api = api;`, box);
  return box;
}
// a body that sends half of its JSON and then breaks, as a connection lost mid-answer
const cut = (status = 200) => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode('[{"id":1,"title":"a"},{"id":2,')); c.error(new TypeError('network error')); },
}), { status, headers: { 'content-type': 'application/json' } });

test('a successful answer cut off on its way is a failure of the connection, not an empty answer', async () => {
  const p = page(() => cut());
  await assert.rejects(p.api('GET', '/api/tasks'), (e) => e.offline === true && e.cut === true);
  assert.equal(p.reported.length, 1, 'the cut answer is not in «Settings → Errors»');
});

test('a successful answer that is not JSON is a failure too; an empty one and a good one are what they were', async () => {
  await assert.rejects(page(() => new Response('[{"id":1', { status: 200 })).api('GET', '/api/tasks'), (e) => e.cut === true);
  // (objects of the stand-in's realm: compared as text)
  assert.equal(JSON.stringify(await page(() => new Response('', { status: 200 })).api('POST', '/api/x')), '{}');
  assert.equal(JSON.stringify(await page(() => new Response('[{"id":1}]', { status: 200 })).api('GET', '/api/tasks')), '[{"id":1}]');
  assert.equal(await page(() => new Response(null, { status: 204 })).api('DELETE', '/api/x'), null);
});

test('a refusal keeps its status, whatever its body', async () => {
  await assert.rejects(page(() => new Response('<html>oops', { status: 500 })).api('GET', '/api/projects'), (e) => e.status === 500 && !e.offline);
  await assert.rejects(page(() => cut(502)).api('GET', '/api/projects'), (e) => e.status === 502);
});

test('a cut list is asked again by the board itself — the stream is alive, no reconnect will come', () => {
  const A = { slug: 'a', settings: false };
  const plan = listFailure({ error: Object.assign(new Error('cut'), { offline: true, cut: true }), latest: true, wanted: A, shown: A });
  assert.equal(plan.answered, true, 'a cut list waits for a reconnect that never comes');
  assert.equal(plan.notice, 'list');
  const down = listFailure({ error: Object.assign(new Error('x'), { offline: true }), latest: true, wanted: A, shown: A });
  assert.equal(down.answered, false);
});
