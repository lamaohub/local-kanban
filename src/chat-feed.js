
import { open, stat } from 'node:fs/promises';
import { watch } from 'node:fs';
import { createHash } from 'node:crypto';
import { emit } from './bus.js';
import { helpersOf, humanText, ownWords, readTail, resultText, toolSummary } from './work-feed.js';
import { inBackground, STOPS, wentBackground } from './own-wait.js';

export const CHAT_TEXT_MAX = 20000;  // a message longer than this is cut, with "…"
export const TURNS_DEFAULT = 15;     // the newest turns a chat gets; "earlier" asks for more
export const TURNS_MAX = 200;
const isObj = (x) => Boolean(x) && typeof x === 'object' && !Array.isArray(x);
const INTERRUPTED = /^\[Request interrupted by user/;
const HELPER_TOOLS = new Set(['Agent', 'Task']);

/** The end of background work Claude Code tells Claude about: {id, status, ms?, steps?} of the step that started it. */
const NOTE_ID = /<tool-use-id>([^<\s]+)<\/tool-use-id>/;
const NOTE_STATUS = /<status>([^<\s]+)<\/status>/;
export function notification(d) {
  let text = null;
  let usage = null;
  if (d.type === 'queue-operation' && d.operation === 'enqueue') text = d.content;
  else if (d.type === 'attachment' && d.attachment?.type === 'queued_command') ({ prompt: text, usage } = d.attachment);
  else if (d.type === 'user') { // Claude Code before 2.1.300 woke Claude with a line of the user
    const c = d.message?.content;
    text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : null;
  }
  if (typeof text !== 'string' || !text.trimStart().startsWith('<task-notification>')) return null;
  const id = NOTE_ID.exec(text)?.[1];
  if (!id) return null;
  return {
    id, status: NOTE_STATUS.exec(text)?.[1] || 'completed',
    ...(Number.isFinite(usage?.durationMs) ? { ms: usage.durationMs } : {}),
    ...(Number.isFinite(usage?.toolUses) ? { steps: usage.toolUses } : {}),
  };
}

export function editSize(r) {
  if (!r || typeof r !== 'object' || typeof r.filePath !== 'string') return null;
  let add = 0;
  let del = 0;
  for (const h of Array.isArray(r.structuredPatch) ? r.structuredPatch : []) {
    for (const l of Array.isArray(h?.lines) ? h.lines : []) {
      if (typeof l !== 'string') continue;
      if (l.startsWith('+')) add++;
      else if (l.startsWith('-')) del++;
    }
  }
  if (!add && !del && r.type === 'create' && typeof r.content === 'string' && r.content) add = r.content.replace(/\n$/, '').split('\n').length;
  return { add, del };
}

const clip = (s, n = CHAT_TEXT_MAX) => {
  const t = String(s ?? '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function modelOf(d) {
  const m = d?.type === 'assistant' && !d.isSidechain ? d.message?.model : null;
  return typeof m === 'string' && /^claude-[\w.-]{1,60}$/.test(m) ? m : null;
}

export const PICTURE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export function pictureOf(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return null;
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext && PICTURE_TYPES[ext] ? path : null;
}
/** The picture file a step of this transcript read — by the step's id; null when there is no such step. */
export async function chatPicture(path, toolId) {
  const c = path ? await itemsOf(path) : null;
  const read = c?.items.find((it) => it.kind === 'tool' && it.id === toolId && it.picture);
  // only a read that went: a picture Claude Code refused to read (its rules, a file not there then) is not served
  const done = read && c.items.find((it) => it.kind === 'result' && it.id === toolId);
  return done && !done.error ? read.picture : null;
}

export const PICTURE_MAX = 25 * 1024 * 1024; // a picture shown whole — larger is not a screenshot
const SHOTS_MAX = 100; // pictures of one line offered (SHOT_RE: two digits)
const READ_CHUNK = 1024 * 1024;
const SHOT_LINE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const SHOT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,2})$/;
const PICTURE_MEDIA = new Set(Object.values(PICTURE_TYPES));
/** The type of a picture by its first bytes (PNG, JPEG, GIF, WebP), null for anything else. */
export function pictureKindOf(head) {
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const JPEG_HEAD = 16384; // base64 characters (12 KB) read for the size of a JPEG
function exifTurned(seg) {
  if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return false;
  const t = seg.subarray(6);
  const le = t.toString('latin1', 0, 2) === 'II';
  const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  try {
    const ifd = le ? t.readUInt32LE(4) : t.readUInt32BE(4);
    for (let k = 0, n = u16(ifd); k < n; k++) if (u16(ifd + 2 + k * 12) === 0x0112) return u16(ifd + 2 + k * 12 + 8) >= 5;
  } catch { /* cut short: not turned */ }
  return false;
}
function jpegSize(b) {
  let turned = false;
  for (let i = 2; i + 9 < b.length;) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = b.readUInt16BE(i + 2);
    if (m === 0xe1 && exifTurned(b.subarray(i + 4, i + 2 + len))) turned = true;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = b.readUInt16BE(i + 5);
      const w = b.readUInt16BE(i + 7);
      return turned ? [h, w] : [w, h];
    }
    i += 2 + len;
  }
  return null;
}
function sizeOf(type, data) {
  const head = Buffer.from(data.slice(0, type === 'image/jpeg' ? JPEG_HEAD : 40), 'base64');
  if (type === 'image/png' && head.length >= 24) return [head.readUInt32BE(16), head.readUInt32BE(20)];
  if (type === 'image/gif' && head.length >= 10) return [head.readUInt16LE(6), head.readUInt16LE(8)];
  if (type === 'image/webp' && head.length >= 30) {
    const kind = head.toString('latin1', 12, 16);
    if (kind === 'VP8X') return [1 + head.readUIntLE(24, 3), 1 + head.readUIntLE(27, 3)];
    if (kind === 'VP8L' && head[20] === 0x2f) { const v = head.readUInt32LE(21); return [1 + (v & 0x3fff), 1 + ((v >>> 14) & 0x3fff)]; }
    if (kind === 'VP8 ' && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) return [head.readUInt16LE(26) & 0x3fff, head.readUInt16LE(28) & 0x3fff];
  }
  if (type === 'image/jpeg') return jpegSize(head);
  return null;
}
/** A picture block of the person's words the chat can show: {type, w?, h?}, null else — by its declared type, its first
    bytes and its size, read from the head of the base64 only. */
