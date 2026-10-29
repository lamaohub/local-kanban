
import { open, stat } from 'node:fs/promises';
import { findTranscript } from './claude-sessions.js';

/** Longer than this from the end of the turn, a wait for its own command reads as a wait for the person again. */
export const OWN_WAIT_MAX_MS = 2 * 3600_000;
const TAIL_STEPS = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024]; // a turn longer than 8 MB is not read: "waits for you"

/* Background work that does not end by itself: Claude does not wait for it, it keeps it running. */
const SERVICE = [
  /\bssh\b[^|;&\n]*\s-[A-Za-z]*[NLRD]/, // a tunnel: -N, -L, -R, -D
  /\btail\s+(-[A-Za-z]*[fF]|--follow)/,
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|preview|watch)\b/,
  /\b(vite|nodemon|http-server|live-server)\b|\bnext\s+(dev|start)\b|\bhttp\.server\b/,
  /\bpm2\s+logs\b|\bcaffeinate\b|(^|[\s;&|])watch\s/,
];
export const isService = (command) => SERVICE.some((re) => re.test(String(command || '')));

/** A line that starts a turn: the person's words or a notification Claude Code wakes Claude with — a `user` line that
    is not a tool's answer, not a skill text Claude Code puts in (`isMeta`), not a helper's line. */
function startsTurn(d) {
  if (d.type !== 'user' || d.isMeta || d.isSidechain) return false;
  const c = d.message?.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b) => b?.type === 'text') && !c.some((b) => b?.type === 'tool_result');
}

/** Whether a turn-starting line is a notification Claude Code woke Claude with, not the person's words. */
function woken(d) {
  const c = d.message?.content;
  const text = typeof c === 'string' ? c : (c || []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  return text.trimStart().startsWith('<task-notification>');
}

export const STOPS = new Set(['TaskStop', 'KillShell', 'KillBash']);
export const inBackground = (input) => input?.run_in_background === true || input?.run_in_background === 'true';

const MOVED = /^Command did not complete within [^\n]*? and was moved to the background \(ID: (\w+)\)/;
const FORKED = /^Skill "[^"\n]{1,200}" launched \(forked execution, running in the background\)/;
const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
/** Whether the answer `b` (a tool_result of the transcript line `d`) says its step runs on in the background: the id of
    that work ('' when the answer names none), or null. What Claude Code writes after a step is read only when the line
    holds this one answer — with several, it is nobody's — and then it alone decides. */
export function wentBackground(d, b) {
  const blocks = Array.isArray(d?.message?.content) ? d.message.content : [];
  const r = blocks.filter((x) => x?.type === 'tool_result').length === 1 ? d.toolUseResult : null;
  if (isObj(r)) {
    if (typeof r.backgroundTaskId === 'string' && r.backgroundTaskId) return r.backgroundTaskId;
    if (r.status === 'forked' && r.background === true) return typeof r.agentId === 'string' ? r.agentId : '';
    return null;
  }
  const c = b?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => String(x.text ?? '')).join('\n') : '';
  const moved = MOVED.exec(text);
  if (moved) return moved[1];
  return FORKED.test(text) ? '' : null;
}
const TURN_LINES = new Set(['assistant', 'user', 'system']);

/** From the raw lines of a transcript's end (oldest first): whether Claude waits for background work of its own —
    {own: true, at: ms of the end of the turn that started it}; {own: false} otherwise; null — no turn start among the
    lines (the turn is longer than what was read). The turns looked at: the last one, and back from it through the turns
    the person started (a question asked meanwhile does not end the wait), down to one a notification woke. */
