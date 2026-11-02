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
  vm.runInNewContext(`const reportError = (scope, msg) => this.reported.push(msg); let warned = null; const doorClosed = () => false;
${fnOf('export function apiError(')}${fnOf('async function answerOf(')}${constOf('export const api = async')}
this.api = api;`, box);
  return box;
}
// the real door of the page: core.js's refusal of the door and init.js's own word on what is typed
function guestPage(typing, answer) {
  const init = readFileSync(new URL('../public/js/init.js', import.meta.url), 'utf8');
  const wired = init.match(/^setDoorClosed\(.*\);$/m);
  assert.ok(wired, 'nobody tells the door about what is typed');
  const at = core.indexOf('let onDoorClosed');
  assert.ok(at >= 0, 'onDoorClosed is gone');
  // the end is found by code: comments are cut out of the published slice
  const end = core.indexOf('\n', core.indexOf('const doorClosed =', at));
  assert.ok(end > at, 'doorClosed is gone');
  const door = core.slice(at, end).replace(/^export /gm, '');
  const box = { reloads: 0, location: { reload() { box.reloads += 1; } }, hasUnsavedInput: () => typing, fetch: async () => answer(), Error, JSON, Object, String };
  vm.runInNewContext(`const reportError = () => {}; let warned = null;
${door}${fnOf('export function apiError(')}${fnOf('async function answerOf(')}${constOf('export const api = async')}
${wired[0]}
this.api = api;`, box);
  return box;
}
const doorSays = () => new Response(JSON.stringify({ error: 'the key of the board is needed', reason: 'share' }), { status: 401 });

test('the door closed under a page: it goes to the form by itself, but never over words typed and not sent', async () => {
  const idle = guestPage(false, doorSays);
  const left = await Promise.race([idle.api('PATCH', '/api/tasks/1').then(() => 'answered', () => 'refused'), new Promise((r) => { setTimeout(r, 50, 'waits for the reload'); })]);
  assert.equal(left, 'waits for the reload');
  assert.equal(idle.reloads, 1, 'a page with nothing typed stays at a refusal instead of asking for the key');
  const typing = guestPage(true, doorSays);
  await assert.rejects(typing.api('PATCH', '/api/tasks/1'), (e) => e.status === 401 && e.body.reason === 'share');
  assert.equal(typing.reloads, 0, 'the reload took the words typed');
  const owner = guestPage(false, () => new Response(JSON.stringify({ error: 'no' }), { status: 401 }));
  await assert.rejects(owner.api('PATCH', '/api/tasks/1'), (e) => e.status === 401);
  assert.equal(owner.reloads, 0, 'a refusal that is not the door reloaded the page');
});

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
