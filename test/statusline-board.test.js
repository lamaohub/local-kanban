// a second longer) — and its reading reached the board only while the board read the body of a request at once. A
// Fastify app with an asynchronous onRequest hook takes the body a moment later, and by then kb had gone: Node aborts
// a request whose client has closed before its body was read, and the reading was lost without a word (acceptance of
// Claude, so it could not see this. Here the board is the real one — src/server.js in its own process, every route and
// hook of it — with an asynchronous onRequest hook put in front, the way the first plugin that needs one would.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KB = join(ROOT, 'bin', 'kb');
const NOW_S = Math.floor(Date.now() / 1000);
let tmp;
const boards = [];

before(() => { tmp = mkdtempSync(join(tmpdir(), 'kb-test-')); });
after(() => {
  for (const b of boards) b.kill('SIGKILL');
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const freePort = () => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

/** The real board with an asynchronous onRequest hook of `ms` in front of everything — put in by a loader hook
    that wraps the Fastify factory server.js calls. Resolves with its address once it answers. */
async function board(ms) {
  const dir = mkdtempSync(join(tmp, 'board-'));
  mkdirSync(join(dir, 'claude'));
  // the factory server.js imports is swapped for one that puts the hook on every app it makes (a loader hook, so the
  // real server.js runs as it is)
  const wrap = join(dir, 'slow-fastify.mjs');
  writeFileSync(wrap, `import real from ${JSON.stringify(createRequire(join(ROOT, 'src', 'server.js')).resolve('fastify'))};
export default function slow(opts) {
  const app = real(opts);
  app.addHook('onRequest', async () => { await new Promise((r) => setTimeout(r, ${Number(ms)})); });
  return app;
}
`);
  const hooks = join(dir, 'hooks.mjs');
  writeFileSync(hooks, `export async function resolve(spec, ctx, next) {
  if (spec === 'fastify' && String(ctx.parentURL).endsWith('/src/server.js')) return { url: ${JSON.stringify(pathToFileURL(wrap).href)}, shortCircuit: true };
  return next(spec, ctx);
}
`);
  const preload = join(dir, 'register.mjs');
  writeFileSync(preload, `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`);
  const port = await freePort();
  const proc = spawn(process.execPath, ['--import', pathToFileURL(preload).href, join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(port), KB_DATA_DIR: dir, KB_CLAUDE_DIR: join(dir, 'claude'), KB_LOCAL_ROOT: join(dir, 'projects'),
      KB_TMUX_SOCKET: `kb-test-statusline-${process.pid}-${port}`, KB_GH_OWNER: '', KB_GH_REPO: '', KB_PANEL_INFO: '', PANEL_INFO: '',
      KB_PANEL_URL: '', PANEL_URL: '', KB_SKILLS_EXTRA: '', KB_PREVIEW_TTL_MS: '120000', KB_URL: '',
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  boards.push(proc);
  let err = '';
  proc.stderr.on('data', (c) => { err += c; });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) break;
    try { if ((await fetch(`${base}/api/limits`)).ok) return base; } catch { /* still starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the board did not start: ${err}`);
}

const statusJson = (five) => JSON.stringify({ model: { id: 'claude-opus-5-5' }, rate_limits: {
  five_hour: { used_percentage: five, resets_at: NOW_S + 7200 }, seven_day: { used_percentage: 3, resets_at: NOW_S + 86400 } } });

function kb(input, base) {
  return new Promise((resolve) => {
    const started = Date.now();
    const env = { ...process.env, KB_URL: base };
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(process.execPath, [KB, 'statusline'], { env });
    let stdout = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.on('close', (code) => resolve({ code, stdout, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

/** What the board holds for the 5-hour window — looked at for a while: a reading still on its way counts. */
async function heard(base, five) {
  const until = Date.now() + 2000;
  for (;;) {
    const got = (await (await fetch(`${base}/api/limits`)).json()).windows?.five_hour?.used;
    if (got === five || Date.now() > until) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

for (const ms of [50, 200]) {
  test(`every reading reaches the real board when it reads the request ${ms} ms late`, { timeout: 60000 }, async () => {
    const base = await board(ms);
    const lost = [];
    for (let i = 1; i <= 6; i++) {
      const five = 10 * i + ms / 50; // higher each time: within a window the board keeps the higher reading
      const input = statusJson(five);
      const r = await kb(input, base);
      assert.equal(r.code, 0);
      assert.equal(r.stdout, input, 'the JSON for the next status line changed on the way');
      if (await heard(base, five) !== five) lost.push(five);
    }
    assert.deepEqual(lost, [], `the board never got ${lost.length} of 6 readings`);
  });
}
