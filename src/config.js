import { join, dirname, sep } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const packaged = ROOT.split(sep).includes('node_modules');
const defaultDataDir = () => {
  if (existsSync(join(ROOT, 'data', 'kanban.db'))) return join(ROOT, 'data');
  return packaged ? join(homedir(), '.local-kanban') : join(ROOT, 'data');
};

const env = (...names) => {
  for (const n of names) {
    const v = process.env[n];
    if (v !== undefined && v !== '') return v;
  }
  return '';
};

export const DATA_DIR = env('KB_DATA_DIR') || defaultDataDir();
export const PORT = Number(env('PORT') || 3100);

export const localRoot = () => env('KB_LOCAL_ROOT') || join(homedir(), 'claude-projects');
export const panelUrl = () => env('KB_PANEL_URL', 'PANEL_URL');
export const panelInfo = () => env('KB_PANEL_INFO', 'PANEL_INFO');
export const skillsExtra = () => env('KB_SKILLS_EXTRA').split(':').filter(Boolean);
export const sseMax = () => Number(env('KB_SSE_MAX')) || 20;
export const allowedHosts = () => env('KB_ALLOWED_HOSTS').split(',').map((s) => s.trim()).filter(Boolean);
export const langOverride = () => env('KB_LANG');
export const ghOwnerEnv = () => env('KB_GH_OWNER');
export const ghRepoEnv = () => env('KB_GH_REPO');
