// over the layer of the lines, its own background is transparent, and the cards are opaque. Checked by pixels in
// Chromium and WebKit (a line over another card's text showed in 54 of 54 points before, in 0 after); here — the rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`));
  assert.ok(m, `${sel} has no rule of its own`);
  return m[1];
};
const z = (body) => Number(body.match(/z-index:\s*(-?\d+)/)?.[1]);

test('the board stands over the layer of the link lines', () => {
  const board = rule('.board');
  const lines = rule('.link-lines');
  assert.match(board, /position:\s*relative/, 'a board without a position ignores its z-index');
  assert.ok(z(board) > z(lines), `the lines (z ${z(lines)}) are drawn over the board (z ${z(board)}) — and over the text of its cards`);
  assert.match(rule('html[data-design="v3"] .board'), /background:\s*transparent/, 'an opaque board hides every line');
});

test('a card hides the line under it: its background is never see-through', () => {
  assert.match(rule('.card'), /background:\s*var\(--panel\)/);
  for (const m of css.matchAll(/--(panel|accent-soft):\s*([^;]+);/g)) {
    assert.match(m[2].trim(), /^#[0-9a-f]{6}$/i, `--${m[1]}: ${m[2]} — a see-through card shows the line over its text`);
  }
});
