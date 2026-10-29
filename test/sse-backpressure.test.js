import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import Fastify from 'fastify';

let app, tmp, port, events, emit;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  events = await import('../src/routes/events.js');
  ({ emit } = await import('../src/bus.js'));
  events.setSseBufferMax(256 * 1024);
  app = Fastify();
  await app.register(events.default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;
});

after(async () => {
  app?.server.closeAllConnections(); // a stream left open by a failed check must not hold the close forever
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
async function connect() {
  const sock = net.connect(port, '127.0.0.1');
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n\r\n`);
  for (let i = 0; i < 100 && events.sseCount() === 0; i++) await tick();
  return sock;
}
const BIG = 'x'.repeat(100_000);
// events one by one, as the board sends them, until it drops the stream or `mb` megabytes went out
async function flood(mb) {
  let sent = 0;
  while (sent < mb * 1e6 && events.sseCount() > 0) {
    emit('task.comment', { body: BIG });
    sent += BIG.length;
    await tick(1);
  }
  await tick(50);
}

test('a client that stopped reading is dropped instead of piling the stream up in memory', async () => {
  const sock = await connect();
  try {
    assert.equal(events.sseCount(), 1);
    sock.pause();
    await flood(64);
    assert.equal(events.sseCount(), 0, 'the board kept writing to a client that reads nothing');
  } finally { sock.destroy(); }
});

test('a client that reads keeps its stream through the same burst', async () => {
  const sock = await connect();
  let got = 0;
  sock.on('data', (c) => { got += c.length; });
  try {
    await flood(8);
    assert.equal(events.sseCount(), 1, 'a reading client was dropped');
    assert.ok(got > 4e6, `the client got only ${got} bytes`);
  } finally { sock.destroy(); }
  for (let i = 0; i < 100 && events.sseCount() > 0; i++) await tick();
  assert.equal(events.sseCount(), 0, 'a closed stream is still counted');
});
