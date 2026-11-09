// task's own over it; the values of the environment never reach a page or a command line — a settings file of 0600 does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const SECRET = 'or-v1-very-secret-value';
let tmp, db, app, P;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-prof-'));
  Object.assign(process.env, { KB_DATA_DIR: join(tmp, 'data'), KB_CLAUDE_DIR: join(tmp, 'claude'), KB_LAUNCH_DRYRUN: '1' });
  mkdirSync(process.env.KB_CLAUDE_DIR);
  mkdirSync(join(tmp, 'work'));
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('pf', 'PF', 'Profiles', ?, 3)").run(join(tmp, 'work'));
  const add = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'pf'), ?, ?, 'todo')");
  add.run(1, 'one'); add.run(2, 'two'); add.run(3, 'three'); add.run(4, 'four');
  P = await import('../src/profiles.js');
  (await import('../src/phantom.js')).setLookShare(0);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.register((await import('../src/routes/profiles.js')).default);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

let cheap, router;
test('a profile is checked at the door; its values never come back — only the names of its variables', async () => {
  for (const [body, field] of [[{ name: '' }, 'name'], [{ name: 'x', model: 'rm -rf /' }, 'model'], [{ name: 'x', effort: 'turbo' }, 'effort'],
    [{ name: 'x', env: { 'bad name': '1' } }, 'env'], [{ name: 'x', env: { KB_URL: 'http://evil' } }, 'env'], [{ name: 'x', env: { PATH: '/tmp' } }, 'env']]) {
    const r = await app.inject({ method: 'POST', url: '/api/profiles', payload: body });
    assert.equal(r.statusCode, 400, JSON.stringify(body));
    assert.equal(r.json().field, field);
  }
  cheap = (await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'Sonnet for simple work', model: 'claude-sonnet-5-5', effort: 'low' } })).json();
  const made = await app.inject({ method: 'POST', url: '/api/profiles', payload: { name: 'OpenRouter', model: 'anthropic/claude-opus', env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api', ANTHROPIC_AUTH_TOKEN: SECRET } } });
  assert.equal(made.statusCode, 201, made.body);
  router = made.json();
  assert.deepEqual(router.env, ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN']);
  assert.equal(router.third_party, true);
  const listed = await app.inject('/api/profiles');
  assert.ok(!listed.body.includes(SECRET), 'a value went to the page');
  // «***» keeps the stored value; a name left out goes
  await app.inject({ method: 'PATCH', url: `/api/profiles/${router.id}`, payload: { env: { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_AUTH_TOKEN: P.KEEP } } });
  assert.deepEqual(JSON.parse(P.profileById(router.id).env), { ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_AUTH_TOKEN: SECRET });
});

test('▶ inside the board: the task\'s own profile over the project\'s — its model and effort, its environment in a file of 0600, never in argv', async () => {
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/projects/pf', payload: { profile_id: cheap.id } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/projects/pf', payload: { profile_id: 9999 } })).statusCode, 400, 'a profile that is not there');
  let r = (await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', project: 'pf', keys: ['PF-1'], text: 'Do it', effort: 'max' } })).json();
  let argv = r.args.join(' ');
  assert.match(argv, /--model claude-sonnet-5-5/);
  assert.match(argv, /CLAUDE_CODE_EFFORT_LEVEL=low/, 'the profile\'s level over the page\'s');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/tasks/PF-1/profile', payload: { profile: router.id } })).statusCode, 200);
  assert.equal((await app.inject('/api/tasks/PF-1')).json().profile, router.id);
  r = (await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'board', project: 'pf', keys: ['PF-1'], text: 'Do it', effort: 'max' } })).json();
  argv = r.args.join(' ');
  assert.match(argv, /--model anthropic\/claude-opus/);
  assert.match(argv, /CLAUDE_CODE_EFFORT_LEVEL=max/, 'no level in the profile — the page\'s');
  assert.ok(!argv.includes(SECRET), 'the secret went on the command line');
  const file = r.args[r.args.indexOf('--settings') + 1];
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, SECRET);
  assert.ok(settings.hooks?.PermissionRequest, 'the hook of questions went with it');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  // the Terminal: the same file and model on the line, the secret not
  const t = (await app.inject({ method: 'POST', url: '/api/launch', payload: { mode: 'terminal', project: 'pf', keys: ['PF-1'], text: 'Do it' } })).json();
  const line = t.args.join(' ');
  assert.match(line, /--settings .*launch-\d+-p\d+-term\.json/);
  assert.match(line, /--model .?anthropic\/claude-opus/);
  assert.ok(!line.includes(SECRET));
  // back to the project's
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-1/profile', payload: { profile: null } });
  assert.equal(P.profileFor([{ id: db.prepare("SELECT id FROM tasks WHERE task_no = 1").get().id }], db.prepare("SELECT * FROM projects WHERE slug = 'pf'").get()).id, cheap.id);
});

