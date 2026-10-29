// («Duplicate»). A check label put on later and the report of an earlier check sent back to To do still made a second
// in the board's words, "this project already has an open check CK-N": the answer of the change carries `warning`, the
// page shows it whatever surface made the change, kb prints it. «Duplicate» on the open check itself said nothing (the
// card opened itself) and logged the expected refusal in Settings → Errors: now the request is quiet and the page says
// the check is still open and how to start it again. A copy of a check that lands in Backlog is not an open check.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Fastify from 'fastify';
import { stillOpen, warningLine } from '../public/js/review-rules.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, folder, db, base;

const inject = (method, url, payload) => app.inject({ method, url, payload });
const add = (project, title, status = 'todo', labels = []) => inject('POST', '/api/tasks', { project, title, status, labels });
const move = (key, status) => db.prepare("UPDATE tasks SET status = ? WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(status, key);
const patch = (key, body) => inject('PATCH', `/api/tasks/${key}`, body);
const kb = (args) => new Promise((resolve) => {
  const env = { ...process.env, KB_URL: base };
  delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-check-')));
  process.env.KB_DATA_DIR = tmp;
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  for (const [slug, prefix] of [['shop', 'SH'], ['villa', 'VT'], ['aqua', 'AQ'], ['kiosk', 'KI']]) {
    db.prepare('INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES (?,?,?,1,?)').run(slug, prefix, slug, folder);
  }
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

test('a check label put on a task while the project has an open check goes through, and the answer says which check is open', async () => {
  const open = (await add('shop', 'Check the tasks in Review', 'todo', ['check'])).json().key;
  const plain = (await add('shop', 'an ordinary task')).json().key;
  const r = await patch(plain, { labels_add: ['check'] });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json().labels, ['check'], 'the label was refused');
  assert.deepEqual(r.json().warning, { reason: 'check-open', key: open, text: `this project already has an open check: ${open}` });
  // the second open check is open already: changing it again says nothing new
  assert.equal((await patch(plain, { priority: 2 })).json().warning, undefined, 'a change of a check that was open already warned again');
  // the whole set (the drawer sends it so) — the same
  const other = (await add('shop', 'another')).json().key;
  assert.equal((await patch(other, { labels: ['bug', 'check'] })).json().warning?.key, open);
  // nothing to say: no other open check, a label that is not the check's, a check out of play
  const alone = (await add('villa', 'a task')).json().key;
  assert.equal((await patch(alone, { labels_add: ['check'] })).json().warning, undefined, 'the only open check of its project warned of itself');
  assert.equal((await patch((await add('shop', 'x')).json().key, { labels_add: ['bug'] })).json().warning, undefined);
  const parked = (await add('shop', 'parked', 'backlog')).json().key;
  assert.equal((await patch(parked, { labels_add: ['check'] })).json().warning, undefined, 'a check in Backlog is not open, yet it warned');
});

test('the report of an earlier check sent back to To do while another check is open goes through, and says so', async () => {
  const report = (await add('aqua', 'Check — the earlier one', 'todo', ['check'])).json().key;
  move(report, 'review');
  const open = (await add('aqua', 'Check — the running one', 'todo', ['check'])).json().key;
  move(open, 'doing');
  const back = await patch(report, { status: 'todo' });
  assert.equal(back.statusCode, 200, back.body);
  assert.equal(back.json().status, 'todo');
  assert.equal(back.json().warning?.key, open, 'a second open check came back without a word');
  // to Backlog it is not open: nothing to say; from there to To do — it is
  move(report, 'review');
  assert.equal((await patch(report, { status: 'backlog' })).json().warning, undefined);
  assert.equal((await patch(report, { status: 'todo' })).json().warning?.key, open);
  // the open one handed in, the report alone in play: nothing
  move(open, 'review');
  move(report, 'review');
  assert.equal((await patch(report, { status: 'todo' })).json().warning, undefined);
});

test('kb lbl and kb mv do it and print the warning, exit code 0', async () => {
  const open = (await add('kiosk', 'Check', 'todo', ['check'])).json().key;
  const plain = (await add('kiosk', 'plain')).json().key;
  const lbl = await kb(['lbl', plain, '+check']);
  assert.equal(lbl.code, 0, lbl.stderr);
  assert.equal(lbl.stdout.trim(), `${plain} [check]`, 'the line kb prints changed');
  assert.equal(lbl.stderr.trim(), `kb: warning — this project already has an open check: ${open}`);
  move(plain, 'review');
  const mv = await kb(['mv', plain, 'todo']);
  assert.equal(mv.code, 0, mv.stderr);
  assert.equal(mv.stdout.trim(), `${plain} todo`);
  assert.match(mv.stderr, new RegExp(`open check: ${open}$`, 'm'));
  const quiet = await kb(['pri', plain, 'high']);
  assert.equal(quiet.stderr, '', 'a change with nothing to say printed a warning');
});

test('a check made or copied into Backlog is not an open one: it is let through', async () => {
  const open = (await add('villa', 'Check', 'todo', ['check'])).json().key;
  assert.equal((await add('villa', 'Check', 'todo', ['check'])).statusCode, 409, 'a second open check was made');
  const parked = await add('villa', 'Check later', 'backlog', ['check']);
  assert.equal(parked.statusCode, 201, `a check in Backlog was refused: ${parked.body}`);
  const copy = await inject('POST', `/api/tasks/${parked.json().key}/duplicate`);
  assert.equal(copy.statusCode, 201, `a copy of a check in Backlog was refused: ${copy.body}`);
  assert.deepEqual([copy.json().status, copy.json().labels], ['backlog', ['check']]);
  // the copy of the open check would land in To do: refused, as before
  assert.deepEqual([(await inject('POST', `/api/tasks/${open}/duplicate`)).statusCode], [409]);
  // the one open check: «Duplicate» on it names that very one — the page then says it is still open, ▶ on its card
  const alone = await inject('POST', `/api/tasks/${open}/duplicate`);
  assert.deepEqual([alone.statusCode, alone.json().key], [409, open], 'the copy of the one open check named another one');
  // on either names that one: on the younger the page opens the older's card, whose ▶ starts; on the older it says it is
  move(parked.json().key, 'todo');
  for (const k of [open, parked.json().key]) {
    const r = await inject('POST', `/api/tasks/${k}/duplicate`);
    assert.deepEqual([r.statusCode, r.json().key], [409, open], 'the copy of one of two open checks named the one whose ▶ is refused');
  }
});

/* ── the page ── */
const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));

