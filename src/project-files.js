import { execFile } from 'node:child_process';
import { bin } from './bin-path.js';

export const FILES_TTL_MS = 30_000;
export const FILES_MAX = 50_000;
export const FILES_SHOWN = 30;
const kept = new Map(); // folder → {at, files, git}
const flights = new Map(); // folder → the walk in progress

function walk(folder) {
  return new Promise((resolve) => {
    execFile(bin('git'), ['-C', folder, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { timeout: 10_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, out) => {
        if (err) { resolve({ files: [], git: false }); return; }
        const files = [...new Set(String(out).split('\0').filter(Boolean))].slice(0, FILES_MAX);
        resolve({ files, git: true });
      });
  });
}
/** The files of a project folder: {files, git}. */
export async function projectFiles(folder, now = Date.now()) {
  const k = kept.get(folder);
  if (k && now - k.at < FILES_TTL_MS) return k;
  if (!flights.has(folder)) {
    flights.set(folder, walk(folder).then((r) => { kept.set(folder, { at: Date.now(), ...r }); return kept.get(folder); })
      .finally(() => flights.delete(folder)));
  }
  return flights.get(folder);
}
/** Forget what is kept — tests, and a folder changed in the project's settings. */
export const forgetProjectFiles = (folder) => (folder ? kept.delete(folder) : kept.clear());

/** The files that match the words `q` best, at most `limit`: the name starting with them, then the name holding them, then
    the path holding them (every word of `q`, any case); shorter paths first within a rank. No words — the shortest paths. */
export function rankFiles(files, q, limit = FILES_SHOWN) {
  const words = String(q || '').toLowerCase().split(/[\s/]+/).filter(Boolean);
  const scored = [];
  for (const f of files) {
    const low = f.toLowerCase();
    if (!words.every((w) => low.includes(w))) continue;
    const name = low.slice(low.lastIndexOf('/') + 1);
    const last = words.at(-1) || '';
    const rank = !last ? 2 : name.startsWith(last) ? 0 : name.includes(last) ? 1 : 2;
    scored.push([rank, f.length, f]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : 1));
  return scored.slice(0, limit).map((s) => s[2]);
}
