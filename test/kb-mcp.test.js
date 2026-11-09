// or Cursor would run it: initialize, tools/list, then each tool; the board's refusals come back as tool errors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const MCP = fileURLToPath(new URL('../bin/kb-mcp', import.meta.url));
let app, tmp, db, base, mcp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-mcp-'));
  process.env.KB_DATA_DIR = join(tmp, 'data');
  process.env.KB_LAUNCH_DRYRUN = '1'; // ▶ answers what it would start, nothing runs
  process.env.KB_CLAUDE_DIR = join(tmp, 'claude');
  mkdirSync(process.env.KB_CLAUDE_DIR);
  mkdirSync(join(tmp, 'work'));
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, path, next_task_no) VALUES ('mcp', 'MC', 'MCP demo', ?, 1)").run(join(tmp, 'work'));
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/projects.js')).default);
  await app.register((await import('../src/routes/system.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
  mcp = client();
});
after(async () => {
  mcp?.child.stdin.end();
  await app?.close();
  rmSync(tmp, { recursive: true, force: true });
});

const WAIT_MS = 10_000;
/** kb-mcp as a client runs it: a line of JSON-RPC in, a line out, answers matched by id. */
function client() {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, KB_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  const lines = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s) => {
    buf += s;
    let at;
    while ((at = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, at));
      buf = buf.slice(at + 1);
      lines.push(m);
      for (const one of Array.isArray(m) ? [] : [m]) waiting.get(one.id)?.(one);
      if (Array.isArray(m)) waiting.get(`batch:${m.map((x) => x.id).sort().join(',')}`)?.(m);
    }
  });
  let n = 0;
  const wait = (key, what, send) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(key); reject(new Error(`no answer to ${what} in ${WAIT_MS} ms`)); }, WAIT_MS);
    waiting.set(key, (m) => { clearTimeout(timer); waiting.delete(key); resolve(m); });
    send();
  });
  const ask = (method, params) => { const id = ++n; return wait(id, method, () => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)); };
  const batch = (msgs) => wait(`batch:${msgs.filter((m) => m.id != null).map((m) => m.id).sort().join(',')}`, 'a batch', () => child.stdin.write(`${JSON.stringify(msgs)}\n`));
  const call = async (name, args) => (await ask('tools/call', { name, arguments: args })).result;
  return { child, ask, batch, call, lines };
}
const text = (r) => r.content.map((c) => c.text).join('');

