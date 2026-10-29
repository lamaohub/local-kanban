
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { db, logError } from './db.js';
import { bus } from './bus.js';
import { findTranscript } from './claude-sessions.js';
import { lineItems, readTail, sessionEvents, sessionWindows } from './work-feed.js';

/* ── prices ─────────────────────────────────────────────────────────────────── */
const M = 1_000_000;
/** Dollars per million tokens: input, output, cache read. A cache write costs the input price × 1.25
    when kept 5 minutes and × 2 when kept an hour. `fast` — the fast mode's input and output, for the
    models that have one; `context` — the model's context window in tokens. The money the board shows
    is what these tokens would cost on the API: with a subscription it is notional. */
export const PRICE_TABLE = {
  asOf: '2026-09-25',
  source: 'Anthropic API pricing reference',
  models: {
    'claude-fable-5-1': { input: 10, output: 50, read: 0.25, context: M },
    'claude-mythos-5-1': { input: 10, output: 50, read: 0.25, context: M },
    'claude-fable-5': { input: 10, output: 50, read: 1, context: M },
    'claude-mythos-5': { input: 10, output: 50, read: 1, context: M },
    'claude-opus-5-5': { input: 4, output: 20, read: 0.2, fast: { input: 8, output: 40 }, context: M },
    'claude-opus-5': { input: 5, output: 25, read: 0.5, fast: { input: 10, output: 50 }, context: M },
    'claude-opus-4-8': { input: 5, output: 25, read: 0.5, fast: { input: 10, output: 50 }, context: M },
    'claude-opus-4-7': { input: 5, output: 25, read: 0.5, context: M },
    'claude-opus-4-6': { input: 5, output: 25, read: 0.5, context: M },
    'claude-opus-4-5': { input: 5, output: 25, read: 0.5, context: 200_000 },
    'claude-opus-4-1': { input: 15, output: 75, read: 1.5, context: 200_000 },
    'claude-opus-4-0': { input: 15, output: 75, read: 1.5, context: 200_000 },
    'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2, context: M },
    'claude-sonnet-5': { input: 2, output: 10, read: 0.2, context: M },
    'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3, context: M },
    'claude-sonnet-4-5': { input: 3, output: 15, read: 0.3, context: 200_000 },
    'claude-sonnet-4-0': { input: 3, output: 15, read: 0.3, context: 200_000 },
    'claude-3-7-sonnet': { input: 3, output: 15, read: 0.3, context: 200_000 },
    'claude-haiku-4-5': { input: 1, output: 5, read: 0.1, context: 200_000 },
    'claude-3-5-haiku': { input: 0.8, output: 4, read: 0.08, context: 200_000 },
  },
};
// the dated ids of the first Claude 4 models carry no `-0`: claude-opus-4-20250514
const ALIASES = { 'claude-opus-4': 'claude-opus-4-0', 'claude-sonnet-4': 'claude-sonnet-4-0' };

/** The table's name for a model as a transcript writes it: dated (`…-20251001`), with a cloud
    provider's prefix or suffix (`us.anthropic.…-v1:0`, `…@20250805`), or with the 1M mark (`…[1m]`). */
export function baseModel(model) {
  const m = String(model ?? '').trim().toLowerCase().replace(/\[[^\]]*\]$/, '')
    .replace(/^(?:[a-z0-9-]+\.)*anthropic\./, '').replace(/@.*$/, '').replace(/-v\d+(?::\d+)?$/, '').replace(/-\d{8}$/, '');
  return ALIASES[m] || m;
}

/** The price row of a model, or null for one the table does not know. */
export const priceOf = (model) => PRICE_TABLE.models[baseModel(model)] || null;

/** The model's context window: 1M for a `[1m]` model, the table's otherwise, null when unknown. */
export function contextWindow(model) {
  if (/\[1m\]$/i.test(String(model ?? '').trim())) return M;
  return priceOf(model)?.context ?? null;
}

