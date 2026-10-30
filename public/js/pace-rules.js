
/** How long nothing may change before the light says there is no answer. */
export const STALL_MS = 60_000;

/** The light's words. `inHand` — a step or a helper Claude waits on: the counter stands still by right then. */
export function paceWords(pace, inHand) {
  if (inHand || !pace || pace.compacting) return 'Claude is working…';
  if (pace.thinking) return 'Claude is thinking…';
  return pace.tokens ? 'Claude is writing…' : 'Claude is working…';
}

/** The moment the spinner last said something new: `mark` is kept while `sig` — what it says now — stays the same. */
export const paceStep = (mark, sig, now) => (mark?.sig === sig ? mark : { sig, at: now });

/** Whether Claude stopped answering: its counter stood still for STALL_MS with nothing to wait on. Only a counter says
    so: Claude Code leaves it out of a line that does not fit the window (a spinner with none is a Claude writing a long
    script as often as not), and it shows none while Claude thinks or compacts. */
export const stalled = (pace, inHand, mark, now) => Boolean(pace?.tokens && !pace.thinking && !pace.compacting && !inHand && mark && now - mark.at >= STALL_MS);
