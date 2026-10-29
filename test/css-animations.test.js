import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function blocks(src) {
  const out = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') { if (depth === 0) open = i; depth++; }
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { out.push({ prelude: src.slice(start, open).trim(), body: src.slice(open + 1, i) }); start = i + 1; }
    }
  }
  return out;
}
const norm = (sel) => sel.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
const top = blocks(css);
const keyframes = new Map(top.filter((b) => b.prelude.startsWith('@keyframes')).map((b) => [b.prelude.split(/\s+/)[1], b.body]));
const infinite = []; // { selector, name }
for (const b of top) {
  if (b.prelude.startsWith('@')) continue;
  const m = /(?:^|;)\s*animation\s*:\s*([^;]*\binfinite\b[^;]*)/.exec(b.body);
  if (!m) continue;
  const name = m[1].trim().split(/\s+/).find((w) => keyframes.has(w));
  for (const selector of norm(b.prelude)) infinite.push({ selector, name });
}
const reduced = new Set();
for (const b of top.filter((x) => /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/.test(x.prelude))) {
  for (const r of blocks(b.body)) if (/animation\s*:\s*none/.test(r.body)) norm(r.prelude).forEach((s) => reduced.add(s));
}

test('the style sheet has infinite animations to check — otherwise this test proves nothing', () => {
  assert.ok(infinite.length >= 5, `found only ${infinite.length}`);
  assert.ok(infinite.every((a) => a.name), `an infinite animation names no @keyframes of this sheet: ${JSON.stringify(infinite.filter((a) => !a.name))}`);
});

test('an infinite animation moves only transform and opacity', () => {
  const bad = [];
  for (const { selector, name } of infinite) {
    const props = [...keyframes.get(name).matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
    const other = props.filter((p) => p !== 'transform' && p !== 'opacity');
    if (other.length) bad.push(`${selector} → @keyframes ${name}: ${[...new Set(other)].join(', ')}`);
  }
  assert.deepEqual(bad, [], `these repaint the tab every frame while it is visible:\n${bad.join('\n')}`);
});

test('an infinite animation runs on a pseudo-element of its own', () => {
  const BOOT = new Set(['.boot-head', '.boot-line']);
  const bare = infinite.filter((a) => !/::(before|after)$/.test(a.selector) && !BOOT.has(a.selector)).map((a) => a.selector);
  assert.deepEqual(bare, [], 'these animate an element itself, not a layer of their own');
});

test('reduced motion turns every infinite animation off', () => {
  const missed = infinite.filter((a) => !reduced.has(a.selector)).map((a) => a.selector);
  assert.deepEqual(missed, [], 'prefers-reduced-motion: reduce leaves these running (the selector must be the same, or it loses on weight)');
});

test('a pulse ring does not take the pseudo-element of the clickable dot', () => {
  assert.ok(!infinite.some((a) => /\.dot\.s-(todo|prep)::after/.test(a.selector)), 'the status dot pulses on ::after');
});

test('an endless turn names where it starts, not only where it ends', () => {
  const bad = [];
  for (const { selector, name } of infinite) {
    const body = keyframes.get(name);
    if (/rotate\(/.test(body) && !/(^|})\s*(from|0%)\s*[,{]/.test(body)) bad.push(`${selector} → @keyframes ${name}`);
  }
  assert.deepEqual(bad, [], `a rotation without its first keyframe stands still in Safari:\n${bad.join('\n')}`);
});

test('every endless pulse can be seen: its layer is drawn, and some moment of it is not transparent', () => {
  const bad = [];
  for (const b of top) {
    if (b.prelude.startsWith('@')) continue;
    const m = /(?:^|;)\s*animation\s*:\s*([^;]*\binfinite\b[^;]*)/.exec(b.body);
    if (!m) continue;
    const name = m[1].trim().split(/\s+/).find((w) => keyframes.has(w));
    if (norm(b.prelude).some((x) => /::(before|after)$/.test(x)) && !/(?:^|;)\s*content\s*:\s*(?!none\b)[^;\s][^;]*/.test(b.body)) {
      bad.push(`${norm(b.prelude).join(', ')}: the layer has no content, nothing is drawn`);
    }
    const opacities = [...keyframes.get(name).matchAll(/opacity\s*:\s*([\d.]+)/g)].map((x) => Number(x[1]));
    if (opacities.length && Math.max(...opacities) < 0.2) bad.push(`@keyframes ${name}: never more opaque than ${Math.max(...opacities)}`);
  }
  assert.deepEqual(bad, [], 'these pulse where nobody can see it');
});
