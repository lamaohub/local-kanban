
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { db, kvGet, kvSet } from '../db.js';
import { ROOT } from '../config.js';
import { gh as ghCli } from '../sync/github.js';
import { BOARD_SKILL, GENERIC_DEPLOY_SKILL, SKILL_MAX_BYTES, SKILL_NAME_RE, deleteSkill, listSkills, readSkill, skillInfo, skillRoots, writeSkill } from '../skills.js';

function upstreamRepo() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const m = String(pkg.repository?.url || pkg.repository || '').match(/github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch { return null; }
}

async function fetchUpstream(name, lang) {
  const repo = upstreamRepo();
  const files = lang && lang !== 'en' ? [[`SKILL.${lang}.md`, lang], ['SKILL.md', 'en']] : [['SKILL.md', 'en']];
  if (repo) {
    for (const [file, got] of files) {
      const path = `skills/${name}/${file}`;
      const url = `https://raw.githubusercontent.com/${repo}/main/${path}`;
      try {
        const res = await fetch(url, { headers: { 'User-Agent': 'local-kanban' }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const text = await res.text();
          if (text.length <= SKILL_MAX_BYTES) return { text, source: 'github', origin: url, lang: got };
        }
      } catch {  }
      try {
        const text = await ghCli(['api', `repos/${repo}/contents/${path}`, '-H', 'Accept: application/vnd.github.raw'], { timeout: 15000 });
        if (text && text.length <= SKILL_MAX_BYTES) return { text, source: 'github', origin: url, lang: got };
      } catch {  }
    }
  }
  const local = join(ROOT, 'skills', name, 'SKILL.md');
  if (existsSync(local)) return { text: readFileSync(local, 'utf8'), source: 'package', origin: local, lang: 'en' };
  return null;
}

const OWN_KEY = 'skills.own';
function ownSkills() {
  try {
    const v = JSON.parse(kvGet(OWN_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && SKILL_NAME_RE.test(x)) : [];
  } catch { return []; }
}
const rememberOwn = (name) => kvSet(OWN_KEY, JSON.stringify([...new Set([...ownSkills(), name])]));
const forgetOwn = (name) => kvSet(OWN_KEY, JSON.stringify(ownSkills().filter((x) => x !== name)));

function packagedSkills() {
  try {
    return readdirSync(join(ROOT, 'skills'))
      .filter((name) => SKILL_NAME_RE.test(name) && existsSync(join(ROOT, 'skills', name, 'SKILL.md')))
      .sort();
  } catch { return []; }
}

export default async function skillRoutes(app) {
  const usedBy = (name) => db.prepare('SELECT slug, name FROM projects WHERE deploy_skill = ? AND archived = 0 ORDER BY name').all(name);

  app.get('/api/skills', () => ({
    roots: skillRoots(),
    board_skill: BOARD_SKILL,
    generic_deploy_skill: GENERIC_DEPLOY_SKILL,
    items: listSkills().map((s) => ({
      ...s,
      used_by: usedBy(s.name),
      packaged: existsSync(join(ROOT, 'skills', s.name, 'SKILL.md')),
    })),
    board: skillInfo(BOARD_SKILL),
    packaged_skills: packagedSkills(),
    own_skills: ownSkills(),
  }));

  app.get('/api/skills/:name', (req, reply) => {
    const { name } = req.params;
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'skill name: latin letters, digits, hyphen, underscore only' });
    return readSkill(name);
  });

  app.get('/api/skills/:name/upstream', async (req, reply) => {
    const { name } = req.params;
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'skill name: latin letters, digits, hyphen, underscore only' });
    const lang = req.query?.lang === 'ru' ? 'ru' : 'en';
    const got = await fetchUpstream(name, lang);
    if (!got) return reply.code(502).send({ error: 'could not get the shared version — no network and the package does not ship this skill' });
    return { name, ...got };
  });

  app.put('/api/skills/:name', (req, reply) => {
    if (process.env.KB_PREVIEW_TTL_MS) return reply.code(403).send({ error: 'this is a check board opened from a backup — it does not write skills' });
    const r = writeSkill(req.params.name, req.body?.text, req.body?.confirm_path);
    if (r.error) return reply.code(r.code).send(r);
    rememberOwn(req.params.name);
    return r;
  });

  app.post('/api/skills/:name/adopt', (req, reply) => {
    const { name } = req.params;
    if (!SKILL_NAME_RE.test(name)) return reply.code(400).send({ error: 'skill name: latin letters, digits, hyphen, underscore only' });
    const info = skillInfo(name);
    if (!info.exists) return reply.code(404).send({ error: 'there is no such skill' });
    rememberOwn(name);
    return { ...info, adopted: true };
  });

  app.delete('/api/skills/:name', (req, reply) => {
    if (process.env.KB_PREVIEW_TTL_MS) return reply.code(403).send({ error: 'this is a check board opened from a backup — it does not delete skills' });
    const r = deleteSkill(req.params.name, req.body?.confirm_path);
    if (r.error) return reply.code(r.code).send(r);
    forgetOwn(req.params.name);
    return r;
  });
}
