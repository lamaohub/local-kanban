// behind the window), a section opens with Enter, and a dropdown is picked with the arrows and Enter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
const fnOf = (s, head) => s.slice(s.indexOf(head), s.indexOf('\n}\n', s.indexOf(head)) + 2);

test('Tab goes round the Settings window and never leaves it, both ways', () => {
  const doc = { activeElement: null, querySelector: () => null };
  const els = ['a', 'b', 'c'].map((name) => ({ name, disabled: false, getClientRects: () => [1], focus() { doc.activeElement = this; } }));
  const hidden = { name: 'hidden', disabled: false, getClientRects: () => [], focus() { doc.activeElement = this; } };
  const overlay = { querySelectorAll: () => [els[0], hidden, els[1], els[2]], contains: (el) => els.includes(el) };
  const box = { $: () => overlay, document: doc, getComputedStyle: () => ({ visibility: 'visible' }) };
  vm.runInNewContext(`const SM_FOCUSABLE = '';\n${fnOf(settings, 'function trapSettingsTab(')}\nthis.tab = trapSettingsTab;`, box);
  const press = (shiftKey) => { let prevented = false; box.tab({ shiftKey, preventDefault: () => { prevented = true; } }); return prevented; };
  doc.activeElement = { name: 'board' };
  assert.ok(press(false)); assert.equal(doc.activeElement.name, 'a', 'Tab from outside does not come into the window');
  press(false); press(false); assert.equal(doc.activeElement.name, 'c', 'Tab stops on a field nobody can see');
  press(false); assert.equal(doc.activeElement.name, 'a', 'Tab off the last field leaves the window');
  press(true); assert.equal(doc.activeElement.name, 'c', 'Shift+Tab off the first field leaves the window');
  box.document.querySelector = () => ({});
  assert.equal(press(false), false, 'a window over Settings (a question, the file editor) lost its own Tab');
});

// the suite stayed green
test('the window\'s keys send Tab to its own step and Esc to closing', () => {
  const calls = [];
  const box = { requestCloseSettings: () => calls.push('close'), trapSettingsTab: () => calls.push('tab') };
  vm.runInNewContext(`${fnOf(settings, 'function settingsModalKey(')}\nthis.key = settingsModalKey;`, box);
  for (const key of ['Tab', 'Escape', 'a']) box.key({ key });
  assert.deepEqual(calls, ['tab', 'close'], 'Tab in Settings walks out onto the board again');
});

test('the window takes the focus, its sections open from the keyboard, and the focus comes back on close', () => {
  const open = fnOf(settings, 'export function openSettingsModal(');
  assert.match(open, /class="sm-nav-item[^`]*tabindex="0" role="button"/, 'a section of Settings is out of the keyboard\'s reach');
  assert.match(open, /n\.onkeydown = \(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\)/, 'Enter on a section does not open it');
  assert.match(open, /\.sm-nav-item\.active'\)\?\.focus\(/, 'the focus stays on the page under the window when it opens');
  assert.match(open, /addEventListener\('focusin', keepSettingsFocus\)/, 'the focus may wander out of the window');
  assert.match(fnOf(settings, 'function closeSettingsModal('), /smReturnFocus\.focus\(/, 'a closed window drops the focus on the page');
});

test('a dropdown of the board is picked with the arrows and Enter', () => {
  const sel = fnOf(board, 'export function buildSelect(');
  assert.match(sel, /e\.key === 'ArrowDown' \|\| e\.key === 'ArrowUp'/, 'the arrows do nothing in a dropdown');
  assert.match(sel, /querySelector\('\.kbsel-opt\.hl:not\(\.hidden\)'\)[\s\S]*o\.click\(\)/, 'Enter does not pick the option the arrows came to');
});

// moved the highlight twice and picked on Enter an option of its old, detached list — one highlighted, another saved
test('a dropdown built again on the same element keeps one key handler', () => {
  const sel = fnOf(board, 'export function buildSelect(');
  const handlers = [];
  const host = { _kbselKeys: undefined, addEventListener: (t, f) => handlers.push(f), removeEventListener: (t, f) => handlers.splice(handlers.indexOf(f), 1) };
  const keys = sel.slice(sel.indexOf('if (host._kbselKeys)'), sel.indexOf("host.addEventListener('keydown', host._kbselKeys);") + 51);
  assert.ok(keys.startsWith('if (host._kbselKeys) host.removeEventListener('), 'a new build does not take the old key handler off');
  for (let i = 0; i < 3; i++) vm.runInNewContext(keys.replace(/= \(e\) => \{[\s\S]*\n {2}\};/, '= () => {};'), { host });
  assert.equal(handlers.length, 1, 'three builds of a dropdown left more than one key handler on it');
});
