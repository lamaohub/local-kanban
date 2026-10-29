// where in it you are. The board keeps the screen at the bottom itself on every redraw; that scroll is not someone
// scrolling and must not flash the bar every second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel)).map(([, , b]) => b).join(';');

test('the terminal screen has a narrow bar, clear until it is scrolled, and the bar takes the room of the right padding', () => {
  const screen = rule('.term-screen');
  assert.match(screen, /scrollbar-width:\s*auto/, 'the screen keeps the hidden scrollbar of the rest of the board');
  assert.match(screen, /overflow-y:\s*scroll/, 'the room of the bar comes and goes — the columns of tmux would change with it');
  const pad = /padding:\s*(\d+)px (\d+)px (\d+)px (\d+)px/.exec(screen);
  assert.ok(pad, 'the screen lost its padding');
  const width = Number(/width:\s*(\d+)px/.exec(rule('.term-screen::-webkit-scrollbar'))?.[1]);
  assert.ok(width > 0 && width <= 8, 'the bar is not narrow');
  assert.equal(Number(pad[2]) + width, Number(pad[4]), 'the line got narrower or wider than before the bar — fewer or more columns of tmux');
  assert.match(rule('.term-screen::-webkit-scrollbar-thumb'), /background:\s*transparent/, 'the bar shows without scrolling');
  assert.match(rule('.term-screen.scrolling::-webkit-scrollbar-thumb'), /background:\s*color-mix\([^)]*var\(--muted\)[^)]*transparent\)/,
    'the bar of a scrolled screen is not a see-through grey');
  assert.match(rule('.term-screen.scrolling::-webkit-scrollbar'), /height:/, 'WebKit keeps the bar unpainted — a change of the class alone does not repaint it');
});

test('the bar shows when someone scrolls, fades after, and stays off for the scroll the board makes itself', () => {
  const render = drawer.slice(drawer.indexOf('function renderTerminal('), drawer.indexOf('function markTermTab('));
  const draw = render.slice(render.indexOf("  const text = r.screen || '';"), render.indexOf('\n}\n'));
  const init = drawer.slice(drawer.indexOf('export function initTerminal('));
  const onscroll = init.slice(init.indexOf('  pre.onscroll = '), init.indexOf('  pre.onpointerdown'));
  const timers = [];
  const classes = new Set();
  let top = 0;
  const pre = {
    textContent: '', scrollHeight: 1000, clientHeight: 300, contains: () => false,
    get scrollTop() { return top; }, set scrollTop(v) { top = Math.max(0, Math.min(v, this.scrollHeight - this.clientHeight)); },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) },
  };
  const box = {
    pre, r: { session: 's1', screen: 'one' }, termScreen: null, termScreenOf: 's1', termSeen: null, termFollow: true, termPressed: false,
    termOwnTop: -1, termBarTimer: null, TERM_BAR_MS: 900, rolledBy: () => 0, document: { getSelection: () => ({ isCollapsed: true }) },
    setTimeout: (f) => { timers.push(f); return timers.length; }, clearTimeout: () => {},
  };
  box.globalThis = box;
  vm.runInNewContext(`function selectingIn() { return false; }\nthis.draw = () => {\n${draw}\n};\n${onscroll}`, box);
  box.draw();
  assert.equal(top, 700, 'the screen does not follow Claude to the bottom');
  pre.onscroll(); // the browser reports the scroll the board just made
  assert.ok(!classes.has('scrolling'), 'the bar flashes on every redraw of the screen');
  pre.scrollTop = 400; pre.onscroll(); // the person scrolls up
  assert.ok(classes.has('scrolling'), 'the bar does not show while the screen is scrolled');
  assert.equal(box.termFollow, false, 'the screen kept following Claude after the person scrolled up');
  timers.at(-1)();
  assert.ok(!classes.has('scrolling'), 'the bar stays after the scrolling stopped');
  pre.scrollTop = 700; pre.onscroll(); // back down to where the board last put it — still the person
  assert.ok(classes.has('scrolling'), 'scrolling back to the bottom does not show the bar');
});
