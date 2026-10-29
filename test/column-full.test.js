// «Claude now → Terminals» opened the task's card and then spread it over the window: two motions, and the chat under
// the card's fields. The column itself grows over the window now — the same chat, live — and goes back to its place,
// which stays held meanwhile. The real setColumnFull of now-terms.js and the real chat button of chat.js on stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const strip = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');

const ROW = { left: 648, top: 115, width: 380, height: 770 };
const WINDOW = { left: 0, top: 0, width: 1400, height: 900 };

function stage({ still = true } = {}) {
  const log = { layers: [], events: [], held: 0, restored: 0, animations: [] };
  const classes = new Set(['panel', 'now-col']);
  const el = {
    classList: {
      add: (...n) => n.forEach((x) => classes.add(x)), remove: (...n) => n.forEach((x) => classes.delete(x)),
      toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)), contains: (n) => classes.has(n),
    },
    // measured over the window while its place is out of the row: the row closes the gap for that layout (acceptance)
    getBoundingClientRect: () => { if (classes.has('col-full') && !log.after?.inRow) log.gapMeasured = (log.gapMeasured || 0) + 1; return classes.has('col-full') ? WINDOW : ROW; },
    getAnimations: () => [],
    after: (node) => { log.after = node; node.inRow = true; },
    ...(still ? {} : { animate: (frames, o) => { const a = { frames, o }; log.animations.push(a); a.finished = new Promise((ok) => { a.end = ok; }); return a; } }),
  };
  const box = {
    setTimeout, clearTimeout, state: {}, CustomEvent: class { constructor(type, o) { this.type = type; this.detail = o?.detail; } },
    getComputedStyle: () => ({ paddingLeft: classes.has('col-full') ? '250px' : '12px' }),
    document: {
      createElement: () => ({ style: {}, className: '', inRow: false, remove() { this.inRow = false; } }),
      dispatchEvent: (e) => log.events.push({ ...e.detail }),
    },
    pushLayer: (k, close) => log.layers.push(['push', k, close]), popLayer: (k) => log.layers.push(['pop', k]),
    matchMedia: () => ({ matches: false }),
  };
  vm.runInNewContext(`${strip('now-terms.js')}\nthis.setColumnFull = setColumnFull;\nthis.dropColumns = dropColumns;`, box);
  const c = { id: 's1', el, chat: { holdReading: () => { log.held += 1; return () => { log.restored += 1; }; } } };
  return { box, c, classes, log };
}

test('the column grows over the window and goes back; its place in the row is held while it is away', () => {
  const { box, c, classes, log } = stage();
  box.setColumnFull(c, true);
  assert.ok(classes.has('col-full'), 'the column is not over the window');
  assert.ok(log.after?.inRow, 'its place in the row is not held — the columns beside it spread under it');
  assert.equal(log.after.className, 'now-col-place');
  assert.deepEqual([log.after.style.width, log.after.style.height], ['380px', '770px'], 'the place is not the size the column had');
  assert.equal(log.layers[0][0], 'push', 'Esc does not take the column back');
  assert.deepEqual(log.events.at(-1), { on: true, id: 's1' }, 'the chat\'s button is not told');
  assert.equal(log.restored, log.held, 'the reading place of the chat is not given back');
  box.setColumnFull(c, true); // twice: nothing new
  assert.equal(log.layers.length, 1);
  log.layers[0][2](); // Esc
  assert.ok(!classes.has('col-full'), 'Esc left the column over the window');
  assert.equal(log.after.inRow, false, 'the held place stays in the row after the column came back');
  assert.deepEqual(log.layers.at(-1), ['pop', 'col-full']);
  assert.deepEqual(log.events.at(-1), { on: false, id: 's1' });
  // review: the section left with a column over the window — its Esc layer would spend the next Esc of the board
  box.setColumnFull(c, true);
  box.dropColumns();
  assert.ok(!classes.has('col-full'), 'the column stays over the window after the section is gone');
  assert.deepEqual(log.layers.at(-1), ['pop', 'col-full'], 'its Esc layer outlives the section');
});

