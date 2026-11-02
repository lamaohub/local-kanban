/* The screens the terminal answered lately, by the mark of their answer, so that the next answer can be what changed
   against the one the page has. Several viewers of several sessions look every second.
   At most SCREENS_KEPT screens. The worst case is measured, not the usual one: 1000 lines of 300 columns in Cyrillic are
   300 000 characters of two bytes each, so 64 of them hold about 40 MB of the heap. A screen is copied in: what tmux answered
   is a slice of one long string with the same screen in it twice, and V8 keeps that whole string alive behind a slice (the
   same 64 screens held 77 MB).
   Nobody looks for SCREENS_TTL_MS, and a screen goes: a stopped terminal leaves nothing behind. A look that comes later
   finds no base and gets the whole screen, so the time only has to outlast the slowest look (a column with its chat, 5 s). */
import { createHash } from 'node:crypto';
import { screenDelta } from '../public/js/term-delta.js';

export const SCREENS_KEPT = 64;
export const SCREENS_TTL_MS = 30000;

const ownCopy = (str) => Buffer.from(str, 'utf8').toString('utf8');

export function createScreens({ kept = SCREENS_KEPT, ttl = SCREENS_TTL_MS } = {}) {
  const screens = new Map(); // the oldest look first
  let sweep = null;
  const sweepLater = () => {
    if (sweep || !screens.size) return;
    sweep = setTimeout(() => {
      sweep = null;
      const old = Date.now() - ttl;
      for (const [v, s] of screens) {
        if (s.at > old) break;
        screens.delete(v);
      }
      sweepLater();
    }, ttl);
    sweep.unref();
  };
  const keep = (v, term) => {
    const had = screens.get(v);
    screens.delete(v);
    screens.set(v, { screen: had?.screen ?? ownCopy(term.screen), wraps: term.wraps, at: Date.now() });
    if (screens.size > kept) screens.delete(screens.keys().next().value);
    sweepLater();
  };
  return {
    get size() { return screens.size; },
    /** What a look gets. `seen` — the mark of the answer the page drew, `delta` — it can apply a delta against that answer:
        `same` when nothing changed, what changed when that pays, or the whole of `term`, each with the mark `v`. */
    answer(term, { seen, delta: wanted } = {}) {
      // the tab looks every second, and a screen that has not changed goes as `same`
      const v = createHash('sha1').update(JSON.stringify(term)).digest('hex').slice(0, 20);
      const base = wanted ? screens.get(seen) : undefined;
      keep(v, term);
      if (seen === v) return { same: true, v };
      const delta = base && screenDelta(base.screen, term.screen, seen);
      if (!delta) return { ...term, v };
      const { screen, wraps, ...rest } = term;
      return { ...rest, delta, v, ...(JSON.stringify(wraps) === JSON.stringify(base.wraps) ? {} : { wraps }) };
    },
  };
}
