const k = (n) => (n >= 1e6 ? `${Math.round(n / 1e5) / 10}M` : `${Math.round(n / 1000)}k`);
/** How long the session has been quiet, in the board's words: «3 h», «2 d». */
export function quietFor(ms, tr = (s) => s) {
  const h = ms / 3600_000;
  return h >= 48 ? `${Math.round(h / 24)} ${tr('d')}` : `${Math.max(1, Math.round(h))} ${tr('h')}`;
}
/** The question of the window: advice {tokens, idle_ms, cost} from GET /api/tasks/:id/resume-advice. */
export function resumeWords(a, tr = (s) => s) {
  const cost = Number.isFinite(a.cost) ? ` — ≈ $${a.cost.toFixed(2)}` : '';
  return `${tr('The conversation is')} ${k(a.tokens)} ${tr('tokens and has been quiet for')} ${quietFor(a.idle_ms, tr)}: `
    + `${tr('continuing writes all of it to the cache again')}${cost}. ${tr('The task keeps its notes and comments — a new session can start from them.')}`;
}
