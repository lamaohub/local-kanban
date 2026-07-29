import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmp, kvSet, uiLang, NAME_TO_KEY, ghStatusName;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  delete process.env.KB_LANG;
  ({ kvSet, uiLang } = await import('../src/db.js'));
  ({ NAME_TO_KEY, ghStatusName } = await import('../src/sync/github.js'));
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test('board language: defaults to ru, switched through kv', () => {
  assert.equal(uiLang(), 'ru');
  kvSet('ui.lang', 'en');
  assert.equal(uiLang(), 'en');
  kvSet('ui.lang', 'ru');
  assert.equal(uiLang(), 'ru');
});

test('column names follow the board language', () => {
  kvSet('ui.lang', 'ru');
  assert.equal(ghStatusName('backlog'), 'Бэклог');
  assert.equal(ghStatusName('review'), 'Проверяю');
  kvSet('ui.lang', 'en');
  assert.equal(ghStatusName('backlog'), 'Backlog');
  assert.equal(ghStatusName('review'), 'Review');
  kvSet('ui.lang', 'ru');
});

test('the name map recognises BOTH locales and GitHub\'s own defaults', () => {
  assert.equal(NAME_TO_KEY['Бэклог'], 'backlog');
  assert.equal(NAME_TO_KEY['Отменено'], 'cancelled');
  assert.equal(NAME_TO_KEY['To do'], 'todo');
  assert.equal(NAME_TO_KEY['Deploying'], 'deploy');
  assert.equal(NAME_TO_KEY['Todo'], 'todo');
  assert.equal(NAME_TO_KEY['In Progress'], 'doing');
  assert.equal(NAME_TO_KEY['Done'], 'done');
  assert.equal(NAME_TO_KEY['Backlogged'], undefined);
});

test('all 8 statuses have a name in both locales', () => {
  const STATUSES = ['backlog', 'todo', 'prep', 'doing', 'deploy', 'review', 'done', 'cancelled'];
  for (const lang of ['ru', 'en']) {
    kvSet('ui.lang', lang);
    for (const s of STATUSES) {
      const name = ghStatusName(s);
      assert.ok(name && name !== s, `${s} has no name in ${lang}`);
      assert.equal(NAME_TO_KEY[name], s, `the name ${name} does not map back to ${s}`);
    }
  }
  kvSet('ui.lang', 'ru');
});
