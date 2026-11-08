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
      waiting.get(m.id)?.(m);
    }
  });
  let n = 0;
  const ask = (method, params) => new Promise((resolve) => {
    const id = ++n;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args) => (await ask('tools/call', { name, arguments: args })).result;
  return { child, ask, call, lines };
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
