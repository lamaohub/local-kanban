
const PR_STATES = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
/** The word of a request's state: 'open' | 'merged' | 'closed' (English — the page translates it). */
export const prStateWord = (pr) => PR_STATES[pr?.state] || 'open';

/** Whether the branch row offers «Open a pull request» (GET …/branch): the branch has commits the base has not, and there
    is no request yet — or the one there was is merged or closed and the branch has commits past it (`ahead_of_pr`; not
    known — offered). */
export function prButtonShown(b) {
  if (!b?.ahead) return false;
  if (!b.pr) return true;
  return b.pr.state !== 'OPEN' && b.ahead_of_pr !== 0;
}

/** The mark of a card on the board (the list's `pr`, task_prs): {number, state} — or null where it says nothing (no
    request; a task closed). */
export function prMark(t) {
  if (!t?.pr || t.status === 'done' || t.status === 'cancelled') return null;
  return { number: t.pr.number ?? null, state: prStateWord(t.pr) };
}

/** What the page says after words went to Claude, by how they went. */
export const WORDS_SAID = {
  chat: 'Sent to Claude of the task.',
  queued: 'Queued for Claude of the task — it gets them when it is free.',
  launch: 'Claude is started with these words.',
};

/** Words for the task's Claude: `post(text)` — its chat (POST …/chat); `launch()` — a start of its own with them, ONLY when
    the board has no Claude on the task (409 `gone`). Any other refusal — the queue full, a terminal of another board, the
    words not typed, an error — is the person's to see, and the words are theirs to keep: {how: 'refused', error}.
    {how: 'chat' | 'queued' | 'launch'} otherwise. */
export async function sendWords(text, { post, launch }) {
  let r;
  try { r = await post(text); } catch (e) {
    if (e?.body?.reason === 'gone') { await launch(); return { how: 'launch' }; }
    return { how: 'refused', error: e };
  }
  return { how: r?.queued ? 'queued' : 'chat' };
}
