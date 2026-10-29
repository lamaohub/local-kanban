// list slides — every one of these was rolled back without a red line in the suite
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
const drawer = read('drawer.js');

test('a card closing leaves as a copy, and one opened meanwhile takes the copy and its place away at once', () => {
  const leave = fnOf(drawer, 'function leaveSmoothly()');
  assert.match(leave, /prefers-reduced-motion: reduce\)'\)\.matches\) return;/, 'less motion still slides the card out');
  assert.match(leave, /ghost\.inert = true;/);
  assert.match(leave, /place\.animate\(\[\{ width: `\$\{r\.width\}px` \}, \{ width: '0px' \}\], timing\)/, 'the board jumps instead of widening after the card');
  assert.match(fnOf(drawer, 'export function closeDrawer()'), /^export function closeDrawer\(\) \{\s*leaveSmoothly\(\);/, 'a card closes at once again');
  const open = fnOf(drawer, 'export function openDrawer(key, { quiet = false } = {})');
  assert.match(open, /\{\s*endLeave\(\{ keepPlace: true \}\);/);
  assert.match(open, /\$\('drawer'\)\.classList\.remove\('hidden'\);\s*endLeave\(\);/, 'the place of the card gone stays after the new one shows');
  assert.match(fnOf(drawer, 'export function openDrawerNew('), /\{\s*endLeave\(\);/);
});

test('back from the full screen the card does not slide in a second time', () => {
  const full = fnOf(drawer, 'export function setDrawerFull(');
  assert.match(full, /d\.classList\.toggle\('drawer-full', on\);\s*settleEntry\(d\);\s*const to = d\.getBoundingClientRect\(\);/, 'the way back is measured mid-slide');
  assert.match(full, /d\.classList\.remove\('drawer-full', 'drawer-leaving'\); settleEntry\(d\);/);
  assert.match(fnOf(drawer, 'function settleEntry(d)'), /a\.animationName === 'v3-drawer-in'\) a\.finish\(\)/);
  assert.match(full, /if \(on\) pushLayer\('drawer-full', \(\) => setDrawerFull\(false\)\)/, 'Esc does not bring the card back from the full screen');
  assert.match(fnOf(drawer, 'export function closeDrawer()'), /setDrawerFull\(false, \{ quiet: true \}\)/, 'a closed card keeps the full screen for the next');
});

test('a column\'s list slides, and a live repaint does not put its rows anew mid-slide', () => {
  const terms = read('now-terms.js');
  assert.match(terms, /slideTasks\(c, on, apply\);/, 'the list opens with a jump again');
  assert.match(fnOf(terms, 'function slideTasks('), /prefers-reduced-motion/);
  assert.match(terms, /if \(c\.slide\) c\.rowsLater = \{ rows, cur \}; else putRows\(list, rows, cur\);/, 'a live repaint puts the rows anew mid-slide');
  assert.match(fnOf(terms, 'function slideTasks('), /if \(c\.rowsLater\) \{ const \{ rows, cur \} = c\.rowsLater; c\.rowsLater = null; putRows\(list, rows, cur\); \}/, 'rows changed mid-slide are lost');
  // the row at work comes in marked: put in bare, WebKit left the chat of a closed list 44px over its end
  assert.match(fnOf(terms, 'function putRows('), /list\.innerHTML = cur \? rows\.replace\(`<div class="now-row" data-key="\$\{cur\}" `, `<div class="now-row now-row-cur"/);
  assert.match(read('now.js'), /`<div class="now-row" data-key="\$\{esc\(t\.key\)\}" tabindex="0" role="button">`/, 'the row of a task is drawn otherwise — the mark above misses it');
});
