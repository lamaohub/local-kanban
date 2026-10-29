
import { open, stat, readdir, readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { db } from './db.js';
import { bus, emit } from './bus.js';
import { findTranscript, isBoardSession, taskSessions } from './claude-sessions.js';

const WORKING = new Set(['prep', 'doing', 'deploy']);
const ACTIVE = new Set(['doing', 'deploy']); // in work, not only queued
const TEXT_MAX = 600;       // a message is clipped here; the card clamps it further and expands on click
const FEED_MAX = 400;       // the newest items a card gets; the count of all of them comes along
// Tools that are bookkeeping rather than steps of the work.
const QUIET_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'TaskStop', 'ListMcpResourcesTool', 'ReadMcpResourceTool']);

const clip = (s, n = TEXT_MAX) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const firstLine = (s) => String(s ?? '').trim().split('\n')[0];
const shortPath = (p) => {
  const parts = String(p ?? '').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
};
/* Where a move cuts the transcript. task_events keep UTC 'YYYY-MM-DD HH:MM:SS', whole seconds, and the
   step that made a move is written to the transcript BEFORE the move (the call goes out, then the command
   changes the status), so a cut at the start of the stored second sent the steps of that second to the
   wrong side: `kb review` at 12.231 with the move stored as 12 fell out of the task it handed in. The cut
   is the END of the move's second. Windows still meet edge to edge (the next one starts at the same cut),
   so a step of that second is never in two windows and never between them: it goes to the stretch before
   the move. The price: when the same second also holds the step that took the next task, that one step
   shows in the feed of the task handed in. */
const eventEdge = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z') + 1000;

/** One short line about a tool call, or null for bookkeeping that is not a step of the work. */
export function toolSummary(name, input = {}) {
  if (QUIET_TOOLS.has(name)) return null;
  switch (name) {
    case 'Bash': return clip(input.description || firstLine(input.command), 160);
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit': return shortPath(input.file_path);
    case 'NotebookEdit': return shortPath(input.notebook_path);
    case 'Grep': return clip(`${input.pattern ?? ''}${input.path ? ` · ${shortPath(input.path)}` : ''}`, 160);
    case 'Glob': return clip(input.pattern, 160);
    case 'Agent': case 'Task': return clip(input.description || input.subagent_type, 160);
    case 'WebFetch': return clip(input.url, 160);
    case 'WebSearch': return clip(input.query, 160);
    case 'Skill': return clip(input.skill, 80);
    case 'AskUserQuestion': return clip(input.questions?.[0]?.question, 200);
    default: {
      // mcp__<server>__<tool>: the server and the tool read better than the raw name
      const m = /^mcp__(.+?)__(.+)$/.exec(name);
      const what = input.description || input.url || input.query || input.action || '';
      return clip(m ? `${m[1].replace(/_/g, ' ')}: ${m[2]}${what ? ` · ${what}` : ''}` : what, 160);
    }
  }
}

// What a person typed, as opposed to what the harness wraps around it: skill bodies (isMeta),
// system reminders and command wrappers (they start with a tag).
export const humanText = (s) => typeof s === 'string' && s.trim() !== '' && !s.trim().startsWith('<');
const PASTED = /<pasted_content\b[^>]*>([\s\S]*?)<\/pasted_content\b[^>]*>/g;
export const ownWords = (s) => (typeof s === 'string' ? s.replace(PASTED, (_, inner) => inner.trim()) : s);

export const resultText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return '';
};

/** The feed items one transcript line holds. Results are kept only to be paired with their call.
    A helper's own transcript is all side-chain lines, so reading one passes `sidechain`. */
