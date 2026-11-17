import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { db } from './db.js';
import { findTranscript } from './claude-sessions.js';

export const START_DAYS = 14;
export const START_NORM_TOKENS = 70_000;
const HEAD_MAX = 4 * 1024 * 1024;          // the first requests are in the first megabytes even of a long session
const CHUNK = 256 * 1024;
const MEDIAN_MIN = 1;

const tokensOf = (u) => (u?.input_tokens || 0) + (u?.cache_creation_input_tokens || 0) + (u?.cache_read_input_tokens || 0);
const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text || '').join('\n') : '');

/** The start of one transcript from its lines (oldest first): {first, with_skill, parts: {instructions, skills, mcp, tools,
    system, kanban}} — tokens of the first request and of the first one after the kanban skill was loaded (null when not
    there), parts in characters. null — no request in the lines. A leaf rule: the test runs it on made-up lines. */
export function startOf(lines) {
  const parts = { instructions: 0, skills: 0, mcp: 0, tools: 0, system: 0, kanban: 0 };
  let first = null;
  let withSkill = null;
  let skillAt = -1;
  let answers = 0;
  const seen = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    let d;
    try { d = JSON.parse(lines[i]); } catch { continue; }
    if (!d || d.isSidechain) continue;
    if (d.type === 'attachment' && first === null) {
      const a = d.attachment || {};
      if (a.type === 'instructions' || a.type === 'nested_memory') {
        for (const f of Array.isArray(a.files) ? a.files : []) parts.instructions += String(f?.content || '').length;
        if (a.type === 'nested_memory' && typeof a.content === 'string') parts.instructions += a.content.length;
      } else if (a.type === 'skill_listing') parts.skills += String(a.content || '').length;
    }
    if (d.type === 'attachment' && answers < 2 && (d.attachment?.type === 'deferred_tools_delta' || d.attachment?.type === 'mcp_instructions_delta')) {
      // servers connect a moment after the start — their descriptions up to the second request count (later ones are
      // servers added mid-work, not the start set)
      const r = d.rendered ?? d.attachment;
      parts.mcp += typeof r === 'string' ? r.length : JSON.stringify(r).length;
    }
    if (d.type === 'api-request-shape' && !parts.tools) {
      parts.tools = JSON.stringify(d.shape?.tools ?? '').length;
      parts.system = JSON.stringify(d.shape?.system ?? '').length;
    }
    if (d.type === 'user' && skillAt < 0) {
      const t = textOf(d.message?.content);
      if (t.startsWith('Base directory for this skill:') && /\/kanban\s*$/.test(t.split('\n')[0])) { parts.kanban = t.length; skillAt = i; }
    }
    if (d.type === 'assistant' && d.message?.usage && d.message.model !== '<synthetic>') {
      const id = d.message.id || `line${i}`;
      if (seen.has(id)) continue;
      seen.add(id);
      answers += 1;
      if (first === null) first = tokensOf(d.message.usage);
      else if (skillAt >= 0 && withSkill === null) { withSkill = tokensOf(d.message.usage); break; }
    }
  }
  return first === null ? null : { first, with_skill: withSkill, parts };
}

const known = new Map(); // transcript path → {size it was read at, result}; a result with the skill measured is final
async function headLines(path) {
  const fh = await open(path, 'r');
  try {
    const lines = [];
    let pos = 0;
    let rest = '';
    let skill = false;
    let more = 2; // chunks with an answer after the skill — one is enough, the second covers a line cut at the edge
    const dec = new StringDecoder('utf8'); // a letter cut by the edge of a chunk is not broken
    while (pos < HEAD_MAX) {
      const buf = Buffer.alloc(CHUNK);
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      pos += bytesRead;
      const parts = (rest + dec.write(buf.subarray(0, bytesRead))).split('\n');
      rest = parts.pop();
      lines.push(...parts);
      // parsed once, at the end — not after every chunk; the read stops once the request after the skill is in sight
      if (!skill) skill = parts.some((l) => l.includes('Base directory for this skill:') && /\/kanban\\n/.test(l));
      else if (parts.some((l) => l.includes('"type":"assistant"') && l.includes('"usage"'))) { more -= 1; if (more <= 0) break; }
    }
    if (rest) lines.push(rest);
    return lines;
  } finally { await fh.close(); }
}
async function sessionStart(sid) {
  const path = await findTranscript(sid);
  if (!path) return null;
  let st;
  try { st = await stat(path); } catch { return null; }
  const k = known.get(path);
  if (k && (k.final || k.size === st.size)) return k.result;
  let result = null;
  try { result = startOf(await headLines(path)); } catch { result = null; }
  // final: the request with the skill is in, or the head is long past where a start set ends (a session of no skill)
  known.set(path, { size: st.size, result, final: Boolean(result && (result.with_skill !== null || st.size > HEAD_MAX)) });
  if (known.size > 2000) known.delete(known.keys().next().value);
  return result;
}

const median = (xs) => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length < MEDIAN_MIN) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
};

/** The start set of every live project with sessions of the last `days`: sorted, the heaviest first. */
export async function startView({ days = START_DAYS, now = Date.now() } = {}) {
  const since = new Date(now - days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`SELECT DISTINCT p.slug, p.name, s.session_id AS sid FROM task_sessions s
    JOIN tasks t ON t.id = s.task_id JOIN projects p ON p.id = t.project_id
    WHERE p.archived = 0 AND s.first_seen >= ?`).all(since);
  const byProject = new Map();
  for (const r of rows) {
    const p = byProject.get(r.slug) || byProject.set(r.slug, { slug: r.slug, name: r.name, sids: new Set() }).get(r.slug);
    p.sids.add(r.sid);
  }
  const out = [];
  for (const p of byProject.values()) {
    const starts = [];
    for (const sid of p.sids) { const s = await sessionStart(sid); if (s) starts.push(s); }
    if (!starts.length) continue;
    const first = median(starts.map((s) => s.first));
    out.push({
      slug: p.slug, name: p.name, sessions: starts.length, first, with_skill: median(starts.map((s) => s.with_skill)),
      parts: Object.fromEntries(Object.keys(starts[0].parts).map((k) => [k, median(starts.map((s) => s.parts[k]))])),
      over: first !== null && first > START_NORM_TOKENS,
    });
  }
  out.sort((a, b) => (b.first ?? 0) - (a.first ?? 0));
  return { days, norm: START_NORM_TOKENS, projects: out };
}
