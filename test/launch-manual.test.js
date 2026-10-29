// every task of the column into the job, manual ones too; the server started Claude on a manual task (200); a tab
// that missed the new label still showed ▶ on its card and the start went through; and `kb take` took a manual task
// from To do like any other. Now the buttons leave manual tasks out, the server refuses a start that names one —
// whichever way Claude is started — the page says so in the board's words and reads the board again, and the take
// (with `kb next`) passes manual tasks by.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import Fastify from 'fastify';
import { boardOnly, effortOf, startEffort, checksOnly, forClaude, isManual, launchPick, manualRefusal } from '../public/js/launch-rules.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const SID = 'abababab-0000-4000-8000-0000000000ab';
let app, tmp, folder, db, base;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'kb-folder-')));
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_LAUNCH_DRYRUN: '1' });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no, path) VALUES ('site','MN','Site',1,?)").run(folder);
  app = Fastify();
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/dashboard.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  delete process.env.KB_LAUNCH_DRYRUN;
  for (const d of [tmp, folder]) if (d) rmSync(d, { recursive: true, force: true });
});

let no = 0;
/** New To do tasks: [{ labels, priority, pinned, blocked }] → their keys. */
function addTasks(cards) {
  const p = db.prepare("SELECT id FROM projects WHERE slug = 'site'").get().id;
  return cards.map((c) => {
    no += 1;
    db.prepare('INSERT INTO tasks (project_id, task_no, title, status, labels, priority, pinned, blocked, position) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(p, no, `Task ${no}`, c.status || 'todo', JSON.stringify(c.labels || []), c.priority || 0, c.pinned ? 1 : 0, c.blocked ? 1 : 0, no);
    return `MN-${no}`;
  });
}
const statusOf = (key) => db.prepare("SELECT t.status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?").get(key).status;
const post = (body) => app.inject({ method: 'POST', url: '/api/launch', payload: body });
const kb = (args, env = {}) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base, ...env };
  if (!env.CLAUDE_CODE_SESSION_ID) delete e.CLAUDE_CODE_SESSION_ID;
  delete e.CLAUDE_CODE_HOST_SESSION_ID;
  execFile(process.execPath, [KB, ...args], { env: e }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('the To do buttons hand Claude every task but the ones done by hand', () => {
  const tasks = [{ key: 'A-1', labels: [] }, { key: 'A-2', labels: ['noclaude', 'bug'] }, { key: 'A-3', labels: ['ui'] }, { key: 'A-4' }];
  assert.deepEqual(forClaude(tasks).map((t) => t.key), ['A-1', 'A-3', 'A-4']);
  assert.deepEqual(forClaude([{ key: 'A-2', labels: ['noclaude'] }]), [], 'a column of manual tasks still offers them to Claude');
  assert.equal(isManual({ labels: ['noclaude'] }), true);
  assert.equal(isManual({ labels: ['bug'] }), false);
  assert.equal(isManual(null), false);
  // the board's own word for a manual task is the same rule
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  assert.match(board, /export function taskIsNoclaude\(t\) \{ return isManual\(t\); \}/);
  assert.match(board, /const mine = key === 'todo' \? forClaude\(tasks, state\.tasks\) : \[\];[^\n]*\n\s*if \(key === 'todo' && mine\.length\) \{/,
    'the buttons of To do show for a column whose tasks are all done by hand');
});

// the rest goes as before
test('the To do buttons leave out a check that waits for another open check of its project', () => {
  const all = [
    { id: 1, key: 'A-1', project: 'a', status: 'doing', labels: ['check'] },
    { id: 2, key: 'A-2', project: 'a', status: 'todo', labels: ['check'] },
    { id: 3, key: 'A-3', project: 'a', status: 'todo', labels: [] },
    { id: 4, key: 'B-1', project: 'b', status: 'todo', labels: ['check'] },
    { id: 5, key: 'A-4', project: 'a', status: 'review', labels: ['check'] },
  ];
  const todo = all.filter((t) => t.status === 'todo');
  assert.deepEqual(forClaude(todo, all).map((t) => t.key), ['A-3', 'B-1'], 'the younger check went along, or the check of another project was held');
  assert.deepEqual(forClaude(todo).map((t) => t.key), ['A-2', 'A-3', 'B-1'], 'with only the column known, its oldest check is the oldest');
  all[0].status = 'review'; // the older check handed its report in: it is not open any more
  assert.deepEqual(forClaude(todo, all).map((t) => t.key), ['A-2', 'A-3', 'B-1']);
  // both in To do: the older one is offered, the younger waits
  const both = [{ id: 7, key: 'C-2', project: 'c', status: 'todo', labels: ['check'] }, { id: 6, key: 'C-1', project: 'c', status: 'todo', labels: ['check'] }];
  assert.deepEqual(forClaude(both).map((t) => t.key), ['C-1']);
  const back = [{ id: 8, key: 'D-1', project: 'd', status: 'todo', labels: ['check'] }, { id: 9, key: 'D-2', project: 'd', status: 'doing', labels: ['check'] }];
  assert.deepEqual(forClaude(back.slice(0, 1), back), [], 'a report sent back was offered while a younger check is running');
});

test('of two open checks of a project ▶ starts the one that goes first — the other is refused naming it, and so is a column with both', async () => {
  const [older, younger, other] = addTasks([{ labels: ['check'] }, { labels: ['check'] }, {}]);
  const setStatus = (key, status) => db.prepare("UPDATE tasks SET status = ? WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(status, key);
  try {
    for (const mode of ['board', 'terminal', ...(process.platform === 'darwin' ? ['desktop'] : [])]) {
      const ok = await post({ mode, text: `Do ${older}`, project: 'site', keys: [older] });
      assert.equal(ok.statusCode, 200, `${mode}: the older check was refused — ${ok.body}`);
      const r = await post({ mode, text: `Do ${younger}`, project: 'site', keys: [younger] });
      assert.equal(r.statusCode, 409, `${mode}: ${r.body}`);
      assert.deepEqual([r.json().reason, r.json().key], ['check-open', older], mode);
      const column = await post({ mode, text: 'Do them', project: 'site', keys: [older, younger, other] });
      assert.deepEqual([column.statusCode, column.json().key], [409, older], `${mode}: a start with both checks went`);
      const rest = await post({ mode, text: 'Do them', project: 'site', keys: [older, other] });
      assert.equal(rest.statusCode, 200, `${mode}: the column without the younger check — ${rest.body}`);
    }
    // the older one is worked on, then hands its report in: the younger starts
    setStatus(older, 'doing');
    assert.equal((await post({ mode: 'terminal', text: `Do ${younger}`, project: 'site', keys: [younger] })).statusCode, 409);
    setStatus(older, 'review');
    assert.equal((await post({ mode: 'terminal', text: `Do ${younger}`, project: 'site', keys: [younger] })).statusCode, 200);
    // check goes first, or a second Claude would be on the same Review
    setStatus(younger, 'doing');
    setStatus(older, 'todo');
    const back = await post({ mode: 'terminal', text: `Do ${older}`, project: 'site', keys: [older] });
    assert.deepEqual([back.statusCode, back.json().key], [409, younger], 'a report sent back started while a younger check is running');
    // Duplicate names the check that goes first: the running one — its own key when it is that one
    const dup = (k) => app.inject({ method: 'POST', url: `/api/tasks/${k}/duplicate` }).then((r) => [r.statusCode, r.json().key]);
    assert.deepEqual(await dup(older), [409, younger]);
    assert.deepEqual(await dup(younger), [409, younger]);
    setStatus(younger, 'todo'); // both waiting: the older goes first, and Duplicate on the younger opens it
    assert.deepEqual(await dup(younger), [409, older]);
    assert.deepEqual(await dup(older), [409, older]);
  } finally { for (const k of [older, younger, other]) setStatus(k, 'cancelled'); }
});

test('the page says which check goes first, offers to open it, starts nothing else and reads the board again', async () => {
  for (const setting of ['board', 'desktop', 'terminal', 'auto']) {
    const calls = [];
    const asked = [];
    const opened = [];
    let refreshed = 0;
    const box = {
      api: async (method, path, body) => {
        calls.push({ method, path, body });
        if (method === 'GET') return { board: true, desktop: true, terminal: true, cli: true };
        throw Object.assign(new Error('MN-1 is already checking this project'), { status: 409, body: { error: 'x', reason: 'check-open', key: 'MN-1' } });
      },
      getSetting: (k) => ({ launch: setting, permission: 'auto' })[k], pickedSetting: (k) => ({ launch: setting, permission: 'auto' })[k], launchPick, boardOnly, effortOf, startEffort, checksOnly, state: {},
      copyText: async () => true, tr: (s) => `«${s}»`, styledAlert: (s) => asked.push(`alert ${s}`), openTerminalOf() {}, askProjectFolder: async () => false,
      styledConfirm: async (s, o) => { asked.push(`${s} [${o.okLabel}]`); return true; }, openDrawer: (k) => opened.push(k),
      refresh: () => { refreshed += 1; }, manualRefusal, setTimeout: () => 0, promptHere: (s) => s,
    };
    vm.runInNewContext([
      'var launchAvail = null;',
      piece('export async function loadLaunchOptions('), piece('async function launchMode('), piece('function flashButton('),
      piece('function refusedManual('), piece('function refusedCheck('), piece('async function postLaunch('),
      piece('const BOARD_WHY = {', '\n};\n'), piece('export async function launchInClaude('),
    ].join('\n'), box);
    const btn = { innerHTML: '', title: '', textContent: '', classList: { toggle() {}, remove() {} } };
    await box.launchInClaude({ text: 'Do MN-2', project: 'site', keys: ['MN-2'], btn });
    await new Promise((r) => { setImmediate(r); });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1, `${setting}: another way of starting was tried after the refusal`);
    assert.deepEqual(asked, ['«Another check of this project is open:» MN-1. «It goes first — start this one once it is finished or cancelled.» [«Open» MN-1]'], setting);
    assert.deepEqual(opened, ['MN-1'], `${setting}: the older check was not opened`);
    assert.equal(refreshed, 1, `${setting}: the board is not read again — the column keeps the younger check in its ▶`);
    assert.equal(btn.textContent, '✕');
  }
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const s of ['Another check of this project is open:', 'It goes first — start this one once it is finished or cancelled.']) assert.ok(core.includes(`'${s}': '`), `no Russian for "${s}"`);
});

test('a start that names a task done by hand is refused, whichever way Claude is started — nothing starts, nothing moves', async () => {
  const [a, m] = addTasks([{}, { labels: ['noclaude'] }]);
  for (const mode of ['board', 'terminal', 'desktop']) {
    const r = await post({ mode, text: `Do ${a} ${m}`, project: 'site', keys: [a, m] });
    assert.equal(r.statusCode, 409, `${mode}: ${r.body}`);
    const j = r.json();
    assert.deepEqual([j.reason, j.manual, j.fallback, j.dry], ['manual', [m], undefined, undefined], `${mode}: the page cannot tell why, or "auto" tries another way`);
    assert.match(j.error, new RegExp(m));
  }
  // and the card ▶ of a tab that missed the label: one key, its own task
  assert.equal((await post({ mode: 'board', text: `Do the task ${m}`, project: 'site', keys: [m] })).json().reason, 'manual');
  assert.deepEqual([statusOf(a), statusOf(m)], ['todo', 'todo']);
  // without the manual task the start goes through
  const ok = await post({ mode: 'terminal', text: `Do ${a}`, project: 'site', keys: [a] });
  assert.equal(ok.statusCode, 200, ok.body);
});

test('kb take and kb next pass a task done by hand by — a pinned, urgent one too — and do not count it as blocked', async () => {
  // a fresh project, so its To do holds only these
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('hand','HD','Hand',1)").run();
  const p = db.prepare("SELECT id FROM projects WHERE slug = 'hand'").get().id;
  const add = db.prepare('INSERT INTO tasks (project_id, task_no, title, status, labels, priority, pinned, blocked, position) VALUES (?,?,?,?,?,?,?,?,?)');
  add.run(p, 1, 'call the supplier', 'todo', '["noclaude"]', 3, 1, 0, 1);
  add.run(p, 2, 'fix the header', 'todo', '[]', 0, 0, 0, 2);
  add.run(p, 3, 'blocked and by hand', 'todo', '["noclaude"]', 0, 0, 1, 3);
  const next = await kb(['next', 'hand']);
  assert.equal(next.code, 0, next.stderr);
  assert.match(next.stdout, /^HD-2 todo fix the header/, `kb next points at a task done by hand:\n${next.stdout}`);
  const take = await kb(['take', 'hand'], { CLAUDE_CODE_SESSION_ID: SID });
  assert.equal(take.code, 0, take.stderr);
  assert.match(take.stdout, /^HD-2 prep/, `kb take took a task done by hand:\n${take.stdout}`);
  const again = await app.inject({ method: 'POST', url: '/api/tasks/take', payload: { project: 'hand' } });
  assert.deepEqual(again.json(), { task: null, blocked_n: 0, by_hand: ['HD-1', 'HD-3'] }, 'a manual task was taken, or counted as a blocked one of Claude\'s');
  assert.equal((await kb(['take', 'hand'])).stdout.trim(), 'empty (2 by hand: HD-1 HD-3)');
  assert.equal((await kb(['next', 'hand'])).stdout.trim(), 'empty (2 by hand: HD-1 HD-3)');
  assert.deepEqual(db.prepare('SELECT status FROM tasks WHERE project_id = ? ORDER BY task_no').all(p).map((r) => r.status), ['todo', 'prep', 'todo']);
});

/* ── the page ───────────────────────────────────────────────────────────── */
const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
const piece = (head, end = '\n}\n') => {
  const at = sse.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from sse.js`);
  return sse.slice(at, sse.indexOf(end, at) + end.length).replace(/^export /, '');
};

test('the page says a start was refused for a task done by hand in its own words, starts nothing else and reads the board again', async () => {
  for (const setting of ['board', 'desktop', 'terminal', 'auto']) {
    for (const [keys, rest] of [[['MN-7'], false], [['MN-5', 'MN-7'], true]]) {
      const calls = [];
      const said = [];
      let refreshed = 0;
      const box = {
        api: async (method, path, body) => {
          calls.push({ method, path, body });
          if (method === 'GET') return { board: true, desktop: true, terminal: true, cli: true };
          throw Object.assign(new Error('done by hand (noclaude), so Claude is not started on it: MN-7'), { status: 409, body: { error: 'x', reason: 'manual', manual: ['MN-7'] } });
        },
        getSetting: (k) => ({ launch: setting, permission: 'auto' })[k], pickedSetting: (k) => ({ launch: setting, permission: 'auto' })[k], launchPick, boardOnly, effortOf, startEffort, checksOnly, state: {},
        copyText: async () => true, tr: (s) => `«${s}»`, styledAlert: (s) => said.push(s), openTerminalOf() {}, askProjectFolder: async () => false,
        refresh: () => { refreshed += 1; }, manualRefusal, setTimeout: () => 0, promptHere: (s) => s,
      };
      vm.runInNewContext([
        'var launchAvail = null;',
        piece('export async function loadLaunchOptions('),
        piece('async function launchMode('),
        piece('function flashButton('),
        piece('function refusedManual('),
        piece('async function postLaunch('),
        piece('const BOARD_WHY = {', '\n};\n'),
        piece('export async function launchInClaude('),
      ].join('\n'), box);
      const btn = { innerHTML: '', title: '', textContent: '', classList: { toggle() {}, remove() {} } };
      await box.launchInClaude({ text: `Do ${keys.join(' ')}`, project: 'site', keys, btn });
      const name = `${setting}, ${keys.join('+')}`;
      assert.equal(calls.filter((c) => c.method === 'POST').length, 1, `${name}: another way of starting was tried after the refusal`);
      assert.deepEqual(said, [`«Tasks done by hand (the noclaude label) are not started in Claude:» MN-7.${rest ? ' «The board is up to date now — press ▶ again to start the rest.»' : ''}`],
        `${name}: the refusal is not said in the board's words`);
      assert.equal(refreshed, 1, `${name}: the board is not read again — the card keeps its ▶`);
      assert.equal(btn.textContent, '✕');
    }
  }
});

