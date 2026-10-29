// name the Russian board translates — a forgotten one would stand in the list in English.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
const sse = read('sse.js');
const core = read('core.js');

test('every sound of the list has a Russian name, and the list is more than the first eight', () => {
  const at = sse.indexOf('export const SOUND_LIB = {');
  assert.ok(at >= 0, 'SOUND_LIB is gone from sse.js');
  const lib = sse.slice(at, sse.indexOf('\n};', at));
  const names = [...lib.matchAll(/^\s+\w+:\s+\{ name: '([^']+)', play:/gm)].map((m) => m[1]);
  assert.ok(names.length >= 17, `only ${names.length} sounds`);
  assert.equal(new Set(names).size, names.length, 'two sounds share a name');
  for (const name of names) assert.ok(core.includes(`\n  '${name}': '`), `«${name}» has no Russian name`);
});
