import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = fileURLToPath(new URL('../public/', import.meta.url));

function frontendFiles() {
  const out = [];
  for (const dir of ['', 'js']) {
    const abs = join(PUBLIC, dir);
    for (const f of readdirSync(abs)) {
      if (f.endsWith('.js')) out.push({ rel: dir ? `${dir}/${f}` : f, abs: join(abs, f) });
    }
  }
  return out;
}

function importedNames(src) {
  const names = new Set();
  for (const m of src.matchAll(/^\s*import\s*\{([^}]*)\}\s*from/gm)) {
    for (let part of m[1].split(',')) {
      part = part.trim();
      if (!part) continue;
      if (part.includes(' as ')) part = part.split(' as ').pop().trim();
      names.add(part);
    }
  }
  return names;
}

function mutableExports(src) {
  return [...src.matchAll(/^export let\s+([\w$]+)/gm)].map((m) => m[1]);
}

const files = frontendFiles().map((f) => ({ ...f, src: readFileSync(f.abs, 'utf8') }));

test('no module assigns to a binding it imported', () => {
  const owner = new Map();
  for (const f of files) for (const name of mutableExports(f.src)) owner.set(name, f.rel);

  const bad = [];
  for (const f of files) {
    const foreign = [...importedNames(f.src)].filter((n) => owner.has(n));
    if (!foreign.length) continue;
    f.src.split('\n').forEach((line, i) => {
      const code = line.split('//')[0];
      for (const name of foreign) {
        const declared = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\b`).test(code);
        const assigned = new RegExp(String.raw`(?<![.\w$])${name}\s*(?:=(?![=>])|\+=|-=|\|\|=|\?\?=|\+\+|--)`).test(code);
        if (assigned && !declared) bad.push(`${f.rel}:${i + 1} assigns to ${name} (owned by ${owner.get(name)})`);
      }
    });
  }

  assert.deepEqual(bad, [], `assignment to an imported binding throws a TypeError at runtime.\n${bad.join('\n')}`);
});

test('shared mutable state is changed through setters', () => {
  const core = files.find((f) => f.rel === 'js/core.js').src;
  const board = files.find((f) => f.rel === 'js/board.js').src;
  assert.match(core, /export function setGhSyncOn\(/, 'setGhSyncOn disappeared from core.js');
  assert.match(board, /export function setScrollToNewCardId\(/, 'setScrollToNewCardId disappeared from board.js');
});