/** Dollars for the tokens of one model, or null when there is no price for it (or for its fast mode). */
export function costOf(model, fast, t) {
  const p = priceOf(model);
  if (!p) return null;
  let { input, output, read } = p;
  if (fast) {
    if (!p.fast) return null;
    read *= p.fast.input / input; // the fast mode's premium covers every kind of input token alike
    ({ input, output } = p.fast);
  }
  return (t.input * input + t.output * output + t.cache_read * read + t.cache_5m * input * 1.25 + t.cache_1h * input * 2) / M;
}

/* ── one answer of the model ────────────────────────────────────────────────── */
export const KINDS = ['input', 'output', 'cache_read', 'cache_5m', 'cache_1h'];
const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

/** The tokens an answer reports, the cache write split by how long it is kept. Without the split the
    whole write is priced as kept 5 minutes. */
export function answerTokens(u) {
  const split = u && typeof u.cache_creation === 'object' && u.cache_creation ? u.cache_creation : null;
  const hour = split ? count(split.ephemeral_1h_input_tokens) : 0;
  const written = Math.max(count(u?.cache_creation_input_tokens), hour + (split ? count(split.ephemeral_5m_input_tokens) : 0));
  return { input: count(u?.input_tokens), output: count(u?.output_tokens), cache_read: count(u?.cache_read_input_tokens), cache_5m: written - hour, cache_1h: hour };
}

/** An answer of the model in a transcript line, or null. Lines Claude Code writes for itself (model
    `<synthetic>`) and lines without usage are not answers. A helper's own transcript is all side-chain
    lines, so reading one passes `sidechain`. */
export function answerOf(d, sidechain = false) {
  if (!d || typeof d !== 'object' || d.type !== 'assistant' || (d.isSidechain && !sidechain)) return null;
  const m = d.message;
  if (!m || typeof m !== 'object' || !m.usage || typeof m.usage !== 'object') return null;
  if (typeof m.model !== 'string' || !m.model || m.model === '<synthetic>') return null;
  const at = Date.parse(d.timestamp);
  if (!Number.isFinite(at)) return null;
  const calls = Array.isArray(m.content)
    ? m.content.filter((b) => b?.type === 'tool_use' && (b.name === 'Agent' || b.name === 'Task') && typeof b.id === 'string').map((b) => b.id)
    : [];
  return {
    id: String(m.id || d.requestId || d.uuid || `${at}`), at, model: m.model, fast: m.usage.speed === 'fast' ? 1 : 0,
    tokens: answerTokens(m.usage), calls,
    // an answer is final once a line of it says why it stopped; until then its output is the stream's start
    stopped: m.stop_reason !== null && m.stop_reason !== undefined,
  };
}

/** How full the conversation memory was on an answer: everything it read, cached or not. */
const contextOf = (t) => t.input + t.cache_read + t.cache_5m + t.cache_1h;

/** 'YYYY-MM-DD' of a moment in the board's own time zone — the dashboard counts days the same way. */
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── whose time it was ──────────────────────────────────────────────────────── */
/** The session's time cut into regions, in order and without gaps from -Infinity to Infinity.
    `own` — a task had the session's focus; `pre` — a stretch without focus, which goes to the task that
    took the focus after it, from the person's last word in it (`task`; undefined — nobody has taken it
    yet). A task the session is not tied to gets nothing (task null): its card would not show it either. */
export function regionsOf(windows, tied) {
  const out = [];
  for (const w of windows) {
    const task = tied.has(w.task_id) ? w.task_id : null;
    if (w.focusAt !== undefined) out.push({ a: w.from, b: w.focusAt, kind: 'pre', task });
    out.push({ a: w.focusAt ?? w.from, b: w.to ?? Infinity, kind: 'own', task });
  }
  const tail = out.length ? out[out.length - 1].b : -Infinity;
  if (tail !== Infinity) out.push({ a: tail, b: Infinity, kind: 'pre', task: undefined });
  return out;
}

/** The region a moment falls in: the last one that starts at or before it. */
export function regionAt(regions, t) {
  let lo = 0;
  let hi = regions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (regions[mid].a <= t) lo = mid; else hi = mid - 1;
  }
  return regions[lo];
}

