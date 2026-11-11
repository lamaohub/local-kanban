export const LOOK_SLOW_MS = 500;
export const LOOK_REST_MAX_MS = 10_000;

/** The pause before the next look: `base` after a quick answer, twice `took` (ms) after a slow one, at most LOOK_REST_MAX_MS. */
export function lookPause(base, took) {
  if (!(took >= LOOK_SLOW_MS)) return base;
  return Math.max(base, Math.min(LOOK_REST_MAX_MS, 2 * took));
}

/** Runs `f` and reports how long it took (ms) to `done(took)`, whatever it ended with. */
export async function timed(f, done) {
  const at = Date.now();
  try { return await f(); } finally { done(Date.now() - at); }
}