test('a session on another provider is counted without Anthropic\'s prices', async () => {
  const { priceOf, THIRD_PARTY } = await import('../src/claude-usage.js');
  P.markSessionProfile('11111111-2222-4333-8444-555555555555', P.profileById(router.id));
  assert.equal(P.thirdPartySession('11111111-2222-4333-8444-555555555555'), true);
  assert.ok(priceOf('claude-opus-5-5'), 'the model has a price of its own');
  assert.equal(priceOf(`claude-opus-5-5 ${THIRD_PARTY}`), null, 'a third-party answer took Anthropic\'s price');
});

test('a deleted profile leaves the projects and tasks that had it; a guest neither edits nor picks one', async () => {
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-2/profile', payload: { profile: cheap.id } });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/profiles/${cheap.id}` })).statusCode, 200);
  assert.equal(db.prepare("SELECT profile_id FROM projects WHERE slug = 'pf'").get().profile_id, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM task_profiles').get().n, 0);
  const { ownerOnly } = await import('../src/share.js');
  assert.equal(ownerOnly('POST', '/api/profiles'), true);
  assert.equal(ownerOnly('PUT', '/api/tasks/:id/profile'), true);
  assert.equal(ownerOnly('GET', '/api/profiles'), false, 'the names are the board\'s, as its tasks');
});

const post = (payload) => app.inject({ method: 'POST', url: '/api/profiles', payload });
const launch = (payload) => app.inject({ method: 'POST', url: '/api/launch', payload });
const filesOf = (id) => readdirSync(process.env.KB_DATA_DIR).filter((f) => new RegExp(`^launch-\\d+-p${id}(-[a-z]+)?\\.json`).test(f)).map((f) => join(process.env.KB_DATA_DIR, f));
const settingsOf = (r) => r.args[r.args.indexOf('--settings') + 1];
const taskId = (no) => db.prepare('SELECT id FROM tasks WHERE task_no = ?').get(no).id;

test('a model may not start with «-», a name holds one line, and the switches of loading and of the board\'s own Claude are refused', async () => {
  for (const [body, field] of [[{ name: 'x', model: '--dangerously-skip-permissions' }, 'model'], [{ name: 'x', model: '-p' }, 'model'],
    [{ name: 'one\ntwo' }, 'name'], [{ name: 'tab\there' }, 'name'],
    ...['LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'BASH_ENV', 'CLAUDE_CODE_SIMPLE', 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN',
      'CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION', 'CLAUDE_CODE_EFFORT_LEVEL'].map((k) => [{ name: 'x', env: { [k]: '1' } }, 'env'])]) {
    const r = await post(body);
    assert.equal(r.statusCode, 400, `${JSON.stringify(body)} was taken`);
    assert.equal(r.json().field, field, JSON.stringify(body));
  }
  assert.match((await post({ name: 'x', env: { CLAUDE_CODE_EFFORT_LEVEL: 'max' } })).json().error, /effort/, 'the refusal does not say where the effort is set');
  assert.equal((await post({ name: 'fine-model', model: 'claude-opus-5-5[1m]' })).statusCode, 201, 'a model id was refused');
});

test('▶ inside the board and the Terminal write files of their own: a Terminal started meanwhile leaves the board\'s Claude its hook', async () => {
  const pr = (await post({ name: 'Both ways', model: 'claude-sonnet-5-5', env: { ANTHROPIC_AUTH_TOKEN: 'both-ways-key' } })).json();
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-3/profile', payload: { profile: pr.id } });
  const board = (await launch({ mode: 'board', project: 'pf', keys: ['PF-3'], text: 'Do it' })).json();
  const term = (await launch({ mode: 'terminal', project: 'pf', keys: ['PF-3'], text: 'Do it' })).json();
  const line = term.args.join(' ');
  const termFile = /--settings '?([^' ]+)/.exec(line)[1];
  assert.notEqual(termFile, settingsOf(board), 'the Terminal wrote the file of ▶ inside the board');
  const kept = JSON.parse(readFileSync(settingsOf(board), 'utf8'));
  assert.ok(kept.hooks?.PermissionRequest, 'the board\'s Claude lost the hook of questions to a Terminal started after it');
  assert.equal(kept.env.ANTHROPIC_AUTH_TOKEN, 'both-ways-key');
  const t = JSON.parse(readFileSync(termFile, 'utf8'));
  assert.equal(t.env.ANTHROPIC_AUTH_TOKEN, 'both-ways-key');
  assert.equal(t.hooks, undefined, 'the Terminal\'s Claude got the board\'s hook of questions');
  assert.equal(statSync(termFile).mode & 0o777, 0o600);
});

