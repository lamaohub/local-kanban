/* What a repaint of the chat brought in — a leaf without the DOM, so a test runs it in node. The chat draws its turns
   anew on every look (innerHTML), and whatever came in — Claude's words, a new run of steps, the bar of a turn that
   ended, the line of what Claude does now — stood there at once, the end of the chat jumping up by its height. The page
   compares what it showed with what it shows now and moves only what is new (chat.js, `settle`). */

/** The blocks of the turns a chat shows: [{at, blocks: [{kind, label, words}]}] in order, from the page.
    `kind` — the block's first class; `label` — what a run line says (it changes in place: «Running a command» →
    «Ran a command»); `words` — the person's words of a bubble, to tell them from a bubble «sending…» that took its place. */
export function freshBlocks(before, after, sent = []) {
  if (!before?.length || !after?.length) return [];
  const was = new Map(before.map((t) => [t.at, t.blocks]));
  // turns over the first one known came with «Show earlier», or the chat is another one altogether: nothing moves
  const first = after.findIndex((t) => was.has(t.at));
  if (first < 0) return [];
  const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const fromSent = (b) => b.kind === 'chat-user' && Boolean(flat(b.words))
    && sent.some((w) => flat(w) && flat(b.words).includes(flat(w).slice(0, 60)));
  const out = [];
  after.forEach((t, ti) => {
    if (ti < first) return;
    const old = was.get(t.at) || [];
    let j = 0;
    t.blocks.forEach((b, bi) => {
      const o = old[j];
      const same = o?.kind === b.kind;
      // the person's words the bubble «sending…» showed already come in quietly: the same words, moved into the turn
      if (fromSent(b) && !same) return;
      if (!o) { out.push({ turn: ti, block: bi, how: 'rise' }); return; }
      if (same) {
        j += 1;
        if (flat(o.label) !== flat(b.label)) out.push({ turn: ti, block: bi, how: 'label' });
        return;
      }
      if (!t.blocks.slice(bi + 1).some((x) => x.kind === o.kind)) j += 1; // changed in place; else put in before it
      out.push({ turn: ti, block: bi, how: 'fade' });
    });
  });
  return out;
}

/** How far the chat's words glide after a repaint held the reader at the end: the scroll moved by that much, and what
    they read jumped — up by what came in, down when a turn ended and folded into its bar. Nothing by more than the view:
    that is no step to follow. */
export function glideBy(fromTop, toTop, view) {
  const d = Math.round(toTop - fromTop);
  return d !== 0 && Math.abs(d) < view ? d : 0;
}

/** The parts of the line over the field whose words changed — `before`/`after`: {words, now}; null — no line. */
export function liveChanged(before, after) {
  if (!before || !after) return [];
  return ['words', 'now'].filter((k) => (before[k] || '') !== (after[k] || '') && Boolean(after[k]));
}