export function shotOf(b) {
  const src = b?.type === 'image' ? b.source : null;
  if (src?.type !== 'base64' || typeof src.data !== 'string' || !PICTURE_MEDIA.has(src.media_type)) return null;
  if (src.data.length * 0.75 > PICTURE_MAX) return null;
  const head = Buffer.from(src.data.slice(0, 32), 'base64');
  if (pictureKindOf(head) !== src.media_type) return null;
  const size = sizeOf(src.media_type, src.data);
  return { type: src.media_type, ...(size && size[0] > 0 && size[1] > 0 && size[0] < 1e5 && size[1] < 1e5 ? { w: size[0], h: size[1] } : {}) };
}

/* Serving: a picture is not kept with the chat (tens of MB of base64) — the board keeps where in the file each line with
   pictures lies (uuid → offset, length), read on from where it stopped as the transcript grows, and reads just that line.
   One reading of a transcript at a time: a chat of ten pictures asks ten times at once. */
const shotIndex = new Map(); // path → { size, at: Map(uuid → [offset, length]) }
const SHOT_INDEX_MAX = 24;
const indexing = new Map();
const IMAGE_MARK = Buffer.from('"type":"image"');
const UUID_MARK = Buffer.from('"uuid":"');
async function indexMore(path) {
  const st = await stat(path);
  let x = shotIndex.get(path);
  if (!x || st.size < x.size) x = { size: 0, at: new Map() }; // rewritten — start over
  if (st.size > x.size) {
    const fh = await open(path, 'r');
    try {
      const chunk = Buffer.alloc(READ_CHUNK);
      let pending = [];
      let start = x.size; // where the line in `pending` begins
      while (x.size < st.size) {
        const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, st.size - x.size), x.size);
        if (!bytesRead) break;
        let from = 0;
        for (let nl = chunk.indexOf(0x0a, 0); nl >= 0 && nl < bytesRead; nl = chunk.indexOf(0x0a, from)) {
          const line = Buffer.concat([...pending, chunk.subarray(from, nl)]);
          if (line.includes(IMAGE_MARK)) {
            const u = line.indexOf(UUID_MARK);
            const uuid = u >= 0 ? line.toString('latin1', u + UUID_MARK.length, u + UUID_MARK.length + 36) : '';
            if (SHOT_LINE_RE.test(uuid)) x.at.set(uuid, [start, line.length]);
          }
          start += line.length + 1;
          pending = [];
          from = nl + 1;
        }
        if (from < bytesRead) pending.push(Buffer.from(chunk.subarray(from, bytesRead)));
        x.size += bytesRead;
      }
      x.size = start; // an unfinished line is read again next time
    } finally { await fh.close(); }
  }
  shotIndex.delete(path);
  shotIndex.set(path, x);
  if (shotIndex.size > SHOT_INDEX_MAX) shotIndex.delete(shotIndex.keys().next().value);
  return x;
}
function indexOf(path) {
  const run = (indexing.get(path) || Promise.resolve()).then(() => indexMore(path));
  const settled = run.catch(() => {});
  indexing.set(path, settled);
  settled.then(() => { if (indexing.get(path) === settled) indexing.delete(path); });
  return run;
}
const SHOT_KEEP_MS = 10_000;
const SHOT_LINES = 2;
const lineBlocks = new Map(); // `<path>\n<uuid>\n<offset>\n<length>` → Promise<the image blocks of the line | null>
export function pictureBlocks(path, uuid, [at, length]) {
  const k = `${path}\n${uuid}\n${at}\n${length}`;
  let p = lineBlocks.get(k);
  if (p) return p;
  p = (async () => {
    const buf = Buffer.alloc(length);
    const fh = await open(path, 'r');
    try { await fh.read(buf, 0, length, at); } finally { await fh.close(); }
    const d = JSON.parse(buf.toString('utf8'));
    if (d?.uuid !== uuid || d.type !== 'user' || !Array.isArray(d.message?.content)) return null;
    return d.message.content.filter((b) => b?.type === 'image');
  })();
  lineBlocks.set(k, p);
  if (lineBlocks.size > SHOT_LINES) lineBlocks.delete(lineBlocks.keys().next().value);
  const forget = () => { if (lineBlocks.get(k) === p) lineBlocks.delete(k); };
  p.then(() => setTimeout(forget, SHOT_KEEP_MS).unref(), forget);
  return p;
}
/** A picture of the person's words in this transcript: {type, data} — only one the chat offers (`shots` of its items);
    null else, and when the transcript is gone. */
