
import http from 'node:http';
import { networkInterfaces, hostname } from 'node:os';
import { PORT, sharePort, isPreviewBoard } from './config.js';
import { kvGet, kvSet, logError, uiLang } from './db.js';
import { qrSvg } from './qr.js';

const PRIVATE = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];
// not a network people join: containers, VMs, VPN tunnels, the Mac's Internet Sharing
const NOT_LAN = /^(docker|br-|veth|vmnet|vboxnet|virbr|bridge|utun|tun|tap|llw|awdl)/;
/** The addresses on which people of this network can reach the computer, Wi-Fi first (en0 on a Mac, wl* on Linux). */
export function lanAddresses(ifaces = networkInterfaces()) {
  const out = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (NOT_LAN.test(name)) continue;
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && PRIVATE.some((r) => r.test(a.address))) out.push({ name, address: a.address });
    }
  }
  const rank = (n) => (/^(en0|wl)/.test(n) ? 0 : /^(en|eth)/.test(n) ? 1 : 2);
  return out.sort((a, b) => rank(a.name) - rank(b.name));
}
// who may knock at all: this computer and the private networks — the door listens on 0.0.0.0, and a public address
// or a tunnel (Tailscale's 100.64/10) would reach it too; the link travels in plain HTTP
const PEER = [/^127\./, ...PRIVATE];
export const fromLan = (addr) => PEER.some((r) => r.test(String(addr || '').replace(/^::ffff:/, '')));
/** Host headers the door answers: any IPv4 of this computer, its name and name.local — with the door's port. A Host
    of another name is DNS rebinding (origin-guard.js): 421. */
export function doorHosts(port = sharePort(), ifaces = networkInterfaces()) {
  const names = new Set();
  for (const list of Object.values(ifaces)) for (const a of list || []) if (a.family === 'IPv4' || a.family === 4) names.add(a.address);
  const h = hostname().toLowerCase();
  if (h) { names.add(h); names.add(h.endsWith('.local') ? h : `${h}.local`); }
  return new Set([...names].map((n) => `${n}:${port}`));
}
const HOSTS_FRESH_MS = 5000; // a guest's page is dozens of requests: the interfaces are read once in a while, not on each
let hostsCache = { at: 0, port: 0, set: null };
function knownHosts(port) {
  const now = Date.now();
  if (!hostsCache.set || hostsCache.port !== port || now - hostsCache.at > HOSTS_FRESH_MS) hostsCache = { at: now, port, set: doorHosts(port) };
  return hostsCache.set;
}
/* What stays the owner's even with the link: the computer the board runs on — Claude Code's settings.json, skills and
   project files on disk, ssh and git with the owner's keys, the board's update, a dialog on the owner's screen, a backup
   opened as a board, the GitHub mirror, the door itself. Reading them is fine; changing — 403 to a guest. The board
   itself (tasks, the chat and terminals of Claude, answers to its questions) is shared, as the owner asked. */
const OWNER_ONLY = [/^\/api\/claude\/hooks/, /^\/api\/update/, /^\/api\/fs\/pick/, /^\/api\/skills/, /^\/api\/backups\/restore/,
  /^\/api\/projects\/(clone|server-git|ssh-check)/, /^\/api\/projects\/[^/]+\/docs/, /^\/api\/sync\/config/, /^\/api\/share/,
  /^\/api\/tasks\/[^/]+\/chat\/run/]; // the chat's command opens a Terminal window on the owner's screen
export const ownerOnly = (method, path) => method !== 'GET' && method !== 'HEAD' && OWNER_ONLY.some((r) => r.test(path));
export const routedPath = (pathname) => { try { return decodeURIComponent(pathname); } catch { return null; } };
export async function guestGuard(req, reply) {
  if (isGuest(req) && ownerOnly(req.method, req.routeOptions?.url || '')) {
    return reply.code(403).send({ error: 'only the owner of the board changes the computer it runs on', reason: 'guest' });
  }
}

export const GUEST_HEADER = 'x-kb-guest';
export const isGuest = (req) => req.headers[GUEST_HEADER] === '1';
export const GUEST_FRESH_MS = 60_000; // «connected now»: an open request (the event stream) or one within a minute

