
/** Whether the board is open on a phone: a touch screen with no pointer that hovers, its shorter side under 600 points. */
export function onPhone(g = globalThis) {
  try {
    if (!g.matchMedia?.('(hover: none) and (pointer: coarse)').matches) return false;
    const s = g.screen;
    return Boolean(s && Math.min(s.width, s.height) < 600);
  } catch { return false; }
}

/** The settings a phone starts with instead of the computer's (`kb.set.*`). */
export const PHONE_DEFAULTS = { theme: 'dark', chatView: 'chat' };
/** The view of Claude now a phone starts with: the runs as columns, each a chat (with PHONE_DEFAULTS.chatView). */
export const PHONE_NOW_VIEW = 'terms';
