// send of one comment carries one key; the server writes it once. Real routes, isolated database; the sync is set up, so
// that a second mirror would show. The page below is the real code of the card, its functions taken out of drawer.js and
// init.js (the modules pull in their DOM neighbours), on a fake list, talking to those routes with answers lost on demand.
// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';
import { canRetry, commentToken, createCommentKeys, createRetryQueue, createUnsentComments, refusalText, resendDelay } from '../public/js/unsaved.js';

let app, tmp, db, bus, pid;
const post = (payload, key = 'DM-1') => app.inject({ method: 'POST', url: `/api/tasks/${key}/comments`, payload });
const count = (id = 1) => db.prepare('SELECT COUNT(*) AS n FROM task_comments WHERE task_id = ?').get(id).n;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_GH_OWNER = 'test-owner'; // without the pair enqueue does nothing, and «not mirrored twice» says nothing
  process.env.KB_GH_REPO = 'test-owner/test-repo';
  ({ db } = await import('../src/db.js'));
  bus = (await import('../src/bus.js')).bus;
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',3)").run();
  pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (id, project_id, task_no, title, status) VALUES (1,?,1,'One','todo')").run(pid);
  db.prepare("INSERT INTO tasks (id, project_id, task_no, title, status) VALUES (2,?,2,'Two','todo')").run(pid);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});
after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  delete process.env.KB_GH_OWNER;
  delete process.env.KB_GH_REPO;
});
const mirrored = (id) => db.prepare("SELECT COUNT(*) AS n FROM sync_queue WHERE op = 'add_comment' AND task_id = ?").get(id).n;

test('the second send of one key answers the same comment and writes nothing', async () => {
  const seen = [];
  const hear = (ev) => { if (ev?.type === 'task.comment') seen.push(ev); };
  bus.on('event', hear);
  const first = await post({ body: 'hello', client_key: 'k1' });
  assert.equal(mirrored(1), 1, 'the sync is not set up here: the check of a second mirror checks nothing');
  const again = await post({ body: 'hello', client_key: 'k1' });
  bus.off('event', hear);
  assert.equal(first.statusCode, 201);
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().id, first.json().id);
  assert.equal(count(), 1);
  assert.equal(seen.length, 1, 'a second event for the same comment');
  assert.equal(mirrored(1), 1, 'mirrored twice');
});

test('a key is the task\'s own, and a comment without one stays as it was', async () => {
  assert.equal((await post({ body: 'there', client_key: 'k1' }, 'DM-2')).statusCode, 201);
  const a = await post({ body: 'same words' });
  const b = await post({ body: 'same words' });
  assert.equal(a.statusCode, 201);
  assert.equal(b.statusCode, 201);
  assert.notEqual(a.json().id, b.json().id);
});

test('a key that is no key is refused by name', async () => {
  for (const client_key of [5, '', 'x'.repeat(65), {}]) {
    const r = await post({ body: 'x', client_key });
    assert.equal(r.statusCode, 400);
    assert.match(r.json().error, /client_key/);
  }
});

test('the queue keeps the key of the first send and gives a text of its own a key of its own', () => {
  const u = createUnsentComments();
  const c = u.add('DM-1', 'hello', 'first-send');
  assert.equal(u.get('DM-1', c.id).token, 'first-send');
  assert.equal(u.add('DM-1', 'hello', 'other').again, true);
  const d = u.add('DM-1', 'bye');
  assert.ok(d.token && d.token !== c.token);
  assert.notEqual(commentToken(), commentToken());
  assert.ok(commentToken().length <= 64);
});

test('the index holds one key per task whatever a route does: another task and no key at all pass', () => {
  const put = (task, key) => db.prepare("INSERT INTO task_comments (task_id, body, client_key) VALUES (?, 'x', ?)").run(task, key);
  put(1, 'unique');
  assert.throws(() => put(1, 'unique'), (e) => e.code === 'SQLITE_CONSTRAINT_UNIQUE');
  put(2, 'unique');
  put(1, null);
  put(1, null);
});