let server = null;
let starting = null;
let error = null;
const guests = new Map(); // ip -> {open, seen}
// a request ends on the entry it began on: switching off clears the map while kicked requests still close, and an
// entry looked up again by ip would go below zero and stop counting the guest when they come back
function guestIn(ip) {
  let g = guests.get(ip);
  if (!g) { g = { open: 0, seen: 0 }; guests.set(ip, g); }
  g.open++; g.seen = Date.now();
  return g;
}
const guestOut = (g) => { g.open--; g.seen = Date.now(); };
export function guestCount(now = Date.now()) {
  let n = 0;
  for (const [ip, g] of guests) {
    if (g.open > 0 || now - g.seen < GUEST_FRESH_MS) n++;
    else guests.delete(ip);
  }
  return n;
}

const PAGE_TEXT = {
  en: {
    title: 'Board over Wi-Fi',
    locked: 'The board does not open this way. Open the address from the QR code (Settings → Wi-Fi) in the browser itself.',
  },
  ru: {
    title: 'Доска по Wi-Fi',
    locked: 'Так доска не открывается. Открой адрес из QR-кода («Настройки → Wi-Fi») прямо в браузере.',
  },
};
const pageText = () => PAGE_TEXT[uiLang() === 'en' ? 'en' : 'ru'];
function page(res, status, body) {
  const t = pageText();
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  });
  res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<title>${t.title}</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;max-width:420px;margin:18vh auto;padding:0 16px;color:#222;background:#fafafa}`
    + '@media (prefers-color-scheme:dark){body{color:#e8e8e8;background:#1c1c1c}a{color:#e8704e}}</style></head>'
    + `<body><h2>${t.title}</h2>${body}</body></html>`);
}
function refuse(req, res, status, error, reason = 'share') {
  if (String(req.url || '').startsWith('/api/')) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ error, reason }));
  }
  return page(res, status, `<p>${pageText().locked}</p>`);
}

export const REFUSALS_MAX = 20;
const REFUSAL_REPEAT_MS = 60_000;
const refusals = []; // newest first: {ip, why, host, at, n}
export function noteRefusal(addr, why, host = null, now = Date.now()) {
  const ip = String(addr || '?').replace(/^::ffff:/, '').slice(0, 64);
  const h = host == null ? null : String(host).slice(0, 100);
  const i = refusals.findIndex((r) => r.ip === ip && r.why === why && r.host === h && now - r.at < REFUSAL_REPEAT_MS);
  const r = i >= 0 ? refusals.splice(i, 1)[0] : { ip, why, host: h, n: 0 };
  r.n += 1;
  r.at = now;
  refusals.unshift(r);
  refusals.length = Math.min(refusals.length, REFUSALS_MAX);
}
export const refusalList = () => refusals.map((r) => ({ ...r, at: new Date(r.at).toISOString() }));
/** Tests start from an empty list. */
export function clearRefusals() { refusals.length = 0; }

const HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'];
const agent = new http.Agent({ keepAlive: true });