test('the refusal reads the same in both languages of the board', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const w = manualRefusal(['MN-1'], ['MN-1', 'MN-2']);
  for (const s of [w.head, w.tail]) assert.ok(core.includes(`'${s}': '`), `no Russian for "${s}"`);
  assert.deepEqual(manualRefusal(['MN-1', 'MN-3'], ['MN-1', 'MN-3']), { head: w.head, keys: 'MN-1, MN-3', tail: '' });
});

test('▶ on a check while another check of its project is open is refused, whichever way — nothing starts, nothing moves', async () => {
  const [open, second] = addTasks([{ labels: ['check'] }, { labels: ['check'] }]);
  const setStatus = (key, status) => db.prepare("UPDATE tasks SET status = ? WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(status, key);
  setStatus(second, 'backlog');
  try {
    for (const mode of ['board', 'terminal', 'desktop']) {
      const r = await post({ mode, text: `Do ${second}`, project: 'site', keys: [second] });
      assert.equal(r.statusCode, 409, `${mode}: ${r.body}`);
      assert.deepEqual([r.json().reason, r.json().key, r.json().dry], ['check-open', open, undefined], mode);
    }
    assert.equal(statusOf(second), 'backlog');
    // the open check itself starts as before
    const ok = await post({ mode: 'terminal', text: `Do ${open}`, project: 'site', keys: [open] });
    assert.equal(ok.statusCode, 200, ok.body);
  } finally { setStatus(open, 'cancelled'); setStatus(second, 'cancelled'); }
});