/** What the regions say about the time up to `until` — the part of the transcript already counted:
    [where a region starts and ends, whose it is]. A stretch without focus still open there whose owner
    is not known yet is '?' — what was parked in it waits for whoever takes the focus. */
export function regionsView(regions, until) {
  if (!Number.isFinite(until)) return [];
  const out = [];
  for (const r of regions) {
    if (r.a > until) break;
    const open = r.b > until;
    out.push([`${r.a === -Infinity ? '-' : r.a}~${open ? '' : r.b}:${r.kind}`, r.task === undefined ? '?' : r.task]);
  }
  return out;
}

/** May a pass go on from where the last one stopped? Only if the regions say the same about the part
    already counted; a stretch that had no owner then ('?') may have one now — that is the common case,
    the next task taking the focus, and its parked answers go to that task. */
export function sameView(was, now) {
  if (!Array.isArray(was) || was.length !== now.length) return false;
  return was.every(([k, o], i) => k === now[i][0] && (o === '?' || o === now[i][1]));
}

/* ── reading a session ──────────────────────────────────────────────────────── */
// JSON has no -Infinity: the start of a session's first stretch is kept as null
const encA = (a) => (a === -Infinity ? null : a);
const decA = (a) => (a === null ? -Infinity : a);
const STATE_V = 1;
const blank = () => ({ v: STATE_V, offset: 0, until: null, fp: [], cur: null, park: null, calls: {}, helpers: {} });
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

function transcriptOf(sid) {
  return db.prepare('SELECT transcript FROM task_sessions WHERE session_id = ? AND transcript IS NOT NULL ORDER BY last_seen DESC LIMIT 1').get(sid)?.transcript || null;
}