export function lineItems(d, sidechain = false) {
  if (!d || typeof d !== 'object' || d.isMeta || (d.isSidechain && !sidechain)) return [];
  const at = Date.parse(d.timestamp);
  const m = d.message;
  if (!Number.isFinite(at) || !m || typeof m !== 'object') return [];
  const out = [];
  if (d.type === 'user') {
    if (typeof m.content === 'string') {
      const said = ownWords(m.content);
      if (humanText(said)) out.push({ at, kind: 'user', text: clip(said) });
    } else if (Array.isArray(m.content)) {
      for (const b of m.content) {
        const said = b?.type === 'text' ? ownWords(b.text) : null;
        if (said !== null && humanText(said)) out.push({ at, kind: 'user', text: clip(said) });
        else if (b?.type === 'tool_result') out.push({ at, kind: 'result', id: b.tool_use_id, error: Boolean(b.is_error), text: clip(resultText(b.content), 400) });
      }
    }
  } else if (d.type === 'assistant' && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) out.push({ at, kind: 'text', text: clip(b.text) });
      else if (b?.type === 'tool_use') {
        const text = toolSummary(b.name, b.input || {});
        if (text !== null) out.push({ at, kind: 'tool', id: b.id, tool: b.name, text });
      }
    }
  }
  return out;
}

/** Where a session's attention was, task by task: [{task_id, from, to, focusAt?}] in ms, `to: null` —
    still there. `focusAt` marks a window that began with an unowned stretch: it is when the task
    actually got the focus, and `from` is where the stretch began. */
export function sessionWindows(events) {
  const out = [];
  const status = new Map(); // task → the status this session last put it in
  const since = new Map();  // task → when
  let focus = null;
  let from = -Infinity;     // start of the focus stretch, or of the unowned stretch while there is no focus
  let focusAt = null;       // when the current focus began, if its window opened with an unowned stretch
  for (const e of events) {
    const at = typeof e.at === 'number' ? e.at : eventEdge(e.created_at);
    if (WORKING.has(e.status)) {
      const batchPrep = focus !== null && focus !== e.task_id && e.status === 'prep' && WORKING.has(status.get(focus));
      if (focus !== e.task_id && !batchPrep) {
        if (focus !== null) {
          out.push({ task_id: focus, from, to: at, ...(focusAt !== null ? { focusAt } : {}) });
          from = at;
          focusAt = null; // a switch hands over at once: the next task's stretch is not unowned
        }
        else focusAt = at; // `from` stays where the unowned stretch began
        focus = e.task_id;
      }
    } else if (focus === e.task_id) {
      out.push({ task_id: focus, from, to: at, ...(focusAt !== null ? { focusAt } : {}) });
      // two in left it with no focus, and the card and Claude now did not say it worked on the other; a task queued
      // in prep is not taken up yet and gets the focus when it is
      let next = null;
      for (const [id, s] of status) if (id !== e.task_id && ACTIVE.has(s) && (next === null || since.get(id) > since.get(next))) next = id;
      focus = next;
      focusAt = null;
      from = at;
    }
    status.set(e.task_id, e.status);
    since.set(e.task_id, at);
  }
  if (focus !== null) out.push({ task_id: focus, from, to: null, ...(focusAt !== null ? { focusAt } : {}) });
  return out;
}

export function sessionEvents(sid) {
  const own = db.prepare(`SELECT e.task_id, e.status, e.created_at, l.event_id IS NOT NULL AS launch FROM task_events e
    LEFT JOIN task_launches l ON l.event_id = e.id WHERE e.session_id = ? ORDER BY e.id`).all(sid);
  // a session whose kb sends no id still has no moves of its own, and borrows its unsigned ones as before
  const plain = (rows) => rows.map(({ task_id, status, created_at }) => ({ task_id, status, created_at }));
  if (own.some((e) => !e.launch) || !isBoardSession(sid)) return plain(own);
  const borrowed = db.prepare(`SELECT e.id, e.task_id, e.status, e.created_at FROM task_events e
    JOIN task_sessions s ON s.task_id = e.task_id AND s.session_id = ?
    WHERE e.session_id IS NULL AND e.created_at >= s.first_seen ORDER BY e.id`).all(sid);
  if (!own.length) return plain(borrowed);
  const launched = db.prepare('SELECT e.id, e.task_id, e.status, e.created_at FROM task_events e WHERE e.session_id = ? ORDER BY e.id').all(sid);
  return plain([...launched, ...borrowed].sort((a, b) => a.id - b.id));
}