function handle(req, res) {
  if (!fromLan(req.socket.remoteAddress)) {
    noteRefusal(req.socket.remoteAddress, 'network');
    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'the board opens only to this computer\'s local network' }));
  }
  const port = sharePort();
  const host = String(req.headers.host || '').toLowerCase();
  if (!knownHosts(port).has(host)) {
    noteRefusal(req.socket.remoteAddress, 'host', host);
    res.writeHead(421, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'request addressed to an unexpected host' }));
  }
  const origin = req.headers.origin;
  if (origin && String(origin).toLowerCase() !== `http://${host}`) { noteRefusal(req.socket.remoteAddress, 'site'); return refuse(req, res, 403, 'cross-origin request rejected'); }
  let url;
  try { url = new URL(req.url || '/', `http://${host}`); } catch { noteRefusal(req.socket.remoteAddress, 'address'); return refuse(req, res, 400, 'bad address'); }

  // Another site may only open the board as a page (the link from a camera or a messenger, cross-site): its requests —
  // a form, a fetch, a frame — are refused, the board's own are same-origin. A link of the time of the secret
  const site = req.headers['sec-fetch-site'];
  const opened = (req.method === 'GET' || req.method === 'HEAD') && req.headers['sec-fetch-mode'] === 'navigate'
    && req.headers['sec-fetch-dest'] === 'document';
  if (site && site !== 'same-origin' && site !== 'none' && !opened) { noteRefusal(req.socket.remoteAddress, 'site'); return refuse(req, res, 403, 'cross-site request rejected'); }
  const path = routedPath(url.pathname);
  if (path === null) { noteRefusal(req.socket.remoteAddress, 'address'); return refuse(req, res, 400, 'bad address'); }
  if (ownerOnly(req.method, path)) return refuse(req, res, 403, 'only the owner of the board changes the computer it runs on', 'guest');

  const headers = { ...req.headers };
  for (const h of [...HOP, 'cookie', 'referer', GUEST_HEADER]) delete headers[h];
  headers.host = `127.0.0.1:${PORT}`;
  if (origin) headers.origin = `http://127.0.0.1:${PORT}`;
  headers[GUEST_HEADER] = '1';
  // a page another site opened has passed the check above; the board's origin-guard would refuse it again by the
  if (opened && site && site !== 'same-origin') headers['sec-fetch-site'] = 'none';

  const g = guestIn(req.socket.remoteAddress || '?');
  let counted = true;
  const done = () => { if (counted) { counted = false; guestOut(g); } };
  const up = http.request({ host: '127.0.0.1', port: PORT, method: req.method, path: req.url, headers, agent }, (upRes) => {
    const out = { ...upRes.headers };
    for (const h of HOP) delete out[h];
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ error: 'the board did not answer' })); } else res.destroy();
  });
  // the guest left before the answer ended (the event stream): the request upstream goes too (SSE_MAX)
  res.on('close', () => { done(); if (!res.writableFinished) up.destroy(); });
  req.pipe(up);
}

// the section asks every 3 s: the code is drawn once per link
let qrCache = { text: null, svg: null };
function qrOf(text) {
  if (qrCache.text !== text) qrCache = { text, svg: qrSvg(text) };
  return qrCache.svg;
}

/** What the owner's page shows (routes/share.js: a guest gets only `{guest, on}`). */
export function shareState() {
  const port = sharePort();
  const urls = lanAddresses().map((a) => ({ name: a.name, url: `http://${a.address}:${port}/` }));
  return {
    on: !!server, wanted: kvGet('share.on') === '1', port, error,
    urls, qr: server && urls[0] ? qrOf(urls[0].url) : null, guests_n: server ? guestCount() : 0,
    refused: refusalList(),
  };
}

export function startShare() {
  if (server) return Promise.resolve(true);
  if (isPreviewBoard()) return Promise.resolve(false);
  if (starting) return starting;
  starting = new Promise((resolve) => {
    const s = http.createServer(handle);
    s.once('error', (e) => {
      error = e?.code === 'EADDRINUSE' ? 'port-busy' : 'failed';
      logError('server', 'share', `Wi-Fi door on port ${sharePort()}: ${e?.message || e}`);
      resolve(false);
    });
    s.listen(sharePort(), '0.0.0.0', () => {
      if (kvGet('share.on') !== '1') { s.close(); resolve(false); return; } // switched off while it was opening
      s.removeAllListeners('error');
      s.on('error', (e) => logError('server', 'share', e?.message || String(e)));
      server = s;
      error = null;
      resolve(true);
    });
  }).finally(() => { starting = null; });
  return starting;
}

export function stopShare() {
  if (!server) return;
  const s = server;
  server = null;
  s.close();
  s.closeAllConnections();
  guests.clear();
}

export async function setShare(on) {
  kvSet('share.on', on ? '1' : '0');
  if (on) await startShare(); else { stopShare(); error = null; }
  return shareState();
}

/** On start: the door the owner left open stays open. */
export function restoreShare() {
  if (kvGet('share.on') === '1') startShare();
}
