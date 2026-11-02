// written. The real module on a small stand-in of the layer, counting what touches the page.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineOutOfSight, writeLines } from '../public/js/link-lines.js';

function layer() {
  const log = { html: 0, d: 0, rect: 0, made: 0, gone: 0 };
  const rect = { setAttribute: () => { log.rect += 1; } };
  const group = { kids: [], appendChild(el) { this.kids.push(el); } };
  const svg = {
    log, group, inner: '',
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
