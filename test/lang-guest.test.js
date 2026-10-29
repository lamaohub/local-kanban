import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, app;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  delete process.env.KB_LANG;
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  app = Fastify();
  await app.register(systemRoutes);
  await app.ready();
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const setLang = (lang, guest) => app.inject({ method: 'POST', url: '/api/lang', payload: { lang }, headers: guest ? { 'x-kb-guest': '1' } : {} });
const lang = async () => (await app.inject({ method: 'GET', url: '/api/lang' })).json().lang;

test("a guest's page does not switch the language of the board", async () => {
  assert.equal((await setLang('ru')).json().lang, 'ru');
  const r = await setLang('en', true);
  assert.equal(r.statusCode, 200, 'a guest page sends its language on every start — a refusal would fill the error log');
  assert.equal(r.json().lang, 'ru');
  assert.equal(await lang(), 'ru', "a guest's English phone switched the owner's board to English");
});

test('the owner still switches it', async () => {
  await setLang('en');
  assert.equal(await lang(), 'en');
  await setLang('ru');
  assert.equal(await lang(), 'ru');
});
