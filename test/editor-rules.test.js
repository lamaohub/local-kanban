import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EDITORS, editorLink, previewUrl } from '../public/js/editor-rules.js';

test('an editor opens a folder or a file at a line; nothing for no editor or a path that is not absolute', () => {
  assert.equal(editorLink('vscode', '/work/my project'), 'vscode://file/work/my%20project');
  assert.equal(editorLink('cursor', '/a/b.js', 12), 'cursor://file/a/b.js:12:1');
  assert.equal(editorLink('zed', '/a/b.js', 3), 'zed://file/a/b.js:3', 'zed takes a line without a column');
  assert.equal(editorLink('vscode', '/a/#x?.js'), 'vscode://file/a/%23x%3F.js', 'a # or ? in a name is not cut off as a fragment or a query');
  assert.equal(editorLink('', '/a'), null);
  assert.equal(editorLink('notepad', '/a'), null);
  assert.equal(editorLink('vscode', 'relative/path'), null);
  assert.equal(editorLink('vscode', null), null);
  assert.deepEqual(Object.keys(EDITORS), ['vscode', 'cursor', 'windsurf', 'zed']);
});

test('the address of the running service: https outside, http at home, nothing that is not an address', () => {
  assert.equal(previewUrl('shop.example.com'), 'https://shop.example.com/');
  assert.equal(previewUrl('localhost:3101'), 'http://localhost:3101/');
  assert.equal(previewUrl('192.168.1.5:8080'), 'http://192.168.1.5:8080/');
  assert.equal(previewUrl('mac.local:3000'), 'http://mac.local:3000/');
  assert.equal(previewUrl('http://example.com/app'), 'http://example.com/app');
  assert.equal(previewUrl('a.ru, b.ru'), 'https://a.ru/', 'the first of several');
  for (const bad of ['', null, 'foo', 'javascript:alert(1)', 'ftp://x.ru']) assert.equal(previewUrl(bad), null, String(bad));
});

test('the card has both buttons, and the editor is a setting with «none»', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /<a id="d-editor" class="btn-icon hidden"><\/a>/);
  assert.match(html, /<a id="d-preview" class="btn-icon hidden" target="_blank" rel="noopener noreferrer"><\/a>/);
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /editor: 'vscode'/);
  assert.match(settings, /\{ value: '', label: tr\('None — no button'\) \}/);
});
