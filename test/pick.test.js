// the board reads it as untrusted (any site can open the board with any hash) and makes the words for the task's Claude.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PICK_PREFIX, bookmarklet, pickMessage, picker, readPick } from '../public/js/pick-rules.js';

const hashOf = (o) => `${PICK_PREFIX}${encodeURIComponent(JSON.stringify(o))}`;
const PICK = { v: 1, url: 'http://localhost:5173/settings', title: 'App', selector: 'main > form > button:nth-of-type(2)', components: ['SaveButton', 'SettingsForm', 'App'],
  source: 'src/SettingsForm.tsx:42', text: 'Save   changes', html: '<button class="primary">Save changes</button>', size: [120, 32], viewport: [1280, 800] };

test('the element in the hash is read back; what is not an element of a web page is not', () => {
  const p = readPick(hashOf(PICK));
  assert.deepEqual([p.url, p.selector, p.components, p.source, p.size], [PICK.url, PICK.selector, PICK.components, PICK.source, [120, 32]]);
  for (const bad of ['', '#CK-1', `${PICK_PREFIX}%E0%A4%A`, `${PICK_PREFIX}${encodeURIComponent('[1]')}`, hashOf({ ...PICK, url: 'javascript:alert(1)' }), hashOf({ ...PICK, selector: '' }), hashOf({ ...PICK, url: 42 })]) {
    assert.equal(readPick(bad), null, bad.slice(0, 60));
  }
});

test('a hash from anywhere is cut to size and to its kinds', () => {
  const p = readPick(hashOf({ ...PICK, html: 'x'.repeat(100_000), components: [...Array(50).keys()].map((i) => `C${i}`).concat([{}, 7]), size: [1, 'a'], extra: 'dropped' }));
  assert.equal(p.html.length, 1500);
  assert.equal(p.components.length, 10);
  assert.equal(p.size, null);
  assert.ok(!('extra' in p));
});

test('the words for Claude: the page, the selector, the components, the file, the text — and the person\'s words', () => {
  const tr = (s) => s;
  const text = pickMessage('CK-7', readPick(hashOf(PICK)), 'Make it green', tr);
  assert.equal(text, [
    'CK-7: an element on the page http://localhost:5173/settings',
    '- selector: `main > form > button:nth-of-type(2)`',
    '- components: SaveButton ← SettingsForm ← App',
    '- source: src/SettingsForm.tsx:42',
    '- text: «Save changes»',
    '- HTML: `<button class="primary">Save changes</button>`',
    '- window: 1280×800, element 120×32',
    '',
    'Make it green',
  ].join('\n'));
  assert.match(pickMessage('CK-7', readPick(hashOf({ ...PICK, components: [], source: null })), '  ', (s) => `[${s}]`), /\n\n\[Look at this element/, 'no words — a request of its own, translated');
  assert.ok(!pickMessage('CK-7', readPick(hashOf({ ...PICK, html: 'a `b` c' })), '', tr).includes('`b`'), 'a backtick broke the code span');
});

test('the bookmark is one piece of JavaScript with the board\'s address in it — and no reach into the board\'s modules', () => {
  const b = bookmarklet('http://127.0.0.1:3101', 'Click «it»');
  assert.match(b, /^javascript:/);
  assert.ok(b.endsWith(';void 0'));
  const code = decodeURIComponent(b.slice('javascript:'.length, -';void 0'.length));
  assert.doesNotThrow(() => new Function(code), 'the bookmark does not parse');
  assert.match(code, /"http:\/\/127\.0\.0\.1:3101"/);
  assert.match(code, /"hint":"Click «it»"/);
  assert.ok(b.length < 12_000, `a bookmark of ${b.length} characters`);
  // the picker is turned into text: anything it took from the module would be undefined on the app's page
  const body = picker.toString();
  for (const name of ['PICK_PREFIX', 'CAP', 'readPick', 'pickMessage', 'tr(']) assert.ok(!body.includes(name), name);
});

test('the board opens on the bookmark: a top-level visit of its page from another site passes the origin guard', () => {
  const guard = readFileSync(new URL('../src/origin-guard.js', import.meta.url), 'utf8');
  assert.match(guard, /pageVisit\(req\)/, 'the bookmark\'s window would get 403 — test/origin-guard.test.js holds the details');
});