export async function chatShot(path, ref) {
  const m = SHOT_RE.exec(String(ref));
  try {
    const c = m && path ? await itemsOf(path) : null;
    if (!c?.items.some((it) => it.kind === 'user' && it.shots?.some((x) => x.ref === ref))) return null;
    const where = (await indexOf(path)).at.get(m[1]);
    if (!where) return null;
    const block = (await pictureBlocks(path, m[1], where))?.[Number(m[2])];
    const shot = shotOf(block);
    const data = shot && Buffer.from(block.source.data, 'base64');
    return data && pictureKindOf(data.subarray(0, 12)) === shot.type ? { type: shot.type, data } : null;
  } catch { return null; } // the transcript moved or was cut under us: no picture, not a failure of the board
}

const QA_MAX = 600;
const ANSWER_PAIR = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
export function askedOf(input) {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.filter((q) => typeof q?.question === 'string' && q.question.trim())
    .map((q) => ({ q: clip(q.question, QA_MAX), ...(typeof q.header === 'string' && q.header.trim() ? { h: clip(q.header, 80) } : {}) }));
}
function byAsked(asked, text) {
  const at = (asked || []).filter((x) => !x.q.endsWith('…')).map((x) => ({ q: x.q, i: text.indexOf(`"${x.q}"="`) }))
    .filter((x) => x.i >= 0).sort((a, b) => a.i - b.i);
  const out = [];
  at.forEach((x, n) => {
    const from = x.i + x.q.length + 4;
    const to = n + 1 < at.length ? text.lastIndexOf('"', text.lastIndexOf(',', at[n + 1].i)) : text.lastIndexOf('"');
    const a = to > from ? text.slice(from, to) : '';
    if (a.trim()) out.push([x.q, a]);
  });
  return out;
}
const COMMAND = /<command-name>\/?([^<\s]+)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const QUIET_COMMANDS = new Set(['model', 'compact']);
export function commandWords(text) {
  const m = COMMAND.exec(text);
  if (!m || QUIET_COMMANDS.has(m[1])) return null;
  const args = COMMAND_ARGS.exec(text)?.[1]?.trim();
  return `/${m[1]}${args ? ` ${args}` : ''}`;
}
export function answersOf(asked, given, text) {
  const map = new Map();
  if (given && typeof given === 'object' && !Array.isArray(given)) {
    for (const [q, a] of Object.entries(given)) {
      const v = Array.isArray(a) ? a.filter((x) => typeof x === 'string').join(', ') : typeof a === 'string' ? a : '';
      if (v.trim()) map.set(q.trim(), v);
    }
  }
  if (!map.size && typeof text === 'string') {
    for (const [q, a] of byAsked(asked, text)) map.set(q, a);
    if (!map.size) for (const m of text.matchAll(ANSWER_PAIR)) if (m[2].trim()) map.set(m[1].trim(), m[2]);
  }
  if (!map.size) return null;
  const out = [];
  for (const x of asked || []) {
    const cut = x.q.endsWith('…') ? x.q.slice(0, -1) : null;
    const a = map.get(x.q) ?? (cut ? [...map].find(([q]) => q.startsWith(cut))?.[1] : undefined);
    if (a !== undefined) out.push({ ...x, a: clip(a, QA_MAX) });
  }
  // asked of nothing the board knows (an older line): the pairs as they came
  if (!out.length) for (const [q, a] of map) out.push({ q: clip(q, QA_MAX), a: clip(a, QA_MAX) });
  return out;
}

