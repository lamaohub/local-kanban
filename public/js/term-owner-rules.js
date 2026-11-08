/* Whose a terminal of a task is, as a look tells the page — the card's Terminal tab (GET …/terminal) and its chat
   (GET …/chat). A leaf without imports and DOM: test/term-owner-rules.test.js runs it in node.

   Two boards may share one tmux socket, and a task here may be tied to a terminal the other board started. The server
   refuses every action on it (typing, «Stop», «Continue»: reason `other-board`), and a look carries `other: {port}`.
   The page said nothing until the person pressed a button and met the refusal — now such a terminal shows one calm line
   in place of the field, «Stop» and «Continue». A tmux that did not say whose the terminal is (`other.silent`) is no
   «another board»: the field stays, and an action then is refused as a slow tmux, for this once. */

/** The port of the board that started the terminal of a look `r`, when another board did: a number, or null when the
    terminal carries no board's address at all — and undefined when it is this board's own, or tmux did not say. */
export const otherBoardOf = (r) => (r?.other && !r.other.silent ? (r.other.port ?? null) : undefined);

export const OTHER_BOARD_LINE = 'This terminal was started by another board — manage it there: port';
export const NO_BOARD_LINE = 'This terminal was not started by this board — manage it where it was started';

/** The line the page says of another board's terminal, or '' for this board's own (and for a silent tmux). */
export function otherBoardLine(r, tr = (s) => s) {
  const port = otherBoardOf(r);
  if (port === undefined) return '';
  return port ? `${tr(OTHER_BOARD_LINE)} ${port}` : tr(NO_BOARD_LINE);
}

/** What the Terminal tab offers for a look `r`: the field with its keys, «Stop» (or «Close»), «Continue», the notes over the
    screen that carry a button which types (sign in, switch to auto) — none of them on another board's terminal. */
export function termControls(r) {
  const there = Boolean(r?.session);
  const mine = there && otherBoardOf(r) === undefined;
  return { field: mine && !r.dead, stop: mine, resume: mine && Boolean(r.dead), notes: mine, other: there && !mine };
}
