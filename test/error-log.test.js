import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, db, logError;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db, logError } = await import('../src/db.js'));
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const rows = () => db.prepare('SELECT source, scope, message, repeats FROM app_errors ORDER BY id DESC').all();
const clear = () => db.prepare('DELETE FROM app_errors').run();

test('a burst of the same error does not wash the log out', () => {
  clear();
  logError('server', 'GET /api/tasks', 'a real failure worth keeping');
  for (let i = 0; i < 320; i++) logError('server', 'POST /api/x', 'broken request');
  const all = rows();
  assert.equal(all.length, 2, `the burst wrote ${all.length} rows instead of one`);
  assert.ok(all.some((r) => r.message === 'a real failure worth keeping'), 'the real failure was washed out by the burst');
  const burst = all.find((r) => r.message === 'broken request');
  assert.equal(burst.repeats, 319, `the repeat counter says ${burst.repeats}, so the scale of the burst is hidden`);
});

test('different errors are still all recorded', () => {
  clear();
  logError('server', 'GET /a', 'first');
  logError('server', 'GET /b', 'second');
  logError('sync', 'GET /a', 'first');
  assert.equal(rows().length, 3);
});

test('the log never throws, and it does not fail silently either', () => {
  clear();
  const seen = [];
  const orig = console.error;
  console.error = (...a) => seen.push(a.join(' '));
  db.exec('ALTER TABLE app_errors RENAME TO app_errors_hidden');
  try {
    assert.doesNotThrow(() => logError('server', 'GET /x', 'while the table is gone'));
    assert.ok(seen.some((line) => /logError failed/.test(line)),
      'a broken error log stays silent: nothing in pm2 logs, and the Errors section answers with the same 500');
  } finally {
    console.error = orig;
    db.exec('ALTER TABLE app_errors_hidden RENAME TO app_errors');
  }
});

test('protocol-level 4xx are not written to the log', async () => {
  clear();
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify();
  const { errorHandler } = await import('../src/error-handler.js');
  app.setErrorHandler(errorHandler);
  await app.register(systemRoutes);
  app.get('/boom', () => { throw new Error('kaboom'); });
  await app.ready();

  const bad = await app.inject({
    method: 'POST', url: '/api/errors',
    headers: { 'content-type': 'application/json' },
    payload: '{ not json at all',
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(rows().length, 0, 'a malformed request body still eats a slot in the error log');

  const boom = await app.inject({ method: 'GET', url: '/boom' });
  assert.equal(boom.statusCode, 500);
  assert.equal(rows().length, 1, 'a real 500 no longer reaches the log');
  await app.close();
});

test('the same failure on different tasks is one entry, not one per task', async () => {
  clear();
  const { default: Fastify } = await import('fastify');
  const { errorHandler } = await import('../src/error-handler.js');
  const app = Fastify();
  app.setErrorHandler(errorHandler);
  app.patch('/api/tasks/:id', () => { throw new Error('Too few parameter values were provided'); });
  await app.ready();
  logError('server', 'GET /api/history', 'an older real failure');
  for (let id = 1; id <= 320; id++) {
    assert.equal((await app.inject({ method: 'PATCH', url: `/api/tasks/${id}?token=x`, payload: {} })).statusCode, 500);
  }
  const all = db.prepare('SELECT scope, message, detail, repeats FROM app_errors ORDER BY id').all();
  assert.equal(all.length, 2, `320 failures on 320 tasks wrote ${all.length} rows and washed the history out`);
  assert.equal(all[0].message, 'an older real failure');
  assert.equal(all[1].scope, 'PATCH /api/tasks/:id');
  assert.equal(all[1].repeats, 319, 'the scale of the burst is hidden');
  assert.match(all[1].detail, /^PATCH \/api\/tasks\/1\n/, 'which task failed first is no longer anywhere');
  assert.doesNotMatch(all[1].detail, /token=x/, 'the query string reached the log (CK-294)');
  await app.close();
});

test('after "Clear the log" the same error is written again at once, from the server and from the browser', async () => {
  clear();
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify();
  await app.register(systemRoutes);
  await app.ready();
  const fromBrowser = () => app.inject({ method: 'POST', url: '/api/errors', payload: { message: 'client boom', scope: 'probe' } });
  logError('server', 'GET /x', 'same failure');
  assert.equal((await fromBrowser()).json().skipped, undefined);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/errors' })).statusCode, 200);
  assert.equal(rows().length, 0);
  logError('server', 'GET /x', 'same failure');
  assert.equal(rows().length, 1, 'a repeat right after clearing went into a row that no longer exists');
  assert.equal((await fromBrowser()).json().skipped, undefined, 'a browser error right after clearing was skipped');
  assert.equal(rows().length, 2);
  await app.close();
});

test('a repeat whose row is gone (the ring pushed it out) is written anew, not lost', () => {
  clear();
  logError('server', 'GET /y', 'evicted');
  db.prepare("DELETE FROM app_errors WHERE message = 'evicted'").run();
  logError('server', 'GET /y', 'evicted');
  assert.equal(rows().filter((r) => r.message === 'evicted').length, 1);
});

test('a huge browser error is kept no longer than the log writes it', async () => {
  clear();
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
  await app.register(systemRoutes);
  await app.ready();
  const head = 'x'.repeat(500);
  const send = (tail) => app.inject({ method: 'POST', url: '/api/errors', payload: { message: head + tail } });
  const first = await send('a'.repeat(1024 * 1024));
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().skipped, undefined);
  assert.equal(rows()[0].message.length, 500, 'the log kept more than 500 characters of the message');
  // the key of the dedup window is the cut message: a different tail past 500 characters is the same error
  assert.equal((await send('b'.repeat(1024 * 1024))).json().skipped, true,
    'the dedup window keyed the whole message — a megabyte per key again');
  // and the kept key is a copy: a slice of a long string in V8 keeps the whole string alive, so cutting alone held
  // the same 200 MB. Different heads, so every one is a new key — of the message and of the scope.
  const { setFlagsFromString } = await import('node:v8');
  const { runInNewContext } = await import('node:vm');
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  gc(); const heapBefore = process.memoryUsage().heapUsed;
  for (let i = 0; i < 40; i++) {
    await app.inject({ method: 'POST', url: '/api/errors',
      payload: { message: `${i} `.padEnd(500 * 1000, 'm'), scope: `${i} `.padEnd(400 * 1000, 's') } });
  }
  gc(); const grew = (process.memoryUsage().heapUsed - heapBefore) / 1048576;
  assert.ok(grew < 12, `40 huge errors still hold ${grew.toFixed(0)} MB of the board's memory (about 36 MB when kept whole)`);
  await app.close();
});
