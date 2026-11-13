
import { inflateRawSync } from 'node:zlib';
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db, DATA_DIR, enqueue, makePrefix, nextPosition, nextTaskNo } from './db.js';
import { emit } from './bus.js';
import { snapshot } from './task-shape.js';

export const SOURCE = 'vibe-kanban';
export const IMPORT_MAX = 512 * 1024 * 1024; // the archive, bytes — with pictures it is large
const FILES_MAX = 20000;
export const ENTRY_MAX = 64 * 1024 * 1024; // one file of the archive unpacked
export const TOTAL_MAX = 1024 * 1024 * 1024; // all that one import unpacks: the archive itself is at most half of it
const ATTACH_MAX = 30; // as routes/tasks.js: pictures per task
export const PICTURES_MAX = 256 * 1024 * 1024;
const PICTURES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const EXT_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

const refused = (message) => Object.assign(new Error(message), { statusCode: 400 }); // the archive's fault, not the board's

/** The directory of a zip, nothing unpacked: Map name → {method, packed, size, start}. Throws (statusCode 400) on what is
    not a zip of this kind, and on entries that share their bytes — the way a small archive unpacks to terabytes. */
export function zipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw refused('not a zip archive');
  // the end of central directory record: its signature within the last 64 KiB + 22 bytes
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw refused('not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  const dir = buf.readUInt32LE(eocd + 16);
  if (count > FILES_MAX) throw refused(`too many files in the archive (${count})`);
  if (dir === 0xffffffff) throw refused('a zip64 archive is not supported');
  const entries = new Map();
  const spans = []; // [from, to) of each entry: its local header and its data
  let at = dir;
  for (let n = 0; n < count; n++) {
    if (at + 46 > buf.length || buf.readUInt32LE(at) !== 0x02014b50) throw refused('the archive is damaged');
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    at += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw refused('the archive is damaged');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + packed > dir) throw refused('the archive is damaged');
    spans.push([local, start + packed]);
    if (name.endsWith('/')) continue; // a folder
    if (method !== 0 && method !== 8) throw refused(`a zip compression this board does not read (${method}): ${name}`);
    entries.set(name, { name, method, packed, size, start });
  }
  spans.sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) throw refused('the archive is damaged: its files overlap');
  return entries;
}

/** The files of a zip, unpacked one by one on request: {names, has(name), read(name) → Buffer}. `total` — the bytes all
    reads together may unpack; a file unpacks to exactly the size its entry declares, or it is «damaged». */
export function zipReader(buf, { total = TOTAL_MAX } = {}) {
  const entries = zipEntries(buf);
  let left = total;
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.size > ENTRY_MAX) throw refused(`a file of the archive is too large: ${name}`);
    if (e.size > left) throw refused('the archive unpacks to more than the board takes in one import');
    const raw = buf.subarray(e.start, e.start + e.packed);
    let data;
    if (e.method === 0) data = Buffer.from(raw);
    else {
      try { data = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) }); } catch { throw refused(`a file of the archive is damaged: ${name}`); }
    }
    if (data.length !== e.size) throw refused(`a file of the archive is damaged: ${name}`);
    left -= data.length;
    return data;
  };
  return { names: [...entries.keys()], has: (name) => entries.has(name), size: (name) => entries.get(name)?.size ?? 0, read };
}

/** All the files of a zip: Map name → Buffer (within the same limits). */
export function readZip(buf, opts) {
  const z = zipReader(buf, opts);
  return new Map(z.names.map((n) => [n, z.read(n)]));
}

/** Rows of a CSV text as arrays of strings (RFC 4180: quotes, doubled quotes, commas and line breaks inside quotes). */
export function parseCsv(text) {
  const s = String(text).replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}
/** Rows as objects by the header row. */
export function csvObjects(text) {
  const [head, ...rows] = parseCsv(text);
  if (!head) return [];
  return rows.map((r) => Object.fromEntries(head.map((h, i) => [h.trim(), r[i] ?? ''])));
}

/* The statuses vibe-kanban starts a project with (crates/remote/src/db/project_statuses.rs) — a project may have renamed
   or added its own. «In progress» is no status of the board without Claude at work: it goes to To do, and the card says
   where it was. Unknown — Backlog, with the same note. */
const STATUS = new Map([['backlog', 'backlog'], ['to do', 'todo'], ['todo', 'todo'], ['in progress', 'todo'],
  ['in review', 'review'], ['review', 'review'], ['done', 'done'], ['completed', 'done'], ['cancelled', 'cancelled'], ['canceled', 'cancelled']]);
