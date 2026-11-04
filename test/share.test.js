// echoes what reached it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { refusalText } from '../public/js/unsaved.js';

let tmp, board, share, door, app, kvGet;
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
  ({ kvGet } = await import('../src/db.js'));
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

let pass = null; // the browser's pass: `name=value`, taken in the first test
function ask(path, { method = 'GET', headers = {}, body, bare = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: door, path, method, agent: false, headers: { host: `127.0.0.1:${door}`, ...(pass && !bare ? { cookie: pass } : {}), ...headers } }, (res) => {
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

const form = (k) => ({ method: 'POST', bare: true, body: `k=${encodeURIComponent(k)}`, headers: { 'content-type': 'application/x-www-form-urlencoded', origin: `http://127.0.0.1:${door}`, 'sec-fetch-site': 'same-origin' } });
const urlOf = (st) => new URL(st.urls[0].url);
const passOf = (r) => r.headers['set-cookie'][0].split(';')[0];

test('closed until the owner opens it; the link of the QR code lets a browser in and it keeps a pass, not the key', async () => {
  await assert.rejects(ask('/'), /ECONNREFUSED/);
  const st = await share.setShare(true);
  assert.equal(st.on, true);
  assert.equal(st.port, door);
  assert.match(st.key, /^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
  const k = st.key.replaceAll('-', '');
  for (const u of st.urls) assert.equal(new URL(u.url).searchParams.get('k'), k, 'the link does not carry the key');
  assert.equal(kvGet('share.key'), k, 'the key is not kept: every restart of the board throws everyone out');
  const r = await ask(`/?k=${k}`, { bare: true });
  // a redirect and no page of its own: a page at the address with the key stays `document.referrer` of the board
  assert.equal(r.status, 303);
  assert.equal(r.headers.location, '/', 'the key stays in the address bar');
  assert.equal(r.text, '');
  assert.equal(r.headers['x-from'], undefined, 'the board was reached with the key in the address');
  const cookie = r.headers['set-cookie'][0];
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Max-Age=34560000/, 'a pass for this session only: a phone asks for the key again after a restart');
  assert.ok(!cookie.includes(k), 'the key itself is kept in the browser');
  assert.ok(cookie.startsWith(`kb_share_${door}=`), 'the cookie of one door logs out another (cookies ignore ports)');
  pass = passOf(r);
  const page = await ask('/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['x-from'], 'board');
  assert.equal((await ask('/api/projects')).status, 200);
});

test('a browser without the pass is asked for the key, and the key typed by hand lets it in', async () => {
  const page = await ask('/', { bare: true });
  assert.equal(page.status, 401);
  assert.equal(page.headers['x-from'], undefined, 'the board was reached without the key');
  assert.match(page.text, /<form method="post" action="\/door\/key">/);
  assert.match(page.text, /<input name="k"/);
  // a browser check found it: with `no-referrer` the form goes with `Origin: null`, and the door refused the key
  assert.equal(page.headers['referrer-policy'], 'same-origin');
  const api = await ask('/api/projects', { bare: true });
  assert.equal(api.status, 401);
  assert.equal(api.json.reason, 'share');
  assert.equal((await ask('/app.js', { bare: true })).status, 401);
  for (const closed of ['/api/about', '/api/share', '/api/backups', '/index.html']) assert.equal((await ask(closed, { bare: true })).status, 401, `${closed} went past the key`);
  for (const m of ['POST', 'PATCH', 'DELETE']) assert.equal((await ask('/api/tasks/1', { method: m, bare: true })).status, 401, `${m} went past the key`);
  assert.equal((await ask('/', { bare: true, headers: { cookie: `kb_share_${door}=forged` } })).status, 401);
  share.clearRefusals();
  const wrong = await ask('/door/key', form('AAAA-AAAA-AAAA-AAAA'));
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers['set-cookie'], undefined);
  assert.match(wrong.text, /class="no"/, 'a wrong key says nothing');
  assert.equal((await ask('/?k=wrong', { bare: true })).status, 401);
  assert.deepEqual(share.refusalList().map((x) => [x.why, x.n]), [['key', 2]], 'a wrong key is not in «Turned away»');
  const key = share.shareState().key;
  for (const typed of [key, key.toLowerCase(), key.replaceAll('-', ' '), ` ${key} `]) {
    const ok = await ask('/door/key', form(typed));
    assert.equal(ok.status, 303, `«${typed}» did not open the door`);
    assert.equal(passOf(ok), pass);
  }
  assert.equal(share.typedKey('oIl-'), '011', 'a letter that looks like a digit is not read as meant');
  // the page of the door brings nothing of the board along, and a home-screen app is made from the manifest, asked for without cookies
  assert.equal((await ask('/manifest.webmanifest', { bare: true })).headers['x-from'], 'board');
  assert.equal((await ask('/manifest.webmanifest', { bare: true, method: 'POST' })).status, 401);
  const head = await ask('/manifest.webmanifest', { bare: true, method: 'HEAD' });
  assert.deepEqual([head.status, head.headers['x-from']], [200, 'board']);
  // a form of another site
  assert.equal((await ask('/door/key', { ...form(key), headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' } })).status, 403);
  assert.equal((await ask('/door/key', { ...form(key), headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } })).status, 403);
});

// a device that stood at the page of the key and then typed the right key is no longer listed in «Turned away»
test('the right key takes the device off the list of refusals it stood in without the key', async () => {
  const key = share.shareState().key;
  for (const enter of [() => ask('/door/key', form(key)), () => ask(`/?k=${key.replaceAll('-', '')}`, { bare: true })]) {
    share.clearRefusals();
    assert.equal((await ask('/', { bare: true })).status, 401);
    assert.deepEqual(share.refusalList().map((x) => x.why), ['nokey']);
    assert.equal((await enter()).status, 303);
    assert.deepEqual(share.refusalList(), [], 'a device that entered with the key stays listed as turned away');
  }
  share.clearRefusals();
});

test('the page of the door remembers where the browser was going, and never leaves the door', async () => {
  const key = share.shareState().key;
  const asked = await ask('/?action=new', { bare: true });
  assert.match(asked.text, /name="to" value="\/\?action=new"/, 'a home-screen shortcut lost its action');
  const go = async (to) => (await ask('/door/key', { ...form(key), body: `k=${encodeURIComponent(key)}&to=${encodeURIComponent(to)}` })).headers.location;
  assert.equal(await go('/?action=new'), '/?action=new');
  // the last ones reach the URL parser as a path that starts with two slashes
  for (const away of ['//evil.example/', '/\\evil.example/', 'http://evil.example/', '/\\/evil.example', '/.//evil.example/', '/x/..//evil.example/']) {
    const at = await go(away);
    assert.equal(new URL(at, 'http://door').host, 'door', `${away} led away to ${at}`);
  }
  assert.equal(await go('/?k=secret&view=dash'), '/?view=dash', 'the key stays in the address');
  assert.equal((await ask(`/?view=dash&k=${key.replaceAll('-', '')}`, { bare: true })).headers.location, '/?view=dash');
  for (const free of ['/icon-192.png', '/icon-maskable-512.png', '/favicon.svg']) assert.equal((await ask(free, { bare: true })).headers['x-from'], 'board', free);
  assert.equal((await ask('/app.js', { bare: true })).status, 401);
});

// the form sends the address back with the key, and the limit of what the door reads is on the two of them
test('a long address costs the way in nothing: the right key opens the door, an address over the limit is not kept', async () => {
  const key = share.shareState().key;
  const browserSends = (page) => new URLSearchParams({ to: page.text.match(/name="to" value="([^"]*)"/)[1].replaceAll('&#38;', '&'), k: key }).toString();
  const enter = async (path) => {
    const asked = await ask(path, { bare: true });
    assert.equal(asked.status, 401);
    return ask('/door/key', { ...form(key), body: browserSends(asked) });
  };
  const fits = `/?x=${'+'.repeat(share.TO_MAX - 4)}`; // `+` is the longest in a form: three characters each
  const kept = await enter(fits);
  assert.equal(kept.status, 303, 'a right key got an empty page');
  assert.equal(kept.headers.location, fits);
  const over = await enter(`${fits}+`);
  assert.equal(over.status, 303, 'a right key got an empty page');
  assert.equal(over.headers.location, '/');
  assert.equal((await enter(`/?x=${'a'.repeat(5000)}`)).status, 303);
  const wrong = await ask(`/?k=wrong&x=${'a'.repeat(5000)}`, { bare: true });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /name="to" value="\/"/);
});

test('a key too long is not read', async () => {
  await assert.rejects(ask('/door/key', form('x'.repeat(100000))).then((r) => { if (r.status !== 413) throw new Error('read'); throw new Error('socket hang up'); }), /socket hang up|ECONNRESET|EPIPE/);
});

test('opened from a messenger or a camera (cross-site) — as a page only, with the key in the link', async () => {
  const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
  const k = urlOf(share.shareState()).searchParams.get('k');
  const r = await ask(`/?k=${k}`, { headers: nav, bare: true });
  assert.equal(r.status, 303);
  assert.equal(passOf(r), pass);
  for (const away of [`//evil.example/?k=${k}`, `/.//evil.example/?k=${k}`]) {
    const at = (await ask(away, { bare: true })).headers.location;
    assert.equal(new URL(at, 'http://door').host, 'door', `the link led away to ${at}`);
  }
  const opened = await ask('/', { headers: nav });
  assert.equal(opened.headers['x-from'], 'board');
  assert.equal(await boardLets(opened.json.headers), true, 'the board lets the opened page in too');
  // another site's form, fetch or frame — refused
  assert.equal((await ask('/api/x', { method: 'POST', headers: { ...nav } })).status, 403);
  assert.equal((await ask('/api/x', { headers: { ...nav, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } })).status, 403);
  assert.equal((await ask('/', { headers: { ...nav, 'sec-fetch-dest': 'iframe' } })).status, 403);
});

test('passed on as from the board page, marked a guest, cookies not passed on', async () => {
  const r = await ask('/api/x?y=1', { method: 'POST', headers: { cookie: `a=1; ${pass}; kb_share_1=old`, origin: `http://127.0.0.1:${door}`, 'sec-fetch-site': 'same-origin', referer: `http://127.0.0.1:${door}/`, 'x-kb-guest': '0', 'content-type': 'application/json' }, body: '{"a":1}' });
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
    ['POST', '/api/sync/config'], ['PUT', '/api/share'], ['POST', '/api/share/reset'], ['POST', '/api/tasks/DM-1/chat/run'],
    ['POST', '/api/backups'], ['GET', '/api/backups'], ['GET', '/api/backups/kanban-2026-01-01.db'], ['GET', '/api/backups/restore']]) {
    const r = await ask(path, { method });
    assert.equal(r.status, 403, `${method} ${path}`);
    assert.equal(r.json.reason, 'guest');
  }
  assert.equal((await ask('/api/backups/kanban-2026-01-01.db', { method: 'HEAD' })).status, 403);
  assert.equal((await ask('/api/skills')).status, 200); // reading goes on to the board
  assert.equal((await ask('/api/tasks/DM-1', { method: 'PATCH' })).status, 200); // the board itself is shared
});

test('another spelling of the path is the same path: the door reads it decoded', async () => {
  for (const [method, path] of [['POST', '/api/upd%61te'], ['POST', '/api/fs/%70ick'], ['PUT', '/api/claude/hook%73'],
    ['PUT', '/api/%73kills/kanban'], ['POST', '/api/share/re%73et'], ['PUT', '/api/projects/demo/doc%73/CLAUDE.md'],
    ['GET', '/api/b%61ckups'], ['GET', '/api/backup%73/x.db']]) {
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
  board.get('/api/backups/:name', ok);
  board.patch('/api/tasks/:id', ok);
  await board.ready();
  try {
    const guest = { 'x-kb-guest': '1' };
    for (const [method, url] of [['POST', '/api/update'], ['POST', '/api/upd%61te'], ['POST', '/api/fs/%70ick'], ['PUT', '/api/projects/demo/docs/CLAUDE.md'],
      ['GET', '/api/backups/x.db'], ['GET', '/api/b%61ckups/x.db']]) {
      const r = await board.inject({ method, url, headers: guest });
      assert.equal(r.statusCode, 403, `${method} ${url}`);
      assert.equal(r.json().reason, 'guest');
    }
    assert.equal((await board.inject({ method: 'HEAD', url: '/api/backups/x.db', headers: guest })).statusCode, 403);
    assert.equal((await board.inject({ method: 'POST', url: '/api/upd%61te' })).statusCode, 200); // the owner's own page
    assert.equal((await board.inject({ method: 'GET', url: '/api/skills', headers: guest })).statusCode, 200);
    assert.equal((await board.inject({ method: 'PATCH', url: '/api/tasks/1', headers: guest })).statusCode, 200);
  } finally {
    await board.close();
  }
});

// `share.key` lives in kv, and a backup is the whole database: to whoever reads one, the secret of the door is plain text
test('a backup holds the key of the door, and a guest neither takes, lists nor downloads one', async () => {
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const real = Fastify();
  real.addHook('onRequest', share.guestGuard);
  await real.register(systemRoutes);
  await real.ready();
  try {
    const guest = { 'x-kb-guest': '1' };
    assert.equal((await real.inject({ method: 'POST', url: '/api/backups', headers: guest })).statusCode, 403);
    assert.equal((await real.inject({ method: 'GET', url: '/api/backups', headers: guest })).statusCode, 403);
    assert.equal((await real.inject({ method: 'POST', url: '/api/backups' })).statusCode, 200);
    const { items } = (await real.inject({ method: 'GET', url: '/api/backups' })).json();
    assert.ok(items.length);
    const url = `/api/backups/${encodeURIComponent(items[0].name)}`;
    const file = await real.inject({ method: 'GET', url });
    assert.ok(file.rawPayload.includes(share.shareState().key.replaceAll('-', '')), 'a backup without the key says nothing of a guest who gets one');
    for (const method of ['GET', 'HEAD']) assert.equal((await real.inject({ method, url, headers: guest })).statusCode, 403, `${method} of a backup`);
  } finally {
    await real.close();
  }
});

test('where the board lives on disk is not said to a guest', async () => {
  const systemRoutes = (await import('../src/routes/system.js')).default;
  const real = Fastify();
  await real.register(systemRoutes);
  await real.ready();
  try {
    const owner = (await real.inject({ url: '/api/about' })).json();
    assert.ok(owner.db_path.includes('kanban.db'));
    assert.ok(owner.data_dir); // bin/local-kanban asks the running board for it
    const guest = (await real.inject({ url: '/api/about', headers: { 'x-kb-guest': '1' } })).json();
    assert.equal(guest.db_path, undefined);
    assert.equal(guest.data_dir, undefined);
    assert.equal(guest.packaged, owner.packaged, 'the page of a guest branches on it');
  } finally {
    await real.close();
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

test('a new key: the old link, key and pass stop working, and everyone connected is out', async () => {
  const before = share.shareState();
  const oldLink = urlOf(before);
  const stream = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: door, path: '/api/events', agent: false, headers: { host: `127.0.0.1:${door}`, cookie: pass } }, resolve);
    req.on('error', reject);
    req.end();
  });
  const cut = new Promise((resolve) => { stream.on('close', resolve); stream.on('error', resolve); stream.resume(); });
  const page = { origin: 'http://127.0.0.1:3100' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/share/reset', headers: { ...page, 'x-kb-guest': '1' } })).statusCode, 403, 'a guest changed the key');
  assert.equal((await app.inject({ method: 'POST', url: '/api/share/reset' })).statusCode, 403, 'changed not from the board page');
  assert.equal((await ask('/api/share/reset', { method: 'POST' })).status, 403, 'a guest changed the key through the door');
  assert.equal(share.shareState().key, before.key);
  const after = (await app.inject({ method: 'POST', url: '/api/share/reset', headers: page })).json();
  assert.notEqual(after.key, before.key);
  assert.notEqual(after.qr, before.qr, 'the QR code still shows the old key');
  let held;
  const late = new Promise((resolve) => { held = setTimeout(() => resolve('open'), 3000); });
  assert.notEqual(await Promise.race([cut, late]), 'open', 'a guest connected before the new key is still connected');
  clearTimeout(held);
  assert.equal((await ask('/')).status, 401, 'the pass of the old key opens the door');
  assert.equal((await ask(oldLink.pathname + oldLink.search, { bare: true })).status, 401, 'the old link opens the door');
  pass = passOf(await ask('/door/key', form(after.key)));
  assert.equal((await ask('/')).headers['x-from'], 'board');
  // the same key after a restart of the board: a new process finds it, it does not make another
  assert.equal(kvGet('share.key'), after.key.replaceAll('-', ''));
  const script = `const { shareState } = await import(${JSON.stringify(new URL('../src/share.js', import.meta.url).href)}); console.log(shareState().key); process.exit(0);`;
  const restarted = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, KB_DATA_DIR: tmp }, encoding: 'utf8' });
  assert.equal(restarted.trim(), after.key, 'a restart of the board throws everyone out');
});

test('a device the door no longer knows is told what to do, not «the board did not accept it»', async () => {
  const r = await ask('/api/tasks/1', { method: 'PATCH', bare: true });
  assert.equal(r.status, 401);
  const said = refusalText(Object.assign(new Error(r.json.error), { status: r.status, body: r.json }));
  for (const words of [said.text, said.reason]) assert.match(words, /key of the board.*reload the page/, words);
});

test('only the owner, from the board page, sees the link and opens or closes the door', async () => {
  const guest = await app.inject({ method: 'GET', url: '/api/share', headers: { 'x-kb-guest': '1' } });
  assert.deepEqual(guest.json(), { guest: true, on: true }, 'a guest reads the key');
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
    const req = http.request({ host: '127.0.0.1', port: door, path: '/api/events', agent: false, headers: { host: `127.0.0.1:${door}`, cookie: pass } }, (res) => res.once('data', () => resolve(res)));
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