test('the page says the warning of any change in the board\'s words, and only a warning it knows', async () => {
  // the real api() of the page on a stand-in fetch
  const at = core.indexOf('let warned = null;');
  assert.ok(at >= 0, 'the warning hook is gone from core.js');
  const end = core.indexOf('\n};\n', core.indexOf('export const api = async')) + 3;
  const box = { reportError() {}, apiError: (m, x) => Object.assign(new Error(m), x), answer: null, JSON };
  box.fetch = async () => ({ status: 200, ok: true, text: async () => JSON.stringify(box.answer) });
  const answerAt = core.indexOf('async function answerOf(');
  vm.runInNewContext(core.slice(answerAt, core.indexOf('\n}\n', answerAt) + 2), box);
  vm.runInNewContext(core.slice(at, end).replace(/^export const api =/m, 'var api =').replace(/^export /gm, ''), box);
  const heard = [];
  box.onApiWarning((w) => heard.push(w));
  box.answer = { key: 'SH-2' };
  await box.api('PATCH', '/api/tasks/SH-2', { priority: 1 });
  box.answer = { key: 'SH-2', warning: { reason: 'check-open', key: 'SH-1' } };
  assert.deepEqual(await box.api('PATCH', '/api/tasks/SH-2', { labels_add: ['check'] }, { quiet: true }), box.answer, 'the answer is not the caller\'s any more');
  assert.deepEqual(heard, [{ reason: 'check-open', key: 'SH-1' }], 'a warning was not heard, or heard where there was none');
  // what review.js does with it: the board's words in a dialog
  const review = readFileSync(new URL('../public/js/review.js', import.meta.url), 'utf8');
  const from = review.indexOf('let warnedAt');
  const line = from < 0 ? null : review.slice(from, review.indexOf('\n});', review.indexOf('onApiWarning(', from)) + 4);
  assert.ok(line, 'nothing on the page listens for warnings');
  const said = [];
  const page = { tr: (s) => `«${s}»`, warningLine, styledAlert: (m) => said.push(m), onApiWarning: (fn) => { page.fn = fn; } };
  vm.runInNewContext(line, page);
  page.fn({ reason: 'check-open', key: 'SH-1' });
  page.fn({ reason: 'check-open', key: 'SH-1' });
  page.fn({ reason: 'something-new', key: 'SH-1' });
  assert.deepEqual(said, ['«This project already has an open check» SH-1.']);
  assert.ok(dict.includes("'This project already has an open check':"), 'the warning stays English on the Russian board');
});

test('«Duplicate» on the open check itself says it is still open and how to start it again — quietly', async () => {
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const at = drawer.indexOf('async function duplicateTask(');
  assert.ok(at >= 0, 'duplicateTask is gone from drawer.js');
  for (const [status, words] of [['prep', stillOpen('prep')], ['todo', stillOpen('todo')]]) {
    const calls = { opened: [], said: [], refused: [], quiet: [] };
    const box = {
      closeDrawerMenu() {}, closeCardMenu() {}, seg: (s) => s, tr: (s) => `«${s}»`, refresh: async () => {}, stillOpen,
      drawerTask: { key: 'SH-7', status }, state: { tasks: [] },
      api: async (m, p, b, opts) => { calls.quiet.push(Boolean(opts?.quiet)); throw Object.assign(new Error('SH-7 is already checking this project'), { status: 409, body: { reason: 'check-open', key: 'SH-7' } }); },
      openDrawer: (k) => calls.opened.push(k), styledAlert: (m) => calls.said.push(m), sayRefused: (e) => calls.refused.push(e.message),
    };
    vm.runInNewContext(drawer.slice(at, drawer.indexOf('\n}\n', at) + 2), box);
    await box.duplicateTask('SH-7');
    assert.deepEqual(calls.quiet, [true], 'the expected refusal goes to Settings → Errors');
    assert.deepEqual([calls.opened, calls.said, calls.refused], [[], [`«${words}»`], []], `${status}: the card opened itself and said nothing`);
    assert.ok(dict.includes(`'${words}':`), `no Russian for "${words}"`);
  }
  assert.notEqual(stillOpen('todo'), stillOpen('prep'), 'a check waiting in To do is told to go back to To do');
});