export function trimLead(window, items) {
  if (window.focusAt === undefined) return window;
  const said = items.filter((i) => i.kind === 'user' && i.at >= window.from && i.at <= window.focusAt);
  return said.length ? { ...window, from: said[said.length - 1].at } : window;
}

/* ── reading transcripts: once, then only what was appended ─────────────────── */
const parsed = new Map(); // path → { size, items, rest: Buffer } — the session's own transcripts
const PARSED_MAX = 24;

// Reads of one transcript go one at a time. The cache entry is shared and its size and tail move
// only after a read finishes, so two readers at once (two tabs refreshing the same card on one
// task.work) read the same bytes and pushed every new step twice.
const reading = new Map(); // key → the read in progress

function oneAtATime(key, read) {
  const run = (reading.get(key) || Promise.resolve()).then(read);
  const settled = run.catch(() => {});
  reading.set(key, settled);
  settled.then(() => { if (reading.get(key) === settled) reading.delete(key); });
  return run;
}

const transcriptItems = (path) => oneAtATime(path, () => readMore(path));

const READ_CHUNK = 1 << 20;
let readChunk = READ_CHUNK;
/** Tests read in tiny pieces, so that lines and multi-byte characters cross every boundary. */
export function setReadChunk(n) { readChunk = n > 0 ? n : READ_CHUNK; }

function eachLine(text, take) {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; } // a line we cannot read is skipped, not fatal
    take(d);
  }
}

/** Read the file from `c.size` up to `size` and hand every whole line to `take`; a line still being
    written stays raw bytes in `c.rest` until it is whole. The usage count (claude-usage.js) reads the
    same transcripts through it. */
export async function readTail(path, c, size, take) {
  const fh = await open(path, 'r');
  let pending = c.rest.length ? [c.rest] : [];
  try {
    const chunk = Buffer.alloc(Math.min(readChunk, size - c.size));
    while (c.size < size) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - c.size), c.size);
      if (!bytesRead) break;
      c.size += bytesRead;
      const piece = chunk.subarray(0, bytesRead);
      const cut = piece.lastIndexOf(0x0a);
      if (cut < 0) { pending.push(Buffer.from(piece)); continue; } // the chunk is reused: keep a copy
      const whole = Buffer.concat([...pending, piece.subarray(0, cut + 1)]);
      pending = cut + 1 < piece.length ? [Buffer.from(piece.subarray(cut + 1))] : [];
      eachLine(whole.toString('utf8'), take);
    }
  } finally {
    c.rest = pending.length ? Buffer.concat(pending) : Buffer.alloc(0);
    await fh.close();
  }
}

async function readMore(path) {
  let st;
  try { st = await stat(path); } catch { return []; }
  let c = parsed.get(path);
  if (!c || st.size < c.size) c = { size: 0, items: [], rest: Buffer.alloc(0) }; // rewritten — start over
  if (st.size > c.size) await readTail(path, c, st.size, (d) => { for (const it of lineItems(d)) c.items.push(it); });
  parsed.delete(path);
  parsed.set(path, c); // most recent last; the oldest goes first when the cache is full
  if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value);
  return c.items;
}

const helperSums = new Map(); // helper transcript → { size, mtimeMs, rest, n, steps, from, last }
const metaIds = new Map();    // helper .meta.json → the tool_use id of the call that started it
const HELPERS_MAX = 2000;     // a summary is a few numbers; the cap only stops an endless growth

const remember = (map, k, v) => {
  map.delete(k);
  map.set(k, v);
  if (map.size > HELPERS_MAX) map.delete(map.keys().next().value);
};