test('it moves smoothly from where it stands to where it will stand, both ways, and the reading place waits for the end', async () => {
  const { box, c, classes, log } = stage({ still: false });
  box.setColumnFull(c, true);
  const [grow] = log.animations;
  assert.ok(grow, 'the column jumps over the window');
  assert.deepEqual([grow.frames[0].left, grow.frames[0].width, grow.frames[1].left, grow.frames[1].width], ['648px', '380px', '0px', '1400px']);
  assert.equal(log.restored, 0, 'the reading place is given back before the column stopped');
  grow.end(); await grow.finished; await null;
  assert.equal(log.restored, 1);
  box.setColumnFull(c, false);
  const shrink = log.animations[1];
  assert.deepEqual([shrink.frames[0].width, shrink.frames[1].left, shrink.frames[1].width], ['1400px', '648px', '380px'], 'it does not go back to its place');
  assert.ok(classes.has('col-full') && classes.has('col-leaving'), 'it is put back in the row before it shrank');
  assert.ok(log.after.inRow, 'the place is let go before the column is back in it');
  shrink.end(); await shrink.finished; await null;
  assert.ok(!classes.has('col-full') && !classes.has('col-leaving'));
  assert.equal(log.after.inRow, false);
});

// (a forced layout), and WebKit moved the reading place of the chats in the columns beside it — 300 became 436
test('its place is in the row before the column is measured over the window — the row never closes the gap', () => {
  for (const still of [true, false]) {
    const { box, c, log } = stage({ still });
    box.setColumnFull(c, true);
    box.setColumnFull(c, false);
    box.setColumnFull(c, true);
    assert.equal(log.gapMeasured || 0, 0, `the column was measured over the window with its place out of the row (still: ${still})`);
  }
});

// review: ⛶ and ⛶ again within the move — measured after the move was cut, the column going back was taken for one over
// the window, and its held place in the row was made the size of the window
test('sent out again while it goes back, it grows from where it is, and its place keeps the size of its row', () => {
  const { box, c, classes, log } = stage({ still: false });
  box.setColumnFull(c, true);
  box.setColumnFull(c, false); // going back: fixed, with col-full and col-leaving on
  assert.ok(classes.has('col-leaving'));
  box.setColumnFull(c, true);
  assert.deepEqual([log.after.style.width, log.after.style.height], ['380px', '770px'], 'the place in the row took the size of the window');
  assert.ok(classes.has('col-full') && !classes.has('col-leaving'));
});

// has to go back first (seen in both engines with the listener gone: the card opened unseen, the column stayed full)
test('a task row of the column over the window opens the card over it — the column goes back first', () => {
  const src = readFileSync(new URL('../public/js/now-terms.js', import.meta.url), 'utf8');
  assert.match(src, /el\.addEventListener\?\.\('click', \(e\) => \{ if \(fullCol === col && e\.target\.closest\?\.\('\.now-row, \.now-col-open'\)\) setColumnFull\(col, false, \{ quiet: true \}\); \}, true\);/,
    'a row of a column on the full screen opens the card under it');
});

test('the column over the window has square corners and no frame in the board\'s design', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /html\[data-design="v3"\] \.now-col\.col-full \{[^}]*border: none;[^}]*border-radius: 0;/, 'the v3 panel rounds and frames the column on the full screen');
});

