
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ROOT, claudeDir, missingClaudeDir, missingClaudeDirError, skillsExtra } from './config.js';
import { snapshotDir, snapshotFile } from './file-snapshot.js';

export const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SKILL_MAX_BYTES = 512 * 1024;

export const BOARD_SKILL = 'kanban';
export const GENERIC_DEPLOY_SKILL = 'deploy';

export function skillRoots() {
  return [join(claudeDir(), 'skills'), ...skillsExtra()].map((r) => resolve(r));
}

export function resolveSkillPath(name) {
  if (!name || !SKILL_NAME_RE.test(name)) return null;
  for (const root of skillRoots()) {
    const p = resolve(root, name, 'SKILL.md');
    if (!p.startsWith(root + sep)) continue;
    if (existsSync(p)) return p;
  }
  return null;
}

export function skillTargetPath(name) {
  if (!name || !SKILL_NAME_RE.test(name)) return null;
  return resolveSkillPath(name) || join(skillRoots()[0], name, 'SKILL.md');
}

function realPathOf(path) {
  try { return realpathSync(path); } catch {  }
  try { return join(realpathSync(join(path, '..')), 'SKILL.md'); } catch { return path; }
}

export function skillInfo(name) {
  if (!name || !SKILL_NAME_RE.test(name)) return null;
  const path = skillTargetPath(name);
  const real = realPathOf(path);
  let size = null;
  let mtime = null;
  try {
    const st = statSync(path);
    size = st.size;
    mtime = new Date(st.mtimeMs).toISOString();
  } catch {  }
  return {
    name,
    path,
    real_path: real,
    symlink: real !== path,
    exists: existsSync(path),
    size,
    mtime,
  };
}

export function listSkills() {
  const seen = new Set();
  const out = [];
  for (const root of skillRoots()) {
    let entries = [];
    try { entries = readdirSync(root); } catch { continue; }
    for (const name of entries.sort()) {
      if (seen.has(name) || !SKILL_NAME_RE.test(name)) continue;
      if (!existsSync(join(root, name, 'SKILL.md'))) continue;
      seen.add(name);
      out.push({ ...skillInfo(name), root });
    }
  }
  return out;
}

export function readSkill(name) {
  const info = skillInfo(name);
  if (!info || !info.exists) return info ? { ...info, text: null, truncated: false } : null;
  const buf = readFileSync(info.path);
  const truncated = buf.length > SKILL_MAX_BYTES;
  return { ...info, text: buf.subarray(0, SKILL_MAX_BYTES).toString('utf8'), truncated };
}

export const SKILL_BACKUP_DIR = () => snapshotDir('skills');

export function writeSkill(name, text, confirmPath) {
  if (!name || !SKILL_NAME_RE.test(name)) return { error: 'skill name: latin letters, digits, hyphen, underscore only', code: 400 };
  if (typeof text !== 'string') return { error: 'text is required', code: 400 };
  if (Buffer.byteLength(text) > SKILL_MAX_BYTES) return { error: `the skill is larger than ${Math.round(SKILL_MAX_BYTES / 1024)} KB`, code: 413 };
  const info = skillInfo(name);
  if (confirmPath !== info.real_path) {
    return { error: 'the file on disk is not the one the page was editing', code: 409, real_path: info.real_path };
  }
  if (!info.exists && missingClaudeDir()) return { error: missingClaudeDirError(), code: 409, reason: 'no-folder' };
  const backup = snapshotFile('skills', name, info.path);
  mkdirSync(join(info.path, '..'), { recursive: true });
  writeFileSync(info.path, text);
  return { ...skillInfo(name), backup, backup_name: backup ? backup.split(sep).pop() : null };
}

export function deleteSkill(name, confirmPath) {
  if (!name || !SKILL_NAME_RE.test(name)) return { error: 'skill name: latin letters, digits, hyphen, underscore only', code: 400 };
  const info = skillInfo(name);
  if (!info.exists) return { error: 'there is no such skill', code: 404 };
  if (confirmPath !== info.real_path) {
    return { error: 'the file on disk is not the one the page was showing', code: 409, real_path: info.real_path };
  }
  const backup = snapshotFile('skills', name, info.path);
  const dir = join(info.path, '..');
  let unlinkedOnly = false;
  try { unlinkedOnly = lstatSync(dir).isSymbolicLink(); } catch {  }
  if (unlinkedOnly) {
    unlinkSync(dir);
  } else {
    rmSync(info.path, { force: true });
    try { if (!readdirSync(dir).length) rmSync(dir, { recursive: true, force: true }); } catch {  }
  }
  return { name, removed: true, link_only: unlinkedOnly, backup, backup_name: backup ? backup.split(sep).pop() : null };
}

