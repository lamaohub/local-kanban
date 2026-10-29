// pictures, and the page that moved under the keyboard when a new task was created. Where the fix is behaviour, the
// function runs here from the page's own source with stand-ins around it; where it is layout, the rule itself is held.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/${rel}`, import.meta.url)), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not in the source`);
  return src.slice(a, b).replace(/^export /gm, '');
};

// the board brought its card into sight with scrollIntoView, and that scrolled the page itself under the keyboard.
test('CK-906: on a narrow screen a card of the board is brought into sight by the board\'s own boxes, not the page', () => {
  const board = code(read('js/board.js'));
  const src = code(between(read('js/board.js'), 'function revealCard(', 'let marqueeEl = null;'));
  let narrow = true;
  const intoView = [];
  const box = (left, right, top, bottom) => ({ getBoundingClientRect: () => ({ left, right, top, bottom }), scrollTop: 0, scrollLeft: 0 });
  const col = box(0, 240, 100, 600);
  const row = box(0, 390, 80, 844);
  const card = {
    getBoundingClientRect: () => ({ left: 400, right: 630, top: 700, bottom: 820 }),
    closest: (q) => (q === '.col-body' ? col : null),
    scrollIntoView: (o) => intoView.push(o),
  };
  const ctx = { NARROW: '(max-width: 760px)', $: (id) => (id === 'board' ? row : null), globalThis: { matchMedia: () => ({ matches: narrow }) } };
  vm.runInNewContext(`${src}; this.reveal = revealCard;`, ctx);
  ctx.reveal(card);
  assert.equal(intoView.length, 0, 'scrollIntoView on a phone scrolls the page under the keyboard too');
  assert.deepEqual([col.scrollTop, row.scrollLeft], [220, 240], 'the column and the row do not bring the card into sight');
  ctx.reveal(null);
  narrow = false;
  ctx.reveal(card);
  assert.equal(intoView.length, 1, 'a wide window lost scrollIntoView and the gap to the open card (scroll-padding, CK-38)');
  const drawer = code(read('js/drawer.js'));
  assert.doesNotMatch(drawer, /\.card\[data-id=[^\n]*scrollIntoView|card\.scrollIntoView/, 'a card of the board is scrolled to past revealCard');
  assert.doesNotMatch(board, /\.card\[data-id=[^\n]*scrollIntoView/, 'the new card is scrolled to past revealCard');
});

// shows only once the task is there.
test('CK-905: the clip of the description gives a picture to the task or the form it was pressed on', () => {
  const drawer = code(read('js/drawer.js'));
  const src = code(between(read('js/drawer.js'), 'function wireTaskPicture(', 'export async function uploadCommentImage('));
  let take; let at;
  const up = []; const kept = [];
  const chip = { parentElement: 'row', innerHTML: '' };
  const ctx = {
    state: { drawerKey: null }, newFormId: 3, formCreated: { form: 0, key: null }, shown: true,
    $: (id) => (id === 'd-attach' ? chip : null), ic: () => '<svg/>', esc: (x) => x, tr: (x) => x,
    wirePicturePick: (form, t, o) => { assert.equal(form, 'row'); take = t; at = o.at; },
    uploadAttachment: (blob, key) => up.push([blob, key]),
    addPendingPicture: (blob) => kept.push(blob),
  };
  ctx.drawerShown = () => ctx.shown;
  vm.runInNewContext(`${src}; this.wire = wireTaskPicture;`, ctx);
  ctx.wire();
  assert.match(chip.innerHTML, /picture/, 'the chip says nothing — a bare clip was too small for a finger');
  const pressed = at(); // the form «+», no task yet
  take('a', pressed);
  assert.deepEqual([kept, up], [['a'], []], 'a picture of the form «+» is not kept for the task to come');
  ctx.state.drawerKey = 'DEMO-9'; ctx.formCreated = { form: 3, key: 'DEMO-9' }; // created while the dialog was open
  take('b', pressed);
  assert.deepEqual(up, [['b', 'DEMO-9']], 'a picture picked while the form became a task is lost');
  ctx.state.drawerKey = 'DEMO-4'; // then another card opened
  take('c', pressed);
  assert.deepEqual(up, [['b', 'DEMO-9'], ['c', 'DEMO-9']], 'the picture of the form went to the card opened after it');
  take('d', at()); // pressed on a task that is there
  assert.deepEqual(up.at(-1), ['d', 'DEMO-4']);
  ctx.state.drawerKey = null; ctx.newFormId = 4; // the form «+» was left for another one
  take('e', pressed);
  assert.deepEqual([kept.length, up.length], [1, 3], 'a picture of a form that is gone went somewhere');
  const html = read('index.html');
  const row = html.slice(html.indexOf('<div class="meta-row">'), html.indexOf('id="d-title"'));
  assert.match(row, /id="d-file"[^>]*accept="image\/png,image\/jpeg,image\/webp,image\/gif"[\s\S]*id="d-attach"[^>]*link-chip[^>]*form-attach/, 'the chip of pictures and its file input are not in the row of labels');
  const desc = html.slice(html.indexOf('<div class="desc-wrap">'), html.indexOf('id="d-checklist"'));
  assert.doesNotMatch(desc, /d-attach|d-file/, 'the clip went back into the description — a finger that missed it lands in the field');
  assert.match(read('style.css'), /\.attach-chip::after \{ content: ''; position: absolute; inset: -11px -3px; \}/, 'the chip lost its wider tap on a phone (CK-793)');
  assert.match(code(read('js/init.js')), /\nwireTaskPicture\(\);/, 'the clip of the description is not wired');
  assert.match(drawer, /\$\('d-attach'\)\.classList\.toggle\('hidden', drawerLocked\);/, 'the clip shows on a task Claude works on, or hides on the new one');
});

test('CK-904: on a touch screen the column cuts off the strip where iOS draws its bar', () => {
  const css = read('style.css');
  const block = css.match(/@media \(hover: none\) and \(pointer: coarse\) \{([^}]*\}[^}]*\})\s*\}/);
  assert.ok(block, 'the rule of the touch screen is gone');
  const clip = block[1].match(/\.col \{ overflow-x: clip; \}/);
  const body = block[1].match(/\.col-body \{ margin-right: -(\d+)px; padding-right: (\d+)px; \}/);
  assert.ok(clip && body, 'the column does not cut its body, or the body does not reach past it');
  const v3pad = Number(css.match(/html\[data-design="v3"\] \.col-body \{ padding: 2px (\d+)px 20px; \}/)[1]);
  assert.equal(Number(body[2]) - Number(body[1]), v3pad, 'the cards moved: the padding does not make up the width past the column');
  assert.ok(Number(body[1]) >= 10, 'the strip is narrower than the bar iOS draws (3pt from the edge, 3pt wide)');
});
