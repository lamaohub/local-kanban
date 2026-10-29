
import { kvGet, kvSet } from './db.js';

export const LIMITS_KEY = 'claude.limits';
export const WINDOWS = ['five_hour', 'seven_day', 'spend_limit'];
// two readings of one window can carry reset times a few seconds apart (rounding on the server side)
const SAME_WINDOW_S = 300;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* One window as the status line spells it → { used, resets_at[, used_usd, limit_usd, period] }, or null.
   `resets_at` is Unix seconds; a value in milliseconds is taken as such, anything outside 2001–5138 is
   refused (a number that cannot be a time). `used` is a percentage: 0–100, past 100 on an exceeded
   spend limit — capped at 1000 so a broken value cannot pass for one. */
export function normalizeWindow(w) {
  if (!w || typeof w !== 'object' || Array.isArray(w)) return null;
  const used = num(w.used_percentage);
  let resets = num(w.resets_at);
  if (used === null || used < 0 || used > 1000) return null;
  if (resets !== null && resets > 1e11) resets = Math.round(resets / 1000); // milliseconds
  if (resets === null || resets < 1e9 || resets > 1e11) return null;
  const out = { used: Math.round(used * 10) / 10, resets_at: Math.round(resets) };
  if (num(w.used_usd) !== null) out.used_usd = num(w.used_usd);
  if (num(w.limit_usd) !== null) out.limit_usd = num(w.limit_usd);
  if (typeof w.period === 'string' && /^[a-z_]{1,20}$/.test(w.period)) out.period = w.period;
  return out;
}

/* The `rate_limits` object of the status line → { five_hour?, seven_day?, spend_limit? } with only the
   windows that hold a usable reading. Unknown keys are dropped at the door. */
export function normalizeLimits(rateLimits) {
  const out = {};
  if (!rateLimits || typeof rateLimits !== 'object' || Array.isArray(rateLimits)) return out;
  for (const k of WINDOWS) {
    const w = normalizeWindow(rateLimits[k]);
    if (w) out[k] = w;
  }
  return out;
}

/* Merge a new reading into what the board holds, window by window. Returns the merged windows. */
export function mergeLimits(held = {}, incoming = {}, nowS = Date.now() / 1000) {
  const out = {};
  for (const k of WINDOWS) {
    const a = held[k] && held[k].resets_at > nowS ? held[k] : null; // a reset window is gone
    const b = incoming[k] && incoming[k].resets_at > nowS ? incoming[k] : null;
    if (!a || !b) { if (a || b) out[k] = a || b; continue; }
    if (Math.abs(a.resets_at - b.resets_at) <= SAME_WINDOW_S) out[k] = b.used >= a.used ? b : a;
    else out[k] = b; // a new window after a reset, or another account's (see the top of the file)
  }
  return out;
}

const sameWindows = (a = {}, b = {}) => WINDOWS.every((k) => (a[k]?.used ?? null) === (b[k]?.used ?? null)
  && (a[k]?.resets_at ?? null) === (b[k]?.resets_at ?? null));

export function readLimits() {
  try {
    const v = JSON.parse(kvGet(LIMITS_KEY) || 'null');
    return v && typeof v === 'object' && v.windows ? v : null;
  } catch { return null; }
}

/* Take one reading. `at` is when the board received a reading last — the footer prints it. Returns
   { snapshot, changed } — `changed` when a figure or a window moved, so the page is told only then. */
export function takeReading({ rate_limits: rateLimits, model } = {}, nowMs = Date.now()) {
  const incoming = normalizeLimits(rateLimits);
  if (!Object.keys(incoming).length) return { snapshot: readLimits(), changed: false, ignored: true };
  const held = readLimits();
  const windows = mergeLimits(held?.windows, incoming, nowMs / 1000);
  const snapshot = { windows, at: new Date(nowMs).toISOString() };
  if (typeof model === 'string' && /^[\w.[\]:-]{1,80}$/.test(model)) snapshot.model = model;
  kvSet(LIMITS_KEY, JSON.stringify(snapshot));
  return { snapshot, changed: !held || !sameWindows(held.windows, windows) };
}

/* What the page gets: the windows still running, and when the board heard last. */
export function currentLimits(nowMs = Date.now()) {
  const held = readLimits();
  if (!held) return { windows: {}, at: null };
  const windows = {};
  for (const k of WINDOWS) if (held.windows[k] && held.windows[k].resets_at > nowMs / 1000) windows[k] = held.windows[k];
  return { windows, at: held.at, ...(held.model ? { model: held.model } : {}) };
}