test('initialize names the server and the version the client asked for; tools/list gives the tools with their schemas', async () => {
  const init = await mcp.ask('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } });
  assert.equal(init.result.serverInfo.name, 'local-kanban');
  mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`); // no answer to a notification
  const later = await mcp.ask('initialize', { protocolVersion: '1999-01-01' });
  assert.equal(later.result.protocolVersion, '2025-06-18', 'an unknown version gets the newest');
  const tools = (await mcp.ask('tools/list', {})).result.tools;
  assert.deepEqual(tools.map((t) => t.name), ['list_projects', 'list_tasks', 'get_task', 'create_task', 'update_task', 'add_comment', 'start_task']);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object', t.name);
  assert.equal((await mcp.ask('ping', {})).result && true, true);
  assert.equal((await mcp.ask('resources/list', {})).error.code, -32601);
});

test('the tools do what the board does: create, list, read, change, comment, start', async () => {
  assert.match(text(await mcp.call('list_projects', {})), /^mcp \(MC\) — MCP demo/);
  const made = await mcp.call('create_task', { project: 'MC', title: 'From an MCP client', description: '- [ ] one\n- [ ] two', priority: 'high', status: 'todo' });
  assert.equal(made.isError, undefined, text(made));
  assert.equal(text(made), 'MC-1 created in todo');
  assert.equal(text(await mcp.call('list_tasks', { project: 'mcp' })), 'MC-1 [todo] high From an MCP client');
  const changed = await mcp.call('update_task', { key: 'mc-1', title: 'Renamed', labels_add: ['bug'] });
  assert.equal(text(changed), 'MC-1 [todo] high Renamed {bug}');
  assert.equal(text(await mcp.call('add_comment', { key: 'MC-1', body: 'looked at it' })), 'MC-1: comment added');
  const full = text(await mcp.call('get_task', { key: 'MC-1' }));
  assert.match(full, /^MC-1 \[todo\] high Renamed \{bug\}\nproject: mcp\n\n- \[ \] one\n- \[ \] two/);
  assert.match(full, /\] me: looked at it$/);
  assert.match(text(await mcp.call('list_tasks', { project: 'mcp', query: 'renamed' })), /^MC-1 /);
  const started = await mcp.call('start_task', { key: 'MC-1' });
  assert.equal(started.isError, undefined, text(started));
  assert.match(text(started), /^MC-1: Claude started inside the board .*a dry run, nothing started/);
});

test('the board\'s refusals and wrong arguments come back as tool errors, and the server goes on', async () => {
  const done = await mcp.call('update_task', { key: 'MC-1', status: 'done' });
  assert.equal(done.isError, true);
  assert.match(text(done), /the person's word/);
  const odd = await mcp.call('update_task', { key: 'MC-1', labels_add: ['not-a-label'] });
  assert.equal(odd.isError, true);
  assert.match(text(odd), /^the board refused \(400\)/);
  assert.equal((await mcp.call('get_task', { key: 'MC-99' })).isError, true);
  assert.match(text(await mcp.call('get_task', { key: '../x' })), /key: a task key/);
  assert.equal((await mcp.ask('tools/call', { name: 'rm_rf', arguments: {} })).error.code, -32602);
  mcp.child.stdin.write('not json\n');
  assert.match(text(await mcp.call('list_projects', {})), /^mcp /, 'a bad line stopped the server');
  assert.ok(mcp.lines.some((m) => m.error?.code === -32700));
});

test('a notification gets no answer, of any method; a request that is no request gets -32600', async () => {
  const before = mcp.lines.length;
  for (const m of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'create_task', arguments: { project: 'mcp', title: 'By a notification' } } }, { jsonrpc: '2.0', id: null, method: 'ping' }]) {
    mcp.child.stdin.write(`${JSON.stringify(m)}\n`);
  }
  await mcp.ask('ping', {});
  assert.deepEqual(mcp.lines.slice(before).map((m) => Object.keys(m.result || m.error || {})), [[]], 'something answered a notification');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title = 'By a notification'").get().n, 0, 'a notification ran a tool');
  const bad = await mcp.ask('tools/call', {}).then(() => mcp.lines.length);
  mcp.child.stdin.write(`${JSON.stringify({ jsonrpc: '1.0', id: 'x', method: 'ping' })}\n`);
  await mcp.ask('ping', {});
  assert.ok(mcp.lines.slice(bad).some((m) => m.id === 'x' && m.error?.code === -32600));
});

test('create_task without its words is a tool error, not a task «undefined»', async () => {
  for (const title of [undefined, '', '   ', 42, null]) {
    const r = await mcp.call('create_task', { project: 'mcp', ...(title === undefined ? {} : { title }) });
    assert.equal(r.isError, true, `title ${JSON.stringify(title)}: ${text(r)}`);
    assert.match(text(r), /^title: /);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE title IN ('undefined', '', '42', 'null')").get().n, 0);
});

test('a batch is answered as one array; one of notifications only, with nothing; an empty one is -32600', async () => {
  const r = await mcp.batch([{ jsonrpc: '2.0', id: 101, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 102, method: 'tools/call', params: { name: 'list_projects', arguments: {} } }]);
  assert.deepEqual(r.map((m) => m.id).sort(), [101, 102]);
  assert.match(text(r.find((m) => m.id === 102).result), /^mcp \(MC\)/);
  const before = mcp.lines.length;
  mcp.child.stdin.write(`${JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }])}\n`);
  mcp.child.stdin.write('[]\n');
  await mcp.ask('ping', {});
  const got = mcp.lines.slice(before);
  assert.equal(got.length, 2, JSON.stringify(got));
  assert.equal(got[0].error.code, -32600);
});

test('the end of stdin: the answers still in flight come whole, however large, before the server goes', async () => {
  const big = `${'a line of words, '.repeat(6)}end\n`.repeat(8000); // ~ 850 KB: a pipe takes 64 KB at a time
  assert.equal((await mcp.call('update_task', { key: 'MC-1', description: big })).isError, undefined);
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, KB_URL: base }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (s) => { out += s; });
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`kb-mcp did not go in ${WAIT_MS} ms`)); }, WAIT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.end([1, 2].map((id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'get_task', arguments: { key: 'MC-1' } } })).join('\n') + '\n');
  assert.equal(await closed, 0);
  const answers = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(answers.map((m) => m.id).sort(), [1, 2]);
  for (const m of answers) assert.ok(text(m.result).includes(big.trim()), `answer ${m.id} cut to ${text(m.result).length}`);
});
