// its name. The project rows under it carry no icon: the first try put the letters on the projects, and the owner sent
// it back — "it was meant for the sections".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const sidebar = read('js/sidebar.js');
const fnAt = (head) => {
  const at = sidebar.indexOf(head);
  return sidebar.slice(at, sidebar.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const box = { esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') };
vm.runInNewContext(`${fnAt('export function nameInitial(')}\n${fnAt('function catNameHTML(')}\nthis.nameInitial = nameInitial; this.catNameHTML = catNameHTML;`, box);

test('the icon of a section is the first letter or digit of its name, in capitals', () => {
  assert.equal(box.nameInitial('Raycast'), 'R');
  assert.equal(box.nameInitial('закреплённые'), 'З');
  assert.equal(box.nameInitial('42 notes'), '4');
  assert.equal(box.nameInitial('🚀 Bots'), 'B', 'an emoji in front is taken for the letter');
  assert.equal(box.nameInitial('  /tk-party'), 'T', 'a sign in front is taken for the letter');
  assert.equal(box.nameInitial('🚀'), '🚀', 'a name without letters gives its first sign');
  assert.equal(box.nameInitial(''), '?');
});

test('every section head carries the icon before its name; the project rows carry none', () => {
  assert.equal(box.catNameHTML('Raycast <x>'),
    '<span class="cat-label"><span class="cat-ic" aria-hidden="true">R</span>Raycast &lt;x></span>');
  assert.match(sidebar, /h\.innerHTML = catNameHTML\(tr\('Pinned'\)\);/, 'the Pinned head lost its icon');
  assert.match(sidebar, /h\.innerHTML = catNameHTML\(tr\(cat\)\);/, 'the head of a section lost its icon');
  const row = fnAt('function makeProjEl(');
  assert.doesNotMatch(row, /-ic\b|Initial\(/, 'a project row got an icon again — the owner wants it on the sections only');
});

test('the icon is grey and as large as the icons of the menu items above', () => {
  const css = read('style.css');
  const rule = css.slice(css.indexOf('.cat-ic {'), css.indexOf('}', css.indexOf('.cat-ic {')));
  assert.match(rule, /width: 15px; height: 15px/, 'the icon is not as large as the icons of the menu items');
  assert.match(rule, /color: var\(--muted\)/, 'the icon is not grey');
  assert.match(sidebar, /<span class="nav-ic">\$\{ic\(name, 15\)\}<\/span>/, 'the icons of the menu items changed size — the letters are out of line');
  assert.doesNotMatch(css, /\.proj-ic\b/, 'the project icon came back');
});

test('the head of a sidebar section is as large as the project rows under it', () => {
  const css = read('style.css');
  const size = (sel) => {
    const all = [...css.matchAll(new RegExp(`html\\[data-design="v3"\\] ${sel.replace('.', '\\.')} \\{[^}]*font-size: ([\\d.]+)px`, 'g'))];
    return Number(all.at(-1)?.[1]);
  };
  assert.ok(size('.cat-head') >= size('.proj'), `the head of a section (${size('.cat-head')}px) is smaller than a project row (${size('.proj')}px)`);
});