/** The chat items one transcript line holds: what the person said, what Claude wrote, the steps it took, the end of a
    turn — and results, kept only to be paired with their call. */
export function chatItems(d) {
  if (!d || typeof d !== 'object' || d.isMeta || d.isSidechain) return [];
  const at = Date.parse(d.timestamp);
  if (!Number.isFinite(at)) return [];
  if (d.type === 'system' && d.subtype === 'turn_duration' && Number.isFinite(d.durationMs)) return [{ at, kind: 'end', ms: d.durationMs }];
  const note = notification(d);
  if (note) return [{ at, kind: 'notified', ...note }];
  // them as this attachment only (`origin.kind: 'human'`), never as a line of the person: they stay in their turn
  const a = d.type === 'attachment' ? d.attachment : null;
  if (a?.type === 'queued_command' && typeof a.prompt === 'string'
    && (a.origin ? a.origin.kind === 'human' : a.commandMode === 'prompt' && !a.prompt.trimStart().startsWith('<'))) {
    const t = ownWords(a.prompt);
    return humanText(t) ? [{ at, kind: 'said', text: clip(t) }] : [];
  }
  const m = d.message;
  if (!m || typeof m !== 'object') return [];
  // the summary that stands for the conversation before a /compact is not the person's words
  if (d.type === 'user' && d.isCompactSummary) return [{ at, kind: 'compact' }];
  const out = [];
  if (d.type === 'user') {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [];
    let images = 0;
    const shots = [];
    const said = [];
    // what Claude Code writes after a step is of the line's one result — with several, it is nobody's
    const size = blocks.filter((b) => b?.type === 'tool_result').length === 1 ? editSize(d.toolUseResult) : null;
    for (const b of blocks) {
      if (b?.type === 'image') {
        images++;
        const shot = images <= SHOTS_MAX && SHOT_LINE_RE.test(String(d.uuid)) ? shotOf(b) : null;
        if (shot) shots.push({ ref: `${d.uuid}.${images - 1}`, ...(shot.w ? { w: shot.w, h: shot.h } : {}) });
      }
      else if (b?.type === 'text') {
        const t = ownWords(b.text);
        const cmd = commandWords(String(b.text ?? ''));
        if (cmd) said.push(cmd);
        else if (INTERRUPTED.test(String(t).trim())) out.push({ at, kind: 'stop' });
        else if (humanText(t)) said.push(t.trim());
      } else if (b?.type === 'tool_result') {
        const text = clip(resultText(b.content), 2000);
        const went = b.is_error ? null : wentBackground(d, b);
        const task = went || d.toolUseResult?.backgroundTaskId || /with ID: (\w+)/.exec(text)?.[1];
        const given = isObj(d.toolUseResult) && isObj(d.toolUseResult.answers) ? d.toolUseResult.answers : null;
        out.push({ at, kind: 'result', id: b.tool_use_id, error: Boolean(b.is_error), text, ...(task ? { task: String(task) } : {}), ...(went !== null ? { bg: true } : {}), ...(size ? { diff: size } : {}), ...(given ? { given } : {}) });
      }
    }
    if (said.length || images) out.unshift({ at, kind: 'user', text: clip(said.join('\n\n')), ...(images ? { images } : {}), ...(shots.length ? { shots } : {}) });
  } else if (d.type === 'assistant' && Array.isArray(m.content)) {
    for (const b of m.content) {
      if (b?.type === 'text' && String(b.text ?? '').trim()) out.push({ at, kind: 'text', text: clip(b.text) });
      else if (b?.type === 'tool_use') {
        const text = toolSummary(b.name, b.input || {});
        const asked = b.name === 'AskUserQuestion' ? askedOf(b.input) : null;
        const picture = b.name === 'Read' ? pictureOf(b.input?.file_path) : null;
        if (text !== null) out.push({ at, kind: 'tool', id: b.id, tool: b.name, text, ...(inBackground(b.input) ? { bg: true } : {}), ...(asked?.length ? { asked } : {}), ...(picture ? { picture } : {}) });
        const stops = STOPS.has(b.name) ? b.input?.task_id ?? b.input?.shell_id : undefined;
        if (stops) out.push({ at, kind: 'halt', task: String(stops) });
      }
    }
  }
  return out;
}