/** Count what was appended to a session's transcript (and its helpers') since the last pass. */
async function countPass(sid) {
  const transcript = transcriptOf(sid) || await findTranscript(sid);
  if (!transcript) return false;
  let size;
  try { size = (await stat(transcript)).size; } catch { return false; }
  // the file is measured BEFORE the windows are read: every line counted was written before them
  const passAt = Date.now();
  const tied = new Set(db.prepare('SELECT task_id FROM task_sessions WHERE session_id = ?').all(sid).map((r) => r.task_id));
  const regions = regionsOf(sessionWindows(sessionEvents(sid)), tied);
  const saved = db.prepare('SELECT transcript, state, last FROM claude_usage_reads WHERE session_id = ?').get(sid);
  let s = saved ? parse(saved.state) : null;
  let last = (saved && parse(saved.last)) || {};
  const parkRegion = () => regions.find((r) => r.kind === 'pre' && r.a === decA(s.park.a));
  const fresh = !s || s.v !== STATE_V || saved.transcript !== transcript || size < s.offset
    || !sameView(s.fp, regionsView(regions, s.until ?? NaN)) || (s.park && !parkRegion());
  if (fresh) { s = blank(); last = {}; }

  const rows = new Map(); // `${task}\t${day}\t${model}\t${fast}` → tokens counted in this pass
  const addRow = (task, day, model, fast, t, answers, partial = 0) => {
    const k = `${task}\t${day}\t${model}\t${fast}`;
    const r = rows.get(k) || rows.set(k, { task, day, model, fast, answers: 0, partial: 0, input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0 }).get(k);
    r.answers += answers;
    r.partial += partial;
    for (const x of KINDS) r[x] += t[x];
  };
  const noteLast = (holder, key, at, model, t) => {
    if (!holder[key] || at >= holder[key].at) holder[key] = { at, model, context: contextOf(t) };
  };

  /* the parked stretch: answers in time nobody has the focus of — they go to the task that takes it next,
     from the person's last word before it, as the feed starts that task's stretch (`trimLead`) */
  const settle = (task) => {
    const p = s.park;
    s.park = null;
    if (typeof task === 'number') {
      for (const [k, t] of Object.entries(p.rows)) {
        const [day, model, fast] = k.split('\t');
        addRow(task, day, model, Number(fast), t, t.answers, t.partial || 0);
      }
      for (const id of p.calls) s.calls[id] = task;
      if (p.last && (!last[task] || p.last.at >= last[task].at)) last[task] = p.last;
      if (s.cur?.to === 'park') Object.assign(s.cur, { to: 'task', task });
    } else {
      for (const id of p.calls) s.calls[id] = null;
      if (s.cur?.to === 'park') s.cur.to = 'none';
    }
  };
  const tick = (at) => {
    if (!s.park) return;
    const r = parkRegion();
    if (r && at >= r.b) settle(r.task);
  };
  const NONE = { input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0 };
  const credit = (cur, t, answers, partial = 0) => {
    if (cur.to === 'task') addRow(cur.task, cur.day, cur.model, cur.fast, t, answers, partial);
    else if (cur.to === 'park') {
      const k = `${cur.day}\t${cur.model}\t${cur.fast}`;
      const r = s.park.rows[k] || (s.park.rows[k] = { answers: 0, partial: 0, input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0 });
      r.answers += answers;
      r.partial = (r.partial || 0) + partial;
      for (const x of KINDS) r[x] += t[x];
    }
  };
  /* a helper is the task's when the line that started it is inside the task's stretch — the feed decides
     the same by the line's own time. One answer can make several calls minutes apart (nine parallel
     helpers, one prompt after another), so the answer's start says nothing about where its calls fall */
  const place = (ids, at) => {
    if (!ids.length) return;
    const r = regionAt(regions, at);
    let owner = null;
    if (r.kind === 'own') owner = r.task;
    else if (r.task !== null) {
      if (!s.park) s.park = { a: encA(r.a), rows: {}, last: null, calls: [] };
      if (decA(s.park.a) === r.a) owner = 'park';
    }
    for (const id of ids) {
      if (owner === 'park') { if (!s.park.calls.includes(id)) s.park.calls.push(id); }
      else s.calls[id] = owner;
    }
  };
  const remember = (cur) => {
    if (cur.to === 'task') noteLast(last, cur.task, cur.at, cur.model, cur.seen);
    else if (cur.to === 'park') {
      const l = s.park.last;
      if (!l || cur.at >= l.at) s.park.last = { at: cur.at, model: cur.model, context: contextOf(cur.seen) };
    }
  };
  const answer = (a) => {
    if (s.cur && s.cur.id === a.id) {
      // another line of the answer counted last: only what it adds (the output grows to the last line)
      const more = {};
      for (const x of KINDS) { more[x] = Math.max(0, a.tokens[x] - s.cur.seen[x]); s.cur.seen[x] += more[x]; }
      s.cur.stopped ||= a.stopped;
      credit(s.cur, more, 0);
      remember(s.cur);
      return;
    }
    // the answer before this one is over: if no line of it said why it stopped, its output stayed the stream's start
    if (s.cur && !s.cur.stopped) credit(s.cur, NONE, 0, 1);
    const r = regionAt(regions, a.at);
    let to = 'none';
    if (r.kind === 'own') to = r.task === null ? 'none' : 'task';
    else if (r.task !== null) {
      if (!s.park) s.park = { a: encA(r.a), rows: {}, last: null, calls: [] };
      // an answer dated before the stretch parked now (lines out of order) is counted nowhere
      if (decA(s.park.a) === r.a) to = 'park';
    }
    s.cur = { id: a.id, at: a.at, day: localDay(a.at), model: a.model, fast: a.fast, to, task: to === 'task' ? r.task : null, seen: { ...a.tokens }, stopped: a.stopped };
    credit(s.cur, a.tokens, 1);
    remember(s.cur);
  };
  const line = (d) => {
    if (d?.type !== 'assistant' && d?.type !== 'user') return;
    const at = Date.parse(d.timestamp);
    if (!Number.isFinite(at)) return;
    s.until = Math.max(s.until ?? -Infinity, Math.min(at, passAt));
    if (d.type === 'user') {
      // the person spoke inside the stretch: what was parked before it is nobody's, the stretch starts here
      if (s.park && lineItems(d).some((i) => i.kind === 'user')) {
        const r = parkRegion();
        if (r && at >= r.a && at <= r.b) settle(null);
      }
      tick(at);
      return;
    }
    tick(at);
    const a = answerOf(d);
    if (!a) return;
    answer(a);
    place(a.calls, at);
  };

  if (size > s.offset) {
    const c = { size: s.offset, rest: Buffer.alloc(0) };
    await readTail(transcript, c, size, line);
    s.offset = c.size - c.rest.length; // a line still being written is read again, whole, next time
  }
  // the stretch's owner is known once the focus event is in: nothing written later can belong before it
  if (s.park) {
    const r = parkRegion();
    if (r && r.task !== undefined) settle(r.task);
  }
  const rewritten = await countHelpers(transcript, s, addRow);
  // a helper's transcript that shrank was rewritten: what was counted from it cannot be taken back — count anew next time
  s.fp = rewritten ? null : regionsView(regions, s.until ?? NaN);

  try {
    db.transaction(() => {
      if (fresh) db.prepare('DELETE FROM task_usage WHERE session_id = ?').run(sid);
      const up = db.prepare(`INSERT INTO task_usage (task_id, session_id, day, model, fast, answers, partial, input, output, cache_read, cache_5m, cache_1h)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (task_id, session_id, day, model, fast) DO UPDATE SET answers = answers + excluded.answers,
          partial = partial + excluded.partial, input = input + excluded.input, output = output + excluded.output,
          cache_read = cache_read + excluded.cache_read, cache_5m = cache_5m + excluded.cache_5m, cache_1h = cache_1h + excluded.cache_1h`);
      for (const r of rows.values()) up.run(r.task, sid, r.day, r.model, r.fast, r.answers, r.partial, r.input, r.output, r.cache_read, r.cache_5m, r.cache_1h);
      db.prepare(`INSERT INTO claude_usage_reads (session_id, transcript, state, last, updated_at) VALUES (?, ?, ?, ?, datetime('now'))
        ON CONFLICT (session_id) DO UPDATE SET transcript = excluded.transcript, state = excluded.state, last = excluded.last, updated_at = excluded.updated_at`)
        .run(sid, transcript, JSON.stringify(s), JSON.stringify(last));
    })();
  } catch (e) {
    // a task deleted while the transcript was being read: its rows have nowhere to go — count the session anew next time
    db.prepare('DELETE FROM claude_usage_reads WHERE session_id = ?').run(sid);
    logError('server', 'claude-usage', `usage of session ${sid} not saved: ${e.message}`);
  }
  return true;
}