test('an edited key does not stay in the files of earlier starts; a deleted profile takes its files along', async () => {
  const pr = (await post({ name: 'Rotated', env: { ANTHROPIC_BASE_URL: 'https://example.invalid', ANTHROPIC_AUTH_TOKEN: 'old-leaked-key' } })).json();
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-4/profile', payload: { profile: pr.id } });
  const board = (await launch({ mode: 'board', project: 'pf', keys: ['PF-4'], text: 'Do it' })).json();
  await launch({ mode: 'terminal', project: 'pf', keys: ['PF-4'], text: 'Do it' });
  writeFileSync(join(process.env.KB_DATA_DIR, `launch-39999-p${pr.id}.json`), JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'old-leaked-key' } })); // another port's
  assert.equal(filesOf(pr.id).length, 3);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/profiles/${pr.id}`, payload: { env: { ANTHROPIC_BASE_URL: P.KEEP, ANTHROPIC_AUTH_TOKEN: 'new-key' } } })).statusCode, 200);
  for (const f of filesOf(pr.id)) {
    const text = readFileSync(f, 'utf8');
    assert.ok(!text.includes('old-leaked-key'), `the old key stayed in ${f}`);
    assert.match(text, /new-key/, `${f} did not get the new key`);
  }
  assert.ok(JSON.parse(readFileSync(settingsOf(board), 'utf8')).hooks?.PermissionRequest, 'the rewrite dropped the hook of questions');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/profiles/${pr.id}` })).statusCode, 200);
  assert.deepEqual(filesOf(pr.id), [], 'the settings files of a deleted profile stayed on the disk with its keys');
  assert.equal(existsSync(settingsOf(board)), false);
});

test('a guest does not switch a project to the owner\'s profile — in words of its own; the value it already has goes through', async () => {
  const pr = (await post({ name: 'Owner keys', env: { ANTHROPIC_AUTH_TOKEN: 'owner' } })).json();
  const guest = { 'x-kb-guest': '1' };
  const r = await app.inject({ method: 'PATCH', url: '/api/projects/pf', headers: guest, payload: { profile_id: pr.id } });
  assert.equal(r.statusCode, 403, 'a guest switched the project to the owner\'s launch profile');
  assert.equal(r.json().reason, 'guest');
  assert.match(r.json().error, /launch profile/, 'the refusal speaks of copies of the repository');
  assert.equal(db.prepare("SELECT profile_id FROM projects WHERE slug = 'pf'").get().profile_id, null);
  const same = await app.inject({ method: 'PATCH', url: '/api/projects/pf', headers: guest, payload: { profile_id: null, description: 'a guest\'s words' } });
  assert.equal(same.statusCode, 200, `the form of a project (it sends every field) was refused to a guest: ${same.body}`);
});

