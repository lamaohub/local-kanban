// a minute at a time; a slow minute goes to the error log (at most once in LOG_EVERY_MS), «Health» shows the last minute,
// the worst of the hour and the slowest routes. The real hook on real routes, a fake histogram and clock.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let W;
before(async () => {
  process.env.KB_DATA_DIR = mkdtempSync(join(tmpdir(), 'kb-slow-'));
  W = await import('../src/slow-watch.js');
});

const fakeLoop = () => {
  let p95 = 0;
  return { set: (v) => { p95 = v; }, get count() { return 100; }, percentile: (q) => (q >= 95 ? p95 : p95 / 4) * 1e6, get max() { return p95 * 2e6; }, reset() {} };
};

test('answers are timed by route template, the event stream is not, and a slow minute is logged once in a while', async () => {
  let clock = 1_000_000;
  const logged = [];
  const loop = fakeLoop();
  const watch = W.createSlowWatch({ now: () => clock, log: (...a) => logged.push(a), histogram: loop });
  const app = Fastify();
  app.addHook('onResponse', watch.onResponse);
  let wait = 0;
  app.get('/api/tasks/:id/terminal', async () => { await new Promise((r) => { setTimeout(r, wait); }); return { ok: 1 }; });
  // as routes/events.js does it: the headers by raw.writeHead, the reply itself never learns the type (review)
  app.get('/api/events', (req, reply) => { reply.hijack(); reply.raw.writeHead(200, { 'Content-Type': 'text/event-stream' }); reply.raw.end('data: x\n\n'); });
  app.get('/api/asks/:id/wait', async () => { await new Promise((r) => { setTimeout(r, 30); }); return { wait: true }; });
  await app.ready();
  await app.inject('/api/tasks/CK-1/terminal');
  await app.inject('/api/tasks/CK-2/terminal');
  await app.inject('/api/events');
  await app.inject('/api/asks/7/wait');
  // a stream that stayed open an hour is not a slow answer, whatever onResponse is told
  watch.onResponse({ method: 'GET', routeOptions: { url: '/api/events' } }, { elapsedTime: 3_600_000, getHeader: () => undefined });
  clock += W.WINDOW_MS;
  let win = watch.tick();
  assert.deepEqual(win.routes.map((r) => [r.route, r.n]), [['GET /api/tasks/:id/terminal', 2]], 'by template, the stream and the long poll left out');
  assert.equal(logged.length, 0, 'a quiet minute was logged');
  // a busy minute: the loop waited, a route answered slowly
  loop.set(W.LOOP_P95_MS + 50);
  wait = 30;
  await app.inject('/api/tasks/CK-3/terminal');
  clock += W.WINDOW_MS;
  win = watch.tick();
  assert.equal(logged.length, 1);
  assert.match(logged[0][2], /event loop waited 350 ms at p95/);
  assert.equal(logged[0][1], 'slow');
  // the next slow minute within LOG_EVERY_MS — not another record
  clock += W.WINDOW_MS;
  watch.tick();
  assert.equal(logged.length, 1, 'every slow minute was its own record');
  clock += W.LOG_EVERY_MS;
  watch.tick();
  assert.equal(logged.length, 2);
  const v = watch.view();
  assert.equal(v.slow, true);
  assert.equal(v.worst.loop.p95, W.LOOP_P95_MS + 50);
  assert.equal(v.slowest[0].route, 'GET /api/tasks/:id/terminal');
  assert.ok(v.slowest[0].max >= 25, `the slowest answer: ${v.slowest[0].max} ms`);
  await app.close();
});

test('an answer slower than ROUTE_SLOW_MS is named in the log; only an hour of minutes is kept', () => {
  let clock = 0;
  const logged = [];
  const watch = W.createSlowWatch({ now: () => clock, log: (...a) => logged.push(a), histogram: fakeLoop() });
  watch.onResponse({ method: 'GET', routeOptions: { url: '/api/now' } }, { elapsedTime: W.ROUTE_SLOW_MS + 1, getHeader: () => 'application/json' });
  clock += W.WINDOW_MS;
  watch.tick();
  assert.match(logged[0][2], /GET \/api\/now 2001 ms/);
  for (let i = 0; i < W.WINDOWS_KEPT + 5; i++) { clock += W.WINDOW_MS; watch.tick(); }
  assert.equal(watch.view().minutes, W.WINDOWS_KEPT);
  assert.equal(watch.view().slow, false, 'the last minute was quiet');
});

test('GET /api/health/load answers with what the watch of the process has seen', async () => {
  const app = Fastify();
  await app.register((await import('../src/routes/health.js')).default);
  const r = await app.inject('/api/health/load');
  assert.equal(r.statusCode, 200);
  const v = r.json();
  assert.equal(v.limits.loop_p95_ms, W.LOOP_P95_MS);
  assert.ok('last' in v && 'slowest' in v);
  await app.close();
});

test('the line of «Health» says the figures in words, the accent only for a slow minute, all of it in the dictionary', async () => {
  const { loadWords } = await import('../public/js/health-rules.js');
  const core = (await import('node:fs')).readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const said = [];
  const tr = (s) => { said.push(s); return s; };
  const fmtNum = (n, d) => Number(n).toFixed(d);
  assert.equal(loadWords(null, { tr, fmtNum }), null);
  assert.match(loadWords({ last: { loop: null } }, { tr, fmtNum }).text, /first figures in a minute/);
  const calm = loadWords({ minutes: 3, slow: false, last: { loop: { p95: 21 } }, worst: { loop: { p95: 80 } }, slowest: [{ route: 'GET /api/now', max: 300 }] }, { tr, fmtNum });
  assert.equal(calm.slow, false);
  assert.equal(calm.text, 'The board kept its work waiting up to 21 ms in the last minute; the worst minute of the hour — 80 ms.');
  assert.equal(calm.routes, '', 'an answer under a second is not named');
  const slow = loadWords({ minutes: 3, slow: true, last: { loop: { p95: 700 } }, worst: { loop: { p95: 900 } }, slowest: [{ route: 'GET /api/now', max: 4200 }] }, { tr, fmtNum });
  assert.equal(slow.slow, true);
  assert.match(slow.text, /error log/);
  assert.equal(slow.routes, 'Slowest answers this hour: GET /api/now 4.2 s');
  for (const s of new Set(said)) assert.ok(core.includes(`'${s}':`), `no Russian for «${s}»`);
});
