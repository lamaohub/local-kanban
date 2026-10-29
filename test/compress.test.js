// live board 3.75 MB (0.74): a phone over Wi-Fi on a slow link took 38–45 s to open the board. Text answers go
// compressed now (src/compress.js, the built-in zlib — the owner's decision: no new dependency).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { COMPRESS_MIN, compressAnswer, pickEncoding } from '../src/compress.js';

let app, dir;
const BIG = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, title: `task ${i}`, status: 'todo' })));
const CODE = 'export const x = 1;\n'.repeat(400);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kb-compress-'));
  writeFileSync(join(dir, 'app.js'), CODE);
  writeFileSync(join(dir, 'tiny.css'), 'a{}');
  writeFileSync(join(dir, 'shot.png'), Buffer.alloc(4096, 7));
  app = Fastify();
  app.addHook('onSend', compressAnswer);
  await app.register(fastifyStatic, { root: dir });
  app.get('/api/big', (req, reply) => reply.send(JSON.parse(BIG)));
  app.get('/api/small', (req, reply) => reply.send({ ok: true }));
  app.get('/api/err', (req, reply) => reply.code(500).send({ error: 'x'.repeat(2000) }));
  app.get('/api/events', (req, reply) => reply.type('text/event-stream').send('data: {}\n\n'.repeat(400)));
  await app.ready();
});
after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

const get = (url, headers = {}) => app.inject({ method: 'GET', url, headers });
const unzip = (r) => (r.headers['content-encoding'] === 'br' ? zlib.brotliDecompressSync(r.rawPayload) : zlib.gunzipSync(r.rawPayload)).toString();

test('the encoding: brotli when taken, else gzip, none when the browser turns both away', () => {
  assert.equal(pickEncoding('gzip, deflate, br, zstd'), 'br');
  assert.equal(pickEncoding('gzip, deflate'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip;q=0.8'), 'gzip');
  assert.equal(pickEncoding('*'), 'gzip');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding(''), null);
  assert.equal(pickEncoding(undefined), null);
});

test('a big JSON answer goes compressed and comes back the same', async () => {
  for (const enc of ['br', 'gzip']) {
    const r = await get('/api/big', { 'accept-encoding': enc });
    assert.equal(r.headers['content-encoding'], enc);
    assert.match(r.headers.vary, /Accept-Encoding/);
    assert.ok(r.rawPayload.length < BIG.length / 3, `${enc}: ${r.rawPayload.length} of ${BIG.length}`);
    assert.deepEqual(JSON.parse(unzip(r)), JSON.parse(BIG));
    assert.notEqual(Number(r.headers['content-length']), BIG.length, 'the length of the uncompressed body was kept');
  }
  const plain = await get('/api/big');
  assert.equal(plain.headers['content-encoding'], undefined, 'a client that asked for nothing got it compressed');
  assert.match(plain.headers.vary, /Accept-Encoding/, 'a cache would hand the plain answer to a browser that takes it compressed');
});

test('a file of the page goes compressed; a small one, a picture and a range do not', async () => {
  const js = await get('/app.js', { 'accept-encoding': 'gzip, br' });
  assert.equal(js.headers['content-encoding'], 'br');
  assert.equal(unzip(js), CODE);
  assert.equal((await get('/tiny.css', { 'accept-encoding': 'br' })).headers['content-encoding'], undefined);
  const png = await get('/shot.png', { 'accept-encoding': 'br' });
  assert.equal(png.headers['content-encoding'], undefined);
  assert.deepEqual(png.rawPayload, readFileSync(join(dir, 'shot.png')));
  const part = await get('/app.js', { 'accept-encoding': 'br', range: 'bytes=0-99' });
  assert.equal(part.headers['content-encoding'], undefined, 'the bytes of a range are the file\'s, not the compressed ones');
  assert.equal(part.statusCode, 206);
});

test('small answers, errors and the event stream', async () => {
  assert.ok(JSON.stringify({ ok: true }).length < COMPRESS_MIN);
  assert.equal((await get('/api/small', { 'accept-encoding': 'br' })).headers['content-encoding'], undefined);
  const err = await get('/api/err', { 'accept-encoding': 'gzip' });
  assert.equal(err.headers['content-encoding'], 'gzip', 'a long refusal is text like any other');
  assert.equal(JSON.parse(unzip(err)).error.length, 2000);
  assert.equal((await get('/api/events', { 'accept-encoding': 'br' })).headers['content-encoding'], undefined,
    'a compressed event stream holds events back in the compressor');
  const head = await app.inject({ method: 'HEAD', url: '/app.js', headers: { 'accept-encoding': 'br' } });
  assert.equal(head.headers['content-encoding'], undefined);
});

test('the hook stands on the root instance before the plugins', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const hook = src.indexOf("app.addHook('onSend', compressAnswer);");
  assert.ok(hook > 0, 'the server does not compress');
  assert.ok(hook < src.indexOf('app.register(fastifyStatic'), 'a hook added after the static plugin does not cover its files');
});