const helperSummary = (path) => oneAtATime(`${path}\0side`, () => readHelper(path));

async function readHelper(path) {
  let st;
  try { st = await stat(path); } catch { return null; }
  let c = helperSums.get(path);
  if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
    // a helper's transcript only grows; one that shrank or changed at the same size was rewritten
    if (!c || st.size <= c.size) c = { size: 0, mtimeMs: 0, rest: Buffer.alloc(0), n: 0, steps: 0, from: Infinity, last: -Infinity, now: null };
    if (st.size > c.size) {
      await readTail(path, c, st.size, (d) => {
        for (const it of lineItems(d, true)) {
          c.n++;
          if (it.kind === 'tool') { c.steps++; c.now = { tool: it.tool, text: it.text }; }
          if (it.at < c.from) c.from = it.at;
          if (it.at > c.last) c.last = it.at;
        }
      });
    }
    c.mtimeMs = st.mtimeMs;
  }
  remember(helperSums, path, c);
  return c.n ? c : null;
}

export async function helpersOf(transcript, wanted) {
  const dir = join(dirname(transcript), basename(transcript, '.jsonl'), 'subagents');
  const out = new Map(); // tool_use id of the call that started it → {steps, from, last}
  let names = [];
  try { names = await readdir(dir); } catch { return out; }
  for (const n of names.filter((x) => x.endsWith('.meta.json'))) {
    const meta = join(dir, n);
    let id = metaIds.get(meta);
    if (id === undefined) {
      // the meta is written once, when the helper starts; one that cannot be read yet is asked again next time
      try { id = JSON.parse(await readFile(meta, 'utf8')).toolUseId || null; } catch { id = null; }
      if (id) remember(metaIds, meta, id);
    }
    if (!id || !wanted.has(id)) continue;
    // a helper we cannot read (no rights, gone between stat and open, a folder in its place) is left out,
    // not the whole feed: without the catch one such file made every feed request of the task a 500
    let sum = null;
    try { sum = await helperSummary(join(dir, n.replace(/\.meta\.json$/, '.jsonl'))); } catch { /* left out */ }
    if (sum) out.set(id, sum);
  }
  return out;
}

const LIVE_MS = 120_000; // a helper that wrote nothing for two minutes is not running anymore

const building = new Map(); // `${taskId}:${what}` → the feed being built

/** The feed of one task: the newest items across its sessions, cut to the stretches that were this task.
    `count` — only how many items there are (the tab's counter): no helpers, no items. */
export function taskFeed(taskId, { count = false } = {}) {
  const key = `${taskId}:${count ? 'n' : 'feed'}`;
  if (building.has(key)) return building.get(key);
  const p = buildFeed(taskId, count).finally(() => { if (building.get(key) === p) building.delete(key); });
  building.set(key, p);
  return p;
}

