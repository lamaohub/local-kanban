
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, realpathSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, home, skillsDir, skills;

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-test-')));
  home = join(tmp, 'home');
  skillsDir = join(home, '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  process.env.HOME = home;
  process.env.KB_DATA_DIR = join(tmp, 'data');

  mkdirSync(join(skillsDir, 'kanban'), { recursive: true });
  writeFileSync(join(skillsDir, 'kanban', 'SKILL.md'), '# kanban skill\n');
  mkdirSync(join(skillsDir, 'not-a-skill'), { recursive: true });

  skills = await import('../src/skills.js');
  const { db } = await import('../src/db.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, deploy_skill) VALUES ('demo','DM','demo',1,'kanban')").run();

  const skillRoutes = (await import('../src/routes/skills.js')).default;
  app = Fastify();
  await app.register(skillRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const put = (name, payload) => app.inject({ method: 'PUT', url: `/api/skills/${name}`, payload });

test('a skill is found in the roots, a directory without SKILL.md is not one', () => {
  const names = skills.listSkills().map((s) => s.name);
  assert.deepEqual(names, ['kanban']);
});

test('traversal in the name resolves to nothing', () => {
  assert.equal(skills.resolveSkillPath('../../etc'), null);
  assert.equal(skills.resolveSkillPath('a/b'), null);
  assert.equal(skills.skillInfo('../../etc'), null);
});

test('a skill that is not installed is reported as missing, not as an error', () => {
  const info = skills.skillInfo('deploy');
  assert.equal(info.exists, false);
  assert.equal(info.path, join(skillsDir, 'deploy', 'SKILL.md'));
});

test('GET /api/skills lists the skills and who uses them', async () => {
  const body = (await app.inject({ method: 'GET', url: '/api/skills' })).json();
  assert.equal(body.board_skill, 'kanban');
  const kanban = body.items.find((s) => s.name === 'kanban');
  assert.equal(kanban.exists, true);
  assert.deepEqual(kanban.used_by, [{ slug: 'demo', name: 'demo' }]);
});

test('GET /api/skills/:name returns the text; a bad name is a 400', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/skills/kanban' });
  assert.equal(r.json().text, '# kanban skill\n');
  assert.equal((await app.inject({ method: 'GET', url: '/api/skills/a.b' })).statusCode, 400);
});

test('a write without the confirmed path is refused (409) and the file stays as it was', async () => {
  const r = await put('kanban', { text: 'REPLACED' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().real_path, join(skillsDir, 'kanban', 'SKILL.md'));
  assert.equal(readFileSync(join(skillsDir, 'kanban', 'SKILL.md'), 'utf8'), '# kanban skill\n');
});

test('a write with a stale path is refused too', async () => {
  const r = await put('kanban', { text: 'REPLACED', confirm_path: join(skillsDir, 'kanban', 'OTHER.md') });
  assert.equal(r.statusCode, 409);
  assert.equal(readFileSync(join(skillsDir, 'kanban', 'SKILL.md'), 'utf8'), '# kanban skill\n');
});

test('a confirmed write goes through and keeps a snapshot of the previous text', async () => {
  const path = join(skillsDir, 'kanban', 'SKILL.md');
  const r = await put('kanban', { text: '# new text\n', confirm_path: path });
  assert.equal(r.statusCode, 200);
  assert.equal(readFileSync(path, 'utf8'), '# new text\n');
  const backup = r.json().backup;
  assert.ok(backup, 'the response names the snapshot');
  assert.equal(readFileSync(backup, 'utf8'), '# kanban skill\n');
  assert.ok(readdirSync(skills.SKILL_BACKUP_DIR()).some((f) => f.startsWith('kanban-')));
});

test('a skill that is not installed yet is created by the write', async () => {
  const path = join(skillsDir, 'fresh-skill', 'SKILL.md');
  assert.equal(existsSync(path), false);
  const r = await put('fresh-skill', { text: '# fresh\n', confirm_path: path });
  assert.equal(r.statusCode, 200);
  assert.equal(readFileSync(path, 'utf8'), '# fresh\n');
});

test('traversal in the name is refused by the write as well', async () => {
  assert.equal((await put('..%2f..%2fevil', { text: 'x', confirm_path: '/tmp/evil' })).statusCode, 400);
});

test('for a symlinked skill the confirmed path is the real file behind the link', async () => {
  const personal = join(tmp, 'personal', 'kanban');
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, 'SKILL.md'), '# personal\n');
  symlinkSync(personal, join(skillsDir, 'linked'));

  const info = skills.skillInfo('linked');
  assert.equal(info.symlink, true);
  assert.equal(info.real_path, join(personal, 'SKILL.md'));

  assert.equal((await put('linked', { text: 'x', confirm_path: join(skillsDir, 'linked', 'SKILL.md') })).statusCode, 409);
  assert.equal((await put('linked', { text: '# edited\n', confirm_path: info.real_path })).statusCode, 200);
  assert.equal(readFileSync(join(personal, 'SKILL.md'), 'utf8'), '# edited\n');
});

test('a check board opened from a backup does not write skills at all', async () => {
  process.env.KB_PREVIEW_TTL_MS = '60000';
  const path = join(skillsDir, 'kanban', 'SKILL.md');
  const before = readFileSync(path, 'utf8');
  const r = await put('kanban', { text: 'FROM A BACKUP', confirm_path: path });
  delete process.env.KB_PREVIEW_TTL_MS;
  assert.equal(r.statusCode, 403);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('deleting a skill needs the confirmed path and keeps a snapshot', async () => {
  const path = join(skillsDir, 'fresh-skill', 'SKILL.md');
  writeFileSync(path, '# to be deleted\n');
  const del = (payload) => app.inject({ method: 'DELETE', url: '/api/skills/fresh-skill', payload });

  assert.equal((await del({})).statusCode, 409, 'no confirmed path — nothing is deleted');
  assert.equal(existsSync(path), true);

  const r = await del({ confirm_path: path });
  assert.equal(r.statusCode, 200);
  assert.equal(existsSync(path), false);
  assert.equal(existsSync(join(skillsDir, 'fresh-skill')), false, 'the empty directory goes too');
  assert.equal(readFileSync(r.json().backup, 'utf8'), '# to be deleted\n');
});

test('deleting a symlinked skill removes the link, never the file behind it', async () => {
  const personal = join(tmp, 'personal2', 'linked2');
  mkdirSync(personal, { recursive: true });
  writeFileSync(join(personal, 'SKILL.md'), '# personal, must survive\n');
  symlinkSync(personal, join(skillsDir, 'linked2'));

  const info = skills.skillInfo('linked2');
  const r = await app.inject({ method: 'DELETE', url: '/api/skills/linked2', payload: { confirm_path: info.real_path } });
  assert.equal(r.statusCode, 200);
  assert.equal(r.json().link_only, true, 'the answer says the link is what went');
  assert.equal(existsSync(join(skillsDir, 'linked2')), false, 'the link is gone from the skills directory');
  assert.equal(readFileSync(join(personal, 'SKILL.md'), 'utf8'), '# personal, must survive\n');
});

test('a check board opened from a backup does not delete skills either', async () => {
  process.env.KB_PREVIEW_TTL_MS = '60000';
  const r = await app.inject({ method: 'DELETE', url: '/api/skills/kanban', payload: { confirm_path: join(skillsDir, 'kanban', 'SKILL.md') } });
  delete process.env.KB_PREVIEW_TTL_MS;
  assert.equal(r.statusCode, 403);
  assert.equal(existsSync(join(skillsDir, 'kanban', 'SKILL.md')), true);
});

test('a skill written from the board is remembered as its own, and forgotten when deleted', async () => {
  const path = join(skillsDir, 'own-one', 'SKILL.md');
  await put('own-one', { text: '# mine\n', confirm_path: path });
  const listed = () => app.inject({ method: 'GET', url: '/api/skills' }).then((r) => r.json().own_skills);
  assert.ok((await listed()).includes('own-one'));
  await app.inject({ method: 'DELETE', url: '/api/skills/own-one', payload: { confirm_path: path } });
  assert.equal((await listed()).includes('own-one'), false);
});