test('a comment deleted, and its key sent again: it stays deleted, the answer says so, and nothing moves', async () => {
  const id = task();
  const key = `DM-${id}`;
  const c = (await post({ body: 'gone', client_key: 'del' }, key)).json();
  assert.equal(mirrored(id), 1);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/tasks/${key}/comments/${c.id}` })).statusCode, 204);
  const seen = [];
  const hear = (ev) => { if (ev?.type === 'task.comment') seen.push(ev); };
  bus.on('event', hear);
  const again = await post({ body: 'gone', client_key: 'del' }, key);
  bus.off('event', hear);
  assert.equal(again.statusCode, 200);
  assert.deepEqual(again.json(), { deleted: true, client_key: 'del' });
  assert.equal(count(id), 0, 'the deleted comment rose again');
  assert.equal(seen.length, 0);
  assert.equal(mirrored(id), 1, 'the deleted comment went to GitHub once more');
  assert.equal((await post({ body: 'gone', client_key: 'other' }, key)).statusCode, 201, 'a key of its own is a comment of its own');
});

test('a task taken away takes the keys of its deleted comments with it', async () => {
  const id = task();
  const c = (await post({ body: 'x', client_key: 'k' }, `DM-${id}`)).json();
  await app.inject({ method: 'DELETE', url: `/api/tasks/DM-${id}/comments/${c.id}` });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comment_keys_deleted WHERE task_id = ?').get(id).n, 1);
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM comment_keys_deleted WHERE task_id = ?').get(id).n, 0);
});

/* ── the page ── */
let nextTask = 100;
function task(status = 'todo') {
  const id = ++nextTask;
  db.prepare('INSERT INTO tasks (id, project_id, task_no, title, status) VALUES (?,?,?,?,?)').run(id, pid, id, `T${id}`, status);
  return id;
}
const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const drawer = read('drawer.js');
const take = (head) => {
  const at = drawer.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return drawer.slice(at, drawer.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const line = (head) => {
  const at = drawer.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from drawer.js`);
  return drawer.slice(at, drawer.indexOf('\n', at) + 1);
};
function commentList() {
  let rows = [];
  const split = (h) => h.split(/(?=<div class="comment(?: unsent)?")/).filter((s) => s.trim());
  const unsent = (r) => r.includes('class="comment unsent"');
  return {
    set innerHTML(h) { rows = split(h); },
    get innerHTML() { return rows.join(''); },
    insertAdjacentHTML(at, h) { rows.push(...split(h)); },
    querySelector: (sel) => {
      const r = sel === '.comment.unsent' && rows.find(unsent);
      return r ? { insertAdjacentHTML(at, h) { rows.splice(rows.indexOf(r), 0, ...split(h)); } } : null;
    },
    querySelectorAll: (sel) => (sel === '.comment.unsent' ? rows.filter(unsent).map((r) => ({ remove() { rows = rows.filter((x) => x !== r); } })) : []),
    written: () => rows.filter((r) => !unsent(r)).length,
    unsent: () => rows.filter(unsent).length,
  };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
// `net`: `lose` answers of POST thrown away after the server did its work, `down` — nothing gets through; `stream` — the
// events reach the page; `lateStream` — they reach it after the answer failed, by `release()`
function page(id, net = {}) {
  const key = `DM-${id}`;
  const held = [];
  const els = { comments: commentList(), 'c-input': { value: '' }, 'c-send': {} };
  const retries = createRetryQueue();
  const box = {
    $: (el) => els[el], state: { drawerKey: key }, seg: String, tr: (s) => s, esc: String, ic: () => '', relTime: () => 'now',
    Map, Set, Math, Boolean, Number, Date, Infinity, setTimeout: () => 0, clearTimeout: () => {},
    canRetry, refusalText, resendDelay, commentToken, createCommentKeys, createUnsentComments, commentDrafts: new Map(),
    autoGrow: () => {}, showOwnComment: () => {}, sayRefused: (e) => { box.refused = e; }, closeReturnPop: () => { box.popClosed = true; },
    refresh: async () => {}, openDrawer: () => {}, wireComments: () => {},
    noteUnsaved: (retry, k) => { if (retry) retries.note(k, retry); }, dropUnsaved: (k) => retries.drop(k),
    api: async (method, path, body) => {
      if (method === 'GET') box.reads = (box.reads || 0) + 1;
      if (net.down) throw Object.assign(new Error('Failed to fetch'), { offline: true });
      if (method === 'POST' && net.passes === 0) throw Object.assign(new Error('Failed to fetch'), { offline: true }); // the connection goes after that many
      if (method === 'POST' && net.passes > 0) net.passes -= 1;
      const r = await app.inject({ method, url: path, payload: body });
      if (method === 'POST' && net.lose > 0) { net.lose -= 1; throw Object.assign(new Error('Failed to fetch'), { offline: true }); }
      if (r.statusCode >= 400) throw Object.assign(new Error(r.json().error), { status: r.statusCode });
      return r.statusCode === 204 ? null : r.json();
    },
  };
  vm.runInNewContext([
    line('const COMMENT_AUTHORS = '),
    line('let commentsShown = '), line('let commentsRead = '), line('let commentsRetry = '), line('let commentsBlank = '), line('const COMMENTS_BLANK_MS = '),
    take('export function renderComments('), take('async function readComments('), take('function drawComments('), take('function commentHTML('),
    take('export function commentArrived('), take('function commentsFailed('),
    line('const unsentComments = '), line('const commentKeys = '), line('const unsentToken = '),
    take('export function queueComment('), take('export function dropUnsentByToken('), take('async function resendComment('), take('function commentOnServer('),
    take('function paintUnsent('), take('function dropUnsentComment('), take('async function doReturn('),
    (() => { const init = read('init.js'); const at = init.indexOf('const commentSending = '); return init.slice(at, init.indexOf('\n};\n', at) + 4); })(),
    'this.commentArrived = commentArrived; this.renderComments = renderComments; this.doReturn = doReturn;',
  ].join('\n'), box);
  const hear = (ev) => {
    if (ev?.type !== 'task.comment' || ev.data.key !== key) return;
    const give = () => box.commentArrived(ev.data.key, ev.data.comment, ev.data.comments_n);
    if (net.lateStream) held.push(give); else if (net.stream) give();
  };
  bus.on('event', hear);
  return {
    box, els, retries, net, key,
    release() { held.splice(0).forEach((give) => give()); },
    async press(text) { els['c-input'].value = text; els['c-send'].onclick(); await settle(); },
    // the resend the page makes by itself: 3 s later, or when the connection is back
    resend: () => retries.retry(),
    close: () => bus.off('event', hear),
  };
}
const state = (p, id) => ({ rows: count(id), shown: p.els.comments.written(), unsent: p.els.comments.unsent(), queue: p.retries.size, mirrored: mirrored(id) });

test('written, the answer lost, the same words pressed again before the resend: one comment, and the queue is empty at once', async (t) => {
  const id = task();
  const p = page(id, { lose: 1 }); // and the stream down: the page knows nothing of what was written
  t.after(p.close);
  await p.press('same words');
  assert.deepEqual(state(p, id), { rows: 1, shown: 0, unsent: 1, queue: 1, mirrored: 1 });
  assert.equal(p.els['c-input'].value, '', 'the words stay in the field');
  await p.press('same words');
  assert.deepEqual(state(p, id).rows, 1, 'the words pressed again went under a key of their own: two comments');
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 1 });
});