/** Helpers started by calls in the task's stretches: each read on from where it stopped, all of it the
    task's. A helper started by a helper belongs where its starter does. One that cannot be read is left
    out, not the whole count. */
async function countHelpers(transcript, s, addRow) {
  const dir = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  let names = [];
  let rewritten = false;
  try { names = await readdir(dir); } catch { return rewritten; }
  for (const n of names) {
    if (!n.endsWith('.meta.json')) continue;
    const name = n.slice(0, -'.meta.json'.length);
    if (s.helpers[name]) continue;
    // the meta is written once, when the helper starts; one that cannot be read yet is asked again next time
    let meta;
    try { meta = JSON.parse(await readFile(join(dir, n), 'utf8')); } catch { continue; }
    s.helpers[name] = {
      call: typeof meta?.toolUseId === 'string' ? meta.toolUseId : null,
      parent: typeof meta?.parentAgentId === 'string' ? meta.parentAgentId : null,
      offset: 0,
      cur: null,
    };
  }
  const ownerOf = (h, depth = 0) => {
    if (h.call && Object.hasOwn(s.calls, h.call)) return s.calls[h.call];
    const up = h.parent && s.helpers[`agent-${h.parent}`];
    return up && depth < 8 ? ownerOf(up, depth + 1) : undefined;
  };
  for (const [name, h] of Object.entries(s.helpers)) {
    const task = ownerOf(h);
    if (typeof task !== 'number') continue; // nobody's, or not decided yet
    const file = join(dir, `${name}.jsonl`);
    let size;
    try { size = (await stat(file)).size; } catch { continue; }
    if (size < h.offset) { rewritten = true; continue; }
    if (size === h.offset) continue;
    const c = { size: h.offset, rest: Buffer.alloc(0) };
    // counted aside and taken only when the whole read went through: a read that broke halfway is
    // repeated next time from the same place, and what it had counted must not be counted twice
    const got = new Map(); // day, model, fast → tokens of this read
    const take = (day, model, fast, t, answers, partial = 0) => {
      const k = `${day}\t${model}\t${fast}`;
      const g = got.get(k) || got.set(k, { day, model, fast, answers: 0, partial: 0, input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0 }).get(k);
      g.answers += answers;
      g.partial += partial;
      for (const x of KINDS) g[x] += t[x];
    };
    let cur = h.cur && { ...h.cur, seen: { ...h.cur.seen } };
    try {
      await readTail(file, c, size, (d) => {
        const a = answerOf(d, true);
        if (!a) return;
        if (cur && cur.id === a.id) {
          const more = {};
          for (const x of KINDS) { more[x] = Math.max(0, a.tokens[x] - cur.seen[x]); cur.seen[x] += more[x]; }
          cur.stopped ||= a.stopped;
          take(cur.day, cur.model, cur.fast, more, 0);
          return;
        }
        if (cur && !cur.stopped) take(cur.day, cur.model, cur.fast, { input: 0, output: 0, cache_read: 0, cache_5m: 0, cache_1h: 0 }, 0, 1);
        cur = { id: a.id, day: localDay(a.at), model: a.model, fast: a.fast, seen: { ...a.tokens }, stopped: a.stopped };
        take(cur.day, a.model, a.fast, a.tokens, 1);
      });
    } catch { continue; } // no rights, gone between stat and open, a folder in its place: left out
    for (const g of got.values()) addRow(task, g.day, g.model, g.fast, g, g.answers, g.partial);
    h.cur = cur;
    h.offset = c.size - c.rest.length;
  }
  return rewritten;
}

