// Claude goes through a stand-in for the board's own `POST /api/launch` (it records what was asked), so no Claude starts.
// Run: node --test. The database is isolated through KB_DATA_DIR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, tmp, db, base, epics, run, kvSet, ownerOnly, forClaude, pid;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ db, kvSet } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  epics = await import('../src/epics.js');
  run = await import('../src/epic-run.js');
  ({ ownerOnly } = await import('../src/share.js'));
  ({ forClaude } = await import('../public/js/launch-rules.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','DM','demo',1)").run();
  pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/epics.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const kb = (args) => new Promise((resolve) => {
  execFile(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base, CLAUDE_CODE_SESSION_ID: '' } },
    (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});
const req = (method, url, payload) => app.inject({ method, url, payload });
const add = async (title, status = 'todo', labels = []) => (await req('POST', '/api/tasks', { project: 'demo', title, status, labels })).json().key;
const status = (key, s) => req('PATCH', `/api/tasks/${key}`, { status: s });
const card = async (key) => (await req('GET', `/api/tasks/${key}`)).json();
const view = async (key) => (await req('GET', `/api/tasks/${key}/epic`)).json();

test('the pure rules: stages, a batch through, the epic\'s own move', () => {
  assert.deepEqual(epics.stageCounts(['todo', 'backlog', 'doing', 'ready', 'review', 'done', 'cancelled']),
    { todo: 2, working: 1, ready: 1, review: 1, done: 1, cancelled: 1, total: 7 });
  assert.equal(epics.batchClosed([]), false);
  assert.equal(epics.batchClosed(['done', 'cancelled']), true);
  assert.equal(epics.epicMove('todo', ['done', 'cancelled'], false), 'review');
  assert.equal(epics.epicMove('backlog', ['done'], false), 'review');
  assert.equal(epics.epicMove('todo', ['cancelled'], false), null, 'nothing accepted — nothing to accept');
  assert.equal(epics.epicMove('doing', ['done'], false), null, 'a Claude working on the epic itself keeps it');
  assert.equal(epics.epicMove('review', ['done', 'todo'], true), 'todo', 'a task opened again takes back the board\'s own Review');
  assert.equal(epics.epicMove('review', ['done', 'todo'], false), null, 'a Review someone else gave stays');
  assert.equal(epics.epicMove('done', ['todo'], true), null);
  assert.equal(epics.epicMove('todo', [], false), null);
});

let E, A, B, C, D;
test('batches: made by kb add --epic --batch, a task moved by kb batch, kb show prints the epic and the place', async () => {
  E = await add('Editor epic');
  let r = await kb(['add', 'demo', 'Sounds in frame', '-s', 'todo', '--epic', E, '--batch', 'Stage 1']);
  assert.equal(r.code, 0, r.stderr);
  A = r.stdout.split(' ')[0];
  assert.match(r.stdout, new RegExp(`→ ${E} batch 1 «Stage 1»`));
  B = (await kb(['add', 'demo', 'Subtitles', '-s', 'todo', '--epic', E, '--batch', 'Stage 1'])).stdout.split(' ')[0];
  C = (await kb(['add', 'demo', 'Frames', '-s', 'todo', '--epic', E, '--batch', 'Stage 1'])).stdout.split(' ')[0];
  r = await kb(['add', 'demo', 'MCP server', '-s', 'todo', '--epic', E, '--batch', 'Stage 2']);
  D = r.stdout.split(' ')[0];
  assert.match(r.stdout, /batch 2 «Stage 2»/);
  let v = await view(E);
  assert.deepEqual(v.batches.map((b) => [b.n, b.title, b.tasks.map((t) => t.key)]), [[1, 'Stage 1', [A, B, C]], [2, 'Stage 2', [D]]]);
  assert.ok((await card(A)).links.some((l) => l.key === E && l.rel === 'parent'), 'a task placed in a batch is a sub-task of the epic');
  r = await kb(['batch', C, '2']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `${C} batch 2 «Stage 2» of ${E}`);
  r = await kb(['batch', C, '1']);
  assert.equal(r.stdout.trim(), `${C} batch 1 «Stage 1» of ${E}`);
  r = await kb(['show', E]);
  assert.match(r.stdout, /^epic: batch 1 of 2, 0 of 4 tasks closed, portions of 3$/m);
  assert.match(r.stdout, new RegExp(`^batch 1 «Stage 1» \\(0/3 closed\\): ${A} todo, ${B} todo, ${C} todo$`, 'm'));
  r = await kb(['show', A]);
  assert.match(r.stdout, new RegExp(`^in batch 1 «Stage 1» of 2 of the epic ${E}$`, 'm'));
});

test('order: a task before another, batches reordered, a refused order names the field', async () => {
  const ids = (await view(E)).batches.map((b) => b.id);
  let r = await req('POST', `/api/tasks/${E}/epic/place`, { key: C, batch: ids[0], before: A });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().batches[0].tasks.map((t) => t.key), [C, A, B]);
  r = await req('PUT', `/api/tasks/${E}/batches/order`, { batches: [ids[1], ids[0]] });
  assert.deepEqual(r.json().batches.map((b) => b.title), ['Stage 2', 'Stage 1']);
  r = await req('PUT', `/api/tasks/${E}/batches/order`, { batches: [ids[1]] });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().field, 'batches');
  await req('PUT', `/api/tasks/${E}/batches/order`, { batches: ids });
  await req('POST', `/api/tasks/${E}/epic/place`, { key: C, batch: ids[0] }); // back to the end
  for (const [body, code] of [[{ key: E, batch: ids[0] }, 400], [{ key: 'DM-999', batch: ids[0] }, 404], [{ key: A, batch: 999999 }, 404], [{ key: A }, 400], [{ key: A, batch_name: '9' }, 404]]) {
    r = await req('POST', `/api/tasks/${E}/epic/place`, body);
    assert.equal(r.statusCode, code, JSON.stringify(body));
  }
  r = await req('POST', `/api/tasks/${A}/epic/place`, { key: E, batch_name: 'x' });
  assert.equal(r.statusCode, 400, 'an epic does not go into a batch of its own sub-task');
});