export const SHELL_LANGS = ['', 'bash', 'sh', 'zsh', 'shell'];
/** The fenced blocks of a text: [{lang, code, closed}] — as the chat draws them; `closed` — a fence ends it (a block left
    open runs to the end of the words, or to where a long message was cut). */
export function codeBlocks(text) {
  const s = String(text ?? '');
  const parts = s.split(/^[ \t]*```[^\n]*$/m);
  const langs = [...s.matchAll(/^[ \t]*```([^\n]*)$/gm)].map((m) => String(m[1]).trim().split(/\s+/)[0].toLowerCase());
  return parts.flatMap((p, i) => (i % 2 ? [{ lang: langs[i - 1] ?? '', code: p.replace(/^\n/, '').replace(/\n$/, ''), closed: i < parts.length - 1 }] : []));
}
/* Review: the page sends the block as the browser read it — an HTML parser drops a newline right after <pre> and turns
   \r into \n — so blank lines at the ends and line breaks are compared loosely; the rest, byte for byte. */
const asSent = (s) => String(s).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
/** The language of the block (`''`, `bash`, `zsh`…) if Claude wrote `code` as a command (a closed block of a shell) in
    the transcript at `path`; null else. */
export async function saidCommand(path, code) {
  const c = path ? await itemsOf(path) : null;
  const want = asSent(code);
  if (!want || !c) return null;
  for (const it of c.items) {
    if (it.kind !== 'text') continue;
    const b = codeBlocks(it.text).find((x) => x.closed && SHELL_LANGS.includes(x.lang) && asSent(x.code) === want);
    if (b) return b.lang;
  }
  return null;
}

const WROTE_MIN_MS = 3000;
const WROTE_MAX_MS = 30 * 60_000;
/** The turns of a chat from its items, oldest first: [{at, user, images?, items, ms, open, compact?}]. A turn begins
    with the person's words (or a compacted conversation); `ms` — how long Claude worked, from Claude Code's own line;
    `open` — no such line yet: Claude is on it, or it was stopped. Steps get their outcome: `ms`, `error`, and the answer
    to a question of Claude's; `wrote` — how long Claude took to write the step. */
