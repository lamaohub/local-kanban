// left at the end of a line, torn from its verb. The real typeset of public/js/typeset.js and its wiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { typeset } from '../public/js/typeset.js';

const N = ' ';
const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');

test('a dash keeps to the word before it, a short Russian word to the word after it', () => {
  assert.equal(typeset('Этой задачи больше нет — её удалили.'), `Этой задачи больше нет${N}— её${N}удалили.`);
  assert.equal(typeset('Claude в работе и не ждёт'), `Claude в${N}работе и${N}не${N}ждёт`, 'short words in a row are not all kept to the next');
  assert.equal(typeset('Задача в «Проверяю» (и ещё)'), `Задача в${N}«Проверяю» (и${N}ещё)`);
  assert.equal(typeset('a – b'), `a${N}– b`, 'an en dash may start a line');
});

test('what typeset must not touch', () => {
  assert.equal(typeset('The task is gone — it was deleted.'), `The task is gone${N}— it was deleted.`, 'an English short word got glued to the next one');
  assert.equal(typeset('Слово в конце а'), 'Слово в конце а', 'a short word at the very end got glued to nothing');
  assert.equal(typeset('CK-12 — да'), `CK-12${N}— да`);
  assert.equal(typeset('foo-bar'), 'foo-bar');
  assert.equal(typeset(undefined), '');
});

test('the windows of the board set their text with it and keep a lone word off the last line', () => {
  const sidebar = read('js/sidebar.js');
  assert.match(sidebar, /<div class="modal-title">\$\{esc\(typeset\(message\)\)\}<\/div>/, 'styledConfirm does not set its message');
  assert.match(sidebar, /<div class="modal-title">\$\{esc\(typeset\(title\)\)\}<\/div>/, 'styledPrompt does not set its title');
  assert.match(read('js/sse.js'), /modal-title">\$\{esc\(typeset\(missing/, 'the folder window does not set its title');
  assert.match(read('style.css'), /\.modal-title \{[^}]*text-wrap: pretty/, 'a lone word may end the window title again');
  assert.doesNotMatch(read('js/typeset.js'), /\(\?<[=!]/, 'a lookbehind: a Safari older than 16.4 cannot parse the module, and the page imports it');
});

// leaves the whole board on its skeleton; a lookbehind written into core.js passed the suite.
test('no module of the page uses a lookbehind', () => {
  const files = ['app.js', 'boot-fallback.js', 'drawer-sync.js', 'sw.js', ...readdirSync(new URL('../public/js/', import.meta.url)).map((f) => `js/${f}`)]
    .filter((f) => f.endsWith('.js'));
  for (const f of files) assert.doesNotMatch(read(f), /\(\?<[=!]/, `${f}: a lookbehind — a Safari older than 16.4 cannot parse it`);
});
