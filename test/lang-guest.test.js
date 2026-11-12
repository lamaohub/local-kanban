import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
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

const setLang = (lang, guest, start) => app.inject({ method: 'POST', url: '/api/lang', payload: start ? { lang, start: true } : { lang }, headers: guest ? { 'x-kb-guest': '1' } : {} });
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

// switched it to English. On start the language only fills a board that has none; a choice in Settings changes it.
test("a page's start does not switch a board that has a language", async () => {
  const { kvSet, db } = await import('../src/db.js');
  db.prepare("DELETE FROM kv WHERE key = 'ui.lang'").run();
  assert.equal((await setLang('en', false, true)).json().lang, 'en', 'a new board takes the language of its first page');
  kvSet('ui.lang', 'ru');
  const r = await setLang('en', false, true);
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().lang, 'ru');
  assert.equal(await lang(), 'ru', 'a page in English switched the board on its start');
  await setLang('en');
  assert.equal(await lang(), 'en', 'a choice in Settings no longer changes the language');
});

test('the page sends its language on start as a start, and Settings without it', () => {
  const read = (f) => readFileSync(new URL('../public/' + f, import.meta.url), 'utf8');
  assert.match(read('js/init.js'), /\nsyncLangToServer\(LANG, \{ start: true \}\);/);
  assert.doesNotMatch(read('js/init.js'), /\nsyncLangToServer\(\);/);
  assert.match(read('js/settings.js'), /smoothReload\(syncLangToServer\(v\)\)/);
});

// every page switches the board again) or one there by default (Settings and the wizard switch nothing) stayed green.
// The very function of settings.js runs here with a stand-in `api` and says what goes in the body.
test('the body the page sends: start only on start', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const fn = /export function syncLangToServer\([^]*?\n\}/.exec(src)?.[0];
  assert.ok(fn, 'syncLangToServer is not in settings.js');
  const sent = [];
  const ctx = { LANG: 'en', api: (method, url, body) => { sent.push([method, url, body]); return Promise.resolve(); } };
  vm.runInNewContext(`${fn.replace(/^export /, '')}\nthis.f = syncLangToServer;`, ctx);
  await ctx.f(undefined, { start: true });
  await ctx.f('ru');
  await ctx.f();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [ // objects of the vm's own realm
    ['POST', '/api/lang', { lang: 'en', start: true }],
    ['POST', '/api/lang', { lang: 'ru' }],
    ['POST', '/api/lang', { lang: 'en' }],
  ]);
});
