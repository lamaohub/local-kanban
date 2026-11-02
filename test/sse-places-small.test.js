import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import Fastify from 'fastify';

let app, tmp, port, events;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_SSE_MAX = '3';
  events = await import('../src/routes/events.js');
  app = Fastify();
  await app.register(events.default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;
});
after(async () => { app?.server.closeAllConnections(); await app?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

async function stream(guest) {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  const head = new Promise((r) => { let b = ''; const on = (c) => { b += c; if (b.includes('\r\n')) { sock.off('data', on); r(b.split('\r\n')[0]); } }; sock.on('data', on); });
  sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n${guest ? 'x-kb-guest: 1\r\n' : ''}\r\n`);
  return { sock, status: await head };
}

test('KB_SSE_MAX=3: guests get two, the third place stays the owner\'s', async () => {
  const a = await stream(true); const b = await stream(true); const c = await stream(true);
  assert.match(a.status, / 200 /); assert.match(b.status, / 200 /);
  assert.match(c.status, / 503 /, 'the guests took the last place');
  const o = await stream(false);
  assert.match(o.status, / 200 /, 'the owner found no place');
  for (const s of [a, b, c, o]) s.sock.destroy();
});
