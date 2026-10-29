import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { appShellHeaders, cacheControlFor, headerSetter } from '../src/static-headers.js';

test('a header lands on the Fastify reply and on the raw Node response alike', () => {
  const viaReply = {};
  headerSetter({ header: (k, v) => { viaReply[k] = v; } })('X-Content-Type-Options', 'nosniff');
  assert.deepEqual(viaReply, { 'X-Content-Type-Options': 'nosniff' });

  const viaRaw = {};
  headerSetter({ setHeader: (k, v) => { viaRaw[k] = v; } })('Referrer-Policy', 'no-referrer');
  assert.deepEqual(viaRaw, { 'Referrer-Policy': 'no-referrer' });
});

test('both static mounts set their headers through headerSetter', () => {
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // the public mount takes the shared hook, which is checked on both kinds of response below
  assert.match(src, /root: join\(ROOT, 'public'\),\s*setHeaders: appShellHeaders\(CSP\)/,
    'the public mount no longer uses appShellHeaders');
  const hooks = src.match(/setHeaders: \(\w+\) => [\s\S]*?\n?\s*\},?\n/g) || [];
  assert.equal(hooks.length, 1, 'expected one inline hook: the attachments mount');
  for (const hook of hooks) {
    assert.match(hook, /headerSetter\(/, `a mount sets headers directly again:\n${hook}`);
    assert.doesNotMatch(hook, /\.header\(|\.setHeader\(/, `a mount bypasses headerSetter:\n${hook}`);
  }
});

test('the app itself is never stored, everything else is revalidated', () => {
  for (const f of ['/x/public/index.html', '/x/public/offline.html', '/x/public/app.js', '/x/public/js/init.js',
    '/x/public/style.css', '/x/public/sw.js', '/x/public/boot-fallback.js', 'C:\\x\\public\\APP.JS']) {
    assert.equal(cacheControlFor(f), 'no-store', f);
  }
  for (const f of ['/x/public/favicon.svg', '/x/public/icon-192.png', '/x/public/manifest.webmanifest',
    '/x/public/favicon.ico', '/x/public/js', '/x/public/style.css.map', '', undefined]) {
    assert.equal(cacheControlFor(f), 'no-cache', String(f));
  }
});

test('the shared hook sets caching and the protective headers on either kind of response', () => {
  const viaRaw = {};
  appShellHeaders('default-src x')({ setHeader: (k, v) => { viaRaw[k] = v; } }, '/x/public/index.html');
  assert.deepEqual(viaRaw, {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': 'default-src x',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
});

test('the real static plugin serves the page, code and styles no-store, icons no-cache', async () => {
  const app = Fastify();
  app.register(fastifyStatic, {
    root: fileURLToPath(new URL('../public', import.meta.url)),
    setHeaders: appShellHeaders("default-src 'self'"),
  });
  await app.ready();
  try {
    const expect = {
      '/': 'no-store', // the page itself: the plugin hands setHeaders the path of index.html
      '/index.html': 'no-store',
      '/app.js': 'no-store',
      '/js/init.js': 'no-store',
      '/js/core.js': 'no-store',
      '/style.css': 'no-store',
      '/boot-fallback.js': 'no-store',
      '/sw.js': 'no-store',
      '/offline.html': 'no-store',
      '/favicon.svg': 'no-cache',
      '/icon-192.png': 'no-cache',
      '/manifest.webmanifest': 'no-cache',
    };
    for (const [url, cc] of Object.entries(expect)) {
      const res = await app.inject({ method: 'GET', url });
      assert.equal(res.statusCode, 200, url);
      assert.equal(res.headers['cache-control'], cc, url);
      assert.equal(res.headers['content-security-policy'], "default-src 'self'", url);
    }
  } finally {
    await app.close();
  }
});
