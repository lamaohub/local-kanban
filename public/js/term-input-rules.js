
export const HINT_STATUSES = new Set(['doing', 'deploy']);
export const HINT_ACTIVITY = new Set(['idle', 'background']);

export function termSuggestion({ key, status, activity }, tr = (s) => s) {
  if (!key || !HINT_STATUSES.has(status) || !HINT_ACTIVITY.has(activity)) return null;
  return tr('Move {key} to Review, so I can check it later').replace('{key}', key);
}

export function withPath(value, start, end, path) {
  const p = /\s/.test(path) ? `"${path}"` : path;
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const tail = after && /^\s/.test(after) ? '' : ' ';
  const head = before + lead + p + tail;
  return { value: head + after, caret: head.length };
}