test('never written, the same words pressed again while they wait: one comment', async (t) => {
  const id = task();
  const p = page(id, { down: true });
  t.after(p.close);
  await p.press('typed again');
  await p.press('typed again');
  assert.deepEqual(state(p, id), { rows: 0, shown: 0, unsent: 1, queue: 1, mirrored: 0 });
  p.net.down = false;
  await p.press('typed again');
  await p.resend();
  await settle();
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 1 });
});

test('the event comes before the send fails: the comment stands alone, with no twin «not sent» and nothing to resend', async (t) => {
  const id = task();
  const p = page(id, { lose: 1, stream: true });
  t.after(p.close);
  await p.box.renderComments(p.key); // the list is read: the event adds to it, and no read comes to tidy up behind the queue
  await settle();
  await p.press('written, answer lost');
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 1 });
  assert.equal(p.box.reads, 1);
});

test('the event comes after the send failed: the waiting twin leaves with it', async (t) => {
  const id = task();
  const p = page(id, { lose: 1, lateStream: true });
  t.after(p.close);
  await p.press('written, answer lost');
  assert.deepEqual(state(p, id), { rows: 1, shown: 0, unsent: 1, queue: 1, mirrored: 1 });
  p.release();
  await settle();
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 1 });
  await p.resend();
  assert.equal(count(id), 1);
});

