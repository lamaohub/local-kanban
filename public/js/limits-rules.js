// test/claude-limits.test.js runs it in node.
// A window whose reset time has passed is not shown at all: its figure belongs to a window that no longer
// exists, and printing it would be showing old numbers as if they were current. With no window left the
// footer says there is no data, which is the honest answer for a board that only desktop sessions talk to
// (the Claude desktop app runs no status line).
export const LIMIT_KINDS = ['five_hour', 'seven_day', 'spend_limit'];

const NONE = ['no data', 'Limits come from the status line of Claude Code in the terminal (kb statusline). The Claude desktop app has no status line, so it sends none.'];
/** What the footer says when no window is current: {text, title} — English, the page translates. */
export const limitsNone = () => ({ text: NONE[0], title: NONE[1] });
export const limitsShown = (rows, link) => rows.length > 0 || link === 'connected';

export function limitsView(snap, nowMs) {
  const rows = [];
  for (const kind of LIMIT_KINDS) {
    const w = snap && snap.windows && snap.windows[kind];
    const resetsAt = Number(w && w.resets_at) * 1000;
    if (!w || !(resetsAt > nowMs)) continue;
    const used = Math.max(0, Math.round(Number(w.used) || 0));
    rows.push({ kind, used, bar: Math.min(100, used), resetsAt });
  }
  return { rows, at: rows.length && snap.at ? Date.parse(snap.at) : null };
}