export function ownWaitIn(lines) {
  const parsed = [];
  for (const raw of lines) {
    let d;
    try { d = JSON.parse(raw); } catch { d = null; }
    parsed.push({ d, raw });
  }
  const starts = [];
  for (let i = 0; i < parsed.length; i += 1) if (parsed[i].d && startsTurn(parsed[i].d)) starts.push(i);
  if (!starts.length) return null;
  let first = starts.length - 1;
  while (first > 0 && !woken(parsed[starts[first]].d)) first -= 1;
  const from = starts[first];
  const turnEnd = (i) => { // the time of the last line of the turn line i is in
    const next = starts.find((s) => s > i) ?? parsed.length;
    for (let j = next - 1; j > i; j -= 1) {
      const d = parsed[j].d; // not the lines Claude Code writes about its next request (`api-request`…)
      const t = TURN_LINES.has(d?.type) ? Date.parse(d.timestamp) : NaN;
      if (Number.isFinite(t)) return t;
    }
    return null;
  };
  const launched = new Map(); // tool_use id → {at, task}
  const steps = new Map();
  const stopped = new Set();  // background task ids Claude stopped itself
  for (let i = from + 1; i < parsed.length; i += 1) {
    const d = parsed[i].d;
    if (!d || d.isSidechain || !Array.isArray(d.message?.content)) continue;
    for (const b of d.message.content) {
      if (d.type === 'assistant' && b?.type === 'tool_use') {
        if (STOPS.has(b.name)) stopped.add(String(b.input?.task_id ?? b.input?.shell_id ?? ''));
        if (!b.id) continue;
        const service = b.name === 'Bash' && isService(b.input?.command);
        if (!inBackground(b.input)) { steps.set(b.id, { at: i, service }); continue; }
        if (service) continue;
        launched.set(b.id, { at: i, task: null });
      } else if (d.type === 'user' && b?.type === 'tool_result' && launched.has(b.tool_use_id)) {
        const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
        launched.get(b.tool_use_id).task = d.toolUseResult?.backgroundTaskId || /with ID: (\w+)/.exec(text)?.[1] || null;
      } else if (d.type === 'user' && b?.type === 'tool_result' && steps.has(b.tool_use_id)) {
        const task = wentBackground(d, b);
        const step = steps.get(b.tool_use_id);
        if (task !== null && !step.service) launched.set(b.tool_use_id, { at: step.at, task: task || null });
      }
    }
  }
  // its notification (or the one Claude Code queued while the turn went on) names the work that ended
  const running = [...launched].filter(([id, { at, task }]) => !(task && stopped.has(task))
    && !parsed.slice(at + 1).some((p) => p.raw.includes(`<tool-use-id>${id}</tool-use-id>`)));
  if (!running.length) return { own: false };
  return { own: true, at: turnEnd(Math.max(...running.map(([, l]) => l.at))) };
}

const paths = new Map(); // sid → transcript path
const seen = new Map();  // path → {size, mtime, result}

/** The whole lines among the last `bytes` of the file at `path` of `size` bytes (api-break.js reads the same way). */
export async function tailLines(path, size, bytes) {
  const from = Math.max(0, size - bytes);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size - from);
    await fh.read(buf, 0, buf.length, from);
    const lines = buf.toString('utf8').split('\n');
    if (from > 0) lines.shift(); // cut in the middle of a line
    return lines.filter((l) => l.trim());
  } finally { await fh.close(); }
}

/** Whether the Claude of session `sid` waits for background work of its own (see above). Read only on a change of
    the transcript; false when it is not found or not read. `known` — its transcript, when the caller has it. */
export async function waitsOwnWork(sid, now = Date.now(), known = null) {
  if (known) paths.set(sid, known);
  let path = paths.get(sid);
  if (!path) {
    path = await findTranscript(sid);
    if (!path) return false;
    paths.set(sid, path);
  }
  let st;
  try { st = await stat(path); } catch { paths.delete(sid); return false; }
  let hit = seen.get(path);
  if (!hit || hit.size !== st.size || hit.mtime !== st.mtimeMs) {
    let result = { own: false };
    try {
      for (const bytes of TAIL_STEPS) {
        const r = ownWaitIn(await tailLines(path, st.size, bytes));
        if (r) { result = r; break; }
        if (bytes >= st.size) break;
      }
    } catch { /* unreadable: say nothing new */ }
    hit = { size: st.size, mtime: st.mtimeMs, result };
    seen.set(path, hit);
    if (seen.size > 200) seen.delete(seen.keys().next().value);
  }
  const { own, at } = hit.result;
  return Boolean(own) && !(at && now - at >= OWN_WAIT_MAX_MS);
}
