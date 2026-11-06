// no terminal works in that folder». The real routes (tasks, health) over a project folder with a CLAUDE.md, and Claude
// Code's registry written into a stand-in Claude folder: a live Claude is this very process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';

let tmp, app, db, folder, claude, health, host;
const sessionsDir = () => join(claude, 'sessions');
let n = 0;
/** A Claude of Claude Code's registry: in `cwd`, with `status`; `pid` — alive (this process) or not. */
function claudeAt(cwd, status, pid = process.pid, updatedAt = Date.now()) {
  n += 1;
  writeFileSync(join(sessionsDir(), `${n}.json`), JSON.stringify({ pid, sessionId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, cwd, status, updatedAt }));
}
const clearClaudes = () => { rmSync(sessionsDir(), { recursive: true, force: true }); mkdirSync(sessionsDir(), { recursive: true }); };
const fix = (project = 'hf') => app.inject({ method: 'POST', url: '/api/health/fix', headers: { host }, payload: { project } });
const task = (key) => db.prepare("SELECT t.status, t.title, t.description FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?").get(key);

before(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'kb-hfix-')));
  folder = join(tmp, 'work', 'proj');
  claude = join(tmp, 'claude');
  mkdirSync(join(folder, 'src'), { recursive: true });
  writeFileSync(join(folder, 'CLAUDE.md'), `${'a rule\n'.repeat(250)}`);
  mkdirSync(join(tmp, 'work', 'bare'), { recursive: true });
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_CLAUDE_DIR = claude;
  clearClaudes();
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  health = await import('../src/auto-health.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('hf','HF','Fix me',?,1)").run(folder);
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('nb','NB','No CLAUDE.md',?,1)").run(join(tmp, 'work', 'bare'));
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('nf','NF','No folder',?,1)").run(join(tmp, 'gone'));
  app = Fastify();
  const { PORT } = await import('../src/config.js');
  host = `127.0.0.1:${PORT}`;
  app.addHook('onRequest', (await import('../src/origin-guard.js')).makeOriginGuard(PORT));
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/health.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('«Fix» opens the task in To do with the docs and the sizes; pressed again, it takes the same task', async () => {
  const r = await fix();
  assert.equal(r.statusCode, 200, r.body);
  const { key, created } = r.json();
  assert.equal(created, true);
  const t = task(key);
  assert.equal(t.status, 'todo', 'the task waits in the backlog instead of being started');
  assert.match(t.description, /https:\/\/code\.claude\.com\/docs\/en\/memory/, 'the task does not point to the docs');
  assert.match(t.description, /CLAUDE\.md: 1[\s ]750 .*250/, 'the task does not say how large the file is');
  const again = (await fix()).json();
  assert.deepEqual(again, { key, created: false }, 'a second press opened a second task');
});

test('the task the automation left in the backlog is taken to To do, not opened again; one in Review is said', async () => {
  const key = (await fix()).json().key;
  db.prepare("UPDATE tasks SET status = 'backlog' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(key);
  assert.deepEqual((await fix()).json(), { key, created: false });
  assert.equal(task(key).status, 'todo');
  db.prepare("UPDATE tasks SET status = 'review' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(key);
  const r = await fix();
  assert.deepEqual([r.statusCode, r.json().reason, r.json().key], [409, 'review', key]);
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE id = (SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.prefix || '-' || t.task_no = ?)").run(key);
  const fresh = (await fix()).json();
  assert.equal(fresh.created, true, 'a fix the person cancelled kept «Fix» from opening a new one');
  assert.notEqual(fresh.key, key);
});

test('a Claude at work in the folder holds «Fix»; one at its prompt, one gone, one in the folder above do not', async () => {
  clearClaudes();
  claudeAt(join(folder, 'src'), 'busy');
  let r = await fix();
  assert.deepEqual([r.statusCode, r.json().reason, r.json().sessions], [409, 'busy', 1], 'a Claude at work in a subfolder did not hold it');
  for (const status of ['waiting', 'shell']) {
    clearClaudes();
    claudeAt(folder, status);
    assert.equal((await fix()).statusCode, 409, `a Claude «${status}» in the folder did not hold it`);
  }
  clearClaudes();
  claudeAt(folder, 'idle');
  claudeAt(folder, 'busy', 999999);
  claudeAt(join(tmp, 'work'), 'busy');
  claudeAt(join(tmp, 'work', 'proj-2'), 'busy');
  r = await fix();
  assert.equal(r.statusCode, 200, `held by a Claude at its prompt, a dead one, or one beside the folder: ${r.body}`);
  clearClaudes();
});

// let go of such a Claude after 2 h — the same bound for the button
test('a Claude at its prompt with commands in the background holds «Fix» for 2 h of quiet, not for ever', async () => {
  const H = 3600_000;
  for (const [ago, want, why] of [[1.9 * H, 409, 'quiet under 2 h no longer held it'], [2.1 * H, 200, 'quiet past 2 h still held it'], [50 * H, 200, 'a dev server of two days still held it']]) {
    clearClaudes();
    claudeAt(folder, 'shell', process.pid, Date.now() - ago);
    const r = await fix();
    assert.equal(r.statusCode, want, `${why}: ${r.body}`);
  }
  // the bound is the background's only: a Claude at work or asking holds the folder however long ago it changed
  for (const status of ['busy', 'waiting']) {
    clearClaudes();
    claudeAt(folder, status, process.pid, Date.now() - 50 * H);
    assert.equal((await fix()).statusCode, 409, `a Claude «${status}» of long ago let the button go`);
  }
  clearClaudes();
});

test('a task of the project in work holds «Fix», one done by hand does not; the refusal names it', async () => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'hf'").get().id;
  const no = db.prepare("SELECT next_task_no AS n FROM projects WHERE id = ?").get(pid).n;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'At work', 'doing')").run(pid, no);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status, labels) VALUES (?, ?, 'By hand', 'doing', '[\"noclaude\"]')").run(pid, no + 1);
  db.prepare('UPDATE projects SET next_task_no = ? WHERE id = ?').run(no + 2, pid);
  const r = await fix();
  assert.deepEqual([r.statusCode, r.json().reason, r.json().keys], [409, 'busy', [`HF-${no}`]]);
  assert.match(r.json().error, /^Claude works in the folder of this project/);
  db.prepare("UPDATE tasks SET status = 'review' WHERE project_id = ? AND task_no = ?").run(pid, no);
  assert.equal((await fix()).statusCode, 200);
});

