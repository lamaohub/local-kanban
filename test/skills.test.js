
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
  process.env.KB_SKILLS_EXTRA = '';
  delete process.env.KB_CLAUDE_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;

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

// the answer carries the folder the section's skills live in and where it comes from, and the section shows those
test('GET /api/skills names the folder of the skills and the variable that gave it; the section shows them', async () => {
  const folder = async () => (await app.inject({ method: 'GET', url: '/api/skills' })).json().folder;
  assert.deepEqual(await folder(), { path: skillsDir, from: 'default' });
  const cfg = join(tmp, 'config-dir');
  const kbDir = join(tmp, 'kb-dir');
  let shown;
  try {
    process.env.CLAUDE_CONFIG_DIR = cfg;
    assert.deepEqual(await folder(), { path: join(cfg, 'skills'), from: 'CLAUDE_CONFIG_DIR' });
    process.env.KB_CLAUDE_DIR = kbDir;
    assert.deepEqual(await folder(), { path: join(kbDir, 'skills'), from: 'KB_CLAUDE_DIR' });
    shown = await sectionText((await app.inject({ method: 'GET', url: '/api/skills' })).json());
  } finally { delete process.env.CLAUDE_CONFIG_DIR; delete process.env.KB_CLAUDE_DIR; }
  assert.ok(shown.includes(join(kbDir, 'skills')), `the section does not name the folder the board uses:\n${shown}`);
  assert.match(shown, /Set by KB_CLAUDE_DIR/, 'the section does not say where the folder comes from');
  assert.doesNotMatch(shown, /~\/\.claude\/skills/, 'the section still names ~/.claude/skills');
  // the folders KB_SKILLS_EXTRA adds are read too, and the section names them after the Claude folder's own
  const listed = (await app.inject({ method: 'GET', url: '/api/skills' })).json();
  const withExtra = await sectionText({ ...listed, roots: [...listed.roots, '/home/user/team-skills'] });
  assert.match(withExtra, /Also read from KB_SKILLS_EXTRA: +\/home\/user\/team-skills/, 'the folders of KB_SKILLS_EXTRA are not named');
  // and each of those words has its Russian line: a Russian board does not show them in English
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const has = (t) => dict.includes(`'${t}':`) || dict.includes(`"${t}":`) || dict.includes(`\n  ${t}:`);
  for (const t of [...sectionWords].filter((w) => /^(Skills are|Also read|Set by|Claude Code's own)/.test(w))) assert.ok(has(t), `stays English on the Russian board: ${t}`);
});

const sectionWords = new Set(); // every text the section passes through tr()
/** The text Settings → Skills draws for an answer of GET /api/skills: the real renderSkillsSection on stubs. */
async function sectionText(info) {
  const { default: vm } = await import('node:vm');
  const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const at = src.indexOf('async function renderSkillsSection(');
  assert.ok(at > 0, 'renderSkillsSection was not found in public/js/settings.js');
  const rules = await import('../public/js/claude-setup-rules.js');
  const els = {};
  const el = () => ({ innerHTML: '', textContent: '', title: '', disabled: false, onclick: null, isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} }, querySelectorAll: () => [] });
  const body = el();
  const box = {
    tr: (t) => (sectionWords.add(t), t), esc: (t) => String(t), api: async () => info, $: (id) => (els[id] ||= el()), folderFrom: rules.folderFrom,
    plural: (n, a, b) => (n === 1 ? a : b), fmtLocalStamp: (t) => t, selectSkillRow: async () => {},
  };
  vm.runInNewContext(`let skillsInfo = null, pendingSkill = null, skillSel = null;\n${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.render = renderSkillsSection;`, box);
  await box.render(body);
  return [body.innerHTML, ...Object.values(els).map((e) => `${e.innerHTML} ${e.textContent}`)].join('\n').replace(/<[^>]+>/g, ' ');
}

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

test('deleting a skill keeps whatever else lives in its folder', async () => {
  const dir = join(skillsDir, 'with-extras');
  mkdirSync(join(dir, 'references'), { recursive: true });
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), '# with extras\n');
  writeFileSync(join(dir, 'references', 'runbook.md'), 'servers\n');
  writeFileSync(join(dir, 'scripts', 'go.sh'), 'echo go\n');
  const r = await app.inject({ method: 'DELETE', url: '/api/skills/with-extras', payload: { confirm_path: join(dir, 'SKILL.md') } });
  assert.equal(r.statusCode, 200);
  assert.equal(existsSync(join(dir, 'SKILL.md')), false);
  assert.equal(readFileSync(join(dir, 'references', 'runbook.md'), 'utf8'), 'servers\n', 'references/ went with the skill, and nothing kept a copy');
  assert.equal(readFileSync(join(dir, 'scripts', 'go.sh'), 'utf8'), 'echo go\n');
  assert.equal(readFileSync(r.json().backup, 'utf8'), '# with extras\n');
});

test('the skills folder is the one in the Claude folder: CLAUDE_CONFIG_DIR moves it, KB_CLAUDE_DIR wins', () => {
  const cfg = join(tmp, 'claude-config');
  mkdirSync(join(cfg, 'skills', 'cfg-only'), { recursive: true });
  writeFileSync(join(cfg, 'skills', 'cfg-only', 'SKILL.md'), '# lives in CLAUDE_CONFIG_DIR\n');
  try {
    process.env.CLAUDE_CONFIG_DIR = cfg;
    assert.equal(skills.skillRoots()[0], join(cfg, 'skills'));
    assert.deepEqual(skills.listSkills().map((x) => x.name), ['cfg-only'], 'the board still reads ~/.claude/skills');
    assert.equal(skills.skillInfo('cfg-only').path, join(cfg, 'skills', 'cfg-only', 'SKILL.md'));
    process.env.KB_CLAUDE_DIR = join(tmp, 'kb-claude');
    assert.equal(skills.skillRoots()[0], join(tmp, 'kb-claude', 'skills'));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.KB_CLAUDE_DIR;
  }
  assert.equal(skills.skillRoots()[0], skillsDir, 'without either variable it is ~/.claude/skills, as before');
});
