// written. The real module on a small stand-in of the layer, counting what touches the page, and the real drawLinks of
// board.js on stand-ins of its cards: what is drawn while a column scrolls.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { lineOutOfSight, writeLines } from '../public/js/link-lines.js';

function layer() {
  const log = { html: 0, d: 0, rect: 0, made: 0, gone: 0 };
  const rect = { setAttribute: () => { log.rect += 1; } };
  const group = { kids: [], appendChild(el) { this.kids.push(el); } };
  const svg = {
    log, group, inner: '', dataset: {}, style: {}, setAttribute() {},
    get innerHTML() { return this.inner; },
    set innerHTML(v) { log.html += 1; this.inner = v; group.kids = []; },
    querySelector: (q) => (q === 'rect' ? rect : group),
    ownerDocument: {
      createElementNS: () => {
        log.made += 1;
        const el = { attrs: {}, setAttribute(k, v) { if (k === 'd') log.d += 1; this.attrs[k] = v; }, remove() { log.gone += 1; group.kids = group.kids.filter((x) => x !== el); } };
        return el;
      },
    },
  };
  return svg;
}
const clip = { y: 40, width: 800, height: 560 };
const zero = (svg) => { for (const k of Object.keys(svg.log)) svg.log[k] = 0; };

test('a frame where one line moved writes one line, and nothing else', () => {
  const svg = layer();
  writeLines(svg, [['1.2', 'M 0 0'], ['3.4', 'M 1 1'], ['5.6', 'M 2 2']], clip);
  assert.equal(svg.group.kids.length, 3);
  assert.equal(svg.group.kids[0].attrs.class, 'link-line');
  zero(svg);
  writeLines(svg, [['1.2', 'M 0 0'], ['3.4', 'M 1 9'], ['5.6', 'M 2 2']], clip);
  assert.deepEqual(svg.log, { html: 0, d: 1, rect: 0, made: 0, gone: 0 });
  assert.equal(svg.group.kids[1].attrs.d, 'M 1 9');
});

test('a frame with nothing moved writes nothing', () => {
  const svg = layer();
  const lines = [['1.2', 'M 0 0'], ['3.4', 'M 1 1']];
  writeLines(svg, lines, clip);
  zero(svg);
  writeLines(svg, lines, clip);
  writeLines(svg, lines, clip);
  assert.deepEqual(svg.log, { html: 0, d: 0, rect: 0, made: 0, gone: 0 });
});

test('a link gone takes its line, a new one adds its own, the clip follows the column heads', () => {
  const svg = layer();
  writeLines(svg, [['1.2', 'M 0 0'], ['3.4', 'M 1 1']], clip);
  zero(svg);
  writeLines(svg, [['3.4', 'M 1 1'], ['7.8', 'M 5 5']], { ...clip, y: 60 });
  assert.deepEqual(svg.log, { html: 0, d: 1, rect: 3, made: 1, gone: 1 });
  assert.deepEqual(svg.group.kids.map((k) => k.attrs.d), ['M 1 1', 'M 5 5']);
});

test('no lines leave an empty layer, and lines after that draw again', () => {
  const svg = layer();
  writeLines(svg, [['1.2', 'M 0 0']], clip);
  writeLines(svg, [], clip);
  assert.equal(svg.innerHTML, '');
  writeLines(svg, [], clip);
  zero(svg);
  writeLines(svg, [['1.2', 'M 0 0']], clip);
  assert.equal(svg.log.html, 1, 'the layer holds no group to draw into');
  assert.equal(svg.log.made, 1);
  assert.equal(svg.log.d, 1);
});

test('a line taken off the page comes back when it is asked for again, with the same path too', () => {
  const svg = layer();
  writeLines(svg, [['1.2', 'M 0 0'], ['3.4', 'M 1 1']], clip);
  writeLines(svg, [['3.4', 'M 1 1']], clip);
  assert.deepEqual(svg.group.kids.map((k) => k.attrs.d), ['M 1 1']);
  writeLines(svg, [['1.2', 'M 0 0'], ['3.4', 'M 1 1']], clip);
  assert.deepEqual(svg.group.kids.map((k) => k.attrs.d).sort(), ['M 0 0', 'M 1 1'], 'the layer still counts the line as drawn');
});