export function chatTurns(items) {
  const calls = new Map();
  const byTask = new Map(); // id of background work → its call
  let before = null;
  for (const it of items) {
    if (it.kind === 'tool') {
      calls.set(it.id, it);
      if (it.bg) it.running = true;
      // Claude thinking and writing it. Moments are not told (a second step of one answer), a pause of hours is no work
      const took = before === null ? 0 : it.at - before;
      if (took >= WROTE_MIN_MS && took <= WROTE_MAX_MS) it.wrote = took;
    }
    before = it.at;
  }
  for (const it of items) {
    const call = (it.kind === 'result' || it.kind === 'notified') && calls.get(it.id);
    if (!call) continue;
    if (it.kind === 'notified') {
      call.running = false;
      call.error = it.status === 'failed';
      call.ms = it.ms ?? Math.max(0, it.at - call.at);
      if (it.steps !== undefined) call.steps = it.steps;
      continue;
    }
    call.error = it.error;
    if (it.bg && !call.bg) { call.bg = true; call.running = true; }
    if (call.bg) { if (it.error) call.running = false; if (it.task) byTask.set(it.task, call); continue; } // launched only: its end comes as a notification
    call.ms = Math.max(0, it.at - call.at);
    if (it.diff && !it.error) call.diff = it.diff;
    if (call.tool === 'AskUserQuestion' && it.text) call.answer = it.text;
    if (call.tool === 'AskUserQuestion' && !it.error) { const qa = answersOf(call.asked, it.given, it.text); if (qa) call.answers = qa; }
  }
  for (const it of items) {
    const call = it.kind === 'halt' && byTask.get(it.task);
    if (call?.running) { call.running = false; call.ms = Math.max(0, it.at - call.at); }
  }
  const turns = [];
  let cur = null;
  const begin = (at, extra = {}) => { cur = { at, user: null, items: [], ms: null, open: true, ...extra }; turns.push(cur); };
  for (const it of items) {
    if (it.kind === 'result' || it.kind === 'notified' || it.kind === 'halt') continue;
    // every turn of its sessions stayed «going on»: no bar, no files
    if (it.kind === 'user' || it.kind === 'compact') { if (cur) cur.open = false; }
    if (it.kind === 'user') { begin(it.at, { user: it.text, ...(it.images ? { images: it.images } : {}), ...(it.shots ? { shots: it.shots } : {}) }); continue; }
    if (it.kind === 'compact') { begin(it.at, { compact: true }); continue; }
    if (!cur) begin(it.at); // a resumed session starts with Claude's words
    // sum of its runs — the second end took the place of the first, and the new work hid inside a finished bar
    if (it.kind === 'end') { cur.ms = (cur.ms || 0) + (it.ms || 0); cur.open = false; continue; }
    if (!cur.open && cur.ms !== null) cur.open = true;
    cur.items.push(it); // the id stays until the helpers are read (transcriptChat) and never goes out
    if (it.kind === 'stop') cur.open = false;
  }
  return turns;
}

export const WAITING_MAX = 20;
const flatWords = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
// the person's line holds the waiting words — Claude Code joins several into one line, and puts «[Image #N]» before them;
// never the other way: a short «ok» taken would have taken a long message that holds it
const holds = (said, words) => {
  const a = flatWords(said);
  const b = flatWords(words);
  return Boolean(a && b) && a.includes(b.slice(0, 60));
};
/** One line onto the list of the person's words waiting in Claude Code's queue ([{text, at, raw}]); `items` — the
    line's chatItems. */
export function waitStep(list, d, items) {
  if (d?.type === 'queue-operation') {
    if (d.operation === 'popAll') list.length = 0;
    else if (d.operation === 'remove' && typeof d.content === 'string') {
      const i = list.findIndex((w) => w.raw === d.content);
      if (i >= 0) list.splice(i, 1);
    } else if (d.operation === 'enqueue' && typeof d.content === 'string') {
      const t = ownWords(d.content);
      const at = Date.parse(d.timestamp);
      if (humanText(t) && Number.isFinite(at)) {
        list.push({ text: clip(t.trim()), at, raw: d.content });
        if (list.length > WAITING_MAX) list.shift();
      }
    }
    return;
  }
  for (const it of items) {
    // a turn over or a conversation compacted: Claude Code's queue has gone into it, or went with a Claude that exited
    // (no `remove` is written then, and «Continue» would show the old words as waiting again)
    if (it.kind === 'end' || it.kind === 'compact') { list.length = 0; continue; }
    if (it.kind !== 'user' && it.kind !== 'said') continue;
    for (let i = list.length - 1; i >= 0; i--) if (holds(it.text, list[i].text)) list.splice(i, 1);
  }
}

/* ── reading: once, then only what was appended (as the work feed) ── */
const parsed = new Map(); // path → { size, items, rest, asks, built }
const PARSED_MAX = 12;
const reading = new Map();