test('«Continue» goes on with the profile its session started on, not the task\'s new one', async () => {
  const first = (await post({ name: 'Started on', model: 'claude-haiku-5-5' })).json();
  const later = (await post({ name: 'Picked later', model: 'claude-opus-5-5' })).json();
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-2/profile', payload: { profile: later.id } });
  const sid = '22222222-3333-4444-8555-666666666666';
  P.markSessionProfile(sid, P.profileById(first.id));
  db.prepare('INSERT OR IGNORE INTO task_sessions (task_id, session_id) VALUES (?, ?)').run(taskId(2), sid);
  db.prepare('INSERT OR IGNORE INTO board_sessions (session_id) VALUES (?)').run(sid); // a Claude of the board
  const r = await launch({ mode: 'board', project: 'pf', keys: ['PF-2'], resume: sid });
  assert.equal(r.statusCode, 200, r.body);
  const argv = r.json().args.join(' ');
  assert.match(argv, /--model claude-haiku-5-5/, 'Continue took the task\'s profile over the one its session started on');
  assert.match(argv, /--resume/);
  // a session started on none: the task's
  const bare = '33333333-4444-4555-8666-777777777777';
  db.prepare('INSERT OR IGNORE INTO task_sessions (task_id, session_id) VALUES (?, ?)').run(taskId(2), bare);
  db.prepare('INSERT OR IGNORE INTO board_sessions (session_id) VALUES (?)').run(bare); // a Claude of the board
  assert.match((await launch({ mode: 'board', project: 'pf', keys: ['PF-2'], resume: bare })).json().args.join(' '), /--model claude-opus-5-5/);
});

test('▶ inside the board marks its session with the profile it started on — another provider\'s goes uncounted in Anthropic\'s money', async () => {
  const pr = (await post({ name: 'Elsewhere', model: 'some/model', env: { ANTHROPIC_BASE_URL: 'https://example.invalid' } })).json();
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-1/profile', payload: { profile: pr.id } });
  // a real start (no dry run) through a stand-in tmux that says yes to everything, and a stand-in claude
  const bin = join(tmp, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nexit 0\n');
  writeFileSync(join(bin, 'claude'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(bin, 'tmux'), 0o755); chmodSync(join(bin, 'claude'), 0o755);
  const saved = { PATH: process.env.PATH, KB_CLAUDE_BIN: process.env.KB_CLAUDE_BIN, KB_TMUX_SOCKET: process.env.KB_TMUX_SOCKET };
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, KB_CLAUDE_BIN: join(bin, 'claude'), KB_TMUX_SOCKET: `kb-profiles-${process.pid}` });
  delete process.env.KB_LAUNCH_DRYRUN;
  let r;
  try { r = await launch({ mode: 'board', project: 'pf', keys: ['PF-1'], text: 'Do it' }); } finally {
    process.env.KB_LAUNCH_DRYRUN = '1';
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  assert.equal(r.statusCode, 200, r.body);
  const sid = r.json().session;
  assert.equal(db.prepare('SELECT profile_id FROM session_profiles WHERE session_id = ?').get(sid)?.profile_id, pr.id, 'the session of ▶ was not marked with its profile');
  assert.equal(P.thirdPartySession(sid), true, 'a session on another provider would be counted at Anthropic\'s prices');
});

test('kb show names the launch profile of the task — its own, or its project\'s', async () => {
  const pr = (await post({ name: 'Shown in kb' })).json();
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-1/profile', payload: { profile: pr.id } });
  assert.equal((await app.inject('/api/tasks/PF-1')).json().profile_name, 'Shown in kb');
  await app.listen({ port: 0, host: '127.0.0.1' });
  const env = { ...process.env, KB_URL: `http://127.0.0.1:${app.server.address().port}` };
  const kb = (...a) => new Promise((ok) => { execFile(process.execPath, [fileURLToPath(new URL('../bin/kb', import.meta.url)), ...a], { env }, (e, out) => ok(out)); });
  assert.match(await kb('show', 'PF-1'), /^profile: Shown in kb$/m, 'kb show does not say the task\'s profile');
  await app.inject({ method: 'PUT', url: '/api/tasks/PF-1/profile', payload: { profile: null } });
  await app.inject({ method: 'PATCH', url: '/api/projects/pf', payload: { profile_id: pr.id } });
  assert.match(await kb('show', 'PF-1'), /^profile: Shown in kb \(the project's\)$/m);
  await app.inject({ method: 'PATCH', url: '/api/projects/pf', payload: { profile_id: null } });
  assert.doesNotMatch(await kb('show', 'PF-1'), /^profile:/m, 'a task with no profile printed one');
});
