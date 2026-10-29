// no DOM — so test/claude-asks.test.js runs it in node.

/** The value of the "Other" option: the answer is the text typed next to it. */
export const OTHER = '__other__';

export function leftoverWords(values) {
  const seen = new Set();
  return values.map((v) => String(v ?? '').trim()).filter((v) => v && !seen.has(v) && seen.add(v)).join('\n');
}

export function intoField(current, words) {
  const now = String(current ?? '');
  if (!words || now.includes(words)) return now;
  return now.trim() ? `${now.replace(/\s+$/, '')}\n${words}` : words;
}

/** What a permission request is about, as the person needs to see it before saying yes: the whole command, the
    file, the address — never cut short. A long command scrolls in its box; a cut one could hide its dangerous
    tail behind a harmless start. */
export function askSummary(a) {
  const i = a && a.input && typeof a.input === 'object' ? a.input : {};
  switch (a && a.tool) {
    case 'Bash': return String(i.command ?? '');
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return String(i.file_path ?? '');
    case 'NotebookEdit': return String(i.notebook_path ?? '');
    case 'WebFetch': return String(i.url ?? '');
    case 'WebSearch': return String(i.query ?? '');
    default: return JSON.stringify(i, null, 2);
  }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The waiting requests after a GET /api/asks. The event stream is newer than a list fetched before it ended:
    what it removed meanwhile (`gone`) is not brought back, and what it brought after the fetch began — events are
    numbered, `seq` above `from` — is kept if the list does not have it yet. Everything else is the list's word:
    a request missing from it is over, even if its `ask.removed` was missed while the page was offline. */
export function mergeAsks(list, current, gone, from) {
  const late = current.filter((a) => a.seq > from && !list.some((x) => x.id === a.id));
  return [...list.filter((a) => !gone.has(a.id)), ...late];
}

/** What the card says when a request leaves it (`ask.removed`): null for nothing, else an English note (it has a
    translation). `sentHere` — this page sent an answer to it. A request whose answer reached Claude leaves as
    'decided'; any other way out means no answer from the board got there — not even one this page sent: the board
    takes an answer while no poll is open (the hook may be between two polls), and when the hook was in fact already
    gone, nobody picks it up. Letting the block vanish then, as after a delivery, would pass that answer off as given. */
export function removalNote(outcome, sentHere) {
  if (outcome === 'decided') return null;
  if (outcome === 'expired') return 'Claude stopped waiting for an answer here';
  return sentHere ? 'Your answer did not reach Claude — it already has one from its own window' : 'Claude already has an answer — given in its own window';
}

/** What the card says when the board refused an answer sent from it because the request is over — `reason` of the
    refusal: another tab of the board answered first ('board'), Claude stopped waiting ('expired'), the board does
    not know the request at all ('unknown' — restarted since the request came when `startedAt`, the board's start,
    is after `createdAt`, the request's), else Claude took an answer in its own window. An English note (it has a
    translation). */
export function refusedNote(reason, { startedAt, createdAt } = {}) {
  if (reason === 'board') return 'Another tab of the board answered first — Claude has that answer';
  if (reason === 'expired') return removalNote('expired', false);
  if (reason === 'unknown') {
    return Date.parse(startedAt) > Date.parse(createdAt)
      ? 'The board was restarted and lost this request — answer Claude in its own window'
      : 'This request is no longer waiting on the board';
  }
  return removalNote('gone', false);
}

/** What the card says about a request missing from the list when the page reads it again — the page had no
    connection when it went, so no `ask.removed` told it. `fate` is what GET /api/asks/:id answers, null for a request
    the board does not know (with `startedAt` from that answer); the rest as in `removalNote`. */
export function missedNote(fate, { startedAt, createdAt, sentHere = false } = {}) {
  if (!fate) return refusedNote('unknown', { startedAt, createdAt });
  return fate.state === 'ended' ? removalNote(fate.outcome, sentHere) : null;
}

/** The questions of an AskUserQuestion as the card shows and answers them: an entry that is not a question with a
    text is left out — the board skips it the same way (decisionFor in src/claude-asks.js) — and so is an option
    without a label. One broken entry must not take the whole block down. */
export function questionsOf(a) {
  const qs = a && isObj(a.input) && Array.isArray(a.input.questions) ? a.input.questions : [];
  return qs.filter((q) => isObj(q) && typeof q.question === 'string').map((q) => ({
    ...q,
    options: (Array.isArray(q.options) ? q.options : []).filter((o) => isObj(o) && typeof o.label === 'string' && o.label !== ''),
  }));
}

/** The answer the board sends: {behavior, message?, answers?}. `form` is what the person filled in —
    {reason} for a permission or a plan, {reason, picks: [{checked: [values], other}]} for a question, one pick
    per question of `questionsOf`. Throws an English message (it has a translation) when the answer is not complete. */
export function answerBody(a, allow, form = {}) {
  const reason = String(form.reason || '').trim();
  if (!allow) return reason ? { behavior: 'deny', message: reason } : { behavior: 'deny' };
  if (a.kind !== 'question') return { behavior: 'allow' };
  if (reason) throw new Error('The line at the bottom goes with Decline — put a note under a question to answer with it');
  const picks = Array.isArray(form.picks) ? form.picks : [];
  const answers = {};
  const annotations = {};
  questionsOf(a).forEach((q, i) => {
    const p = picks[i] || { checked: [] };
    const chosen = [];
    for (const v of p.checked || []) {
      if (v !== OTHER) { chosen.push(v); continue; }
      const own = String(p.other || '').trim();
      if (!own) throw new Error('Write your own answer or pick an option');
      chosen.push(own);
    }
    if (!chosen.length) throw new Error('Answer every question');
    answers[q.question] = q.multiSelect ? chosen : chosen[0];
    const note = String(p.note || '').trim();
    if (note) annotations[q.question] = { notes: note };
  });
  // the notes go to Claude Code as its own form sends them: `annotations` by question → {notes}
  return Object.keys(annotations).length ? { behavior: 'allow', answers, annotations } : { behavior: 'allow', answers };
}
