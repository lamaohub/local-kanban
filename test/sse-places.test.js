// owner's page refused and silent. Guests get at most five of the twenty; the owner always has a place; a refused
// board over pm2's restart limit — all the streams together have a limit too.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import Fastify from 'fastify';

let app, tmp, port, events, emit, SSE_MAX;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  delete process.env.KB_SSE_MAX;
  events = await import('../src/routes/events.js');
  ({ emit, SSE_MAX } = await import('../src/bus.js'));
  app = Fastify();
  await app.register(events.default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = app.server.address().port;
});

after(async () => {
  app?.server.closeAllConnections();
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const open = [];
// a stream; resolves with its status line
async function stream({ guest = false } = {}) {
  const sock = net.connect(port, '127.0.0.1');
  open.push(sock);
  await new Promise((r) => sock.once('connect', r));
  const head = new Promise((r) => { let b = ''; const on = (c) => { b += c; if (b.includes('\r\n')) { sock.off('data', on); r(b.split('\r\n')[0]); } }; sock.on('data', on); });
  sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAccept: text/event-stream\r\n${guest ? 'x-kb-guest: 1\r\n' : ''}\r\n`);
  return { sock, status: await head };
}
const room = async (guest) => (await app.inject({ url: '/api/events/room', headers: guest ? { 'x-kb-guest': '1' } : {} })).json();
const closeAll = async () => { for (const s of open.splice(0)) s.destroy(); for (let i = 0; i < 200 && events.sseCount() > 0; i++) await tick(); };

test('guests take at most five places; the sixth guest is refused and can learn why; the owner still gets in', async () => {
  try {
    assert.equal(SSE_MAX, 20);
    for (let i = 0; i < events.GUEST_SSE_MAX; i++) assert.match((await stream({ guest: true })).status, / 200 /);
    assert.equal(events.guestCount(), 5);
    assert.deepEqual(await room(true), { full: true, reason: 'guests' });
    assert.match((await stream({ guest: true })).status, / 503 /, 'a sixth guest took a place of the owner');
    assert.deepEqual(await room(false), { full: false, reason: null });
    assert.match((await stream()).status, / 200 /, 'the owner was refused while guests held their share');
  } finally { await closeAll(); }
  assert.equal(events.guestCount(), 0, 'a closed stream of a guest is still counted');
});

test('the owner fills the rest; then everyone is refused as «full»', async () => {
  try {
    for (let i = 0; i < SSE_MAX; i++) assert.match((await stream()).status, / 200 /);
    assert.deepEqual(await room(false), { full: true, reason: 'full' });
    assert.match((await stream()).status, / 503 /);
  } finally { await closeAll(); }
});

test('streams that stopped reading are dropped once all of them together hold too much', async () => {
  events.setSseBufferMax(64 * 1024 * 1024); // one stream alone never reaches its own limit here
  events.setSseTotalMax(2 * 1024 * 1024);
  try {
    for (let i = 0; i < 6; i++) (await stream()).sock.pause();
    const BIG = 'x'.repeat(100_000);
    for (let sent = 0; sent < 40e6 && events.sseCount() === 6; sent += BIG.length * 6) { emit('task.comment', { body: BIG }); await tick(1); }
    await tick(50);
    assert.ok(events.sseCount() < 6, 'twenty-four megabytes waited in the board for clients that read nothing');
  } finally { await closeAll(); events.setSseBufferMax(0); events.setSseTotalMax(0); }
});