export function packagedSkillNames() {
  try {
    return readdirSync(join(ROOT, 'skills'))
      .filter((name) => SKILL_NAME_RE.test(name) && existsSync(join(ROOT, 'skills', name, 'SKILL.md')))
      .sort();
  } catch { return []; }
}

function packageFiles(name) {
  const dir = join(ROOT, 'skills', name);
  try {
    return readdirSync(dir, { recursive: true }).filter((rel) => statSync(join(dir, rel)).isFile()).sort();
  } catch { return []; }
}

const installedDir = (name) => join(skillRoots()[0], name);

export function throughLink(target, rel) {
  let p = target;
  for (const part of ['', ...rel.split(sep)]) {
    if (part) p = join(p, part);
    try { if (lstatSync(p).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}

export function packagedSkillState(name) {
  if (!name || !SKILL_NAME_RE.test(name)) return null;
  const files = packageFiles(name);
  if (!files.includes('SKILL.md')) return null;
  const source = join(ROOT, 'skills', name);
  const target = installedDir(name);
  let dirLink;
  try { dirLink = lstatSync(target).isSymbolicLink(); } catch { return 'missing'; }
  if (dirLink) {
    try { if (realpathSync(target) === realpathSync(source)) return 'same'; } catch {  }
    return 'link';
  }
  if (!existsSync(join(target, 'SKILL.md'))) return 'missing';
  let differs = false;
  for (const rel of files) {
    if (throughLink(target, rel)) return 'link';
    if (differs) continue;
    try { differs = !readFileSync(join(target, rel)).equals(readFileSync(join(source, rel))); } catch { differs = true; }
  }
  return differs ? 'differs' : 'same';
}

/** The installed skill folder is a link to the package's own skills/<name> (a clone, as its wizard links it). */
function selfLink(name) {
  const target = installedDir(name);
  try { return lstatSync(target).isSymbolicLink() && realpathSync(target) === realpathSync(join(ROOT, 'skills', name)); } catch { return false; }
}

export function copyFromPackage(name, target = installedDir(name), { dataDir } = {}) {
  const source = join(ROOT, 'skills', name);
  const files = packageFiles(name);
  if (missingClaudeDir()) throw new Error(missingClaudeDirError());
  const linked = files.find((rel) => throughLink(target, rel));
  if (linked) throw new Error(`${join(target, linked)} goes through a link to a file elsewhere — the board does not write through it`);
  const written = [];
  for (const rel of files) {
    const from = join(source, rel);
    const to = join(target, rel);
    if (existsSync(to) && readFileSync(to).equals(readFileSync(from))) continue;
    const label = rel === 'SKILL.md' ? name : `${name}-${rel.split(sep).join('-')}`;
    const kept = existsSync(to) ? snapshotFile('skills', label, to, { dataDir }) : null;
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    written.push({ rel, kept });
  }
  return written;
}

export function refreshPackagedSkill(name, confirmPath = null) {
  const state = packagedSkillState(name);
  if (state === null) return { error: 'the board does not ship this skill', code: 404, reason: 'not-packaged' };
  if (state === 'link') return { error: 'the skill is a link to a file elsewhere — the board does not write through it', code: 409, reason: 'link' };
  if (missingClaudeDir()) return { error: missingClaudeDirError(), code: 409, reason: 'no-folder' };
  // a clone's link to its own skills/ IS the board's version: nothing to write, and no write goes through a link (an
  if (selfLink(name)) return { name, written: [], kept: [], state };
  const real = realPathOf(join(installedDir(name), 'SKILL.md'));
  if (confirmPath !== null && confirmPath !== real) {
    return { error: 'the file on disk is not the one the page was showing', code: 409, reason: 'changed', real_path: real };
  }
  const written = copyFromPackage(name);
  return {
    name,
    written: written.map((w) => w.rel),
    kept: written.filter((w) => w.kept).map((w) => w.kept.split(sep).pop()),
    state: packagedSkillState(name),
  };
}
