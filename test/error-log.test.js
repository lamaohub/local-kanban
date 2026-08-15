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
