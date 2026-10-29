
/** The label of a check task: the board puts it on the task it makes, and tells a check by it in any language. */
export const CHECK_LABEL = 'check';
/** Statuses in which a check is still open: made and not started yet, or being worked on. The server holds the
    same list for its one-open-check guard (src/review-check.js); a test keeps the two equal. */
export const OPEN_CHECK = ['todo', 'prep', 'doing', 'deploy'];
const isCheck = (t) => Array.isArray(t.labels) && t.labels.includes(CHECK_LABEL);
export const IN_WORK = ['prep', 'doing', 'deploy'];
const manual = (t) => Array.isArray(t.labels) && t.labels.includes('noclaude');
export const HOLD_STALE_MS = 2 * 3600 * 1000;
export function holdsCheck(t, live = {}, now = Date.now()) {
  if (!IN_WORK.includes(t.status) || isCheck(t) || manual(t) || t.blocked) return false;
  const claude = live?.[t.id]?.claude;
  if (claude) return claude !== 'gone';
  const at = Date.parse(`${String(t.updated_at || '').replace(' ', 'T')}Z`);
  return !(now - at > HOLD_STALE_MS); // an unknown time holds: better wait than test code still being written
}
export function leadCheck(tasks) {
  return tasks.filter((t) => OPEN_CHECK.includes(t.status) && isCheck(t))
    .sort((a, b) => (a.status === 'todo') - (b.status === 'todo') || a.id - b.id)[0];
}

export function reviewGroups(tasks, projects, live = {}, now = Date.now()) {
  const out = [];
  for (const p of projects) {
    const own = tasks.filter((t) => t.project === p.slug);
    const review = own.filter((t) => t.status === 'review' && !isCheck(t))
      .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')) || a.id - b.id);
    if (!review.length) continue;
    const open = leadCheck(own);
    out.push({
      project: p.slug, name: p.name || p.slug, tasks: review,
      batch: review.map((t) => t.key),
      running: open ? { id: open.id, key: open.key, status: open.status } : null,
      working: own.filter((t) => holdsCheck(t, live, now)).map((t) => t.key),
    });
  }
  return out;
}

export function columnCheck(shown, tasks, slug, all, projects, live = {}, now = Date.now()) {
  const own = slug !== all ? [slug] : [...new Set(shown.map((t) => t.project))];
  if (own.length !== 1) return null;
  const p = projects.find((x) => x.slug === own[0]) || { slug: own[0] };
  const g = reviewGroups(tasks, [p], live, now)[0];
  return g || null;
}

export function sidebarOrder(projects, slugs) {
  const at = new Map();
  slugs.forEach((s, i) => { if (!at.has(s)) at.set(s, i); });
  const rank = (p) => (at.has(p.slug) ? at.get(p.slug) : slugs.length);
  return projects.map((p, i) => ({ p, i })).sort((a, b) => (rank(a.p) - rank(b.p)) || (a.i - b.i)).map((x) => x.p);
}

const LIVE = new Set(['busy', 'waiting', 'idle']);
export function checkState(running, terminal, claude = null) {
  if (!running) return null;
  const alive = Boolean(terminal && terminal.session && !terminal.dead);
  if (alive && terminal.question) return 'answer';
  if (running.status !== 'todo') {
    if (alive || LIVE.has(claude)) return 'checking';
    if (claude === 'unsent') return 'unsent';
    if (claude === 'starting') return 'checking';
    const dead = Boolean(terminal && terminal.session && terminal.dead);
    return dead || claude === 'gone' ? 'closed' : 'checking';
  }
  return alive ? 'answer' : 'waiting';
}

export const LIVE_CHECK = new Set(['checking', 'answer']);
export function checkingFirst(groups, stateOf) {
  const live = groups.filter((g) => LIVE_CHECK.has(stateOf(g)));
  return [...live, ...groups.filter((g) => !live.includes(g))];
}

export function warningLine(w, say = (s) => s) {
  if (w?.reason === 'check-open' && typeof w.key === 'string') return `${say('This project already has an open check')} ${w.key}.`;
  return null;
}
export const stillOpen = (status) => (status === 'todo'
  ? 'This check is still open and waits in To do — press ▶ on its card to start it.'
  : 'This check is still open — to start it again, move it back to To do and press ▶ on its card.');

export function checkDescription(batch, say) {
  return [`${say.tasks} ${batch.join(', ')}`, say.later, say.done, say.report].filter(Boolean).join('\n\n');
}
