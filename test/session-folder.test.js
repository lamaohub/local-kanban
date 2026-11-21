// the project's instructions only from the folder a session was opened in. kb warns when it hands a task to such a
// session (show, take, mv … prep); a session in the project's folder, in a copy of its repository or launched by ▶
// hears nothing. The real `bin/kb` against a stand-in board, a Claude folder of its own and real git repositories.
// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bin as fullPath } from '../src/bin-path.js';
import { foreignFolder, startFolder } from '../src/session-folder.js';
import { withFolders } from '../public/js/launch-rules.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kb-folder-')));
after(() => rmSync(root, { recursive: true, force: true }));
const claude = join(root, 'claude');
const repo = join(root, 'repo'); // the project's repository; the project is a folder inside it, as in a monorepo
const project = join(repo, 'app');
const copy = join(root, 'copy'); // another worktree of the same repository
const foreign = join(root, 'elsewhere');
const git = (...a) => execFileSync(fullPath('git'), a, { stdio: 'ignore' });
const ids = { inside: '11111111-1111-4111-8111-111111111111', copy: '22222222-2222-4222-8222-222222222222',
  foreign: '33333333-3333-4333-8333-333333333333', unknown: '44444444-4444-4444-8444-444444444444' };

let server, base;
let failProject = false;
before(async () => {
  mkdirSync(project, { recursive: true });
  mkdirSync(foreign);
  git('init', '-q', repo);
  writeFileSync(join(project, 'a.txt'), 'a');
  git('-C', repo, 'add', '.');
  git('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'a');
  git('-C', repo, 'worktree', 'add', '-q', copy);
  // a transcript starts with lines without cwd; the session's folder is the first cwd
  const transcript = (id, cwd) => {
    const dir = join(claude, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jsonl`), `${JSON.stringify({ type: 'summary' })}\n${JSON.stringify({ type: 'user', cwd, sessionId: id })}\n${JSON.stringify({ type: 'user', cwd: '/somewhere/it/cd-ed' })}\n`);
  };
  transcript(ids.inside, project);
  transcript(ids.copy, copy);
  transcript(ids.foreign, foreign);
  server = createServer((req, res) => {
    const send = (body) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/api/projects/demo' && failProject) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"message":"Route GET:/api/projects/demo not found"}'); }
    if (req.url === '/api/projects/demo') return send({ slug: 'demo', name: 'Demo', path: project });
    if (req.url.endsWith('/comments')) return send([]);
    if (req.url === '/api/tasks/take') return send({ task, blocked_n: 0 });
    return send(task);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const task = { id: 7, key: 'DM-7', status: 'prep', project: 'demo', title: 'a task', labels: [], checklist: [], links: [] };
const run = (args, session) => new Promise((resolve) => {
  const e = { ...process.env, KB_URL: base, CLAUDE_CONFIG_DIR: claude };
  delete e.CLAUDE_CODE_SESSION_ID; delete e.CLAUDE_CODE_HOST_SESSION_ID; delete e.KB_CLAUDE_DIR; delete e.KB_DEBUG;
  if (session) e.CLAUDE_CODE_SESSION_ID = session;
  execFile(process.execPath, [KB, ...args], { env: e, cwd: project }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
});

test('the session\'s folder is the first cwd of its transcript; an unknown session has none', () => {
  assert.equal(startFolder(ids.foreign, claude), foreign);
  assert.equal(startFolder(ids.unknown, claude), null);
  assert.equal(startFolder('../../etc/passwd', claude), null, 'only a session id goes into a path');
});

test('in the folder, in a subfolder and in another copy of the repository — at home; elsewhere — foreign', () => {
  assert.equal(foreignFolder(project, project), false);
  assert.equal(foreignFolder(join(project), repo), false, 'a subfolder of the project');
  assert.equal(foreignFolder(copy, project), false, 'a project inside a monorepo is at home in any copy of the monorepo');
  assert.equal(foreignFolder(repo, project), false, 'the top of its own repository');
  assert.equal(foreignFolder(foreign, project), true);
  assert.equal(foreignFolder(join(root, 'gone'), project), false, 'a folder not on this machine — nothing is said');
  mkdirSync(join(root, 'site'), { recursive: true }); mkdirSync(join(root, 'site-old'), { recursive: true });
  assert.equal(foreignFolder(join(root, 'site-old'), join(root, 'site')), true, '/a/site-old was taken for a subfolder of /a/site');
});

test('kb warns a session opened elsewhere, once, with the right folder — on show, take and mv prep', async () => {
  for (const args of [['show', 'DM-7', 'DM-7'], ['take', 'demo'], ['mv', 'DM-7', 'prep']]) {
    const r = await run(args, ids.foreign);
    assert.equal(r.code, 0, r.stderr);
    const said = r.stderr.split('\n').filter((l) => l.startsWith('kb: warning — this session was opened in'));
    assert.equal(said.length, 1, `${args[0]}: ${r.stderr}`);
    assert.ok(said[0].includes(`opened in ${foreign}`) && said[0].endsWith(`open the session in ${project}, or read its CLAUDE.md before the work`), said[0]);
  }
});

test('a session in the project\'s folder, in a copy of its repository, an unknown one or none — no warning', async () => {
  for (const s of [ids.inside, ids.copy, ids.unknown, null]) {
    const r = await run(['show', 'DM-7'], s);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /this session was opened in/, `${s}: ${r.stderr}`);
  }
  failProject = true; // the board refuses the project: the command still does its work, with code 0
  const refused = await run(['show', 'DM-7'], ids.foreign);
  failProject = false;
  assert.equal(refused.code, 0, refused.stderr);
  assert.match(refused.stdout, /^DM-7 demo prep/);
  const moved = await run(['mv', 'DM-7', 'doing'], ids.foreign);
  assert.doesNotMatch(moved.stderr, /this session was opened in/, 'only taking the task is a start');
});

test('the copied prompt names the folder of its project, of each of several, and none for a project without one', () => {
  const tr = (s) => `«${s}»`; // a marked tr: a word that skips the dictionary shows
  assert.equal(withFolders('Do X-1', [{ slug: 'x', path: '/code/x' }], tr),
    'Do X-1\n«Project folder:» /code/x («Claude Code loads the project\'s instructions only in a session opened there»)');
  assert.match(withFolders('Do', [{ slug: 'x', path: '/a' }, { slug: 'y', path: '/b' }, { slug: 'z', path: '/a' }], tr), /\n«Project folders:» x — \/a; y — \/b \(/);
  assert.equal(withFolders('Do', [{ slug: 'x', path: '' }, null]), 'Do');
});