test('the event of a task whose card was left: its queue entry is settled all the same', async (t) => {
  const id = task();
  const p = page(id, { lose: 1, lateStream: true });
  t.after(p.close);
  await p.press('written, answer lost');
  assert.equal(p.retries.size, 1);
  p.box.state.drawerKey = 'DM-2';
  p.release();
  assert.equal(p.retries.size, 0, 'it would be sent again though the server has it');
});

test('the answer and the event both lost: the next read of the list settles it', async (t) => {
  const id = task();
  const p = page(id, { lose: 1 });
  t.after(p.close);
  await p.press('written, answer lost');
  assert.equal(p.els.comments.unsent(), 1);
  await p.box.renderComments(p.key);
  await settle();
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 1 });
});

test('the resend of a comment deleted meanwhile is delivered: nothing written, no «not sent», no badge', async (t) => {
  const id = task();
  const p = page(id, { lose: 1 });
  t.after(p.close);
  await p.press('deleted meanwhile');
  const c = db.prepare('SELECT id FROM task_comments WHERE task_id = ?').get(id);
  await app.inject({ method: 'DELETE', url: `/api/tasks/${p.key}/comments/${c.id}` });
  await p.resend();
  await settle();
  assert.deepEqual(state(p, id), { rows: 0, shown: 0, unsent: 0, queue: 0, mirrored: 1 });
  assert.equal(p.box.refused, undefined);
  assert.equal(p.box.reads, undefined, 'an answer that holds no comment was taken for one');
});

test('the person deleted it and presses the same words: they are written, not swallowed by the key of the deleted one', async (t) => {
  const id = task();
  const p = page(id, { lose: 1 });
  t.after(p.close);
  await p.press('once more');
  const c = db.prepare('SELECT id FROM task_comments WHERE task_id = ?').get(id);
  await app.inject({ method: 'DELETE', url: `/api/tasks/${p.key}/comments/${c.id}` });
  await p.press('once more');
  assert.equal(count(id), 1, 'the words pressed were dropped');
  await p.resend();
  await settle();
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 2 });
});

test('deleted elsewhere, pressed again, and the connection goes under the new words: they wait, and are written once', async (t) => {
  const id = task();
  const p = page(id, { lose: 1 });
  t.after(p.close);
  await p.press('still mine');
  const c = db.prepare('SELECT id FROM task_comments WHERE task_id = ?').get(id);
  await app.inject({ method: 'DELETE', url: `/api/tasks/${p.key}/comments/${c.id}` });
  p.net.passes = 1; // the old key answers «deleted», the new one never arrives
  await p.press('still mine');
  assert.equal(count(id), 0);
  assert.equal(p.els.comments.unsent(), 1, 'the words were lost without a word: they joined the entry of the deleted comment');
  p.net.passes = undefined;
  await p.resend();
  await settle();
  assert.deepEqual(state(p, id), { rows: 1, shown: 1, unsent: 0, queue: 0, mirrored: 2 });
});

test('Send back with a reason, the answer lost, pressed again: one line of the reason, and the task moves', async (t) => {
  const id = task('review');
  const p = page(id, { lose: 1 });
  t.after(p.close);
  await p.box.doReturn('does not work');
  assert.equal(p.box.refused?.offline, true, 'the lost answer is not said');
  assert.equal(p.box.popClosed, undefined);
  await p.box.doReturn('does not work');
  assert.deepEqual(db.prepare('SELECT body FROM task_comments WHERE task_id = ?').all(id).map((c) => ({ ...c })), [{ body: 'Send back: does not work' }]);
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id = ?').get(id).status, 'todo');
});

test('Send back answered, and sent back later with the same reason: that is a comment of its own', async (t) => {
  const id = task('review');
  const p = page(id);
  t.after(p.close);
  await p.box.doReturn('still broken');
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = ?").run(id);
  await p.box.doReturn('still broken');
  assert.equal(count(id), 2);
});