test('no CLAUDE.md, no folder, no such project — said, nothing opened', async () => {
  assert.deepEqual([(await fix('nb')).statusCode, (await fix('nb')).json().reason], [409, 'no-claude-md']);
  assert.deepEqual([(await fix('nf')).statusCode, (await fix('nf')).json().reason], [409, 'no-folder']);
  assert.equal((await fix('nope')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/health/fix', headers: { host }, payload: { project: ['hf'] } })).statusCode, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug IN ('nb', 'nf')").get().n, 0);
  // the rule of the folder alone: a sibling whose name starts with the folder's is not inside it
  assert.equal(health.claudesAt('/a/proj', [{ cwd: '/a/proj-2', alive: true, status: 'busy' }, { cwd: '/a/proj/x', alive: true, status: 'busy' }]), 1);
});

test('the Russian count of the task agrees with its number', () => {
  const f = ['строка', 'строки', 'строк'];
  for (const [n, want] of [[1, 'строка'], [2, 'строки'], [4, 'строки'], [5, 'строк'], [11, 'строк'], [12, 'строк'], [14, 'строк'],
    [21, 'строка'], [22, 'строки'], [111, 'строк'], [201, 'строка'], [250, 'строк'], [40001, 'строка'], [40002, 'строки']]) {
    assert.equal(health.ruCount(n, f), want, String(n));
  }
});

test('presses at once open one task: of twenty, the rest take the one the first opened', async () => {
  db.prepare("UPDATE tasks SET status = 'cancelled' WHERE title LIKE '% CLAUDE.md'").run(); // the task of «Fix», in either language
  clearClaudes();
  for (let round = 0; round < 3; round += 1) {
    const answers = (await Promise.all(Array.from({ length: 20 }, () => fix()))).map((r) => r.json());
    assert.equal(answers.filter((a) => a.created).length, 1, `round ${round}: ${answers.filter((a) => a.created).length} tasks opened`);
    assert.equal(new Set(answers.map((a) => a.key)).size, 1, 'the presses got different tasks');
    db.prepare("UPDATE tasks SET status = 'cancelled' WHERE title LIKE '% CLAUDE.md'").run(); // the task of «Fix», in either language
  }
});

test('a CLAUDE.md within the norms opens nothing — the API too; a long one and a heavy one do', async () => {
  const small = join(tmp, 'work', 'small');
  mkdirSync(small, { recursive: true });
  writeFileSync(join(small, 'CLAUDE.md'), 'two\nlines\n');
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('sm','SM','Small',?,1)").run(small);
  const r = await fix('sm');
  assert.deepEqual([r.statusCode, r.json().reason], [409, 'within-norm'], r.body);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.slug = 'sm'").get().n, 0);
  writeFileSync(join(small, 'CLAUDE.md'), 'x'.repeat(40001)); // heavy, one line
  assert.equal((await fix('sm')).json().created, true, 'a heavy CLAUDE.md of one line is refused');
});

test('every working status holds «Fix»: prep, doing, ready, deploy', async () => {
  clearClaudes();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'hf'").get().id;
  const no = db.prepare('SELECT next_task_no AS n FROM projects WHERE id = ?').get(pid).n;
  db.prepare('UPDATE projects SET next_task_no = ? WHERE id = ?').run(no + 1, pid);
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, 'Held', 'todo')").run(pid, no);
  for (const status of ['prep', 'doing', 'ready', 'deploy']) {
    db.prepare('UPDATE tasks SET status = ? WHERE project_id = ? AND task_no = ?').run(status, pid, no);
    const r = await fix();
    assert.deepEqual([r.statusCode, r.json().keys], [409, [`HF-${no}`]], `a task in ${status} did not hold it`);
  }
  db.prepare("UPDATE tasks SET status = 'review' WHERE project_id = ? AND task_no = ?").run(pid, no);
});

test('the folder is compared as it really is: a project by a link, a Claude in the real folder', async () => {
  const { symlinkSync } = await import('node:fs');
  const link = join(tmp, 'work', 'link-to-proj');
  symlinkSync(folder, link);
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('ln','LN','By a link',?,1)").run(link);
  clearClaudes();
  claudeAt(folder, 'busy');
  const r = await fix('ln');
  assert.deepEqual([r.statusCode, r.json().sessions], [409, 1], 'a Claude in the real folder of a linked project did not hold it');
  clearClaudes();
  claudeAt(link, 'busy');
  assert.deepEqual((await fix()).json().sessions, 1, 'a Claude in the link of the folder did not hold it');
  clearClaudes();
});

test('a subfolder whose name begins with two dots is inside the folder', () => {
  assert.equal(health.claudesAt('/a/proj', [{ cwd: '/a/proj/..hidden', alive: true, status: 'busy' }]), 1);
  assert.equal(health.claudesAt('/a/proj', [{ cwd: '/a', alive: true, status: 'busy' }, { cwd: '/a/other', alive: true, status: 'busy' }]), 0);
});

test('the page shows «Fix» on a long CLAUDE.md and on a heavy one, not on one within the norms', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const rules = await import('../public/js/health-rules.js');
  const src = readFileSync(new URL('../public/js/health.js', import.meta.url), 'utf8');
  const at = src.indexOf('function projectHTML(');
  const fixAt = src.indexOf('const statusWord =');
  const box = { ...rules, tr: (s) => s, esc: (s) => String(s), ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), num: String, size: () => '', DOT: ' · ',
    stateHTML: () => '', fileHTML: () => '', opened: new Set(), fixes: {}, STATUS_LABELS: { todo: 'To do', doing: 'Doing', review: 'Review' },
    liveBadge: () => '' };
  vm.createContext(box);
  vm.runInContext(`${src.slice(fixAt, src.indexOf('\n}\n', fixAt) + 2)}\n${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.row = projectHTML;`, box);
  const norms = { lines: 200, file_chars: 40000, total_chars: 120000 };
  const d = { norms, everywhere: { files: [], chars: 0, lines: 0 } };
  const row = (chars, lines) => box.row({ slug: 'x', name: 'X', main: { path: 'CLAUDE.md', chars, lines }, files: [], nested: [], chars, lines }, d);
  assert.match(row(5000, 250), /class="btn-ghost hl-fix"/, 'a long CLAUDE.md has no «Fix»');
  assert.match(row(40001, 10), /class="btn-ghost hl-fix"/, 'a heavy CLAUDE.md has no «Fix»');
  assert.doesNotMatch(row(5000, 150), /hl-fix/, 'a CLAUDE.md within the norms has «Fix»');
  assert.doesNotMatch(box.row({ slug: 'x', name: 'X', main: null, files: [], nested: [], chars: 0, lines: 0 }, d), /hl-fix/);
});

