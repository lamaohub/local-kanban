import { failWord } from './review-rules.js';

/** «2 in work · 1 to ship · 3 accepted» — the stages that have tasks; a batch all accepted — «accepted». */
export function batchProgress(c, tr) {
  if (!c?.total) return tr('empty');
  if (c.done + c.cancelled === c.total) return tr('accepted');
  const parts = [[c.todo, 'to do'], [c.working, 'in work'], [c.ready, 'to ship'], [c.review, 'to review'], [c.done, 'accepted']]
    .filter(([n]) => n).map(([n, w]) => `${n} ${tr(w)}`);
  return parts.join(' · ');
}
/** The epic's card on the board: «batch 2/7 · 14/37», all through — «batches accepted · 37/37». */
export function epicBadge(e, tr) {
  if (!e?.batches_n) return '';
  const head = e.current ? `${tr('batch')} ${e.current}/${e.batches_n}` : tr('batches accepted');
  return `${head} · ${e.closed_n}/${e.tasks_n}`;
}
/** Why a start of a batch was refused, in the board's words, or null — the server's answer `{reason, error}`. */
export const refusedWord = (body) => (body?.reason ? failWord(`${body.reason}: ${body.error || ''}`) : null);
/** What a batch's run is doing, in the board's words; '' — nothing to say. */
export function runWords(r, tr) {
  if (!r?.state) return '';
  const keys = (r.keys || []).join(', ');
  if (r.state === 'starting') return `${tr('Starting Claude on')} ${keys}…`;
  if (r.state === 'running') return r.hold === 'limit-high' ? tr('Waits: the subscription limit is past 80%') : `${tr('In work')}: ${keys}`;
  if (r.state === 'accepting') return tr('Everything started — waits for your acceptance');
  if (r.state === 'passed') return tr('Handed in — the next batch runs; waits for your acceptance');
  if (r.state === 'done') return tr('Accepted');
  if (r.state === 'stopped') return tr('Stopped — no next portion starts');
  // a refusal of the start in the words the Automations use (`failWord`: «<reason>: <the server's English>»)
  if (r.state === 'failed') { const w = failWord(r.error); return `${tr('Did not start')}: ${w ? tr(w) : r.error || ''}`.trim(); }
  return '';
}
