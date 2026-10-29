// The close button of Settings stands on the line of the section's heading and at the right edge of its rows, and
// the buttons of a section head wrap to a line of their own on a narrow window instead of running under it.
// test/look-rules.test.js holds that a section has no width ceiling and that its head keeps room for the button.
// Measured in Chromium and WebKit: the middle of the button is within a pixel of the middle of the heading's first line.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel)).map(([, , b]) => b).join(';');
const px = (body, prop) => {
  const m = body.match(new RegExp(`(?:^|;|\\s)${prop}:\\s*([^;]+)`));
  return m ? m[1].trim() : null;
};

test('the close button of Settings starts on the line of the heading and ends at the edge of the rows', () => {
  const close = rule('.sm-close');
  const top = parseFloat(px(close, 'top'));
  const right = parseFloat(px(close, 'right'));
  const pad = px(rule('.sm-body'), 'padding').split(/\s+/).map(parseFloat);
  const padTop = pad[0];
  const padRight = pad.length > 1 ? pad[1] : pad[0];
  const headFont = parseFloat(px(rule('html[data-design="v3"] .sm-h'), 'font-size'));
  assert.ok(Number.isFinite(top) && Number.isFinite(right) && Number.isFinite(padTop) && Number.isFinite(headFont), 'the rules of the close button, the section or its heading moved');
  assert.ok(top >= padTop && top < padTop + headFont, `the close button (top ${top}px) is not on the line of the heading (${padTop}px to ${padTop + headFont}px)`);
  assert.ok(Math.abs(right - padRight) <= 6, `the close button (right ${right}px) is not at the edge of the rows (${padRight}px)`);
});

test('the buttons of a section head wrap below the heading on a narrow window', () => {
  assert.match(rule('.sm-h'), /flex-wrap:\s*wrap/, 'the buttons of a section head run off the window or under the close button on a phone');
});
