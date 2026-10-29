// column by ~500 points and the field the person typed in went off the top (439 → −85, Chromium and WebKit at 390). The
// behaviour was measured in both engines on stand-in answers of the board (the field, a middle and the last column stay
// within a point); the wiring is held here: the place is noted before every change of the question, the question's height
// is watched, and the browser's own anchoring, which moved the section meanwhile, is off there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const fn = (head) => { const at = chat.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return chat.slice(at, chat.indexOf('\n  }\n', at)); };

test('CK-833: the place is noted before the question can change, and kept when it shrinks', () => {
  assert.match(fn('  function paint() {'), /^ {2}function paint\(\) \{\s*notePlace\(\);/, 'a repaint changes the question before its place is noted');
  assert.match(fn('  function paintAsk(d) {'), /^ {2}function paintAsk\(d\) \{\s*notePlace\(\);/);
  assert.match(chat, /askWatch\?\.observe\(ask\);/, 'the height of the question is not watched');
  const note = fn('  function notePlace() {');
  assert.match(note, /f\.closest\('\.chat'\)\?\.querySelector\('\.chat-form'\)/, 'typing in the form that goes, the place is not the field under it');
  assert.match(chat, /if \(Math\.abs\(moved\) >= 1\) sc\.scrollTop \+= moved;/);
  assert.match(chat, /document\.removeEventListener\?\.\('scroll', onSectionScroll, true\); askWatch\?\.disconnect\(\);/, 'a destroyed chat keeps listening');
  const narrow = css.slice(css.indexOf('.now-view.now-terms { display: block; overflow-y: auto;'));
  assert.match(narrow.slice(0, 300), /\.now-view\.now-terms \{ overflow-anchor: none; \}/, 'the browser moves the section under the noted place again');
});
