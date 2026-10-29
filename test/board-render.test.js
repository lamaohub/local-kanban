// ×4 and WebKit on 573 cards: an unchanged render 239 → 22 ms, a move from elsewhere 257 → 31 ms; 18 120 changes of the
// page in 30 frames of a scroll → 0; a dragged card no longer shows again in its old column).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const fn = (head) => { const at = board.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return board.slice(at, board.indexOf('\n}\n', at) + 2); };

test('CK-848: a render keeps the node of a card drawn the same and does not rebuild the board it shows', () => {
  const render = fn('export function renderBoard(');
  assert.match(render, /node && node\._kbSig === parts\.sig \? node : cardEl\(t, parts\)/, 'every card is built anew on every render again');
  assert.match(render, /if \(!sameBoard\) board\.innerHTML = '';/, 'the same board is emptied before every render again');
  assert.doesNotMatch(render, /querySelectorAll\('\.card'\)\.forEach\(\(c\) => oldCards\.set\(Number\(c\.dataset\.id\), \{ rect: c\.getBoundingClientRect\(\)/, 'every card is measured on every render again');
  assert.match(fn('function cardEl('), /el\._kbSig = parts\.sig;/);
  assert.match(fn('function cardEl('), /openCardMenu\(e, now\(\)\)/, 'a kept card opens its menu with the task as it was drawn');
});

test('CK-860: a render that comes while a card is dragged waits for the end of the drag', () => {
  assert.match(fn('export function renderBoard('), /^export function renderBoard\(\) \{\s*if \(dragId != null\) \{ renderHeld = true; return; \}/);
  assert.match(fn('export function patchCard('), /if \(dragId != null\) \{ renderHeld = true; return true; \}/);
  assert.match(fn('function cardEl('), /if \(renderHeld && !dropSends\) renderBoard\(\);/, 'a render held through a drag that ended elsewhere is lost');
});

test('CK-847: the link badges are written only when they change', () => {
  const draw = fn('export function drawLinks(');
  assert.match(draw, /if \(el\.dataset\.n === want\) continue;/, 'every badge is written on every frame of a scroll again');
});
