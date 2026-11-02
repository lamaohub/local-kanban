
const ROLL_MAX = 200; // lines the window of 1000 can roll between two looks: a window rolled further comes whole
const WORTH = 0.5;    // a delta holding more than this share of the screen is not worth it

function run(a, from, b) {
  let n = 0;
  while (from + n < a.length && n < b.length && a[from + n] === b[n]) n += 1;
  return n;
}

/** What makes `now` of `was`: drop the first `drop` lines, keep the next `keep`, add `add`, keep the last `tail`. `of` — the
    mark of `was`. Null when it does not pay: the whole screen goes then. Pure. */
export function screenDelta(was, now, of) {
  if (typeof was !== 'string' || typeof now !== 'string') return null;
  const a = was.split('\n');
  const b = now.split('\n');
  let drop = 0;
  let keep = run(a, 0, b);
  // the history is full: every line printed takes the oldest away, and the same lines stand higher
  if (keep < b.length / 2) {
    for (let k = 1; k <= Math.min(ROLL_MAX, a.length - 1); k += 1) {
      if (a[k] !== b[0]) continue;
      const n = run(a, k, b);
      if (n > keep) { keep = n; drop = k; }
    }
  }
  let tail = 0;
  while (tail < b.length - keep && tail < a.length - drop - keep && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  const add = b.slice(keep, b.length - tail);
  const size = add.reduce((n, l) => n + l.length + 1, 0);
  if (size > now.length * WORTH) return null;
  return { of, was: was.length, drop, keep, add, tail, n: now.length };
}

/** The screen a delta makes of `was`, or null when `was` is not the screen it was made against. Pure. */
export function applyDelta(was, d) {
  if (typeof was !== 'string' || !d || was.length !== d.was) return null;
  const a = was.split('\n');
  const now = [...a.slice(d.drop, d.drop + d.keep), ...d.add, ...(d.tail ? a.slice(-d.tail) : [])].join('\n');
  return now.length === d.n ? now : null;
}

/** An answer of the terminal with its screen whole. `base` — {screen, wraps} of the answer marked `seen`. Null when the
    delta is not against that one: the page then asks without `seen`, and the whole screen comes. */
export function wholeAnswer(r, base, seen) {
  if (!r.delta) return r;
  if (r.delta.of !== seen) return null;
  const screen = applyDelta(base?.screen, r.delta);
  if (screen === null) return null;
  const { delta, ...rest } = r;
  return { ...rest, screen, wraps: r.wraps ?? base.wraps };
}