test('a line is left out only when nothing of it can show', () => {
  const box = { top: 100, bottom: 700 };
  const card = (top) => ({ top, bottom: top + 60 });
  assert.equal(lineOutOfSight(card(-400), card(-300), box), true, 'both above');
  assert.equal(lineOutOfSight(card(900), card(1200), box), true, 'both below');
  assert.equal(lineOutOfSight(card(-400), card(900), box), false, 'one above, one below: it crosses the view');
  assert.equal(lineOutOfSight(card(-400), card(300), box), false, 'one in view');
  assert.equal(lineOutOfSight(card(0), card(10), box), false, 'above the edge, but the arc under the cards reaches the view');
  assert.equal(lineOutOfSight(card(650), card(800), box), false);
});

/* The real drawLinks, with the real lineOutOfSight and writeLines. Cards are given by id: [left, top] on the board, each
   100 wide and 60 high; `at.y` is how far the first column (left under 200) has scrolled. A card not in `cards` is not on
   the board. */
const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
const from = board.indexOf('export function drawLinks(');
const drawLinksSrc = board.slice(from, board.indexOf('\n}\n', from) + 3).replace('export function', 'function');

function stand(tasks, cards) {
  const svg = layer();
  const at = { y: 0 };
  const rect = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const area = rect(0, 0, 800, 600);
  const els = Object.entries(cards).map(([id, [left, top]]) => ({ dataset: { id }, getBoundingClientRect: () => rect(left, left < 200 ? top - at.y : top, 100, 60) }));
  const badges = els.map((card) => ({
    dataset: {}, innerHTML: '', shown: false, closest: () => card,
    classList: { add() {}, remove() {} },
  }));
  for (const b of badges) {
    b.classList.add = () => { b.shown = false; };
    b.classList.remove = () => { b.shown = true; };
  }
  const brd = {
    getBoundingClientRect: () => area, parentElement: { getBoundingClientRect: () => area },
    querySelectorAll: (q) => (q === '.card' ? els : badges), querySelector: () => null,
  };
  const state = { tasks };
  const ctx = { $: (id) => (id === 'link-lines' ? svg : brd), getSetting: () => true, ic: () => '', writeLines, lineOutOfSight, state };
  vm.runInNewContext(`${drawLinksSrc}; this.draw = drawLinks;`, ctx);
  const badge = (id) => badges[els.findIndex((c) => c.dataset.id === String(id))];
  return { svg, at, state, draw: ctx.draw, badge, pairs: () => [...svg._kbDrawn.paths.keys()].sort() };
}
const link = (id, ...linked_ids) => ({ id, linked_ids });

test('a line that scrolled past the edge leaves the page, and is back when the column scrolls back', () => {
  // 1 and 2 ride the column; 3 and 4 stand in view, so the layer is never empty and is not rebuilt on the way
  const s = stand([link(1, 2), link(2, 1), link(3, 4), link(4, 3)], { 1: [10, 100], 2: [10, 200], 3: [300, 100], 4: [500, 100] });
  s.draw();
  assert.deepEqual(s.pairs(), ['1.2', '3.4']);
  const there = s.svg.group.kids.length;
  assert.equal(there, 2);
  s.at.y = 1000;
  s.draw();
  assert.deepEqual(s.pairs(), ['3.4'], 'a line with both cards past the edge stayed drawn');
  assert.equal(s.svg.group.kids.length, 1);
  s.at.y = 0;
  s.draw();
  assert.deepEqual(s.pairs(), ['1.2', '3.4']);
  assert.equal(s.svg.group.kids.length, there, 'the line did not come back to the page');
});

test('a line cut for being out of sight is not counted as a link without a line', () => {
  const s = stand([link(1, 2), link(2, 1)], { 1: [10, 100], 2: [10, 200] });
  s.at.y = 1000;
  s.draw();
  assert.equal(s.badge(1).dataset.n, '0', 'a badge for a line that only scrolled away');
  assert.equal(s.badge(2).dataset.n, '0');
  assert.equal(s.badge(1).shown, false);
});

test('a link whose partner is not on the board is counted', () => {
  const s = stand([link(1, 9)], { 1: [10, 100] });
  s.draw();
  assert.equal(s.badge(1).dataset.n, '1');
  assert.equal(s.badge(1).shown, true);
});

test('a link is one line under one name, whichever of its tasks comes first', () => {
  const s = stand([link(2, 1), link(1, 2)], { 1: [10, 100], 2: [300, 100] });
  s.draw();
  assert.deepEqual(s.pairs(), ['1.2']);
  assert.equal(s.svg.group.kids.length, 1, 'one link drawn twice');
  zero(s.svg);
  s.state.tasks = [link(1, 2), link(2, 1)]; // the order of the list changed under a redraw
  s.draw();
  assert.equal(s.svg.log.made, 0, 'the same line was made again');
  assert.equal(s.svg.log.gone, 0);
});