/* One pass at a time for the whole board: a pass reads files and then writes one transaction, and two
   passes of one session at once would count the same lines twice. A pass asked for while the same
   session's pass is already waiting in the queue is that pass. */
let chain = Promise.resolve();
const queued = new Map(); // session → its pass that has not started yet

/** Count what is new in the session's transcript. Resolves when the pass is done. */
export function countSession(sid) {
  if (queued.has(sid)) return queued.get(sid);
  const p = chain.then(() => { queued.delete(sid); return countPass(sid); });
  queued.set(sid, p);
  chain = p.catch(() => {});
  return p;
}

/* ── what the card and the dashboard show ───────────────────────────────────── */
const SUM = `SUM(answers) AS answers, SUM(partial) AS partial, SUM(input) AS input, SUM(output) AS output,
  SUM(cache_read) AS cache_read, SUM(cache_5m) AS cache_5m, SUM(cache_1h) AS cache_1h`;

/** Totals of usage rows grouped by model: tokens by kind, the money of the priced part, the tokens
    of models without a price (counted, not priced), answers, and answers recorded without their final
    count (their output is the stream's start, so output and money are at least what is shown). */
export function summarize(groups) {
  const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let cost = 0;
  let priced = false;
  let unpriced = 0;
  let answers = 0;
  let partial = 0;
  const models = new Set();
  const missing = new Set();
  for (const g of groups) {
    tokens.input += g.input;
    tokens.output += g.output;
    tokens.cache_read += g.cache_read;
    tokens.cache_write += g.cache_5m + g.cache_1h;
    answers += g.answers;
    partial += g.partial || 0;
    models.add(g.model);
    const c = costOf(g.model, g.fast, g);
    if (c === null) {
      unpriced += g.input + g.output + g.cache_read + g.cache_5m + g.cache_1h;
      missing.add(g.fast ? `${g.model} (fast)` : g.model);
    } else { cost += c; priced = true; }
  }
  const total = tokens.input + tokens.output + tokens.cache_read + tokens.cache_write;
  return {
    tokens, total, answers, partial_answers: partial,
    cost: priced ? Math.round(cost * 1e6) / 1e6 : null,
    unpriced, unpriced_models: [...missing], models: [...models],
  };
}

/** The task's usage from what is counted, or null when nothing is: tokens, money, and how full the
    conversation memory was on the last answer of the session's own (helpers are not its memory). */
