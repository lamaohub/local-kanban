// suite without — where the waiting words stand and what they carry, the step that opens a picture, how the chat keeps
// its reader. How they look and move is checked in the browser; here — that they are there
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const chat = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');

test('the words that wait stand in the dock over the field, escaped, each with Now and ✕', () => {
  assert.match(chat, /'<div class="chat-dock"><div class="chat-live"><\/div><div class="chat-ask hidden"><\/div><div class="chat-note muted"><\/div><div class="chat-queue"><\/div>'/,
    'the queue went back under the turns, out of the dock');
  assert.match(chat, /<div class="chat-q-row" title="\$\{esc\(q\.text\)\}"><span class="chat-q-t">\$\{esc\(q\.text\)\}<\/span>/, 'the words that wait go into the page unescaped');
  assert.match(chat, /class="chat-now-btn" data-now="\$\{esc\(q\.id\)\}"/, 'a waiting message has no Now');
  assert.match(chat, /class="chat-unq" data-q="\$\{esc\(q\.id\)\}"/, 'a waiting message has no ✕');
  assert.match(chat, /if \(e\?\.status !== 404\) \{ c\.refused = refusalLine\('Not taken back', e, tr\); say\(c\.refused\); \}/, 'a ✕ refused says nothing');
  // a refusal goes once Claude's state moves on — «Claude asks a question» stood after the question was answered
  assert.match(chat, /else if \(c\.refused && d\.state !== c\.refusedState\) c\.refused = c\.refusedSaid = '';/);
});

test('a step that read a picture is a button that opens it by the step', () => {
  assert.match(chat, /it\.pic \? `<button type="button" class="chat-step-t chat-pic" data-pic="\$\{esc\(it\.pic\)\}"/);
  assert.match(chat, /log\.querySelectorAll\('\[data-pic\]'\)\.forEach\(\(b\) => \{\s*b\.onclick = \(e\) => \{ e\.stopPropagation\(\); openLightbox\(`\/api\/tasks\/\$\{seg\(c\.key\)\}\/chat\/picture\/\$\{seg\(b\.dataset\.pic\)\}\?session=/,
    'the step of a picture opens nothing');
  const lightbox = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const box = lightbox.slice(lightbox.indexOf('export function openLightbox('), lightbox.indexOf('\n}\n', lightbox.indexOf('export function openLightbox(')));
  assert.match(box, /img\.onerror = /, 'a picture that does not load leaves an empty window');
  assert.match(box, /prefers-reduced-motion/, 'the picture window moves for one who asked for less motion');
});

test('the chat keeps its reader: at the end by their own scrolling, scrolled up by the turn in sight', () => {
  assert.match(chat, /for \(const el of \[sc, log, box\.querySelector\('\.chat-dock'\)\]\) sizes\?\.observe\(el\);/, 'a part growing under a reader at the end hides the end');
  assert.match(chat, /c\.atEnd = gapToEnd\(\) < END_GAP; \/\/ a fold opened at the end/);
  assert.match(chat, /const anchor = atEnd \? null : seenTurn\(\);/);
  assert.match(chat, /else if \(c\.earlier\) sc\.scrollTop = Math\.max\(0, sc\.scrollHeight - keepFrom\);[^\n]*\n\s*else holdTurn\(anchor, keepTop\);/,
    'a reader scrolled up is kept by the distance from the end again — what they read runs away with every step');
  assert.match(chat, /return `<div class="chat-turn" data-at="\$\{esc\(t\.at\)\}">\$\{out\}<\/div>`;/);
  // a thumbnail still drawn has no <img>: the click is wired by the thumbnail, not by the n-th picture
  assert.match(chat, /imgsEl\.querySelectorAll\('\.chat-thumb'\)\.forEach\(\(th, i\) => \{ const img = th\.querySelector\('img'\);/);
});
