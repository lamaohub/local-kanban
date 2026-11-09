// (crates/remote/src/routes/export.rs): issues.csv, projects.csv, users.csv deflated, attachments.csv and the files under
// attachments/<Issue ID>/ stored; CSV by the rust csv writer — quotes only where a field needs them; dates RFC 3339;
// the priority as Debug prints it (Urgent, High, Medium, Low); the default statuses of their projects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';
import Fastify from 'fastify';

let tmp, db, V, app;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-import-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  V = await import('../src/import-vibe.js');
  app = Fastify();
  await app.register((await import('../src/routes/import.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

/** A zip as their ZipWriter makes it: local header, data, central directory, end record. */
function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, stored, declared] of entries) {
    const data = Buffer.from(content);
    const packed = stored === 'raw' ? data : stored ? data : deflateRawSync(data);
    const nameB = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(packed.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameB.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8); cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(packed.length, 20); cd.writeUInt32LE(declared ?? data.length, 24); cd.writeUInt16LE(nameB.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(local, nameB, packed);
    central.push(cd, nameB);
    offset += 30 + nameB.length + packed.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
const field = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const csv = (rows) => rows.map((r) => r.map((v) => field(String(v))).join(',')).join('\n') + '\n';
const HEAD = ['Issue ID', 'Title', 'Description', 'Status', 'Priority', 'Project', 'Assignee(s)', 'Creator', 'Created', 'Updated', 'Start Date', 'Due Date', 'Completed', 'Parent Issue'];
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function archive(extra = []) {
  const issues = [HEAD,
    ['VK-1', 'Set up the build', 'Line one\nline two, with a comma and a "quote"', 'Done', 'High', 'Rocket', 'Ann Lee', 'Bob', '2026-09-01T10:00:00+00:00', '2026-09-03T12:00:00+00:00', '', '', '2026-09-03T12:00:00+00:00', ''],
    ['VK-2', 'Write the parser', '', 'In progress', 'Urgent', 'Rocket', '', 'Bob', '2026-09-02T10:00:00+00:00', '2026-09-04T10:00:00+00:00', '2026-09-02T00:00:00+00:00', '2026-09-20T00:00:00+00:00', '', 'VK-1'],
    ['VK-3', 'Polish', '', 'Waiting on legal', 'Low', 'Rocket', '', '', '2026-09-05T10:00:00+00:00', '2026-09-05T10:00:00+00:00', '', '', '', 'VK-2'],
    ['VK-4', 'Look at the design', 'See the picture', 'In review', 'Medium', 'Ракета 2', '', '', '2026-09-06T10:00:00+00:00', '2026-09-06T10:00:00+00:00', '', '', '', ''],
    ['VK-5', 'Dropped idea', '', 'Cancelled', '', 'Ракета 2', '', '', '2026-09-07T10:00:00+00:00', '2026-09-08T10:00:00+00:00', '', '', '', ''],
    ...extra];
  return zip([
    ['issues.csv', csv(issues)],
    ['projects.csv', csv([['Name', 'Created', 'Updated'], ['Rocket', '2026-08-01T00:00:00+00:00', '2026-09-01T00:00:00+00:00'], ['Ракета 2', '2026-08-02T00:00:00+00:00', '2026-09-01T00:00:00+00:00']])],
    ['users.csv', csv([['Email', 'Name'], ['ann@example.com', 'Ann Lee'], ['bob@example.com', 'Bob']])],
    ['attachments.csv', csv([['Issue ID', 'Filename', 'Content Type', 'Size (bytes)', 'File Path in ZIP'],
      ['VK-4', 'mock.png', 'image/png', String(PNG.length), 'attachments/VK-4/mock.png'],
      ['VK-4', 'spec.pdf', 'application/pdf', '5', 'attachments/VK-4/spec.pdf']])],
    ['attachments/VK-4/mock.png', PNG, true],
    ['attachments/VK-4/spec.pdf', Buffer.from('%PDF-'), true],
  ]);
}
const task = (title) => db.prepare(`SELECT t.*, p.name AS pname, (p.prefix || '-' || t.task_no) AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.title = ?`).get(title);

test('CSV of their writer: quotes, doubled quotes, commas and line breaks inside a field', () => {
  assert.deepEqual(V.parseCsv('a,"b ""q"", c","line\nbreak"\r\nx,,z\n'), [['a', 'b "q", c', 'line\nbreak'], ['x', '', 'z']]);
  assert.deepEqual(V.csvObjects('﻿Name,Created\nRocket,2026\n'), [{ Name: 'Rocket', Created: '2026' }]);
});

test('a dry run says what it would do and writes nothing', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/import/vibe-kanban?dry=1', headers: { 'content-type': 'application/zip' }, payload: archive() });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().created, 5);
  assert.deepEqual([r.json().links, r.json().pictures, r.json().not_pictures, r.json().missing], [2, 1, 1, 0]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
});

test('projects, tasks, statuses, priorities, parents and pictures are on the board', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/import/vibe-kanban', headers: { 'content-type': 'application/zip' }, payload: archive() });
  assert.equal(r.statusCode, 200, r.body);
  const a = r.json();
  assert.deepEqual(a.projects.map((p) => [p.name, p.created]), [['Rocket', true], ['Ракета 2', true]]);
  assert.deepEqual(a.projects.map((p) => p.slug), ['rocket', 'raketa-2'], 'a Russian name makes a slug that reads');
  assert.equal(a.created, 5);
  assert.equal(a.links, 2);
  assert.equal(a.pictures, 1);
  assert.equal(a.not_pictures, 1);
  assert.deepEqual(a.unknown_status, ['Waiting on legal']);
  const t1 = task('Set up the build');
  assert.equal(t1.pname, 'Rocket');
  assert.equal(t1.status, 'done');
  assert.equal(t1.priority, 3);
  assert.equal(t1.done_at, '2026-09-03 12:00:00');
  assert.equal(t1.created_at, '2026-09-01 10:00:00');
  assert.match(t1.description, /^Line one\nline two, with a comma and a "quote"\n\n---\nImported from vibe-kanban: VK-1 · assignee: Ann Lee · creator: Bob/);
  const t2 = task('Write the parser');
  assert.equal(t2.status, 'todo', 'In progress is no status of the board without Claude at work');
  assert.match(t2.description, /status «In progress» — put in To do/);
  assert.match(t2.description, /start: 2026-09-02 · due: 2026-09-20/);
  assert.equal(t2.priority, 3);
  const t3 = task('Polish');
  assert.equal(t3.status, 'backlog');
  assert.match(t3.description, /status «Waiting on legal» — unknown to the board, put in Backlog/);
  assert.equal(t3.priority, 1);
  const t4 = task('Look at the design');
  assert.equal(t4.status, 'review');
  assert.equal(t4.pname, 'Ракета 2');
  assert.match(t4.description, /file not brought over: spec\.pdf/);
  const pic = db.prepare('SELECT * FROM task_attachments WHERE task_id = ?').get(t4.id);
  assert.equal(pic.mime, 'image/png');
  assert.deepEqual(readFileSync(join(tmp, 'attachments', String(t4.id), pic.file)), PNG);
  assert.equal(task('Dropped idea').status, 'cancelled');
  assert.equal(task('Dropped idea').priority, 0);
  // VK-1 is the parent of VK-2, VK-2 of VK-3 — a link «parent» with task_id = the parent
  const links = db.prepare("SELECT task_id, linked_task_id FROM task_links WHERE kind = 'parent' ORDER BY task_id").all();
  assert.deepEqual(links, [{ task_id: t1.id, linked_task_id: t2.id }, { task_id: t2.id, linked_task_id: t3.id }]);
  // the journal the dashboard counts has where each task stands
  assert.equal(db.prepare("SELECT created_at FROM task_events WHERE task_id = ? AND status = 'done'").get(t1.id).created_at, '2026-09-03 12:00:00');
  // the keys are the board's own: a prefix per new project
  assert.match(t1.key, /^[A-Z0-9]{2,10}-1$/);
});

test('the same archive again adds nothing; a newer one adds only what is new, under its parent', async () => {
  const again = (await app.inject({ method: 'POST', url: '/api/import/vibe-kanban', headers: { 'content-type': 'application/zip' }, payload: archive() })).json();
  assert.equal(again.created, 0);
  assert.equal(again.skipped, 5);
  assert.deepEqual(again.projects.map((p) => p.created), [false, false], 'a project of the same name is reused');
  const more = archive([['VK-6', 'A follow-up', '', 'To do', 'Medium', 'Rocket', '', '', '2026-09-09T10:00:00+00:00', '2026-09-09T10:00:00+00:00', '', '', '', 'VK-1']]);
  const r = (await app.inject({ method: 'POST', url: '/api/import/vibe-kanban', headers: { 'content-type': 'application/zip' }, payload: more })).json();
  assert.equal(r.created, 1);
  assert.equal(r.skipped, 5);
  assert.equal(r.links, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, 6);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_attachments').get().n, 1, 'the picture was put on again');
});

test('what is not their archive is refused with its reason, nothing written', async () => {
  for (const [payload, word] of [[Buffer.from('not a zip at all'), /not a zip/], [zip([['readme.txt', 'hi']]), /no issues\.csv/]]) {
    const r = await app.inject({ method: 'POST', url: '/api/import/vibe-kanban', headers: { 'content-type': 'application/zip' }, payload });
    assert.equal(r.statusCode, 400, r.body);
    assert.equal(r.json().reason, 'not-vibe');
    assert.match(r.json().error, word);
  }
  const r = await app.inject({ method: 'POST', url: '/api/import/vibe-kanban', headers: { 'content-type': 'application/json' }, payload: '{}' });
  assert.equal(r.statusCode, 400, 'a JSON body is not an archive');
  assert.equal(r.json().reason, 'no-archive');
  assert.ok(!existsSync(join(tmp, 'attachments', 'NaN')));
});

const post = (payload) => app.inject({ method: 'POST', url: '/api/import/vibe-kanban', headers: { 'content-type': 'application/zip' }, payload });
const ISSUES = (rows) => csv([HEAD, ...rows.map((r) => [r[0], r[1], '', 'To do', '', r[2] || 'Spare', '', '', '2026-09-01T10:00:00+00:00', '2026-09-01T10:00:00+00:00', '', '', '', ''])]);

function overlapping(n, mb) {
  const one = zip([['issues.csv', Buffer.alloc(mb * 1024 * 1024)]]);
  const cdAt = one.readUInt32LE(one.length - 22 + 16);
  const cd = one.subarray(cdAt, one.length - 22);
  const cds = [cd];
  for (let i = 1; i < n; i++) {
    const name = Buffer.from(`f${i}.bin`);
    const e = Buffer.from(cd.subarray(0, 46));
    e.writeUInt16LE(name.length, 28);
    cds.push(e, name);
  }
  const dir = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(n, 8); end.writeUInt16LE(n, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(cdAt, 16);
  return Buffer.concat([one.subarray(0, cdAt), dir, end]);
}

test('entries of the directory sharing one file are a damaged archive, not 20 copies of it', async () => {
  const bomb = overlapping(20, 1);
  assert.ok(bomb.length < 30_000, `${bomb.length} bytes`);
  const r = await post(bomb);
  assert.equal(r.statusCode, 400, r.body.slice(0, 200));
  assert.match(r.json().error, /damaged: its files overlap/);
  assert.throws(() => V.zipEntries(bomb), (e) => e.statusCode === 400);
});

test('a file unpacks to the size its entry declares and no more; a declared size over ENTRY_MAX is refused unread', async () => {
  const issues = ISSUES([['L-1', 'Liar']]);
  // the entry says 10 bytes, its data inflates to a megabyte: maxOutputLength is the declared size
  const liar = await post(zip([['issues.csv', issues + 'x'.repeat(1 << 20), false, 10]]));
  assert.equal(liar.statusCode, 400, liar.body.slice(0, 200));
  assert.match(liar.json().error, /a file of the archive is damaged: issues\.csv/);
  const huge = await post(zip([['issues.csv', issues, false, V.ENTRY_MAX + 1]]));
  assert.equal(huge.statusCode, 400);
  assert.match(huge.json().error, /a file of the archive is too large: issues\.csv/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Liar'").get().n, 0);
});

test('only what the import needs is unpacked, and all of it together to TOTAL_MAX', async () => {
  // a file nobody names, damaged: the import never opens it
  const junk = zip([['issues.csv', ISSUES([['J-1', 'Next to junk']])], ['junk.bin', Buffer.alloc(4096, 7), 'raw']]);
  const cdAt = junk.readUInt32LE(junk.length - 22 + 16);
  const second = cdAt + 46 + 'issues.csv'.length;
  junk.writeUInt16LE(8, second + 10); // «deflate» over bytes that are no deflate stream
  junk.writeUInt32LE(1 << 20, second + 24);
  const r = await post(junk);
  assert.equal(r.statusCode, 200, r.body.slice(0, 300));
  assert.equal(r.json().created, 1);
  // three CSV files of 3 MB together, the import may unpack 2 MB
  const big = zip([['issues.csv', ISSUES([['T-1', 'Too much']]) + ' '.repeat(1 << 20)], ['projects.csv', 'Name\n' + ' '.repeat(2 << 20)]]);
  assert.throws(() => V.importVibe(big, { total: 2 << 20 }), (e) => e.statusCode === 400 && /more than the board takes/.test(e.message));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Too much'").get().n, 0);
  assert.ok(V.TOTAL_MAX >= V.IMPORT_MAX && V.TOTAL_MAX <= 2 * 1024 ** 3, 'the default bound of one import');
});

test('a row repeated in one archive is one task, not a 500', async () => {
  const r = await post(zip([['issues.csv', ISSUES([['R-1', 'Twice'], ['R-1', 'Twice'], ['R-2', 'Once']])]]));
  assert.equal(r.statusCode, 200, r.body.slice(0, 300));
  assert.deepEqual([r.json().created, r.json().skipped], [2, 1]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Twice'").get().n, 1);
});

test('files: one the archive does not hold is «not in the archive», not «not a picture»; a name with ../ writes nothing outside', async () => {
  const atts = csv([['Issue ID', 'Filename', 'Content Type', 'Size (bytes)', 'File Path in ZIP'],
    ['P-1', 'gone.png', 'image/png', '9', 'attachments/P-1/gone.png'],
    ['P-1', '../../escape.png', 'image/png', String(PNG.length), '../../escape.png']]);
  const r = await post(zip([['issues.csv', ISSUES([['P-1', 'Files of P-1', 'Paths']])], ['attachments.csv', atts], ['../../escape.png', PNG, true]]));
  assert.equal(r.statusCode, 200, r.body.slice(0, 300));
  assert.deepEqual([r.json().pictures, r.json().missing, r.json().not_pictures], [1, 1, 0]);
  const t = task('Files of P-1');
  assert.match(t.description, /file not brought over \(not in the archive\): gone\.png/);
  const pic = db.prepare('SELECT * FROM task_attachments WHERE task_id = ?').get(t.id);
  assert.match(pic.file, /^\d+\.png$/, 'the name in the archive became the name on disk');
  assert.deepEqual(readdirSync(join(tmp, 'attachments', String(t.id))), [pic.file]);
  assert.ok(!readdirSync(tmp, { recursive: true }).some((f) => String(f).includes('escape')), 'the name in the archive is on disk');
  for (const from of [tmp, join(tmp, 'attachments'), join(tmp, 'attachments', String(t.id)), process.cwd()]) {
    assert.ok(!existsSync(join(from, '../../escape.png')), `a file named by the archive is outside the attachments folder, by ${from}`);
  }
});

test('a picture that turns out damaged refuses the import whole: no task, no file left', async () => {
  const n = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
  const atts = csv([['Issue ID', 'Filename', 'Content Type', 'Size (bytes)', 'File Path in ZIP'],
    ['D-1', 'ok.png', 'image/png', '1', 'a/ok.png'], ['D-2', 'bad.png', 'image/png', '1', 'a/bad.png']]);
  const r = await post(zip([['issues.csv', ISSUES([['D-1', 'Good one'], ['D-2', 'Bad one']])], ['attachments.csv', atts], ['a/ok.png', PNG, true], ['a/bad.png', PNG, false, 5]]));
  assert.equal(r.statusCode, 400, r.body.slice(0, 300));
  assert.match(r.json().error, /damaged: a\/bad\.png/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n, n);
  const left = readdirSync(join(tmp, 'attachments'), { recursive: true }).filter((f) => /\.png$/.test(f));
  assert.equal(left.length, db.prepare('SELECT COUNT(*) AS n FROM task_attachments').get().n, `files of a refused import stay: ${left}`);
});

// a picture, were unpacked one by one up to the limit and left the board at 470 MB — and a dry run said «pictures: 20».
// The pictures of one import are checked by the sizes their entries declare before any is unpacked, in a dry run too.
test('the pictures of an import are weighed by their declared sizes before any is unpacked, in a dry run too', () => {
  const rows = [['Issue ID', 'Filename', 'Content Type', 'Size (bytes)', 'File Path in ZIP']];
  const files = [];
  for (let n = 1; n <= 3; n++) {
    rows.push(['W-1', `big${n}.png`, 'image/png', String(1 << 20), `attachments/W-1/big${n}.png`]);
    files.push([`attachments/W-1/big${n}.png`, Buffer.alloc(1 << 20)]); // deflated: a few KB each
  }
  const heavy = zip([['issues.csv', ISSUES([['W-1', 'Heavy pictures']])], ['attachments.csv', csv(rows)], ...files]);
  assert.ok(heavy.length < 64 * 1024, `the archive is ${heavy.length} bytes`);
  for (const dry of [true, false]) {
    assert.throws(() => V.importVibe(heavy, { dry, pictures: 2 << 20 }), (e) => e.statusCode === 400 && /pictures of the archive unpack to 3 MB/.test(e.message), `dry ${dry}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'Heavy pictures'").get().n, 0);
  assert.ok(V.PICTURES_MAX <= V.TOTAL_MAX);
  // within the bound, the same archive comes whole
  assert.equal(V.importVibe(heavy, { dry: true, pictures: 4 << 20 }).pictures, 3);
});
