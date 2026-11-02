import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLink } from '../public/js/live-link.js';

let tmp, board, share, door;
const freePort = () => new Promise((resolve) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-review-b-'));
  process.env.KB_DATA_DIR = tmp;
  const boardPort = await freePort();
  door = await freePort();
  process.env.PORT = String(boardPort);
  process.env.KB_SHARE_PORT = String(door);
  // a stand-in board: the stream is dropped mid-way, as the board drops a stream that fell behind (events.js)
  board = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"ping"}\n\n');
    setTimeout(() => res.destroy(), 50);
  });
  await new Promise((r) => board.listen(boardPort, '127.0.0.1', r));
  share = await import('../src/share.js');
  await share.setShare(true);
});
after(async () => {
  share?.stopShare();
  board?.closeAllConnections();
  await new Promise((r) => (board ? board.close(r) : r()));
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const ask = (path, headers = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: door, path, agent: false, headers: { host: `127.0.0.1:${door}`, ...headers } }, resolve);
  req.on('error', reject);
  req.end();
});

test('CK-856: a stream that never opened is said too — the first failure is a change of state', async () => {
  const states = [];
  class Refused { constructor() { queueMicrotask(() => this.onerror?.()); } close() {} }
  const link = createLink({ EventSourceImpl: Refused, timers: { setTimeout: () => 0, clearTimeout() {} }, onState: (s) => states.push(s) });
  link.start();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(states.length, 1, 'the page never heard of it: the board looks alive and nothing comes');
  assert.equal(states[0].up, false);
});

test('CK-869: a stream the board dropped ends for the guest too, or the guest never learns to reconnect', async () => {
  const first = await ask(`/?k=${share.shareState().key.replace(/-/g, '')}`);
  first.resume();
  const cookie = first.headers['set-cookie'][0].split(';')[0];
  const res = await ask('/api/events', { cookie });
  assert.equal(res.statusCode, 200);
  const gone = await new Promise((resolve) => {
    res.on('data', () => {});
    res.on('close', () => resolve(true));
    setTimeout(() => resolve(false), 1500);
  });
  assert.ok(gone, 'the door keeps the guest on a stream that no longer exists');
});

test('CK-824: a device with no key, or the pass of an old key, is in «Turned away»', async () => {
  share.clearRefusals();
  (await ask('/')).resume();
  assert.deepEqual(share.refusalList().map((r) => r.why), ['nokey']);
  share.clearRefusals();
  (await ask('/', { cookie: `kb_share_${door}=stale` })).resume();
  assert.deepEqual(share.refusalList().map((r) => r.why), ['oldpass']);
});

test('CK-824: a device that goes on to give the right key was not turned away; a wrong key stays', async () => {
  share.clearRefusals();
  (await ask('/')).resume();
  const right = await ask(`/?k=${share.shareState().key.replace(/-/g, '')}`);
  right.resume();
  assert.deepEqual(share.refusalList(), [], 'everybody who came in by hand stands in the list of the turned away');
  (await ask('/?k=WRONG')).resume();
  (await ask(`/?k=${share.shareState().key.replace(/-/g, '')}`)).resume();
  assert.deepEqual(share.refusalList().map((r) => r.why), ['key']);
});

test('CK-855: on a phone the sidebar is closed — the failure of the first list is said in the top bar too', () => {
  const src = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function sayProjectsFailed'), src.indexOf('export async function loadProjects'));
  assert.match(body, /\$\('load-badge'\)/, 'the only word is inside a sidebar closed off screen');
  const notice = src.slice(src.indexOf('function showLoadNotice'), src.indexOf('export function retryLoad'));
  assert.match(notice, /if \(!n && el\.dataset\.projects\) return;/, 'the tasks that came take away the word that the projects did not');
});