test('the row of a project says what became of its fix: the task, and Claude on it (CK-967)', async () => {
  // the owner: «started, but it is not clear whether the agent works yet» — the row stayed as it was after «Fix»
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const rules = await import('../public/js/health-rules.js');
  const src = readFileSync(new URL('../public/js/health.js', import.meta.url), 'utf8');
  const at = src.indexOf('const statusWord =');
  const live = new Map();
  const box = { ...rules, tr: (s) => s, esc: (s) => String(s), STATUS_LABELS: { todo: 'To do', doing: 'Doing', review: 'Review' },
    liveBadge: (t) => (live.has(t.id) ? `<span class="card-live">${live.get(t.id)}</span>` : '') };
  vm.createContext(box);
  vm.runInContext(`${src.slice(at, src.indexOf('\n}\n', at) + 2)}\nthis.fix = fixHTML;`, box);
  const BUTTON = '<button class="hl-fix">Fix</button>';
  assert.equal(box.fix(undefined, BUTTON), BUTTON, 'no open fix — the button as before');
  live.set(7, 'working');
  const working = box.fix({ id: 7, key: 'X-7', status: 'doing' }, BUTTON);
  assert.match(working, /data-key="X-7"/, 'the task of the fix is not named');
  assert.match(working, /card-live">working/, "Claude's state on the task is not shown");
  assert.doesNotMatch(working, /hl-fix"/, 'a second «Fix» over a Claude at work');
  assert.match(box.fix({ id: 8, key: 'X-8', status: 'doing' }, BUTTON), /Doing · Claude is not running/, 'a fix in work with nobody on it reads as working');
  const review = box.fix({ id: 9, key: 'X-9', status: 'review' }, BUTTON);
  assert.match(review, /waits for your review/);
  assert.doesNotMatch(review, /hl-fix"/);
  const todo = box.fix({ id: 10, key: 'X-10', status: 'todo' }, BUTTON);
  assert.match(todo, /data-key="X-10"[\s\S]*To do[\s\S]*hl-fix/, 'a fix waiting in To do — the key, the column and the button that starts it');
  assert.equal(rules.fixStage({ status: 'ready' }), 'work');
  assert.equal(rules.fixStage({ status: 'backlog' }), 'todo');
});

test('the size of a CLAUDE.md breaks only after a «·», never between a number and its word', async () => {
  const { readFileSync } = await import('node:fs');
  const vm = (await import('node:vm')).default;
  const src = readFileSync(new URL('../public/js/health.js', import.meta.url), 'utf8');
  const from = src.indexOf('const NB =');
  const box = { plural: (n, a, b) => (n === 1 ? a : b), tr: (s) => s, LANG: 'ru' };
  vm.createContext(box);
  vm.runInContext(`${src.slice(src.indexOf('const num ='), src.indexOf('\n', src.indexOf('const num =')))}\n${src.slice(from, src.indexOf('\n', src.indexOf('const size =', from)))}\nthis.size = size; this.DOT = DOT;`, box);
  const text = box.size({ lines: 250, chars: 180250 });
  const pieces = text.split(' '); // a plain space is the only place a line breaks
  assert.deepEqual(pieces.map((p) => p.endsWith('\u00b7')), [true, false], `a line may break elsewhere than after «·»: ${JSON.stringify(text)}`);
  assert.ok(!pieces.some((p) => p.startsWith('\u00b7')), 'a line may start with «·»');
  assert.match(src, /\$\{esc\(p\.main\.path\)\}\$\{DOT\}\$\{esc\(size\(p\.main\)\)\}/, 'the name of the file and its size are joined by a plain « · »');
});

test('GET /api/health/fixes names the open fix of each project, the newest, not a done or cancelled one (CK-967)', async () => {
  const RU_TITLE = '\u0423\u0436\u0430\u0442\u044c CLAUDE.md'; // the Russian title of the task, spelt by its code points: the public slice keeps the Russian to the locale
  const { openFixes } = await import('../src/auto-health.js');
  const pid = db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('fixes967', 'FXS', 'Fixes', 5)").run().lastInsertRowid;
  const add = (n, title, status) => db.prepare('INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, ?)').run(pid, n, title, status);
  add(1, RU_TITLE, 'done');
  add(2, 'Shrink CLAUDE.md', 'review');
  add(3, 'Something else', 'doing');
  assert.deepEqual(openFixes().fixes967, { id: db.prepare("SELECT id FROM tasks WHERE project_id = ? AND task_no = 2").get(pid).id, key: 'FXS-2', status: 'review' });
  add(4, RU_TITLE, 'cancelled');
  assert.equal(openFixes().fixes967.key, 'FXS-2', 'a cancelled fix hid the open one');
  db.prepare("UPDATE tasks SET status = 'done' WHERE project_id = ? AND task_no = 2").run(pid);
  assert.equal(openFixes().fixes967, undefined, 'a project with no open fix has one');
});

test('GET /api/health/fixes answers what openFixes knows — the page asks it on every look (CK-967)', async () => {
  const r = await app.inject({ method: 'GET', url: '/api/health/fixes', headers: { host } });
  assert.equal(r.statusCode, 200, 'the page asks a route the server does not have: every row of a fix stays as it was');
  assert.deepEqual(r.json(), { fixes: JSON.parse(JSON.stringify(health.openFixes())) });
  assert.ok(Object.keys(r.json().fixes).length, 'no open fix to answer with — the test proves nothing');
});

const PAGE_DIR = new URL('../public/js/', import.meta.url);
const pageSrc = (f) => readFileSync(new URL(f, PAGE_DIR), 'utf8');
const RU = (() => {
  const core = pageSrc('core.js');
  const open = core.indexOf('const I18N_RU = ') + 'const I18N_RU = '.length;
  return new Function(`return (${core.slice(open, core.indexOf('\n};', open) + 2)})`)();
})();
const trRu = (s) => (Object.hasOwn(RU, s) ? RU[s] : `MISSING<${s}>`);

/** The tags of an HTML string as elements for querySelectorAll: tag, classes, data-*, the same objects until the next write. */
function fakeBox() {
  let html = '';
  let cache = new Map();
  const tags = () => [...html.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)].map((m) => {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    const dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
    return { tag: m[1], attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean), dataset, disabled: false, onclick: null };
  });
  const matches = (el, sel) => sel.split(/\s*,\s*/).some((one) => {
    const [, tag, cls, attr] = one.match(/^(\w+)?(?:\.([\w-]+))?(?:\[([\w-]+)\])?$/);
    return (!tag || el.tag === tag) && (!cls || el.classes.includes(cls)) && (!attr || attr in el.attrs);
  });
  return {
    all: [],
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; cache = new Map(); this.all = tags(); },
    get firstChild() { return html ? {} : null; },
    addEventListener() {},
    querySelectorAll(sel) { if (!cache.has(sel)) cache.set(sel, this.all.filter((el) => matches(el, sel))); return cache.get(sel); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
}
/** Wait for what the page does after a click without awaiting it (the start, the look that follows) — at most 5 s. */
const until = async (ok) => { for (const end = Date.now() + 5000; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5)); };
const click = (el) => {
  const ev = { prevented: false, stopped: false, currentTarget: el, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  el.onclick(ev);
  return ev;
};

/** A fresh instance of the page module; `asked` — the requests it sent, `opened`/`launched` — what its clicks did. */
async function healthPage({ tr = (s) => s } = {}) {
  const rules = await import('../public/js/health-rules.js');
  const box = fakeBox();
  const state = { slug: 'health', live: {} };
  const asked = [];
  const opened = [];
  const launched = [];
  const api = async (method, url, body) => {
    asked.push(`${method} ${url}`);
    const r = await app.inject({ method, url, headers: { host }, ...(body ? { payload: body } : {}) });
    if (r.statusCode >= 400) throw Object.assign(new Error(r.body), { body: r.json() });
    return r.json();
  };
  const stubs = {
    $: (id) => { assert.equal(id, 'health'); return box; }, HEALTH: 'health', LANG: 'en', api, state, tr, ic: () => '',
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    liveBadge: (t) => (state.live[t.id] ? `<span class="card-live">${state.live[t.id].claude}</span>` : ''),
    keepFocus: (_el, fn) => fn(), plural: (n, a, b) => (n === 1 ? a : b),
    selectProject: () => {}, styledAlert: (s) => { throw new Error(`alert: ${s}`); }, styledConfirm: async () => false,
    refusalLine: (s) => s, openDrawer: (key) => opened.push(key),
    STATUS_LABELS: { backlog: 'Backlog', todo: 'To do', prep: 'Prep', doing: 'Doing', review: 'Review' },
    launchInClaude: async (o) => { launched.push({ keys: [...o.keys], project: o.project, text: o.text }); },
    taskPromptText: (k) => `Take ${k}`,
    ...rules, renderStands: async () => {}, stopStands: () => {}, localStore: { getItem: () => null, setItem() {} },
  };
  const src = pageSrc('health.js');
  const imported = [...src.matchAll(/^import \{([^}]*)\} from '[^']+';$/gm)].flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));
  assert.ok(imported.length > 10, 'the imports of health.js are not where the test reads them');
  assert.deepEqual(imported.filter((n) => !(n in stubs)), [], 'health.js imports a name the test does not give');
  const body = src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const ctx = vm.createContext({ ...stubs, setTimeout, clearTimeout });
  vm.runInContext(`${body}\nthis.page = { renderHealth, repaintHealth };`, ctx);
  return { page: ctx.page, box, state, asked, opened, launched };
}
/** The row of one project as the page drew it. */
const rowOf = (box, slug) => {
  const at = box.innerHTML.indexOf(`<details class="hl-proj" data-slug="${slug}"`);
  assert.ok(at >= 0, `no row of ${slug}`);
  return box.innerHTML.slice(at, box.innerHTML.indexOf('</details>', at));
};
let pageProject;
/** A project of its own for the page: a long CLAUDE.md, no task yet. */
function pageFolder() {
  if (pageProject) return pageProject;
  const dir = join(tmp, 'work', 'page');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'CLAUDE.md'), `${'a line\n'.repeat(230)}`);
  pageProject = { id: db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('pg','PG','Page',?,1)").run(dir).lastInsertRowid };
  return pageProject;
}
/** The open fix of the page's project, opened through the API when there is none — each test stands on its own. */
async function pageFix() {
  if (!fixOfPage()) assert.equal((await fix('pg')).statusCode, 200);
  return fixOfPage();
}
const setFix = (status) => db.prepare("UPDATE tasks SET status = ? WHERE project_id = ? AND title LIKE '% CLAUDE.md' AND status NOT IN ('done', 'cancelled')").run(status, pageFolder().id);
const fixOfPage = () => db.prepare("SELECT t.id, p.prefix || '-' || t.task_no AS key FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.id = ? AND t.status NOT IN ('done', 'cancelled') AND t.title LIKE '% CLAUDE.md'").get(pageFolder().id);

test('«Fix» on the page opens the task and starts Claude on it; the row then names the task, its key opens the card (CK-960, CK-967)', async () => {
  clearClaudes();
  pageFolder();
  const { page, box, asked, opened, launched } = await healthPage();
  await page.renderHealth();
  assert.match(rowOf(box, 'pg'), /class="btn-ghost hl-fix" data-slug="pg"/, 'a long CLAUDE.md with no fix has no «Fix»');
  const btn = box.querySelectorAll('.hl-fix').find((b) => b.dataset.slug === 'pg');
  assert.equal(typeof btn?.onclick, 'function', 'the button «Fix» does nothing when pressed');
  const ev = click(btn);
  assert.ok(ev.prevented && ev.stopped, 'a press of «Fix» inside <summary> folds the row as well');
  await until(() => asked.filter((a) => a === 'GET /api/health/fixes').length > 1); // the look after the start
  assert.ok(asked.includes('POST /api/health/fix'), `«Fix» asked the server nothing: ${asked.join(', ')}`);
  const fx = fixOfPage();
  assert.ok(fx, 'no task of the fix opened');
  assert.deepEqual(launched, [{ keys: [fx.key], project: 'pg', text: `Take ${fx.key}` }], 'Claude was not started on the task of the fix');
  assert.match(rowOf(box, 'pg'), new RegExp(`class="hl-fix-key" href="#" data-key="${fx.key}"`), 'the row does not name the task right after «Fix»');
  const key = box.querySelectorAll('a.hl-fix-key').find((a) => a.dataset.key === fx.key);
  const kev = click(key);
  assert.deepEqual(opened, [fx.key], 'the key of the fix does not open its card');
  assert.ok(kev.prevented && kev.stopped, 'a click on the key follows href="#" or folds the row');
});

test('a look within 30 s asks the fixes again, not the folders: a fix moved meanwhile shows (CK-967)', async () => {
  clearClaudes();
  await pageFix();
  setFix('doing');
  const { page, box, asked } = await healthPage();
  await page.renderHealth();
  assert.match(rowOf(box, 'pg'), /Doing · Claude is not running/);
  setFix('review'); // handed in by its Claude: an event of the board brings the section to look again
  await page.renderHealth();
  assert.equal(asked.filter((a) => a === 'GET /api/health').length, 1, 'the folders were walked again within 30 s');
  assert.equal(asked.filter((a) => a === 'GET /api/health/fixes').length, 2, 'the second look did not ask the fixes');
  assert.match(rowOf(box, 'pg'), /waits for your review/, 'the row kept a fix in work that is handed in');
});

test('task.live redraws the row of a fix: «Claude is not running» gives way to Claude at work, and back (CK-967)', async () => {
  // the complaint itself: the row said «Claude is not running» over a working Claude
  clearClaudes();
  const fx = await pageFix();
  setFix('doing');
  const { page, box, state } = await healthPage();
  await page.renderHealth();
  assert.match(rowOf(box, 'pg'), /Claude is not running/);
  // the real handler of the stream (public/js/sse.js), its neighbours given by the test
  const sse = pageSrc('sse.js');
  const at = sse.indexOf('function streamMessage(data) {');
  assert.ok(at >= 0, 'the handler of the stream is not where the test looks for it');
  const noop = () => {};
  const ctx = vm.createContext({
    state, lastSseAt: Date.now(), liveEvents: 0, silentTooLong: () => false, refresh: async () => {}, renderComments: noop,
    applyLive: (tasks) => { state.live = Object.fromEntries((tasks || []).map((x) => [x.id, { claude: x.claude }])); },
    applyTerminalQuestions: noop, maybeWaitingAlert: noop, maybeQuestionAlert: noop, markNowEntry: noop, peekTerminal: noop,
    loadTasks: async () => {}, DASH: 'dash', NOW: 'now', REVIEW: 'review', repaintHealth: page.repaintHealth,
  });
  vm.runInContext(`${sse.slice(at, sse.indexOf('\n}\n', at) + 3)}\nthis.message = streamMessage;`, ctx);
  const live = (tasks) => ctx.message(JSON.stringify({ type: 'task.live', data: { tasks, projects: [], questions: [] } }));
  live([{ id: fx.id, claude: 'working' }]);
  assert.match(rowOf(box, 'pg'), /card-live">working/, 'the row still says «Claude is not running» over a Claude at work');
  assert.doesNotMatch(rowOf(box, 'pg'), /Claude is not running/);
  live([{ id: fx.id, claude: 'waiting' }]);
  assert.match(rowOf(box, 'pg'), /card-live">waiting/, 'a change of the state of Claude alone did not redraw the row');
  live([]);
  assert.match(rowOf(box, 'pg'), /Claude is not running/, 'a Claude gone still reads as at work');
});

test('the words of the row of a fix are in the Russian dictionary (CK-967)', async () => {
  clearClaudes();
  await pageFix();
  const { page, box } = await healthPage({ tr: trRu });
  for (const status of ['doing', 'review', 'todo']) {
    setFix(status);
    await page.renderHealth({ force: true });
    assert.deepEqual([...rowOf(box, 'pg').matchAll(/MISSING<([^>]*)>/g)].map((m) => m[1]), [], `a fix in ${status}: words with no translation`);
  }
  setFix('doing');
  await page.renderHealth({ force: true });
  const row = rowOf(box, 'pg');
  for (const words of ['Claude is not running', 'Open the task of the fix']) assert.ok(row.includes(RU[words]), `«${words}» is not said in Russian`);
  assert.match(RU['Claude is not running'], /[\u0400-\u04ff]/, 'the Russian of «Claude is not running» is English');
  setFix('cancelled');
});