export function boardStatus(name) {
  const s = STATUS.get(String(name || '').trim().toLowerCase());
  return s ? { status: s, kept: s !== 'todo' || /^to ?do$/i.test(String(name).trim()), known: true } : { status: 'backlog', kept: false, known: false };
}
// their IssuePriority, written with `{:?}`: Urgent, High, Medium, Low; the board has high, med, low (3, 2, 1)
const PRIORITY = { urgent: 3, high: 3, medium: 2, low: 1 };
export const boardPriority = (name) => PRIORITY[String(name || '').trim().toLowerCase()] ?? 0;

/** An RFC 3339 moment as SQLite keeps it ('YYYY-MM-DD HH:MM:SS', UTC), or null. */
export function sqlTime(s) {
  const t = Date.parse(String(s || ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 19).replace('T', ' ');
}

/** What the archive holds: {issues, projects, attachments, fileAt(path) → the name of the file in the zip or null,
    read(name)} — or throws with what is missing. Only the three CSV files are unpacked here; users.csv never is. */
export function readArchive(buf, opts) {
  const z = zipReader(buf, opts);
  // their writer puts the files at the top; a zip made again by hand may have one folder around them
  const issuesAt = z.names.find((k) => k === 'issues.csv' || k.endsWith('/issues.csv'));
  if (!issuesAt) throw refused('no issues.csv in the archive — is it the export of vibe-kanban?');
  const base = issuesAt.slice(0, issuesAt.length - 'issues.csv'.length);
  const csv = (name) => (z.has(base + name) ? csvObjects(z.read(base + name).toString('utf8')) : []);
  const issues = csv('issues.csv');
  if (issues.length && !('Issue ID' in issues[0] && 'Title' in issues[0])) throw refused('issues.csv has no «Issue ID» and «Title» columns');
  const fileAt = (path) => { const p = String(path || ''); return p && z.has(base + p) ? base + p : (p && z.has(p) ? p : null); };
  return { issues, projects: csv('projects.csv'), attachments: csv('attachments.csv'), fileAt, read: z.read, size: z.size };
}

// Cyrillic letters a…ya (U+0430…U+044F) in Latin, then yo — a Russian project name makes a slug that reads
const CYR = 'a b v g d e zh z i y k l m n o p r s t u f kh ts ch sh shch  y  e yu ya'.split(' ');
const latin = (s) => s.replace(/[\u0430-\u044f\u0451]/g, (c) => (c === '\u0451' ? 'e' : CYR[c.charCodeAt(0) - 0x430]));
const slugOf = (name) => latin(String(name).toLowerCase()).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'imported';

/** Put the archive on the board. `dry` — say what would be done, write nothing: the same counts, the pictures not
    unpacked. `total` — the bytes it may unpack (TOTAL_MAX). Answers {projects: [{name, slug, created}], created, skipped,
    links, pictures, not_pictures, missing, too_many, unknown_status: [names]}: files named under a description are
    counted by why — not a picture, not in the archive, over ATTACH_MAX of one task. */
export function importVibe(buf, { dry = false, total, pictures = PICTURES_MAX } = {}) {
  let a;
  try { a = readArchive(buf, { total }); } catch (e) { e.statusCode = 400; throw e; } // the archive's fault, not the board's

  const out = { projects: [], created: 0, skipped: 0, links: 0, pictures: 0, not_pictures: 0, missing: 0, too_many: 0, unknown_status: [] };
  const projectNames = [...new Set([...a.projects.map((p) => p.Name), ...a.issues.map((i) => i.Project)].map((n) => String(n || '').trim()).filter(Boolean))];
  if (!a.issues.length && !projectNames.length) return out;
  const known = db.prepare('SELECT task_id FROM imported_tasks WHERE source = ? AND ext_id = ?');
  const unknownStatus = new Set();
  const run = db.transaction(() => {
    const projectId = new Map();
    const makeProject = (name) => {
      const base = slugOf(name);
      let slug = base;
      for (let n = 2; db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug); n++) slug = `${base}-${n}`;
      if (dry) return { id: null, slug };
      const id = db.prepare("INSERT INTO projects (slug, name, prefix, category, description) VALUES (?, ?, ?, 'Local', ?)")
        .run(slug, name, makePrefix(slug), 'Imported from vibe-kanban').lastInsertRowid;
      return { id, slug };
    };
    /* A project of that name the person has archived is not where new tasks go: they would be on neither the board nor
       its search, and the answer would say «created». Its new tasks get a new project; when it gets none (an archive
       imported again), nothing is made, and the answer says the project is archived. */
    const archivedOnly = new Map(); // lower-cased name → its entry in out.projects
    for (const name of projectNames.length ? projectNames : ['vibe-kanban']) {
      let p = db.prepare('SELECT id, slug FROM projects WHERE name = ? COLLATE NOCASE AND archived = 0 ORDER BY id LIMIT 1').get(name);
      let created = false;
      if (!p) {
        const hidden = db.prepare('SELECT slug FROM projects WHERE name = ? COLLATE NOCASE AND archived = 1 ORDER BY id LIMIT 1').get(name);
        if (hidden) {
          const entry = { name, slug: hidden.slug, created: false, archived: true };
          archivedOnly.set(name.toLowerCase(), entry);
          projectId.set(name.toLowerCase(), entry); // a new project is made below, once a new task needs one
          out.projects.push(entry);
          continue;
        }
        p = makeProject(name);
        created = true;
      }
      projectId.set(name.toLowerCase(), p.id);
      out.projects.push({ name, slug: p.slug, created });
    }
    const fallback = projectId.values().next().value;
    const byIssue = new Map(); // `${project}\t${Issue ID}` → task id, of this archive (new or imported before)
    const keyOf = (i) => `${String(i.Project || '').trim()}\t${String(i['Issue ID']).trim()}`;
    const fresh = [];
    const seen = new Set(); // a row repeated in the archive is the same issue: once (it was a 500 on imported_tasks)
    for (const i of a.issues) {
      const ext = keyOf(i);
      if (!String(i['Issue ID'] || '').trim()) continue;
      if (seen.has(ext)) { out.skipped++; continue; }
      seen.add(ext);
      const before = known.get(SOURCE, ext);
      if (before) { byIssue.set(ext, before.task_id); out.skipped++; continue; }
      const pid = projectId.get(String(i.Project || '').trim().toLowerCase()) ?? fallback;
      const { status, kept, known: knownStatus } = boardStatus(i.Status);
      if (!knownStatus && i.Status) unknownStatus.add(i.Status);
      fresh.push({ i, ext, pid, status, kept });
      out.created++;
    }
    for (const entry of archivedOnly.values()) {
      const mine = fresh.filter((f) => f.pid === entry);
      if (!mine.length) continue;
      const made = makeProject(entry.name);
      for (const f of mine) f.pid = made.id;
      Object.assign(entry, { slug: made.slug, created: true });
      delete entry.archived;
    }
    const freshExt = new Set(fresh.map((f) => f.ext));
    const notes = new Map(); // ext → lines added under the description
    // pictures first: a file that is not a picture is named under the description instead. Only the name of the file in
    // the zip is kept here — it is unpacked when it is written, and a dry run never unpacks it
    const pics = new Map(); // ext → [{at, mime}]
    const issueById = new Map();
    for (const x of a.issues) { const id = String(x['Issue ID'] || '').trim(); if (id && !issueById.has(id)) issueById.set(id, x); }
    for (const att of a.attachments) {
      const issue = issueById.get(String(att['Issue ID'] || '').trim());
      if (!issue) continue;
      const ext = keyOf(issue);
      if (!freshExt.has(ext)) continue;
      const at = a.fileAt(att['File Path in ZIP']);
      const dot = String(att.Filename).split('.').pop().toLowerCase();
      const mime = PICTURES[String(att['Content Type']).split(';')[0].trim()] ? String(att['Content Type']).split(';')[0].trim() : EXT_MIME[dot];
      const full = (pics.get(ext)?.length || 0) >= ATTACH_MAX;
      if (at && mime && !full) {
        if (!pics.has(ext)) pics.set(ext, []);
        pics.get(ext).push({ at, mime });
        out.pictures++;
      } else {
        const why = !at ? 'missing' : !mime ? 'not_pictures' : 'too_many';
        if (!notes.has(ext)) notes.set(ext, []);
        notes.get(ext).push(`file not brought over${{ missing: ' (not in the archive)', not_pictures: '', too_many: ` (more than ${ATTACH_MAX} pictures)` }[why]}: ${att.Filename}`);
        out[why]++;
      }
    }
    const pictureBytes = [...pics.values()].flat().reduce((sum, pic) => sum + a.size(pic.at), 0);
    if (pictureBytes > pictures) throw refused(`the pictures of the archive unpack to ${Math.ceil(pictureBytes / 2 ** 20)} MB — the board takes at most ${Math.round(pictures / 2 ** 20)} MB of them in one import`);
    // a parent of the same project in this archive or on the board from an earlier import — a link ↑
    const parentOf = (f) => { const p = String(f.i['Parent Issue'] || '').trim(); return p ? `${String(f.i.Project || '').trim()}\t${p}` : null; };
    if (dry) {
      out.links = fresh.filter((f) => { const p = parentOf(f); return p && p !== f.ext && (freshExt.has(p) || byIssue.has(p)); }).length;
      return;
    }
    const insert = db.prepare(`INSERT INTO tasks (project_id, task_no, title, description, priority, status, labels, position, created_at, updated_at, done_at)
      VALUES (?, ?, ?, ?, ?, ?, '[]', ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')), ?)`);
    const event = db.prepare('INSERT INTO task_events (task_id, status, created_at) VALUES (?, ?, COALESCE(?, datetime(\'now\')))');
    const mapped = db.prepare('INSERT INTO imported_tasks (source, ext_id, task_id) VALUES (?, ?, ?)');
    const attach = db.prepare('INSERT INTO task_attachments (task_id, file, mime) VALUES (?, ?, ?)');
    const setFile = db.prepare('UPDATE task_attachments SET file = ? WHERE id = ?');
    out.pictures = 0; // counted again as they are written
    for (const f of fresh) {
      const { i } = f;
      const facts = [`Imported from vibe-kanban: ${String(i['Issue ID']).trim()}`];
      if (!f.kept && i.Status) facts.push(`status «${i.Status}»${f.status === 'todo' ? ' — put in To do' : ' — unknown to the board, put in Backlog'}`);
      if (i['Assignee(s)']) facts.push(`assignee: ${i['Assignee(s)']}`);
      if (i.Creator) facts.push(`creator: ${i.Creator}`);
      if (i['Start Date']) facts.push(`start: ${String(i['Start Date']).slice(0, 10)}`);
      if (i['Due Date']) facts.push(`due: ${String(i['Due Date']).slice(0, 10)}`);
      const desc = [String(i.Description || '').trim(), `---\n${facts.join(' · ')}`, ...(notes.get(f.ext) || [])].filter(Boolean).join('\n\n');
      const created = sqlTime(i.Created);
      const doneAt = f.status === 'done' ? (sqlTime(i.Completed) || sqlTime(i.Updated)) : null;
      const id = insert.run(f.pid, nextTaskNo(f.pid), String(i.Title || '').trim() || String(i['Issue ID']).trim(), desc,
        boardPriority(i.Priority), f.status, nextPosition(f.pid, f.status), created, sqlTime(i.Updated), doneAt).lastInsertRowid;
      // the journal of moves the dashboard counts: where the task stands, at the moment it got there
      event.run(id, f.status, f.status === 'done' ? doneAt : (f.status === 'cancelled' ? sqlTime(i.Updated) : created));
      mapped.run(SOURCE, f.ext, id);
      byIssue.set(f.ext, id);
      for (const pic of pics.get(f.ext) || []) {
        const data = a.read(pic.at); // a damaged one throws: the transaction is rolled back, the files written are removed
        const r = attach.run(id, '', pic.mime);
        const file = `${r.lastInsertRowid}.${PICTURES[pic.mime]}`;
        const folder = join(DATA_DIR, 'attachments', String(id));
        mkdirSync(folder, { recursive: true });
        written.push(join(folder, file));
        writeFileSync(join(folder, file), data);
        setFile.run(file, r.lastInsertRowid);
        out.pictures++;
      }
    }
    // a parent of the same project in this archive — a link ↑ (task_id = the parent); one there already is kept
    const link = db.prepare("INSERT OR IGNORE INTO task_links (task_id, linked_task_id, kind) SELECT ?, ?, 'parent' WHERE NOT EXISTS (SELECT 1 FROM task_links WHERE task_id = ? AND linked_task_id = ?)");
    for (const f of fresh) {
      const parent = parentOf(f);
      if (!parent) continue;
      const pid = byIssue.get(parent);
      const child = byIssue.get(f.ext);
      if (pid && child && pid !== child && link.run(pid, child, child, pid).changes) out.links++;
    }
    out.task_ids = fresh.map((f) => byIssue.get(f.ext));
  });
  const written = []; // the pictures put in the attachments folder — a task id of a rolled-back import is given out again
  try { run(); } catch (e) {
    for (const file of written) {
      rmSync(file, { force: true });
      try { rmdirSync(join(file, '..')); } catch { /* the folder holds more */ }
    }
    throw e;
  }
  out.unknown_status = [...unknownStatus];
  if (!dry && out.task_ids?.length) {
    // the mirror and the pages hear of them as of any new task
    const taskOf = db.prepare(`SELECT t.*, p.slug AS project, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?`);
    for (const id of out.task_ids) enqueue('create_issue', id, snapshot(taskOf.get(id)));
    for (const p of out.projects.filter((x) => x.created)) emit('project.updated', db.prepare('SELECT * FROM projects WHERE slug = ?').get(p.slug));
    emit('tasks.imported', { n: out.task_ids.length });
  }
  delete out.task_ids;
  return out;
}
