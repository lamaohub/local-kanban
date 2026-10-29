import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const src = readFileSync(fileURLToPath(new URL('../public/js/init.js', import.meta.url)), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const handler = code.slice(code.indexOf("document.addEventListener('keydown'"), code.indexOf('// CK-61/CK-79'));

test('an open window or menu gets the keys before any board shortcut', () => {
  const guard = handler.indexOf('if (document.querySelector(POPUP_SELECTOR)) {');
  assert.ok(guard > 0, 'the keydown handler no longer stops at an open window');
  for (const [name, branch] of [
    ['[ / ] switching boards', "matchKey(e, 'prevProject')"],
    ['Delete/Backspace deleting cards', "matchKey(e, 'deleteCard')"],
    ['N creating a task', "matchKey(e, 'newTask')"],
    ['arrows moving the cursor', 'const ARROW ='],
    ['Enter opening a card', "matchKey(e, 'openCard')"],
    ['⌘F opening the search', "matchKey(e, 'search')"],
  ]) {
    const at = handler.indexOf(branch);
    assert.ok(at > 0, `the branch for ${name} is gone from the handler`);
    assert.ok(guard < at, `${name} runs before the open-window check again`);
  }
});

test('Esc still reaches the window, and the window list covers the Settings overlay', () => {
  assert.ok(handler.indexOf("if (e.key === 'Escape')") < handler.indexOf('if (document.querySelector(POPUP_SELECTOR)) {'));
  assert.match(handler, /if \(document\.querySelector\(POPUP_SELECTOR\)\) \{ if \(e\.key === 'Backspace' && !inField\) e\.preventDefault\(\); return; \}/,
    'Backspace under an open window is left to the browser, which may navigate back');
  assert.match(code, /const POPUP_SELECTOR = '\.modal-overlay,/);
});
