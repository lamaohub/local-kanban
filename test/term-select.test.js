// everywhere and back on where text gets copied; the screen of Claude was left out, so nothing on it
// could be selected. And a busy Claude redraws the screen every second — a redraw under a selection
// wipes it before the person copies it, so the card holds the redraw while they select.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8').replace(/^export /gm, '');

test('the screen of Claude is in the list of what can be selected', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
  const on = rules.filter(([, , body]) => /(^|;|\s)user-select:\s*text/.test(body)).map(([, sel]) => sel.replace(/\/\*[\s\S]*?\*\//g, ''));
  assert.ok(on.some((sel) => sel.split(',').map((s) => s.trim()).includes('.term-screen')), 'the terminal screen stays unselectable');
});

test('a screen that changed is not redrawn while the person selects on it', () => {
  const fn = drawer.slice(drawer.indexOf('function selectingIn('), drawer.indexOf('function renderTerminal('));
  const render = drawer.slice(drawer.indexOf('function renderTerminal('), drawer.indexOf('function markTermTab('));
  const draw = render.slice(render.indexOf("  const text = r.screen || '';"), render.indexOf('\n}\n'));
  const pre = { textContent: 'old', scrollTop: 0, scrollHeight: 100, contains: (n) => n === 'inside' };
  const run = (selection, screen, termPressed = false) => {
    const box = { pre, r: { session: 's1', screen }, termScreen: 'old', termScreenOf: 's1', termSeen: 'v1', termFollow: true, termPressed, document: { getSelection: () => selection } };
    box.globalThis = box;
    vm.runInNewContext(`${fn}\n${draw}`, box);
    return box;
  };
  pre.textContent = 'old';
  let b = run({ isCollapsed: false, anchorNode: 'inside', focusNode: 'outside' }, 'new');
  assert.equal(pre.textContent, 'old', 'the screen was redrawn under the selection');
  assert.equal(b.termSeen, null, 'the next look would answer "same" and the screen would stay old after the selection');
  pre.textContent = 'old';
  run({ isCollapsed: false, anchorNode: 'outside', focusNode: 'inside' }, 'new');
  assert.equal(pre.textContent, 'old', 'a selection that ends on the screen was wiped by a redraw');
  b = run({ isCollapsed: true, anchorNode: 'inside', focusNode: 'inside' }, 'new');
  assert.equal(pre.textContent, 'new', 'no selection — the screen follows Claude');
  pre.textContent = 'old';
  b = run({ isCollapsed: false, anchorNode: 'elsewhere', focusNode: 'elsewhere' }, 'new');
  assert.equal(pre.textContent, 'new', 'a selection elsewhere on the page holds the screen');
  pre.textContent = 'old';
  b = run({ isCollapsed: true, anchorNode: 'inside', focusNode: 'inside' }, 'new', true);
  assert.equal(pre.textContent, 'old', 'the screen was redrawn under a pressed mouse button');
});

// of VT-683 opened next — the owner read another task's Claude there, and every later look was held the same way
test('the screen of another terminal is drawn at once, whatever was selected or pressed on the old one', () => {
  const fn = drawer.slice(drawer.indexOf('function selectingIn('), drawer.indexOf('function renderTerminal('));
  const render = drawer.slice(drawer.indexOf('function renderTerminal('), drawer.indexOf('function markTermTab('));
  const draw = render.slice(render.indexOf("  const text = r.screen || '';"), render.indexOf('\n}\n'));
  const pre = { textContent: 'SCREEN OF VT-682', scrollTop: 0, scrollHeight: 100, contains: (n) => n === 'inside' };
  const sel = { isCollapsed: false, anchorNode: 'inside', focusNode: 'inside', cleared: 0, removeAllRanges() { this.cleared++; this.isCollapsed = true; } };
  const box = {
    pre, r: { session: 's683', screen: 'SCREEN OF VT-683' }, termScreen: 'SCREEN OF VT-682', termScreenOf: 's682', termSeen: null,
    termFollow: true, termPressed: true, rolledBy: () => 0, document: { getSelection: () => sel },
  };
  box.globalThis = box;
  vm.runInNewContext(`${fn}\nthis.draw = () => {\n${draw}\n};`, box);
  box.draw();
  assert.equal(pre.textContent, 'SCREEN OF VT-683', 'the card of VT-683 shows the terminal of VT-682');
  assert.equal(box.termScreenOf, 's683', 'the card does not know whose screen it shows');
  assert.equal(sel.cleared, 1, 'the selection of the old screen stays and holds the next looks');
  assert.equal(box.termPressed, false, 'a press on the old screen holds the new one');
  sel.isCollapsed = false;
  box.r = { session: 's683', screen: 'NEWER' };
  box.draw();
  assert.equal(pre.textContent, 'SCREEN OF VT-683', 'a selection on the screen of its own terminal no longer holds it');
  // the card switched to a task and drew the remembered screen from nothing (renderWorkTabs: termScreen = null)
  box.termScreen = null; box.r = { session: 's900', screen: '' };
  box.draw();
  assert.equal(pre.textContent, '', 'a card opened on another task keeps the old screen until its first look');
});

test('answering Claude lets go of a selection on its screen, so the screen shows what Claude did', async () => {
  const fn = drawer.slice(drawer.indexOf('function selectingIn('), drawer.indexOf('function renderTerminal('));
  const send = drawer.slice(drawer.indexOf('async function termSend('), drawer.indexOf('async function termStop('));
  const pre = { contains: (n) => n === 'inside' };
  const sel = { isCollapsed: false, anchorNode: 'inside', focusNode: 'inside', cleared: 0, removeAllRanges() { this.cleared++; this.isCollapsed = true; } };
  const box = {
    termKey: 'CK-1', termInfo: { session: 's', dead: false }, termUntrusted: new Set(), termFollow: false, termSeen: 'v',
    $: (id) => (id === 'term-screen' ? pre : null), seg: (x) => x, api: async () => ({}), termSoon() {},
    document: { getSelection: () => sel },
  };
  box.globalThis = box;
  vm.runInNewContext(`${fn}\n${send}\nthis.termSend = termSend;`, box);
  assert.equal(await box.termSend({ key: '1' }), true);
  assert.equal(sel.cleared, 1, 'the selection on the screen stayed and kept the screen still');
  sel.isCollapsed = false; sel.anchorNode = sel.focusNode = 'elsewhere';
  await box.termSend({ key: 'Escape' });
  assert.equal(sel.cleared, 1, 'a selection elsewhere on the page was wiped by an answer to Claude');
});

test('only the main button holds the screen, and a context menu or an answer lets go of it', () => {
  assert.match(drawer, /pre\.onpointerdown = \(e\) => \{ termPressed = e\.button === 0; \};/, 'any button pressed on the screen holds it');
  assert.match(drawer, /pre\.oncontextmenu = letGo;/, 'a right click leaves the screen held for good');
  const send = drawer.slice(drawer.indexOf('async function termSend('), drawer.indexOf('async function termStop('));
  assert.match(send, /termPressed = false;/, 'an answer to Claude leaves a stuck press holding the screen');
});
