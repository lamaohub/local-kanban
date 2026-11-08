
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
/** A tick only on a stand that can go: a busy one or one with work not in main never gets into a cleanup. */
export const tickable = (s) => s?.state === 'free';
/** «Show what is not in main» — only on a stand with work not in main. */
export const diffable = (s) => s?.state === 'unsent';
/** The chosen folders that can still go: a stand chosen earlier that is no longer free drops out of the choice. */
export const chosenFree = (chosen, stands) => (stands || []).filter((s) => tickable(s) && chosen.has(s.path)).map((s) => s.path);
/** «Tick all that can go» / «Untick all»: every stand that can go, and nothing else; pressed with all of them ticked —
    none. Changes `chosen` in place. */
export function tickAll(chosen, stands) {
  const free = (stands || []).filter(tickable);
  if (free.length && chosenFree(chosen, stands).length === free.length) chosen.clear();
  else for (const s of free) chosen.add(s.path);
  return chosen;
}
/** The weight of a stand or of the free room: under a gigabyte in MB (a stand of a few files is no «0.0 GB»); '—' unknown. */
export function sizeWords(n, { tr, fmtNum }) {
  if (!n) return '—';
  if (n >= 1024 ** 3) return `${fmtNum(n / 1024 ** 3, 1)} ${tr('GB')}`;
  return `${fmtNum(Math.max(1, Math.round(n / 1024 ** 2)), 0)} ${tr('MB')}`;
}
/** Why a stand is not free, in words: each reason of `s.why` (src/stands.js, standState) said, none left as its code. */
export function whyWords(s, { tr, plural, statusWord = (x) => x }) {
  const lost = (s.commits || []).filter((c) => !c.found);
  const n = lost.filter((c) => !c.merge).length;
  const m = lost.filter((c) => c.merge).length;
  const words = {
    session: () => tr('a Claude session is open in the folder'),
    process: () => tr('a process runs in the folder'),
    task: () => `${tr('its task is in work')}${s.task ? ` (${statusWord(s.task.status)})` : ''}`,
    locked: () => tr('the worktree is locked'),
    main: () => `${tr('a branch the repository keeps')}${s.branch ? ` (${s.branch})` : ''}`,
    project: () => tr('a project of the board lives in the folder'),
    unknown: () => tr('could not tell what is in it'),
    dirty: () => `${tr('not committed')}: ${s.changes?.files ?? '?'} ${plural(s.changes?.files ?? 0, 'file', 'files')}`,
    ignored: () => `${tr('ignored data not in the main checkout')}: ${s.ignored?.files ?? '?'} ${plural(s.ignored?.files ?? 0, 'file', 'files')}`,
    commits: () => `${tr('not in main')}: ${n} ${plural(n, 'commit', 'commits')}`,
    merge: () => `${tr('a merge with changes of its own')}: ${m}`,
    detached: () => tr('detached HEAD with commits of its own'),
  };
  return (s.why || []).map((w) => (words[w] ? words[w]() : w)).join(' · ');
}
export function commitWords(c, tr) {
  if (c.found === 'patch') return tr('in main as the same change');
  if (c.found === 'content') return tr('its changes are in main');
  if (c.merge) return tr('a merge with changes of its own');
  if (c.like === 'title') return tr('not in main: its title is, the changes differ');
  if (c.like === 'issue') return tr('not in main: its issue is, the changes differ');
  return tr('not in main');
}

export function walkPct(done, total) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  if (t <= 0 || d <= 0) return 0;
  return Math.min(100, Math.round((d / t) * 100));
}
/** The bar itself: `label` — already translated and escaped; numbers only from the server, never its text; `kind` — whose
    walk it is (`data-walk`): the section redrawn on an event keeps its own bar instead of drawing it from zero again. */
export function walkBarHTML(label, done, total, kind = '') {
  const t = Math.max(0, Number(total) || 0);
  const d = Math.min(t, Math.max(0, Number(done) || 0));
  const n = t ? `${d} / ${t}` : '';
  return `<div class="hl-walk"${kind ? ` data-walk="${kind}"` : ''} role="progressbar" aria-valuemin="0" aria-valuemax="${t || 100}" aria-valuenow="${t ? d : 0}">`
    + `<div class="hl-walk-h muted"><span>${label}</span><span class="hl-walk-n">${n}</span></div>`
    + `<div class="hl-walk-track"><span class="hl-walk-fill" style="width:${walkPct(d, t)}%"></span></div></div>`;
}

export const SLOW_ANSWER_SHOWN_MS = 1000;
export function loadWords(v, { tr, fmtNum }) {
  if (!v) return null;
  const sec = (ms) => `${fmtNum(ms / 1000, 1)} ${tr('s')}`;
  const msw = (ms) => `${fmtNum(ms, 0)} ${tr('ms')}`;
  if (!v.last?.loop) return { slow: false, text: tr('The board measures its own speed — the first figures in a minute.'), routes: '' };
  let text = tr('The board kept its work waiting up to {ms} in the last minute').replace('{ms}', msw(v.last.loop.p95));
  if (v.worst?.loop && v.minutes > 1) text += `; ${tr('the worst minute of the hour — {ms}').replace('{ms}', msw(v.worst.loop.p95))}`;
  text += '.';
  if (v.slow) text += ` ${tr('That is slow — the error log has a record of it.')}`;
  const slowest = (v.slowest || []).filter((r) => r.max >= SLOW_ANSWER_SHOWN_MS);
  const routes = slowest.length ? `${tr('Slowest answers this hour:')} ${slowest.map((r) => `${r.route} ${sec(r.max)}`).join(', ')}` : '';
  return { slow: Boolean(v.slow), text, routes };
}