async function readMore(path) {
  let st;
  try { st = await stat(path); } catch { return null; }
  let c = parsed.get(path);
  if (!c || st.size < c.size) c = { size: 0, items: [], rest: Buffer.alloc(0), asks: new Set(), built: null, waits: [] };
  if (st.size > c.size) {
    await readTail(path, c, st.size, (d) => {
      const m = modelOf(d);
      if (m) c.model = m;
      const items = chatItems(d);
      waitStep(c.waits, d, items);
      for (const it of items) {
        // text of every result sat in memory, up to 2 KB a step, for nothing
        if (it.kind === 'tool' && it.tool === 'AskUserQuestion') c.asks.add(it.id);
        if (it.kind === 'result' && !c.asks.has(it.id)) { delete it.text; delete it.given; }
        c.items.push(it);
      }
    });
    c.built = null;
  }
  parsed.delete(path);
  parsed.set(path, c);
  if (parsed.size > PARSED_MAX) parsed.delete(parsed.keys().next().value);
  return c;
}
// reads of one transcript one at a time: the cached size moves only when a read is over
function itemsOf(path) {
  const run = (reading.get(path) || Promise.resolve()).then(() => readMore(path));
  const settled = run.catch(() => {});
  reading.set(path, settled);
  settled.then(() => { if (reading.get(path) === settled) reading.delete(path); });
  return run;
}

/** The chat of a transcript: the newest `turns` turns and how many are earlier; `v` — a hash of it, for `seen`. */
export async function transcriptChat(path, { turns = TURNS_DEFAULT } = {}) {
  const c = path ? await itemsOf(path) : null;
  if (!c) return { turns: [], earlier_n: 0, away: true, waiting: [] };
  // the turns are built once per size of the file: a chat asked again and again while nothing was written is not rebuilt
  // (the items are shared with the cache: the outcome of a step is written onto copies)
  if (!c.built) c.built = chatTurns(c.items.map((it) => ({ ...it })));
  const all = c.built;
  const n = Math.min(TURNS_MAX, Math.max(1, turns));
  const shown = all.slice(-n);
  const wanted = new Set(shown.flatMap((t) => t.items.filter((it) => it.kind === 'tool' && HELPER_TOOLS.has(it.tool)).map((it) => it.id)));
  let helpers = new Map();
  if (wanted.size) try { helpers = await helpersOf(path, wanted); } catch { /* a helper we cannot read is left out */ }
  const out = shown.map((t) => ({
    ...t,
    at: new Date(t.at).toISOString(),
    items: t.items.map(({ id, steps, asked, picture, ...it }) => {
      const h = helpers.get(id);
      // the steps Claude Code counted when the helper ended, else its transcript's
      const helper = h || steps !== undefined ? { steps: steps ?? h.steps, ...(it.running && h?.now ? { now: h.now } : {}) } : null;
      return { ...it, at: new Date(it.at).toISOString(), ...(helper ? { helper } : {}), ...(picture && !it.error && it.ms !== undefined ? { pic: id } : {}) };
    }),
  }));
  const waiting = c.waits.map((w) => ({ text: w.text, at: new Date(w.at).toISOString() }));
  return { turns: out, earlier_n: Math.max(0, all.length - n), model: c.model || null, waiting };
}

export const chatHash = (o) => createHash('sha1').update(JSON.stringify(o)).digest('hex').slice(0, 20);

/* ── live: transcripts a page looks at ── */
export const WATCH_FOR_MS = 10 * 60_000;
const RING_MS = 1500;
const watched = new Map(); // path → { watcher, sessions: Set, until, timer }

/** Keep `path` (the transcript of `session`) watched for the next WATCH_FOR_MS; a change rings `session.chat`. */
export function watchChat(path, session) {
  if (!path) return;
  const until = Date.now() + WATCH_FOR_MS;
  const w = watched.get(path);
  if (w) { w.until = until; w.sessions.add(session); return; }
  let watcher;
  try { watcher = watch(path, { persistent: false }, () => ring(path)); } catch { return; }
  watcher.on('error', () => unwatch(path));
  watched.set(path, { watcher, sessions: new Set([session]), until, timer: null });
  sweepSoon();
}
function ring(path) {
  const w = watched.get(path);
  if (!w || w.timer) return;
  if (Date.now() > w.until) { unwatch(path); return; }
  w.timer = setTimeout(() => {
    w.timer = null;
    for (const session of w.sessions) emit('session.chat', { session });
  }, RING_MS);
  w.timer.unref?.();
}
function unwatch(path) {
  const w = watched.get(path);
  if (!w) return;
  w.watcher.close();
  clearTimeout(w.timer);
  watched.delete(path);
}
let sweeper = null;
function sweepSoon() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const [p, w] of watched) if (Date.now() > w.until) unwatch(p);
    if (!watched.size) { clearInterval(sweeper); sweeper = null; }
  }, 60_000);
  sweeper.unref?.();
}
/** Tests: what is watched now. */
export const watchedChats = () => [...watched.keys()];
