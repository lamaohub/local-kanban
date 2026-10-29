
/** The longest a screen keeps the old picture while Claude Code prints the new one — counted from the first change. */
export const REPRINT_HOLD_MS = 8000;

const RULE = /^─{8,}/;
const TAIL = 8000; // the last rows are enough: the screen keeps a thousand of them

/** Whether Claude Code has printed its screen for a window `cols` wide: the input box at the bottom (a rule, then the
    line with ❯) is drawn last, and its rule is as wide as the window. The box of the old width is narrower or wider;
    an old rule twice as wide, wrapped by tmux in two, has a rule right above it (the real box has words there). A
    dialog without the box under it waits out the hold. */
export function reprinted(text, cols) {
  if (!cols) return true;
  const lines = String(text || '').slice(-TAIL).split('\n').filter((l) => l.trim()).slice(-14);
  for (let i = lines.length - 2; i >= 0; i--) {
    if (RULE.test(lines[i]) && /^\s*❯/.test(lines[i + 1])) {
      const width = [...lines[i].trimEnd()].length;
      return width >= cols - 2 && width <= cols && !(i > 0 && RULE.test(lines[i - 1]));
    }
  }
  return false;
}

/** The end of the hold after the window changed its width from `was` to `now` (ms): a hold on its way keeps its end —
    a window that keeps changing does not freeze the screen for good. 0 — no hold. */
export function holdUntil(hold, was, now, at = Date.now()) {
  if (!was || !now || was === now) return hold;
  return hold || at + REPRINT_HOLD_MS;
}
