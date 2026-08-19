
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { skillsExtra } from './config.js';
import { snapshotDir, snapshotFile } from './file-snapshot.js';

export const SKILL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const SKILL_MAX_BYTES = 512 * 1024;

export const BOARD_SKILL = 'kanban';
export const GENERIC_DEPLOY_SKILL = 'deploy';

export function skillRoots() {
  const home = process.env.HOME || homedir();
  return [join(home, '.claude', 'skills'), ...skillsExtra()].map((r) => resolve(r));
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
