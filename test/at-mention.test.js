import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { bin as fullPath } from '../src/bin-path.js';
import { DEFAULT_TEMPLATES, atQuery, fileMention, insertAt, matchTemplates } from '../public/js/at-rules.js';

let tmp, db, app, repo, F;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-at-'));
  process.env.KB_DATA_DIR = join(tmp, 'data');
  ({ db } = await import('../src/db.js'));
  F = await import('../src/project-files.js');
  repo = join(tmp, 'repo');
  mkdirSync(join(repo, 'src', 'routes'), { recursive: true });
  const git = (...a) => execFileSync(fullPath('git'), ['-C', repo, ...a], { stdio: 'ignore', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
  git('init', '-q');
  writeFileSync(join(repo, '.gitignore'), 'secret.env\n');
  writeFileSync(join(repo, 'src', 'server.js'), '');
  writeFileSync(join(repo, 'src', 'routes', 'tasks.js'), '');
  writeFileSync(join(repo, 'README.md'), '');
  git('add', '.');
  writeFileSync(join(repo, 'src', 'new file.js'), ''); // untracked, with a space
  writeFileSync(join(repo, 'secret.env'), 'KEY=1'); // ignored
  db.prepare("INSERT INTO projects (slug, prefix, name, path) VALUES ('at', 'AT', 'At', ?)").run(repo);
  db.prepare("INSERT INTO projects (slug, prefix, name, path) VALUES ('nogit', 'NG', 'No git', ?)").run(tmp);
  app = Fastify();
  await app.register((await import('../src/routes/mention.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

test('the «@word» the caret stands after: at the start or after a space, never inside an address', () => {
  assert.deepEqual(atQuery('@bu', 3), { start: 0, query: 'bu' });
  assert.deepEqual(atQuery('see @ser', 8), { start: 4, query: 'ser' });
  assert.deepEqual(atQuery('line\n@', 6), { start: 5, query: '' });
  assert.equal(atQuery('mail me@home', 12), null);
  assert.equal(atQuery('@bug done', 9), null, 'a space after the word ends it');
  assert.deepEqual(atQuery('(@x', 3), { start: 1, query: 'x' });
});

test('what goes in replaces «@word», the caret stands after it', () => {
  assert.deepEqual(insertAt('Fix it @bu now', 7, 10, 'Steps:\n'), { value: 'Fix it Steps:\n now', caret: 14 });
});

test('templates by the letters typed — the name starting with them first', () => {
  const list = [{ name: 'debug', text: 'a' }, { name: 'bug', text: 'b' }, { name: 'criteria', text: 'c' }];
  assert.deepEqual(matchTemplates(list, 'bu').map((t) => t.name), ['bug', 'debug']);
  assert.deepEqual(matchTemplates(list, '').map((t) => t.name), ['debug', 'bug', 'criteria']);
  assert.deepEqual(DEFAULT_TEMPLATES.map((t) => t.name), ['bug', 'criteria', 'question']);
  assert.match(DEFAULT_TEMPLATES[1].text, /- \[ \] /, 'the criteria are a checklist — Claude takes it as the brief');
});

test('a file named for Claude Code: @path, a path with a space in quotes', () => {
  assert.equal(fileMention('src/server.js'), '@src/server.js ');
  assert.equal(fileMention('src/new file.js'), '@"src/new file.js" ');
});

test('the templates: none of the person\'s own, then saved, refused when wrong, back to the defaults', async () => {
  assert.deepEqual((await app.inject('/api/templates')).json(), { templates: null });
  const mine = [{ name: 'bug', text: 'Steps:\n' }, { name: 'idea', text: 'Why:\n' }];
  assert.equal((await app.inject({ method: 'PUT', url: '/api/templates', payload: { templates: mine } })).statusCode, 200);
  assert.deepEqual((await app.inject('/api/templates')).json(), { templates: mine });
  for (const bad of [[{ name: 'two words', text: '' }], [{ name: 'a', text: 'x' }, { name: 'A', text: 'y' }], [{ name: '@x', text: '' }], [{ name: 'x', text: 'y'.repeat(4001) }], 'x']) {
    const r = await app.inject({ method: 'PUT', url: '/api/templates', payload: { templates: bad } });
    assert.equal(r.statusCode, 400, JSON.stringify(bad).slice(0, 80));
    assert.equal(r.json().field, 'templates');
  }
  assert.deepEqual((await app.inject('/api/templates')).json(), { templates: mine }, 'a refused save changed what is kept');
  await app.inject({ method: 'PUT', url: '/api/templates', payload: { templates: null } });
  assert.deepEqual((await app.inject('/api/templates')).json(), { templates: null });
});

test('the files of a project: tracked and new, not the ignored; ranked by the letters; nothing without git', async () => {
  F.forgetProjectFiles();
  const all = (await app.inject('/api/projects/at/files?limit=50')).json();
  assert.equal(all.git, true);
  assert.deepEqual([...all.files].sort(), ['.gitignore', 'README.md', 'src/new file.js', 'src/routes/tasks.js', 'src/server.js']);
  assert.ok(!all.files.includes('secret.env'), 'an ignored file was offered');
  assert.deepEqual((await app.inject('/api/projects/at/files?q=ser')).json().files, ['src/server.js']);
  assert.deepEqual((await app.inject('/api/projects/AT/files?q=src%20ta')).json().files, ['src/routes/tasks.js'], 'by prefix, every word');
  assert.deepEqual(F.rankFiles(['a/xserver.js', 'b/server.js', 'server/a.js'], 'server'), ['b/server.js', 'a/xserver.js', 'server/a.js'], 'the name starting with the word first');
  assert.equal((await app.inject('/api/projects/nogit/files')).json().git, false);
  assert.equal((await app.inject('/api/projects/none/files')).statusCode, 404);
  assert.equal((await app.inject('/api/projects/at/files?limit=0')).statusCode, 400);
});

test('a guest of the Wi-Fi gets neither the files nor the board\'s timings', async () => {
  const { ownerOnly } = await import('../src/share.js');
  assert.equal(ownerOnly('GET', '/api/projects/:slug/files'), true);
  assert.equal(ownerOnly('GET', '/api/templates'), false, 'the templates are the board\'s, as its tasks');
});
