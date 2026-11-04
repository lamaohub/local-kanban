
/** 'heavy' — Claude Code warns about the file; 'long' — longer than the docs ask; 'ok'. */
export function fileState(f, norms) {
  if (!f) return 'none';
  if (f.chars > norms.file_chars) return 'heavy';
  if (f.lines > norms.lines) return 'long';
  return 'ok';
}

export const fixable = (main, norms) => ['heavy', 'long'].includes(fileState(main, norms));

const FIX_WORK = new Set(['prep', 'doing', 'ready', 'deploy']);
export function fixStage(fix) {
  if (!fix) return 'none';
  if (FIX_WORK.has(fix.status)) return 'work';
  if (fix.status === 'review') return 'review';
  if (fix.status === 'backlog' || fix.status === 'todo') return 'todo';
  return 'none';
}

const RANK = { heavy: 0, long: 1, ok: 2 };

/** The projects split for the section: with their own CLAUDE.md (worst first, then the most loaded at the start), without
    one, without a folder on this computer. */
export function healthGroups(projects, norms) {
  const own = [];
  const bare = [];
  const away = [];
  for (const p of projects) {
    if (!p.files) away.push(p);
    else if (p.main) own.push(p);
    else bare.push(p);
  }
  own.sort((a, b) => (RANK[fileState(a.main, norms)] - RANK[fileState(b.main, norms)]) || (b.main.chars - a.main.chars));
  bare.sort((a, b) => b.chars - a.chars);
  return { own, bare, away };
}

/** All a session of the project reads at its start: its files and the person's own ones; over the norm of the total? */
export function startTotal(p, everywhere, norms) {
  const chars = (p.chars || 0) + (everywhere?.chars || 0);
  return { chars, over: chars > norms.total_chars };
}

/** How many of the projects with their own CLAUDE.md are long and how many heavy. */
export function healthCounts(own, norms) {
  const n = { long: 0, heavy: 0 };
  for (const p of own) {
    const s = fileState(p.main, norms);
    if (s === 'heavy') n.heavy++;
    if (s !== 'ok') n.long++;
  }
  return n;
}

const BY_SIZE = (a, b) => (b.size || 0) - (a.size || 0) || String(a.path).localeCompare(String(b.path));
/** The stands split for the section — what can go first, the biggest first: {free, unsent, busy, reading}. */
export function standGroups(stands) {
  const out = { free: [], unsent: [], busy: [], reading: [] };
  for (const s of stands || []) (out[s.state] || out.reading).push(s);
  for (const k of Object.keys(out)) out[k].sort(BY_SIZE);
  return out;
}
/** How many stands and how much room: {n, size, freeN, freeSize}. */
export function standTotals(stands) {
  let size = 0; let freeN = 0; let freeSize = 0;
  for (const s of stands || []) {
    size += s.size || 0;
    if (s.state === 'free') { freeN += 1; freeSize += s.size || 0; }
  }
  return { n: (stands || []).length, size, freeN, freeSize };
}
/** The chosen folders that can still go: a stand chosen earlier that is no longer free drops out of the choice. */
export const chosenFree = (chosen, stands) => (stands || []).filter((s) => s.state === 'free' && chosen.has(s.path)).map((s) => s.path);
