import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  const horizonRoutes = (await import('../src/routes/horizons.js')).default;
  app = Fastify();
  await app.register(horizonRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const post = (payload) => app.inject({ method: 'POST', url: '/api/horizons', payload });
const list = (q = '') => app.inject({ method: 'GET', url: `/api/horizons${q}` });

test('a goal is created and found by its scale', async () => {
  const r = await post({ scale: 'months', period: '2026-07', text: 'ship the release' });
  assert.equal(r.statusCode, 201);
  assert.equal(r.json().text, 'ship the release');

  const byScale = (await list('?scale=months')).json();
  assert.equal(byScale.length, 1);
  assert.equal((await list('?scale=days')).json().length, 0, 'another scale is not returned');
});

test('scale and period are validated (otherwise the Horizon view fills with junk)', async () => {
  assert.equal((await post({ scale: 'decades', period: '2026' })).statusCode, 400);
  assert.equal((await post({ scale: 'years' })).statusCode, 400, 'the period is required');
});

test('a new goal goes to the end of its period', async () => {
  await post({ scale: 'weeks', period: '2026-W30', text: 'first' });
  const second = (await post({ scale: 'weeks', period: '2026-W30', text: 'second' })).json();
  const rows = (await list('?scale=weeks')).json();
  assert.deepEqual(rows.map((g) => g.text), ['first', 'second'], 'ordered by position');
  assert.equal(rows.at(-1).id, second.id);
});

test('editing and deleting', async () => {
  const g = (await post({ scale: 'years', period: '2026', text: 'draft' })).json();
  const patched = await app.inject({ method: 'PATCH', url: `/api/horizons/${g.id}`, payload: { text: 'done', done: 1 } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().text, 'done');
  assert.equal(patched.json().done, true);

  assert.equal((await app.inject({ method: 'DELETE', url: `/api/horizons/${g.id}` })).statusCode, 204);
  assert.equal((await list('?scale=years')).json().length, 0);
});

test('a missing goal is a 404, not a silent success', async () => {
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/horizons/999999', payload: { text: 'x' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/horizons/999999' })).statusCode, 404);
});
