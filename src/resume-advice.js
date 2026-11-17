import { priceOf } from './claude-usage.js';

export const RESUME_IDLE_MS = 3600_000;     // the cache of a conversation lives an hour
export const RESUME_BIG_TOKENS = 300_000;   // below this, rereading is cheap enough not to ask
const WRITE_1H = 2;                         // a cache write kept an hour costs the input price × 2

/** The advice for continuing a conversation of `tokens` (the size of its last request) on `model`, last answered at `at`
    (ms): null — just continue; else {tokens, idle_ms, cost} (cost in dollars, null for a model with no price). */
export function resumeAdvice({ tokens, model, at, thirdParty = false } = {}, now = Date.now()) {
  if (!Number.isFinite(tokens) || !Number.isFinite(at)) return null;
  const idle = now - at;
  if (idle < RESUME_IDLE_MS || tokens < RESUME_BIG_TOKENS) return null;
  const p = thirdParty ? null : priceOf(model);
  return { tokens, idle_ms: idle, cost: p ? Math.round((tokens / 1e6) * p.input * WRITE_1H * 100) / 100 : null, model: model || null };
}
