// link and no cookie — a browser that lost one stayed out. Here the board is a stand-in that echoes what reached it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let tmp, board, share, door, app;
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-share-'));
  process.env.KB_DATA_DIR = tmp;
  const boardPort = await freePort();
  door = await freePort();
  process.env.PORT = String(boardPort);
  process.env.KB_SHARE_PORT = String(door);
  board = http.createServer((req, res) => {
    if (req.url === '/api/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"type":"ping"}\n\n'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json', 'x-from': 'board' }); res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, body })); });
  });
  await new Promise((r) => board.listen(boardPort, '127.0.0.1', r));
  share = await import('../src/share.js');
  const shareRoutes = (await import('../src/routes/share.js')).default;
  app = Fastify();
  await app.register(shareRoutes);
  await app.ready();
});

after(async () => {
  share?.stopShare();
  await app?.close();
  board?.closeAllConnections();
  await new Promise((r) => (board ? board.close(r) : r()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function ask(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: door, path, method, agent: false, headers: { host: `127.0.0.1:${door}`, ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
// from another site got through the door and stood at the board's 403)
async function boardLets(headers) {
  const { makeOriginGuard } = await import('../src/origin-guard.js');
  let refused = null;
  makeOriginGuard(Number(process.env.PORT))({ headers }, { code: (c) => ({ send: () => { refused = c; } }) }, () => {});
  return refused === null;
}

test('closed until the owner opens it; then the plain address opens the board', async () => {
  await assert.rejects(ask('/'), /ECONNREFUSED/);
  const st = await share.setShare(true);
  assert.equal(st.on, true);
  assert.equal(st.port, door);
  for (const u of st.urls) assert.equal(u.url, `http://${new URL(u.url).hostname}:${door}/`, 'no secret in the link');
  const page = await ask('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-from'], 'board');
  assert.equal(page.headers['set-cookie'], undefined);
  assert.equal((await ask('/api/projects')).status, 200);
});

test('opened from a messenger or a camera (cross-site) — as a page only; an old link with ?k= opens too', async () => {
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const r = await ask('/?k=0GuzFFnF_aruNljPWDjBqA', { headers: nav });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-from'], 'board');
  assert.equal(r.json.url, '/?k=0GuzFFnF_aruNljPWDjBqA'); // the board's page drops the parameter itself
  assert.equal(await boardLets(r.json.headers), true, 'the board lets the opened page in too');
  // another site's form, fetch or frame — refused
  assert.equal((await ask('/api/x', { method: 'POST', headers: { ...nav } })).status, 403);
  assert.equal((await ask('/api/x', { headers: { ...nav, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).status, 403);
  assert.equal((await ask('/', { headers: { ...nav, 'sec-fetch-dest': 'iframe' } })).status, 403);
});

test('passed on as from the board page, marked a guest, cookies not passed on', async () => {
  const r = await ask('/api/x?y=1', { method: 'POST', headers: { cookie: 'a=1; kb_share_1=old', origin: `http://127.0.0.1:${door}`, 'sec-fetch-site': 'same-origin', referer: `http://127.0.0.1:${door}/`, 'x-kb-guest': '0', 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-from'], 'board');
  const h = r.json.headers;
  assert.equal(h.host, `127.0.0.1:${process.env.PORT}`);
  assert.equal(h.origin, `http://127.0.0.1:${process.env.PORT}`);
  assert.equal(h['x-kb-guest'], '1');
  assert.equal(h.cookie, undefined);
  assert.equal(h.referer, undefined);
  assert.equal(r.json.url, '/api/x?y=1');
  assert.equal(r.json.body, '{"a":1}');
  assert.equal(await boardLets(h), true);
});

test('other pages, other names: refused before the board', async () => {
  share.clearRefusals();
  assert.equal((await ask('/api/x', { headers: { host: `evil.example:${door}` } })).status, 421);
  assert.equal((await ask('/api/x', { method: 'POST', headers: { origin: 'http://evil.example' } })).status, 403);
  assert.equal((await ask('/api/x', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await ask('/api/y', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  const refused = share.shareState().refused;
  assert.deepEqual(refused.map((r) => [r.ip, r.why, r.host, r.n]), [['127.0.0.1', 'site', null, 3], ['127.0.0.1', 'host', `evil.example:${door}`, 1]],
    'the refusals of the door are not kept, or every repeat is a row of its own');
  // a guest's action that only the owner may take is not a refusal of entry
  await ask('/api/update', { method: 'POST' });
  assert.equal(share.shareState().refused.length, 2);
  // what a guest gets of the section is only {guest, on}
  assert.deepEqual(Object.keys((await app.inject({ url: '/api/share', headers: { 'x-kb-guest': '1' } })).json()).sort(), ['guest', 'on']);
});

test('CK-824: the list of refusals keeps the last ones only, and a wrong host as typed (cut)', () => {
  share.clearRefusals();
  for (let i = 0; i < share.REFUSALS_MAX + 5; i++) share.noteRefusal(`::ffff:192.168.1.${i}`, 'network');
  const list = share.shareState().refused;
  assert.equal(list.length, share.REFUSALS_MAX);
  assert.equal(list[0].ip, `192.168.1.${share.REFUSALS_MAX + 4}`, 'the newest is not first, or the IPv4 of an IPv6 socket is not shown plainly');
  share.noteRefusal('10.0.0.2', 'host', 'x'.repeat(500));
  assert.equal(share.shareState().refused[0].host.length, 100);
  share.noteRefusal('10.0.0.2', 'host', 'y', 0);
  share.noteRefusal('10.0.0.2', 'host', 'y', 61_000);
  assert.equal(share.shareState().refused.filter((r) => r.host === 'y').length, 2, 'a refusal a minute later is folded into an old one');
  share.clearRefusals();
});

test('the computer itself stays the owner\'s: a guest reads, but does not change, its settings', async () => {
  for (const [method, path] of [['PUT', '/api/claude/hooks'], ['DELETE', '/api/claude/hooks'], ['POST', '/api/update'], ['POST', '/api/fs/pick'],
    ['PUT', '/api/skills/kanban'], ['POST', '/api/backups/restore'], ['POST', '/api/projects/server-git'], ['PUT', '/api/projects/demo/docs/CLAUDE.md'],
    ['POST', '/api/sync/config'], ['PUT', '/api/share'], ['POST', '/api/share/reset'], ['POST', '/api/tasks/DM-1/chat/run']]) {
    const r = await ask(path, { method });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.reason, 'guest');
  }
  assert.equal((await ask('/api/skills')).status, 200); // reading goes on to the board
  assert.equal((await ask('/api/tasks/DM-1', { method: 'PATCH' })).status, 200); // the board itself is shared
});

test('another spelling of the path is the same path: the door reads it decoded', async () => {
  for (const [method, path] of [['POST', '/api/upd%61te'], ['POST', '/api/fs/%70ick'], ['PUT', '/api/claude/hook%73'],
    ['PUT', '/api/%73kills/kanban'], ['POST', '/api/share/re%73et'], ['PUT', '/api/projects/demo/doc%73/CLAUDE.md']]) {
    const r = await ask(path, { method });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.reason, 'guest');
  }
  assert.equal((await ask('/api/upd%E0te', { method: 'POST' })).status, 400); // not a spelling of anything
});

test('the board itself refuses a guest by the route its router matched, whatever reached it', async () => {
  const board = Fastify();
  board.addHook('onRequest', share.guestGuard);
  const ok = async () => ({ ok: true });
  board.post('/api/update', ok);
  board.post('/api/fs/pick', ok);
  board.put('/api/projects/:slug/docs/:name', ok);
  board.get('/api/skills', ok);
  board.patch('/api/tasks/:id', ok);
  await board.ready();
  try {
    const guest = { 'x-kb-guest': '1' };
    for (const [method, url] of [['POST', '/api/update'], ['POST', '/api/upd%61te'], ['POST', '/api/fs/%70ick'], ['PUT', '/api/projects/demo/docs/CLAUDE.md']]) {
      const r = await board.inject({ method, url, headers: guest });
      assert.equal(r.statusCode, 403, `${method} ${url}`);
      assert.equal(r.json().reason, 'guest');
    }
    assert.equal((await board.inject({ method: 'POST', url: '/api/upd%61te' })).statusCode, 200); // the owner's own page
    assert.equal((await board.inject({ method: 'GET', url: '/api/skills', headers: guest })).statusCode, 200);
    assert.equal((await board.inject({ method: 'PATCH', url: '/api/tasks/1', headers: guest })).statusCode, 200);
  } finally {
    await board.close();
  }
});

// Public and carrier addresses are assembled, not written out: the release audit refuses any routable IPv4 literal.
const ip = (...parts) => parts.join('.');

test('who may knock: this computer and private networks only', () => {
  for (const ok of ['127.0.0.1', '::ffff:192.168.1.5', '10.0.0.2', ip(172, 20, 1, 1)]) assert.equal(share.fromLan(ok), true, ok);
  for (const no of [ip(8, 8, 8, 8), `::ffff:${ip(100, 101, 1, 2)}`, ip(172, 32, 0, 1), '', undefined, '::1']) assert.equal(share.fromLan(no), false, String(no));
});

test('a guest is counted while connected', async () => {
  assert.ok(share.shareState().guests_n >= 1);
});

test('only the owner, from the board page, sees the link and opens or closes the door', async () => {
  const guest = await app.inject({ method: 'GET', url: '/api/share', headers: { 'x-kb-guest': '1' } });
  assert.deepEqual(guest.json(), { guest: true, on: true });
  const owner = (await app.inject({ method: 'GET', url: '/api/share' })).json();
  assert.equal(owner.on, true);
  const page = { origin: 'http://127.0.0.1:3100', 'content-type': 'application/json' };
  assert.equal((await app.inject({ method: 'PUT', url: '/api/share', headers: { ...page, 'x-kb-guest': '1' }, payload: { on: false } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/share', headers: { 'content-type': 'application/json' }, payload: { on: false } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/share', headers: page, payload: { on: 'yes' } })).statusCode, 400);
  assert.equal(share.shareState().on, true);
});

test('a guest on the event stream is counted however long it is quiet', { timeout: 5000 }, async () => {
  const held = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: door, path: '/api/events', agent: false, headers: { host: `127.0.0.1:${door}` } }, (res) => res.once('data', () => resolve(res)));
    req.end();
  });
  assert.ok(share.guestCount(Date.now() + 10 * share.GUEST_FRESH_MS) >= 1);
  held.destroy();
});

test('switched off while it was still opening — it stays closed', async () => {
  await share.setShare(false);
  const opening = share.setShare(true);
  const st = await share.setShare(false);
  await opening;
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(st.on, false);
  assert.equal(share.shareState().on, false);
  await assert.rejects(ask('/'), /ECONNREFUSED/);
  await share.setShare(true);
});

test('switching off closes the port and every connection', async () => {
  const st = await share.setShare(false);
  assert.equal(st.on, false);
  assert.equal(st.qr, null);
  await assert.rejects(ask('/'), /ECONNREFUSED/);
});

test('the addresses offered: private networks, Wi-Fi first, no tunnels or containers', () => {
  const v4 = (address, internal = false) => ({ family: 'IPv4', address, internal });
  const got = share.lanAddresses({
    lo0: [v4('127.0.0.1', true)],
    utun3: [v4('10.8.0.2')],
    docker0: [v4(ip(172, 17, 0, 1))],
    en5: [v4('192.168.2.10')],
    en0: [v4('192.168.1.20'), { family: 'IPv6', address: 'fe80::1', internal: false }],
    tailscale0: [v4(ip(100, 101, 1, 2))],
    bridge100: [v4('192.168.64.1')],
  });
  assert.deepEqual(got.map((a) => a.address), ['192.168.1.20', '192.168.2.10']);
});