test('the epic is no task for Claude: take skips it, kb take names it, the buttons of To do leave it out', async () => {
  const list = (await req('GET', '/api/tasks?project=demo')).json();
  const e = list.find((t) => t.key === E);
  assert.deepEqual(e.epic, { batches_n: 2, tasks_n: 4, closed_n: 0, current: 1 });
  assert.equal(list.find((t) => t.key === A).epic, null);
  assert.deepEqual(forClaude(list).map((t) => t.key).includes(E), false);
  for (const k of [A, B, C, D]) await status(k, 'backlog');
  const r = await kb(['take', 'demo']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout.trim(), `empty (1 epic: ${E} — its batches start from the card)`);
  assert.equal((await kb(['next', 'demo'])).stdout.trim(), `empty (1 epic: ${E} — its batches start from the card)`);
  for (const k of [A, B, C, D]) await status(k, 'todo');
});

test('the board leads the epic: all accepted → Review; a task opened again → back to To do; a Review of Claude\'s stays', async () => {
  for (const k of [A, B, C]) { await status(k, 'doing'); await status(k, 'review'); await req('PATCH', `/api/tasks/${k}`, { status: 'done' }); }
  assert.equal((await card(E)).status, 'todo', 'batch 2 is still open');
  await status(D, 'doing'); await status(D, 'review'); await status(D, 'cancelled');
  assert.equal((await card(E)).status, 'review', 'every task closed, three of them done');
  assert.equal((await view(E)).batches.every((b) => b.closed), true);
  await status(D, 'todo');
  assert.equal((await card(E)).status, 'todo', 'the board takes back its own Review');
  // a Review Claude gave the epic is not the board's to undo
  await status(E, 'doing'); await status(E, 'review');
  await status(D, 'doing');
  assert.equal((await card(E)).status, 'review');
  await status(E, 'todo');
});

test('a link taken off tells the epic: the last open task gone, the epic goes to Review; a manual epic is named once by take', async () => {
  const H = await add('Epic of links');
  const a = (await kb(['add', 'demo', 'a', '-s', 'todo', '--epic', H, '--batch', '1'])).stdout.split(' ')[0];
  const b = (await kb(['add', 'demo', 'b', '-s', 'todo', '--epic', H, '--batch', '1'])).stdout.split(' ')[0];
  await status(a, 'doing'); await status(a, 'review'); await status(a, 'done');
  assert.equal((await card(H)).status, 'todo');
  await req('DELETE', `/api/tasks/${H}/links/${(await card(b)).id}`);
  assert.equal((await card(H)).status, 'review', 'b gone, every task left in the batches is accepted');
  const list = (await req('GET', '/api/tasks?project=demo')).json();
  assert.deepEqual(list.find((t) => t.key === H).epic, { batches_n: 1, tasks_n: 1, closed_n: 1, current: null });
  // a manual epic in To do is named once — by hand, not again as an epic
  const M = await add('Manual epic', 'todo', ['noclaude']);
  await kb(['add', 'demo', 'm', '-s', 'backlog', '--epic', M, '--batch', '1']);
  const r = (await req('POST', '/api/tasks/take', { project: 'demo' })).json();
  assert.ok(r.by_hand.includes(M));
  assert.ok(!r.epics.includes(M));
  if (r.task) await status(r.task.key, 'todo');
});