export function usageSummary(taskId) {
  const groups = db.prepare(`SELECT model, fast, ${SUM} FROM task_usage WHERE task_id = ? GROUP BY model, fast`).all(taskId);
  let ctx = null;
  for (const r of db.prepare(`SELECT r.last FROM claude_usage_reads r
    JOIN task_sessions s ON s.session_id = r.session_id AND s.task_id = ?`).all(taskId)) {
    const l = parse(r.last)?.[taskId];
    if (l && (!ctx || l.at > ctx.at)) ctx = l;
  }
  if (!groups.length && !ctx) return null;
  return {
    ...summarize(groups),
    context: ctx ? { tokens: ctx.context, window: contextWindow(ctx.model), model: ctx.model, at: new Date(ctx.at).toISOString() } : null,
    prices_as_of: PRICE_TABLE.asOf,
  };
}

/** The task's usage, its sessions counted up to now first (each pass reads only what is new; a session
    whose transcript is not found yet is looked for by its id, at most once a minute). */
export async function taskUsage(taskId) {
  for (const { session_id: sid } of db.prepare('SELECT session_id FROM task_sessions WHERE task_id = ?').all(taskId)) {
    try { await countSession(sid); } catch (e) { logError('server', 'claude-usage', `counting session ${sid}: ${e.message}`); }
  }
  return usageSummary(taskId);
}

/** Usage since a local day across the board, and the tasks that cost the most; archived projects do
    not count, as nowhere on the dashboard. */
export function usageSince(day, top = 6) {
  const rows = db.prepare(`SELECT u.task_id, u.model, u.fast, ${SUM.replace(/SUM\((\w+)\)/g, 'SUM(u.$1)')}
    FROM task_usage u JOIN tasks t ON t.id = u.task_id JOIN projects p ON p.id = t.project_id AND p.archived = 0
    WHERE u.day >= ? GROUP BY u.task_id, u.model, u.fast`).all(day);
  const byTask = new Map();
  for (const r of rows) (byTask.get(r.task_id) || byTask.set(r.task_id, []).get(r.task_id)).push(r);
  const info = db.prepare(`SELECT (p.prefix || '-' || t.task_no) AS key, t.title, p.name AS project, t.status
    FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`);
  const tasks = [...byTask].map(([id, groups]) => ({ id, ...summarize(groups) }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.total - a.total)
    .slice(0, top)
    .map(({ id, total, cost, unpriced, tokens, partial_answers }) => ({ ...info.get(id), total, cost, unpriced, tokens, partial_answers }));
  return { since: day, ...summarize(rows), tasks, prices_as_of: PRICE_TABLE.asOf };
}

/* ── keeping it current ─────────────────────────────────────────────────────── */
function countTask(id) {
  for (const r of db.prepare('SELECT DISTINCT session_id FROM task_sessions WHERE task_id = ? AND transcript IS NOT NULL').all(id)) {
    countSession(r.session_id).catch(() => {});
  }
}

/** Keep the counts current: on a transcript of a task in work growing (`task.work`) and on a task
    changing its status (the stretch closed, helpers finishing), and once in the background for the
    sessions never counted — one at a time with a pause, so that a start does not read gigabytes at once. */
export function startUsageWatch({ delayMs = 20_000, gapMs = 1_000 } = {}) {
  bus.on('event', (ev) => {
    if (ev?.type === 'task.work') for (const id of ev.data?.ids || []) countTask(id);
    else if (ev?.type === 'task.updated' && ev.data?.prev_status && ev.data.prev_status !== ev.data.status) countTask(ev.data.id);
  });
  const later = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
  const backfill = async () => {
    await later(delayMs);
    const sids = db.prepare(`SELECT DISTINCT s.session_id FROM task_sessions s
      WHERE NOT EXISTS (SELECT 1 FROM claude_usage_reads r WHERE r.session_id = s.session_id)`).all().map((r) => r.session_id);
    for (const sid of sids) {
      await countSession(sid).catch(() => {});
      await later(gapMs);
    }
    return sids.length;
  };
  return backfill().catch(() => 0);
}
