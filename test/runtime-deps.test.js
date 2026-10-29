import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));

// The first Node 22 release that can require() an ES module without a flag.
const REQUIRE_ESM_SINCE = [22, 12];

function engineFloor(range) {
  const m = /^>=\s*(\d+)(?:\.(\d+))?/.exec(String(range).trim());
  assert.ok(m, `engines.node "${range}" is not a ">=" range this guard can read`);
  return [Number(m[1]), Number(m[2] || 0)];
}

function targets(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => targets(v, out));
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => targets(v, out));
  return out;
}

/** True when require() of this package needs a Node that can require ES modules. */
function esmOnly(meta) {
  const entry = meta.exports ?? meta.main ?? 'index.js';
  if (meta.exports && JSON.stringify(meta.exports).includes('"require"')) return false;
  const files = targets(entry).filter((t) => /\.[cm]?js$/.test(t));
  if (files.some((f) => f.endsWith('.cjs'))) return false;
  if (meta.type === 'module') return true;
  return files.length > 0 && files.every((f) => f.endsWith('.mjs'));
}

test('the ES-module detector reads the package shapes it was written for', () => {
  // content-disposition 3.0.0 — the package that took the board down
  assert.equal(esmOnly({ type: 'module', exports: './dist/index.js', main: './dist/index.js' }), true);
  // a dual package (glob, minimatch, lru-cache…) ships a require condition
  assert.equal(esmOnly({ type: 'module', exports: { '.': { import: './esm/i.js', require: './cjs/i.js' } } }), false);
  // a module-typed package that still hands CommonJS a .cjs file
  assert.equal(esmOnly({ type: 'module', exports: { '.': { default: './i.cjs' } } }), false);
  // plain CommonJS, with and without exports
  assert.equal(esmOnly({ main: 'index.js' }), false);
  assert.equal(esmOnly({ exports: { '.': './lib/index.js' } }), false);
  assert.equal(esmOnly({}), false);
  // no type field, but every entry is .mjs
  assert.equal(esmOnly({ exports: { '.': { import: './i.mjs' } } }), true);
});

test('every runtime dependency can be required on the oldest Node the package promises', (t) => {
  const floor = engineFloor(pkg.engines?.node);
  const floorRequiresEsm = floor[0] > REQUIRE_ESM_SINCE[0]
    || (floor[0] === REQUIRE_ESM_SINCE[0] && floor[1] >= REQUIRE_ESM_SINCE[1]);
  if (floorRequiresEsm) {
    t.diagnostic(`engines.node is ${pkg.engines.node}: ES-only dependencies are fine from here on`);
    return;
  }
  const offenders = [];
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (!path || entry.dev) continue; // '' is the package itself
    const file = join(ROOT, path, 'package.json');
    if (!existsSync(file)) continue; // an optional package for another platform
    const meta = JSON.parse(readFileSync(file, 'utf8'));
    if (esmOnly(meta)) offenders.push(`${meta.name}@${meta.version} (${path})`);
  }
  assert.deepEqual(offenders, [],
    `engines.node is ${pkg.engines.node}, but Node below ${REQUIRE_ESM_SINCE.join('.')} cannot require() `
    + 'these ES-only packages, so the board would not start there. Pin the dependency that pulls '
    + 'them in to a version that does not, or raise engines.node to >=22.12 on purpose.');
});