test('a link taken off takes the place in the batch; a batch deleted leaves its tasks sub-tasks', async () => {
  const id = (await card(D)).id;
  await req('DELETE', `/api/tasks/${E}/links/${id}`);
  let v = await view(E);
  assert.equal(v.batches[1].tasks.length, 0);
  assert.equal(v.loose.length, 0);
  await req('POST', `/api/tasks/${E}/epic/place`, { key: D, batch: v.batches[1].id });
  const r = await req('DELETE', `/api/tasks/${E}/batches/${v.batches[1].id}`);
  assert.equal(r.statusCode, 200);
  v = r.json();
  assert.equal(v.batches.length, 1);
  assert.deepEqual(v.loose.map((t) => t.key), [D]);
});

test('settings and titles: a portion from 1 to 10, auto_next a boolean, a title a short string', async () => {
  let r = await req('PATCH', `/api/tasks/${E}/epic`, { portion: 2, auto_next: true });
  assert.deepEqual([r.json().portion, r.json().auto_next], [2, true]);
  for (const body of [{ portion: 0 }, { portion: 11 }, { portion: '3' }, { auto_next: 'yes' }]) {
    r = await req('PATCH', `/api/tasks/${E}/epic`, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
  }
  r = await req('POST', `/api/tasks/${E}/batches`, { title: 'x'.repeat(201) });
  assert.equal(r.statusCode, 400);
  r = await req('POST', `/api/tasks/${E}/batches`, { title: 5 });
  assert.equal(r.statusCode, 400);
});

test('portions: up to N runnable tasks of one project in the batch\'s order; ask, by hand, blocked and checks wait for the person', () => {
  const t = (key, s = 'todo', extra = {}) => ({ key, status: s, project: 'demo', labels: [], blocked: 0, ...extra });
  const batch = { n: 1, closed: false, tasks: [t('X-1', 'done'), t('X-2', 'todo', { labels: ['ask'] }), t('X-3'), t('X-4', 'todo', { blocked: 1 }), t('X-5', 'backlog'), t('X-6', 'todo', { labels: ['noclaude'] }), t('X-7'), t('X-8', 'todo', { project: 'other' })] };
  assert.deepEqual(run.nextPortion(batch, 2), { project: 'demo', keys: ['X-3', 'X-5'] });
  assert.deepEqual(run.nextPortion(batch, 9), { project: 'demo', keys: ['X-3', 'X-5', 'X-7'] });
  assert.deepEqual(run.nextPortion({ tasks: [t('X-9', 'todo', { epic: true }), t('X-10')] }, 3).keys, ['X-10'], 'an epic in a batch is no task for a portion');
  const bs = [{ id: 1, closed: true, tasks: [] }, { id: 2, closed: false, tasks: [t('Y-1')] }, { id: 3, closed: false, tasks: [t('Y-2')] }];
  assert.equal(run.nextBatch(bs, 1, 3, {})?.id, 2);
  assert.equal(run.nextBatch(bs, 1, 3, { 2: { state: 'stopped' } })?.id, 3, 'a batch the person stopped is not started by itself');
  assert.equal(run.nextBatch(bs, 1, 3, { 2: { state: 'failed' }, 3: { state: 'running' } }), null);
  assert.deepEqual(run.batchJudge({ ...batch, tasks: batch.tasks.map((x) => (x.key === 'X-3' ? { ...x, status: 'doing' } : x)) }, { keys: ['X-3', 'X-5'] }, 2), { phase: 'working', keys: ['X-3'] });
  assert.equal(run.batchJudge({ closed: true, tasks: [] }, {}, 2).phase, 'closed');
  assert.equal(run.batchJudge({ closed: false, tasks: [t('X-1', 'review')] }, { keys: ['X-1'] }, 2).phase, 'accepting');
  const words = { run: 'Run the kanban skill', epic: 'Batch {n}{title} of the epic {key}; its plan: kb plan {key}', doTask: 'Do the tasks' };
  assert.equal(run.portionText(words, 'DM-1', { n: 2, title: 'MCP' }, ['DM-5', 'DM-6']),
    'Run the kanban skill\nBatch 2 «MCP» of the epic DM-1; its plan: kb plan DM-1\nDo the tasks DM-5, DM-6');
  assert.equal(run.portionText(words, 'DM-1', { n: 3, title: '' }, ['DM-7']).split('\n')[1], 'Batch 3 of the epic DM-1; its plan: kb plan DM-1');
});

test('a run: portion after portion as the last goes out of work, the next batch only after acceptance, never two at once', async () => {
  // a fresh epic of 2 batches: 3 tasks and 1
  const F = await add('Second epic');
  const k = [];
  for (const [title, batch] of [['a', 'One'], ['b', 'One'], ['c', 'One'], ['d', 'Two']]) {
    k.push((await kb(['add', 'demo', title, '-s', 'todo', '--epic', F, '--batch', batch])).stdout.split(' ')[0]);
  }
  await req('PATCH', `/api/tasks/${F}/epic`, { portion: 2, auto_next: true });
  const calls = [];
  const fake = { inject: async ({ payload }) => { calls.push(payload); for (const key of payload.keys) await status(key, 'prep'); return { statusCode: 200, json: () => ({ ok: true }) }; } };
  const epic = { id: (await card(F)).id, key: F };
  const [one, two] = (await view(F)).batches.map((b) => b.id);
  const words = { run: 'Run the kanban skill', doTask: 'Do the tasks', epic: 'Batch {n} of {key}' };
  let r = await run.runBatch(fake, epic, one, { words, launch: { permission: 'acceptEdits' } });
  assert.equal(r.code, 200);
  assert.deepEqual(calls.at(-1).keys, [k[0], k[1]]);
  assert.equal(calls.at(-1).mode, 'board');
  assert.equal(calls.at(-1).permission, 'acceptEdits');
  assert.match(calls.at(-1).text, new RegExp(`Batch 1 of ${F}`));
  // two batches at once only after a word
  r = await run.runBatch(fake, epic, two, { words });
  assert.deepEqual([r.code, r.reason, r.batch], [409, 'batch-running', 1]);
  // the portion in work: nothing starts
  await run.tickEpics(fake);
  assert.equal(calls.length, 1);
  await status(k[0], 'doing'); await status(k[0], 'review');
  await run.tickEpics(fake);
  assert.equal(calls.length, 1, 'one task of the portion still in work');
  await status(k[1], 'doing'); await status(k[1], 'review');
  await run.tickEpics(fake);
  assert.deepEqual(calls.at(-1).keys, [k[2]], 'the next portion — the rest of the batch');
  await status(k[2], 'doing'); await status(k[2], 'review');
  await run.tickEpics(fake);
  assert.equal(calls.length, 2);
  assert.equal(epics.epicSettings(epic.id).run[one].state, 'accepting');
  // accepted — but Automations are off: the next batch waits
  kvSet('automations.on', '0');
  for (const key of [k[0], k[1], k[2]]) await status(key, 'done');
  await run.tickEpics(fake);
  assert.equal(calls.length, 2);
  assert.equal(epics.epicSettings(epic.id).run[one].state, 'done');
  // with Automations on, the next batch starts once the last one closes
  await status(k[2], 'review');
  epics.saveRun(epic.id, { [one]: { state: 'accepting', keys: [k[2]] } });
  kvSet('automations.on', '1');
  await status(k[2], 'done');
  await run.tickEpics(fake);
  assert.deepEqual(calls.at(-1).keys, [k[3]]);
  assert.equal(epics.epicSettings(epic.id).run[two].state, 'running');
  // a second press on a running batch starts nothing on top of it
  r = await run.runBatch(fake, epic, two, { words });
  assert.deepEqual([r.code, r.reason], [409, 'running']);
  assert.equal(calls.length, 3);
  // a start the board went down in the middle of (not awaited in this process) is judged by its tasks: here in prep — working
  epics.saveRun(epic.id, { [two]: { state: 'starting', keys: [k[3]], at: Date.now() } });
  await run.tickEpics(fake);
  assert.equal(calls.length, 3, 'its task is in prep — nothing starts twice');
  // stop: no next portion
  epics.saveRun(epic.id, { [two]: { state: 'running', keys: [k[3]], at: Date.now() } });
  assert.equal(run.stopBatch(epic, two), true);
  assert.equal(epics.epicSettings(epic.id).run[two].state, 'stopped');
});

test('a start refused is said on the batch and not repeated every tick; nothing to start is a refusal of its own', async () => {
  const G = await add('Third epic');
  const x = (await kb(['add', 'demo', 'x', '-s', 'todo', '--epic', G, '--batch', '1st'])).stdout.split(' ')[0];
  const y = (await kb(['add', 'demo', 'y', '-s', 'todo', '--epic', G, '--batch', '2nd'])).stdout.split(' ')[0];
  await req('PATCH', `/api/tasks/${y}`, { labels: ['ask'] });
  const epic = { id: (await card(G)).id, key: G };
  const [first, second] = (await view(G)).batches.map((b) => b.id);
  let n = 0;
  const refusing = { inject: async () => { n++; return { statusCode: 409, json: () => ({ reason: 'no-folder', error: 'the folder is not on this Mac' }) }; } };
  const words = { run: 'r', doTask: 'd', epic: 'e' };
  let r = await run.runBatch(refusing, epic, first, { words });
  assert.deepEqual([r.code, r.reason], [409, 'no-folder']);
  assert.equal(epics.epicSettings(epic.id).run[first].state, 'failed');
  assert.match(epics.epicSettings(epic.id).run[first].error, /^no-folder: /);
  await run.tickEpics(refusing);
  assert.equal(n, 1, 'a failed run waits for the person');
  r = await run.runBatch(refusing, epic, second, { words, force: true });
  assert.deepEqual([r.code, r.reason], [409, 'nothing']);
  assert.match(r.error, new RegExp(`by hand: ${y}`));
  assert.equal(x.startsWith('DM-'), true);
});

test('the route checks what the page sends; a guest neither starts nor stops a batch', async () => {
  const v = await view(E);
  for (const body of [{}, { words: { run: 'r', doTask: 'd' } }, { words: { run: 'r', doTask: 'd', epic: 'e' }, launch: { permission: 'everything' } }, { words: { run: 'r', doTask: 'd', epic: 'e' }, force: 'yes' }]) {
    const r = await req('POST', `/api/tasks/${E}/batches/${v.batches[0].id}/run`, body);
    assert.equal(r.statusCode, 400, JSON.stringify(body));
  }
  assert.equal(ownerOnly('POST', '/api/tasks/:id/batches/:batchId/run'), true);
  assert.equal(ownerOnly('POST', '/api/tasks/:id/batches/:batchId/stop'), true);
  assert.equal(ownerOnly('POST', '/api/tasks/:id/epic/place'), false);
  assert.equal(ownerOnly('GET', '/api/tasks/:id/epic'), false);
});

test('the queue of To do never takes an epic', async () => {
  const { queueBatch } = await import('../src/automations.js');
  const t = (id, extra = {}) => ({ id, key: `DM-${id}`, status: 'todo', blocked: 0, labels: [], priority: 0, position: id, ...extra });
  assert.deepEqual(queueBatch([t(1, { epic: 1 }), t(2)]), ['DM-2']);
});

test('the words of a batch on the page: progress, the epic\'s badge, the run — every one in the dictionary', async () => {
  const { batchProgress, epicBadge, runWords } = await import('../public/js/epic-rules.js');
  const said = [];
  const tr = (s) => { said.push(s); return `[${s}]`; };
  assert.equal(batchProgress({ todo: 1, working: 2, ready: 0, review: 1, done: 3, cancelled: 0, total: 7 }, tr), '1 [to do] · 2 [in work] · 1 [to review] · 3 [accepted]');
  assert.equal(batchProgress({ todo: 0, working: 0, ready: 0, review: 0, done: 2, cancelled: 1, total: 3 }, tr), '[accepted]');
  assert.equal(batchProgress({ total: 0 }, tr), '[empty]');
  assert.equal(epicBadge({ batches_n: 7, tasks_n: 37, closed_n: 14, current: 2 }, tr), '[batch] 2/7 · 14/37');
  assert.equal(epicBadge({ batches_n: 2, tasks_n: 4, closed_n: 4, current: null }, tr), '[batches accepted] · 4/4');
  for (const r of [{ state: 'starting', keys: ['A'] }, { state: 'running', keys: ['A', 'B'] }, { state: 'running', hold: 'limit-high' }, { state: 'accepting' }, { state: 'done' }, { state: 'stopped' }, { state: 'failed', error: 'x' }]) {
    assert.ok(runWords(r, tr).includes('['), JSON.stringify(r));
  }
  const { readFileSync } = await import('node:fs');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const s of new Set(said)) assert.ok(core.includes(`'${s}':`) || core.includes(`${s}:`), `no Russian for «${s}»`);
});