// took the end of the cut move for where it was: sent out again on its way back it jumped to the window at once
test('a move cut short: the next one starts from where the column is midway, both ways', () => {
  const MID = { left: 300, top: 60, width: 760, height: 830 };
  const { box, c, log } = stage({ still: false });
  const live = [];
  const animate = c.el.animate;
  c.el.animate = (frames, o) => { const a = animate(frames, o); a.id = o.id; a.cancel = () => { a.cancelled = true; }; live.push(a); return a; };
  c.el.getAnimations = () => live.filter((a) => !a.cancelled);
  const rect = c.el.getBoundingClientRect;
  c.el.getBoundingClientRect = () => (c.el.getAnimations().length ? MID : rect());
  box.setColumnFull(c, true);
  box.setColumnFull(c, false); // cut on its way over the window
  box.setColumnFull(c, true); // cut on its way back
  const starts = log.animations.slice(1).map((a) => [a.frames[0].left, a.frames[0].width]);
  assert.deepEqual(starts, [['300px', '760px'], ['300px', '760px']], 'a move cut short started from the end of the cut move, not from where the column was');
  assert.ok(live.slice(0, 2).every((a) => a.cancelled), 'the cut move is left running');
});

test('a column\'s chat grows its column; the card\'s chat spreads the card', () => {
  const src = strip('chat.js');
  const calls = [];
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', drawerIsFull: () => false,
    setDrawerFull: (on) => calls.push(['card', on]), openDrawerFull: (k) => calls.push(['open card', k]),
  };
  // the branch of the menu's «full» action, taken whole from the module: a column with `full` never opens the card
  const branch = /else if \(what === 'full'\) \{([\s\S]*?)\n    \} else if/.exec(src)?.[1];
  assert.ok(branch, 'the full-screen action of the chat is not where it was');
  const act = new vm.Script(`(function (inCard, full, c, form, input) { ${branch} })`).runInNewContext(box);
  let on = false;
  const focus = [];
  const full = { on: () => on, set: (v) => { on = v; calls.push(['column', v]); } };
  act(false, full, { key: 'D-1' }, { classList: { contains: () => false } }, { focus: () => focus.push(1) });
  assert.deepEqual(calls, [['column', true]], 'a column\'s chat opened the card');
  assert.equal(focus.length, 1, 'the field of the chat on the full screen is not ready to type');
  act(false, full, { key: 'D-1' }, { classList: { contains: () => false } }, { focus: () => focus.push(1) });
  assert.deepEqual(calls.at(-1), ['column', false]);
  act(true, null, { key: 'D-1' }, null, null);
  assert.deepEqual(calls.at(-1), ['card', true]);
});

// column's field (896 → 1943), and back in the row the person stood at another column, their own field above the screen
test('back in the row, the section stands where the person left it', async () => {
  const { box, c, log } = stage({ still: false });
  const page = { scrollTop: 896 };
  c.el.closest = (sel) => (sel === '#now' ? page : null);
  box.setColumnFull(c, true);
  log.animations[0].end(); await log.animations[0].finished; await null;
  page.scrollTop = 1943; // the browser scrolled the section behind the column
  box.setColumnFull(c, false);
  assert.equal(page.scrollTop, 896, 'the column went back, the section stayed where the browser scrolled it');
  page.scrollTop = 1500; // and again while it shrinks
  log.animations[1].end(); await log.animations[1].finished; await null;
  assert.equal(page.scrollTop, 896, 'the section is not put back when the column has come back');
  page.scrollTop = 40; // the person scrolls afterwards: nothing holds them
  box.setColumnFull(c, true); log.animations[2].end(); await log.animations[2].finished; await null;
  box.setColumnFull(c, false); log.animations[3].end(); await log.animations[3].finished; await null;
  assert.equal(page.scrollTop, 40);
});

// at letting go of the field, and the column came back only on the second. In the row and in the card it still only
// lets go of the field.
test('one Esc from the chat field brings a column on the full screen back', () => {
  const chat = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');
  const at = chat.indexOf('input.onkeydown = (e) => {');
  const esc = chat.slice(at, chat.indexOf("e.stopPropagation(); return;\n    }", at));
  assert.match(esc, /input\.blur\(\);[\s\S]*if \(!inCard && full\?\.on\(\)\) return;/, 'Esc in the field of a full-screen column stops at the field again');
});
