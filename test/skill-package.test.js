// was updated: the board moved on, Claude kept the rules of the version it was installed with, and Settings → Claude
// Code showed the skill as fine (it only looked whether the file was there). Now the copy is compared with what the
// package ships, a button in Settings → Skills takes the board's version, and the board's own update brings along the
// copies nobody changed. HOME and the data folder are the test's own: the real ~/.claude/skills takes no part.
// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const PKG = (name) => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url));
let tmp, skillsDir, skills, system, app;

before(async () => {
  // realpath: on macOS /var is a link to /private/var, and the page's lock is the resolved path
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-pkg-skill-')));
  skillsDir = join(tmp, 'home', '.claude', 'skills');
  mkdirSync(skillsDir, { recursive: true });
  process.env.HOME = join(tmp, 'home');
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_GH_BIN = join(tmp, 'no-gh');
  delete process.env.KB_CLAUDE_DIR; delete process.env.CLAUDE_CONFIG_DIR; delete process.env.KB_PREVIEW_TTL_MS;
  skills = await import('../src/skills.js');
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  system = await import('../src/routes/system.js');
  app = Fastify();
  await app.register((await import('../src/routes/skills.js')).default);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

/** The skill `name` in the Claude folder, made of `files` (relative path → text). */
function put(name, files) {
  const dir = join(skillsDir, name);
  rmSync(dir, { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}
const snapshots = () => (existsSync(join(tmp, 'data', 'backups', 'skills')) ? readdirSync(join(tmp, 'data', 'backups', 'skills')) : []);
const refresh = (name, payload) => app.inject({ method: 'POST', url: `/api/skills/${name}/refresh`, payload });

test('the board\'s skill against the package: the same, an old copy, a link, a file linked inside, missing, not shipped', () => {
  rmSync(join(skillsDir, 'kanban'), { recursive: true, force: true });
  assert.equal(skills.packagedSkillState('kanban'), 'missing');
  put('kanban', { 'SKILL.md': PKG('kanban'), 'references/mine.md': 'a file of the person\'s own next to it\n' });
  assert.equal(skills.packagedSkillState('kanban'), 'same', 'a file of the person\'s own makes the copy differ');
  put('kanban', { 'SKILL.md': '# kanban, as an older version had it\n' });
  assert.equal(skills.packagedSkillState('kanban'), 'differs');
  // a link to a version of the person's own is never compared
  rmSync(join(skillsDir, 'kanban'), { recursive: true });
  mkdirSync(join(tmp, 'own'), { recursive: true });
  writeFileSync(join(tmp, 'own', 'SKILL.md'), '# my own kanban\n');
  symlinkSync(join(tmp, 'own'), join(skillsDir, 'kanban'));
  assert.equal(skills.packagedSkillState('kanban'), 'link');
  // a clone's link to its own skills/ is the board's version by definition
  rmSync(join(skillsDir, 'kanban'));
  symlinkSync(fileURLToPath(new URL('../skills/kanban', import.meta.url)), join(skillsDir, 'kanban'));
  assert.equal(skills.packagedSkillState('kanban'), 'same');
  // a folder of its own with SKILL.md linked into it: a write would go through the link
  rmSync(join(skillsDir, 'kanban'));
  mkdirSync(join(skillsDir, 'kanban'));
  symlinkSync(join(tmp, 'own', 'SKILL.md'), join(skillsDir, 'kanban', 'SKILL.md'));
  assert.equal(skills.packagedSkillState('kanban'), 'link');
  assert.equal(skills.packagedSkillState('seo'), null, 'a skill the package does not ship has a state');
  assert.equal(skills.packagedSkillState('../kanban'), null);
  assert.deepEqual(skills.packagedSkillNames(), ['deploy', 'kanban']);
});

test('taking the board\'s version: the shipped files, the old one kept, the person\'s own files left, a link never written', async () => {
  const dir = put('kanban', { 'SKILL.md': '# kanban, old\n', 'references/mine.md': 'mine\n' });
  const had = snapshots().length;
  // the lock: the page sends the path it showed
  let r = await refresh('kanban', {});
  assert.equal(r.statusCode, 400);
  r = await refresh('kanban', { confirm_path: '/somewhere/else/SKILL.md' });
  assert.deepEqual([r.statusCode, r.json().reason], [409, 'changed']);
  assert.equal(readFileSync(join(dir, 'SKILL.md'), 'utf8'), '# kanban, old\n', 'written although the path was not the one shown');
  r = await refresh('kanban', { confirm_path: join(dir, 'SKILL.md') });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.deepEqual([j.written, j.state, j.kept.length], [['SKILL.md'], 'same', 1]);
  assert.ok(readFileSync(join(dir, 'SKILL.md')).equals(PKG('kanban')), 'the board\'s version is not in place');
  assert.equal(readFileSync(join(dir, 'references', 'mine.md'), 'utf8'), 'mine\n', 'a file of the person\'s own went away');
  assert.equal(snapshots().length, had + 1);
  assert.equal(readFileSync(join(tmp, 'data', 'backups', 'skills', j.kept[0]), 'utf8'), '# kanban, old\n', 'the old text is not in the snapshot');
  // the same again: nothing to write, nothing kept
  const again = (await refresh('kanban', { confirm_path: join(dir, 'SKILL.md') })).json();
  assert.deepEqual([again.written, again.kept], [[], []]);
  // through a link — never
  rmSync(dir, { recursive: true });
  symlinkSync(join(tmp, 'own'), dir);
  r = await refresh('kanban', { confirm_path: realpathSync(join(dir, 'SKILL.md')) });
  assert.deepEqual([r.statusCode, r.json().reason], [409, 'link']);
  assert.equal(readFileSync(join(tmp, 'own', 'SKILL.md'), 'utf8'), '# my own kanban\n', 'the file behind the link was written');
  rmSync(dir);
  // a skill of that name in an extra root (KB_SKILLS_EXTRA) is what the page shows, but the write goes to the Claude
  // folder: its path is not the lock
  const extra = join(tmp, 'extra');
  mkdirSync(join(extra, 'kanban'), { recursive: true });
  writeFileSync(join(extra, 'kanban', 'SKILL.md'), '# kanban in an extra root\n');
  process.env.KB_SKILLS_EXTRA = extra;
  try {
    r = await refresh('kanban', { confirm_path: join(extra, 'kanban', 'SKILL.md') });
    assert.deepEqual([r.statusCode, r.json().reason], [409, 'changed'], 'the page\'s path was taken for another file than the one written');
    assert.ok(!existsSync(join(skillsDir, 'kanban')), 'written although the lock did not match');
    assert.equal(readFileSync(join(extra, 'kanban', 'SKILL.md'), 'utf8'), '# kanban in an extra root\n');
  } finally { delete process.env.KB_SKILLS_EXTRA; }
  assert.equal((await refresh('seo', { confirm_path: 'x' })).statusCode, 404);
  assert.equal((await refresh('..', { confirm_path: 'x' })).statusCode, 404, 'a step up the path reached the route');
  // a check board opened from a backup writes no skills
  put('kanban', { 'SKILL.md': '# old\n' });
  process.env.KB_PREVIEW_TTL_MS = '60000';
  try {
    assert.equal((await refresh('kanban', { confirm_path: join(skillsDir, 'kanban', 'SKILL.md') })).statusCode, 403);
  } finally { delete process.env.KB_PREVIEW_TTL_MS; }
  assert.equal(readFileSync(join(skillsDir, 'kanban', 'SKILL.md'), 'utf8'), '# old\n');
});

// copy that cannot be read is "not the board's version", not a section that fails to load or an update that cannot start
test('a link anywhere on the way is not written through, and an unreadable copy breaks nothing', async () => {
  const dir = put('kanban', { 'SKILL.md': '# old\n' });
  mkdirSync(join(tmp, 'own-refs'), { recursive: true });
  symlinkSync(join(tmp, 'own-refs'), join(dir, 'references'));
  assert.equal(skills.throughLink(dir, 'references/x.md'), true, 'a linked subfolder is not seen');
  assert.equal(skills.throughLink(dir, 'SKILL.md'), false);
  assert.equal(skills.throughLink(join(tmp, 'nowhere'), 'SKILL.md'), false);
  rmSync(join(dir, 'SKILL.md'));
  writeFileSync(join(tmp, 'own-file.md'), '# mine\n');
  symlinkSync(join(tmp, 'own-file.md'), join(dir, 'SKILL.md'));
  assert.throws(() => skills.copyFromPackage('kanban'), /goes through a link/);
  assert.equal(readFileSync(join(tmp, 'own-file.md'), 'utf8'), '# mine\n', 'the file behind the link was written');
  // unreadable
  put('kanban', { 'SKILL.md': '# old\n' });
  chmodSync(join(skillsDir, 'kanban', 'SKILL.md'), 0o000);
  try {
    assert.equal(skills.packagedSkillState('kanban'), 'differs');
    assert.equal((await app.inject({ method: 'GET', url: '/api/skills' })).statusCode, 200, 'the Skills section fails to load');
    assert.doesNotThrow(() => system.skillStates(), 'the update cannot start');
  } finally { chmodSync(join(skillsDir, 'kanban', 'SKILL.md'), 0o644); }
});

test('GET /api/skills says which copy is not the board\'s version', async () => {
  put('kanban', { 'SKILL.md': '# old\n' });
  put('deploy', { 'SKILL.md': '# my own deploy\n' });
  let j = (await app.inject({ method: 'GET', url: '/api/skills' })).json();
  assert.equal(j.board.package_state, 'differs');
  assert.deepEqual(Object.fromEntries(j.items.map((s) => [s.name, s.package_state])), { deploy: 'differs', kanban: 'differs' });
  rmSync(join(skillsDir, 'kanban'), { recursive: true });
  j = (await app.inject({ method: 'GET', url: '/api/skills' })).json();
  assert.equal(j.board.package_state, 'missing');
});

test('the board\'s update brings along the copies nobody changed, and leaves a changed one as it was', () => {
  // before the update: kanban exactly as the package put it, deploy changed by the person
  const k = put('kanban', { 'SKILL.md': PKG('kanban') });
  const d = put('deploy', { 'SKILL.md': '# my own deploy\n' });
  const before = system.skillStates();
  assert.deepEqual(before, { deploy: 'differs', kanban: 'same' });
  // the package moves on — here the copy turns into what the older package had
  writeFileSync(join(k, 'SKILL.md'), '# kanban as the older package had it\n');
  assert.deepEqual(system.bringSkills(before), { refreshed: ['kanban'], kept: ['deploy'], failed: [] });
  assert.ok(readFileSync(join(k, 'SKILL.md')).equals(PKG('kanban')), 'the untouched copy did not come along');
  assert.equal(readFileSync(join(d, 'SKILL.md'), 'utf8'), '# my own deploy\n', 'a changed copy was overwritten');
  // a link and a skill that is not installed are left alone; an update that changed nothing writes nothing
  assert.deepEqual(system.bringSkills({ kanban: 'link', deploy: 'missing' }), { refreshed: [], kept: [], failed: [] });
  assert.deepEqual(system.bringSkills({ kanban: 'same' }), { refreshed: [], kept: [], failed: [] });
});

test('the update route looks at the skills before it installs, and answers what became of them', () => {
  const src = readFileSync(new URL('../src/routes/system.js', import.meta.url), 'utf8');
  const route = src.slice(src.indexOf("app.post('/api/update'"));
  const at = (s) => route.indexOf(s);
  assert.ok(at('skillStates()') > 0 && at('skillStates()') < at('runUpdate(plan, exec)'), 'the skills are looked at after the install: every copy would differ then');
  assert.ok(at('bringSkills(') > at('if (res.err)') && at('bringSkills(') < at('process.exit(0)'), 'the skills come along on a failed update, or after the exit');
  assert.match(route, /return \{ ok: true, how: plan\.how, restart, output, skills \}/);
});

test('every word of the skill\'s state on the page has its Russian line', () => {
  const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');
  const core = read('core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const settings = read('settings.js');
  // the Skills section, and the update dialog of About
  const parts = [settings.slice(settings.indexOf('async function loadSkillText('), settings.indexOf('// CK-230:')),
    settings.slice(settings.indexOf("$('about-do-upd').onclick"), settings.indexOf("phase = tr('restarting…')"))];
  assert.ok(parts.every((p) => p.length > 500), 'the parts of the page were not found');
  const words = parts.flatMap((p) => [...p.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1].replace(/\\'/g, "'")));
  for (const w of ["Take the board's version", "not the board's version", "The skills Claude reads come along with it, unless a copy already differs from the board's version — that one stays as it is."]) {
    assert.ok(words.includes(w), `"${w}" is no longer on the page`);
  }
  const js = (t) => `'${t.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  const has = (t) => dict.includes(`${js(t)}:`) || dict.includes(`"${t}":`);
  assert.deepEqual([...new Set(words)].filter((t) => !has(t)), [], 'stays English on the Russian board');
});

// 'same' by definition — and the update handed it to the refresh, which refused to write through the link: every update
// of a clone logged "the skill kanban did not come along with the update" into Settings → Errors
test('a clone\'s link to its own skills/ comes along with an update quietly, and the button writes nothing', async () => {
  const { db } = await import('../src/db.js');
  rmSync(join(skillsDir, 'kanban'), { recursive: true, force: true });
  symlinkSync(fileURLToPath(new URL('../skills/kanban', import.meta.url)), join(skillsDir, 'kanban'));
  try {
    const errors = () => db.prepare("SELECT message FROM app_errors WHERE message LIKE '%did not come along%'").all().length;
    const was = errors();
    const before = system.skillStates();
    assert.equal(before.kanban, 'same');
    assert.deepEqual(system.bringSkills({ kanban: before.kanban }), { refreshed: [], kept: [], failed: [] });
    assert.equal(errors(), was, 'the update of a clone logged an error about its own skill');
    const r = await refresh('kanban', { confirm_path: realpathSync(join(skillsDir, 'kanban', 'SKILL.md')) });
    assert.equal(r.statusCode, 200, r.body);
    assert.deepEqual(r.json().written, []);
  } finally { rmSync(join(skillsDir, 'kanban')); }
});

// written into it — once the skill had made the folder, connecting went through as well
test('a Claude folder KB_CLAUDE_DIR names that is not there is made by no skill write', async () => {
  const typo = join(tmp, 'no-such-claude');
  process.env.KB_CLAUDE_DIR = typo;
  try {
    let r = await refresh('kanban', { confirm_path: join(typo, 'skills', 'kanban', 'SKILL.md') });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().reason, 'no-folder');
    assert.match(r.json().error, /KB_CLAUDE_DIR/);
    const info = skills.skillInfo('fresh-one');
    r = await app.inject({ method: 'PUT', url: '/api/skills/fresh-one', payload: { text: '# fresh\n', confirm_path: info.real_path } });
    assert.equal(r.statusCode, 409, r.body);
    assert.equal(r.json().reason, 'no-folder');
    assert.throws(() => skills.copyFromPackage('deploy'), /KB_CLAUDE_DIR/);
    assert.deepEqual(system.bringSkills({ kanban: 'same' }).refreshed, []);
    assert.ok(!existsSync(typo), 'a skill write made the folder KB_CLAUDE_DIR names');
  } finally { delete process.env.KB_CLAUDE_DIR; }
});

test('the section does not send a missing skill to Skills when the folder is a mistake in KB_CLAUDE_DIR', async () => {
  const r = await import('../public/js/claude-setup-rules.js');
  const skillRow = (folder) => r.setupView({ folder, skill: { exists: false } }).flatMap((g) => g.rows).find((x) => x.id === 'skill');
  const typo = skillRow({ path: '/x/typo', from: 'KB_CLAUDE_DIR', exists: false });
  assert.equal(typo.fix.section, undefined, 'installing in Skills would make the folder');
  assert.match(typo.fix.text, /KB_CLAUDE_DIR/);
  // Claude Code yet to run in its own folder: installing the skill there is right
  assert.equal(skillRow({ path: '/x/.claude', from: 'default', exists: false }).fix.section, 'skills');
});

// not get the shared version…"); it now says it through errorLine, and these two have words of their own
test('the server\'s refusals of a skill have the board\'s words', async () => {
  const { refusalText } = await import('../public/js/unsaved.js');
  const typo = join(tmp, 'no-such-claude-2');
  process.env.KB_CLAUDE_DIR = typo;
  try {
    const r = await refresh('kanban', { confirm_path: join(typo, 'skills', 'kanban', 'SKILL.md') });
    assert.equal(r.statusCode, 409);
    assert.equal(refusalText({ status: 409, message: r.json().error, body: r.json() }).reason, 'no such folder — check KB_CLAUDE_DIR; the board does not make it');
  } finally { delete process.env.KB_CLAUDE_DIR; }
  const src = readFileSync(new URL('../src/routes/skills.js', import.meta.url), 'utf8');
  const upstream = src.match(/reply\.code\(502\)\.send\(\{ error: '([^']+)'/)[1];
  assert.equal(refusalText({ status: 502, message: upstream }).reason, 'could not get the shared version — no network, and the board does not ship this skill');
});

// link is real, to a version of the person's own, and the update leaves it and the file behind it as they were
test('the board\'s update leaves a link to the person\'s own version as it is', () => {
  rmSync(join(skillsDir, 'kanban'), { recursive: true, force: true });
  const own = join(tmp, 'own-kanban');
  mkdirSync(own, { recursive: true });
  writeFileSync(join(own, 'SKILL.md'), '# my own kanban\n');
  symlinkSync(own, join(skillsDir, 'kanban'));
  try {
    const before = system.skillStates();
    assert.equal(before.kanban, 'link');
    assert.deepEqual(system.bringSkills({ kanban: before.kanban }), { refreshed: [], kept: [], failed: [] });
    assert.equal(readFileSync(join(own, 'SKILL.md'), 'utf8'), '# my own kanban\n', 'the update wrote through the link');
  } finally { rmSync(join(skillsDir, 'kanban')); }
});

// only "the board did not accept it"; and a save refused for a Claude folder that is not there read the skill again,
// which emptied the text that was not saved and replaced the reason with "the file will be created on save"
test('a refused delete of a skill says why, and a save refused for a missing folder keeps its text', async () => {
  const { refusalText } = await import('../public/js/unsaved.js');
  put('mine', { 'SKILL.md': '# mine\n' });
  let r = await app.inject({ method: 'DELETE', url: '/api/skills/mine', payload: { confirm_path: '/not/the/one' } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(refusalText({ status: 409, message: r.json().error }).reason, 'the file on disk is not the one opened here — open it again');
  rmSync(join(skillsDir, 'mine'), { recursive: true });
  r = await app.inject({ method: 'DELETE', url: '/api/skills/mine', payload: { confirm_path: '/whatever' } });
  assert.equal(r.statusCode, 404, r.body);
  const gone = refusalText({ status: 404, message: r.json().error });
  assert.equal(gone.reason, 'there is no such skill any more');
  assert.equal(gone.refresh, true);
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const saveAt = settings.indexOf("$('sk-save').onclick");
  assert.ok(saveAt > 0, 'the save of a skill is gone from settings.js');
  const save = settings.slice(saveAt, settings.indexOf('\n  };', saveAt));
  assert.match(save, /if \(e\.status === 409 && e\.body\?\.reason !== 'no-folder'\) loadSkillText\(/, 'a save refused for a missing folder reads the skill again');
});
