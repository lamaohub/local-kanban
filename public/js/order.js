
export const SORT_MODES = ['manual', 'num-desc', 'num-asc'];
export const DEFAULT_SORT = 'manual';

export function sortMode(v) { return SORT_MODES.includes(v) ? v : DEFAULT_SORT; }

export function taskNumber(t) {
  const n = Number(String(t.key || '').split('-').pop());
  return Number.isFinite(n) ? n : 0;
}

const pinnedFirst = (a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);

export function columnComparator(mode, { mixed = false, closed = false } = {}) {
  const m = sortMode(mode);
  const pin = closed ? () => 0 : pinnedFirst;
  if (m === DEFAULT_SORT) {
    return closed
      ? (a, b) => b.priority - a.priority || b.id - a.id
      : (a, b) => pin(a, b) || b.priority - a.priority || a.position - b.position || a.id - b.id;
  }
  const num = mixed ? (t) => t.id : taskNumber;
  const dir = m === 'num-asc' ? 1 : -1;
  return (a, b) => pin(a, b) || dir * (num(a) - num(b)) || dir * (a.id - b.id);
}

export function orderColumn(tasks, mode, { mixed = false, closed = false, limit = Infinity } = {}) {
  let list = [...tasks];
  if (closed) list = list.sort((a, b) => b.id - a.id).slice(0, limit);
  return list.sort(columnComparator(mode, { mixed, closed }));
}

export function slotBefore(tasks, task, mode, opts = {}) {
  const cmp = columnComparator(mode, opts);
  const next = orderColumn(tasks.filter((x) => x.id !== task.id), mode, opts).find((x) => cmp(task, x) < 0);
  return next ? next.id : null;
}
