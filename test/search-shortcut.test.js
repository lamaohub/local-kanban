// ⌘F (Ctrl+F off a Mac) opens the search over projects and tasks from any screen, a field too, and the key can be
// changed in Settings -> Hotkeys. test/board-keys.test.js holds where the branch stands in the keydown handler; this
// file runs the real binding rules of public/js/settings.js in node (KEY_ACTIONS, keyBinding, matchKey) and holds the
// branch itself: it takes the key from the browser (its own find would open too) and does not wait for a field to lose focus.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const settings = read('settings.js');

function rules(platform, keymap = {}) {
  const from = settings.indexOf('const MAC =');
  const to = settings.indexOf('const KEY_FIXED');
  const fnFrom = settings.indexOf('function keyBinding(');
  const fnTo = settings.indexOf('const KEY_NAMES');
  assert.ok(from > 0 && to > from && fnFrom > 0 && fnTo > fnFrom, 'the key rules of settings.js moved; teach this test where they are');
  const code = `${settings.slice(from, to)}\n${settings.slice(fnFrom, fnTo).replace(/^export /gm, '')}\nthis.api = { matchKey, keyBinding };`;
  const box = { navigator: { platform, userAgent: '' }, tr: (s) => s, getSetting: (k) => (k === 'keymap' ? keymap : undefined) };
  vm.runInNewContext(code, box);
  return box.api;
}
const key = (code, mods = {}) => ({ code, shiftKey: !!mods.shift, altKey: !!mods.alt, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta });

test('on a Mac ⌘F is the search, Ctrl+F is not; elsewhere Ctrl+F is', () => {
  const mac = rules('MacIntel');
  assert.equal(mac.matchKey(key('KeyF', { meta: true }), 'search'), true, '⌘F does not open the search on a Mac');
  assert.equal(mac.matchKey(key('KeyF', { ctrl: true }), 'search'), false, 'Ctrl+F (a field\'s own key on a Mac) is taken');
  assert.equal(mac.matchKey(key('KeyF'), 'search'), false, 'a bare F opens the search');
  assert.equal(mac.matchKey(key('KeyF', { meta: true, shift: true }), 'search'), false, '⇧⌘F is taken too');
  const linux = rules('Linux x86_64');
  assert.equal(linux.matchKey(key('KeyF', { ctrl: true }), 'search'), true, 'Ctrl+F does not open the search off a Mac');
  assert.equal(linux.matchKey(key('KeyF', { meta: true }), 'search'), false);
});

test('a key of your own takes the place of ⌘F, and ⌘F goes back to the browser', () => {
  const r = rules('MacIntel', { search: { code: 'KeyK', shift: false, alt: false, ctrl: false, meta: true } });
  assert.equal(r.matchKey(key('KeyK', { meta: true }), 'search'), true, 'the shortcut chosen in Settings does not open the search');
  assert.equal(r.matchKey(key('KeyF', { meta: true }), 'search'), false, '⌘F still opens the search after another key was chosen');
  // the other actions keep working with a keymap holding only the search
  assert.equal(r.matchKey(key('KeyN'), 'newTask'), true);
});

test('the branch takes ⌘F from the browser and opens the search from a field too', () => {
  const init = read('init.js');
  const line = init.split('\n').find((l) => l.includes("matchKey(e, 'search')"));
  assert.ok(line, 'the keydown handler has no branch for the search');
  assert.match(line, /e\.preventDefault\(\)/, 'the browser\'s find opens over the search window');
  assert.match(line, /openSearch\(\)/, 'the branch does not open the search');
  assert.doesNotMatch(line, /if \(\s*!inField\s*&&/, '⌘F in a field (a card, the board\'s own search) does nothing again');
  assert.match(line, /!inField\s*\|\|\s*e\.metaKey\s*\|\|\s*e\.ctrlKey/, 'a search key rebound to a bare letter is swallowed while typing in a field');
});

test('the chat field lets ⌘F through to the board and keeps the other keys', () => {
  const chat = read('chat.js');
  const from = chat.indexOf('input.onkeydown');
  const stop = chat.indexOf('e.stopPropagation(); // the board', from);
  assert.ok(from > 0 && stop > from, 'the keydown of the chat field moved; teach this test where it is');
  const body = chat.slice(from, stop);
  assert.match(body, /if \(matchKey\(e, 'search'\) && \(e\.metaKey \|\| e\.ctrlKey\)\) return;/, '⌘F in the chat field is the browser\'s find, not the board\'s search');
});
