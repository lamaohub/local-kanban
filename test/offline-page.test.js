import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../public/${rel}`, import.meta.url), 'utf8');

test('the offline page has nothing the CSP of the board would block', () => {
  const html = read('offline.html');
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, 'an inline event handler — the CSP blocks it, the button does nothing');
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, 'an inline script — the CSP blocks it');
  assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, 'a script file — it does not load while the server is down');
});

test('the offline page retries by itself and by a link to the same address', () => {
  const html = read('offline.html');
  assert.match(html, /<meta http-equiv="refresh" content="\d+">/, 'the page no longer asks the board again by itself');
  assert.match(html, /<a class="retry" href="">/, 'Try again is no longer a link to the address that failed');
  assert.match(html, /<html lang="en">/, 'the text is English');
});

test('the service worker caches the offline page under a new name, so old installs get the fixed one', () => {
  const sw = read('sw.js');
  const name = sw.match(/const OFFLINE_CACHE = '([^']+)'/)?.[1];
  assert.ok(name, 'OFFLINE_CACHE is gone');
  assert.notEqual(name, 'kb-offline-v1', 'v1 holds the page with the blocked onclick — installed boards would keep it');
});
