// task's own over it; the values of the environment never reach a page or a command line — a settings file of 0600 does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  add.run(1, 'one'); add.run(2, 'two');
  P = await import('../src/profiles.js');
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
  assert.match(line, /--settings .*launch-\d+-p\d+\.json/);
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