async function buildFeed(taskId, count) {
  const sessions = await taskSessions(taskId);
  const all = [];
  let total = 0;
  for (const s of sessions) {
    if (!s.transcript) continue;
    const own = sessionWindows(sessionEvents(s.session_id)).filter((w) => w.task_id === taskId);
    if (!own.length) continue;
    const parsedItems = await transcriptItems(s.transcript);
    const windows = own.map((w) => trimLead(w, parsedItems));
    const inside = (at) => windows.some((w) => at >= w.from && (w.to === null || at < w.to));
    const items = parsedItems.filter((it) => inside(it.at));
    if (count) { total += items.filter((it) => it.kind !== 'result').length; continue; }
    const calls = new Map(items.filter((i) => i.kind === 'tool').map((i) => [i.id, { ...i }]));
    const started = new Set([...calls.values()].filter((c) => c.tool === 'Agent' || c.tool === 'Task').map((c) => c.id));
    const helpers = started.size ? await helpersOf(s.transcript, started) : new Map();
    // results first: a call is printed with its outcome, which arrives in a later line — maybe past the
    // end of the window (the hand-in's own result comes after the move it made), so only calls are cut
    for (const it of parsedItems) {
      const call = it.kind === 'result' && calls.get(it.id);
      if (!call) continue;
      call.error = it.error;
      call.ms = it.at - call.at;
      if (call.tool === 'AskUserQuestion' && it.text) call.answer = it.text;
    }
    for (const it of items) {
      if (it.kind === 'result') continue;
      const row = it.kind === 'tool' ? calls.get(it.id) : { ...it };
      if (row.kind === 'tool' && helpers.has(row.id)) {
        const h = helpers.get(row.id);
        row.helper = { steps: h.steps, ms: Math.max(0, h.last - h.from), live: Date.now() - h.last < LIVE_MS };
      }
      all.push({ ...row, session: s.session_id });
    }
  }
  if (count) return { items_n: total };
  all.sort((a, b) => a.at - b.at);
  const items = all.slice(-FEED_MAX).map(({ id, ...it }) => ({ ...it, at: new Date(it.at).toISOString() }));
  return {
    items,
    items_n: all.length,
    sessions: sessions.map((s) => ({ session_id: s.session_id, transcript: s.transcript })),
  };
}

/* ── live: watch the transcripts of sessions whose tasks are in work ─────────── */
const watchers = new Map(); // transcript → { watcher, timer }
const RING_DELAY_MS = 1500; // a transcript changes many times a second while Claude works

function ring(path) {
  const w = watchers.get(path);
  if (!w || w.timer) return;
  w.timer = setTimeout(() => {
    w.timer = null;
    const rows = db.prepare(`SELECT DISTINCT t.id, (p.prefix || '-' || t.task_no) AS key
      FROM task_sessions s JOIN tasks t ON t.id = s.task_id JOIN projects p ON p.id = t.project_id
      WHERE s.transcript = ? AND t.status IN ('prep','doing','deploy')`).all(path);
    if (rows.length) emit('task.work', { ids: rows.map((r) => r.id), keys: rows.map((r) => r.key) });
  }, RING_DELAY_MS);
  w.timer.unref?.();
}

/** Bring the set of watched transcripts in line with the tasks that are in work now. */
export async function refreshWorkWatch() {
  const pending = db.prepare(`SELECT s.task_id, s.session_id FROM task_sessions s JOIN tasks t ON t.id = s.task_id
    WHERE t.status IN ('prep','doing','deploy') AND s.transcript IS NULL`).all();
  for (const r of pending) {
    const found = await findTranscript(r.session_id);
    if (found) db.prepare('UPDATE task_sessions SET transcript = ? WHERE task_id = ? AND session_id = ?').run(found, r.task_id, r.session_id);
  }
  const want = new Set(db.prepare(`SELECT DISTINCT s.transcript FROM task_sessions s JOIN tasks t ON t.id = s.task_id
    WHERE t.status IN ('prep','doing','deploy') AND s.transcript IS NOT NULL`).all().map((r) => r.transcript));
  for (const [p, w] of watchers) {
    if (!want.has(p)) { w.watcher.close(); clearTimeout(w.timer); watchers.delete(p); }
  }
  for (const p of want) {
    if (watchers.has(p)) continue;
    try {
      const watcher = watch(p, { persistent: false }, () => ring(p));
      watcher.on('error', () => { watcher.close(); watchers.delete(p); });
      watchers.set(p, { watcher, timer: null });
    } catch { /* the file is gone — nothing to watch */ }
  }
  return watchers.size;
}

/** Start watching, and keep the watched set current as tasks move in and out of work. */
export function startWorkWatch() {
  let timer = null;
  const again = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; refreshWorkWatch().catch(() => {}); }, 1000);
    timer.unref?.();
  };
  bus.on('event', (ev) => { if (ev?.type && ev.type.startsWith('task.') && ev.type !== 'task.work' && ev.type !== 'task.live') again(); });
  return refreshWorkWatch().catch(() => 0);
}
