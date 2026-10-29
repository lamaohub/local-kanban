// the column was dropped) — the focus fell to the page, the next Backspace asked «Delete the task forever?» and the
// Enter after it said yes. The rule lives in public/js/lost-field.js; here it runs against a fake document, and the
// order of the branches in the key handler of init.js is checked as text (the handler lives in the browser).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isField, watchTyping } from '../public/js/lost-field.js';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

/** A document that keeps its listeners and fires a fake event at them, as a browser does. */
function fakeDoc() {
  const on = new Map();
  const doc = {
    activeElement: null,
    addEventListener(type, fn, capture) { assert.equal(capture, true, `${type} is not watched in the capture phase`); on.set(type, fn); },
    fire(type, init = {}) { on.get(type)?.({ type, ...init }); },
  };
  return doc;
}
const body = { tagName: 'BODY' };
const field = () => ({ tagName: 'TEXTAREA' });

/** The person types in `el`: it has the focus and gets a key. */
function typeIn(doc, el, key = 'a') {
  if (doc.activeElement !== el) { doc.activeElement = el; doc.fire('focusin', { target: el }); }
  doc.fire('keydown', { target: el, key });
}

test('a field that vanished while typed in holds the board keys', () => {
  const doc = fakeDoc();
  const lost = watchTyping(doc);
  assert.equal(lost(), false, 'nothing typed yet');
  const input = field();
  typeIn(doc, input);
  assert.equal(lost(), false, 'the field is still there and focused');
  doc.activeElement = body; // removed, hidden or disabled: the browser drops the focus without a focus event
  assert.equal(lost(), true, 'the next key would act on the board');
  doc.fire('keydown', { target: body, key: 'Backspace' });
  assert.equal(lost(), true, 'a key on the page is no way out of the vanished field');
});

test('the person leaving the field on purpose gives the keys back to the board', () => {
  for (const [how, leave] of [
    ['a click or a touch', (doc) => doc.fire('pointerdown', { target: body })],
    ['Tab to another element', (doc) => { const card = { tagName: 'DIV' }; doc.activeElement = card; doc.fire('focusin', { target: card }); }],
    ['Esc', (doc) => doc.fire('keydown', { target: doc.activeElement, key: 'Escape' })],
  ]) {
    const doc = fakeDoc();
    const lost = watchTyping(doc);
    const input = field();
    typeIn(doc, input);
    leave(doc);
    doc.activeElement = body;
    assert.equal(lost(), false, `${how} did not free the board keys`);
  }
});

test('the field coming back into focus is still the field typed in', () => {
  const doc = fakeDoc();
  const lost = watchTyping(doc);
  const input = field();
  typeIn(doc, input);
  doc.activeElement = body;
  typeIn(doc, input); // the same field focused again (a repaint kept it)
  assert.equal(lost(), false);
  const other = field();
  typeIn(doc, other); // a new field the page focused after a repaint
  doc.activeElement = body;
  assert.equal(lost(), true, 'the field typed in last is the one that counts');
});

// review: ⌘F, a word, Enter — the window of the search closed with its field, and the board's keys stayed dead until a
// click; so after Enter in a prompt and after renaming the project's title
test('a field that its own Enter closed gives the keys back; one gone later still holds them', async () => {
  const { ENTER_CLOSES_MS } = await import('../public/js/lost-field.js');
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  const doc = fakeDoc();
  const lost = watchTyping(doc);
  const search = field();
  typeIn(doc, search, 'x');
  typeIn(doc, search, 'Enter');
  doc.activeElement = body; // the window closed on the Enter
  await wait(ENTER_CLOSES_MS + 20);
  assert.equal(lost(), false, 'the board keys stay dead after the search window chose a task');
  const chat = field();
  typeIn(doc, chat, 'Enter'); // sent; the field stays
  await wait(ENTER_CLOSES_MS + 20);
  doc.activeElement = body; // and vanishes later — Claude left
  assert.equal(lost(), true, 'a field gone seconds after its Enter is still a field lost under typing');
});

test('fields are inputs, text areas, selects and editable text', () => {
  assert.ok(isField({ tagName: 'INPUT' }) && isField({ tagName: 'TEXTAREA' }) && isField({ tagName: 'SELECT' }));
  assert.ok(isField({ tagName: 'DIV', isContentEditable: true }));
  assert.ok(!isField({ tagName: 'DIV' }) && !isField(body) && !isField(null));
});

test('the key handler stops at a vanished field before every board shortcut', () => {
  const code = read('public/js/init.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const handler = code.slice(code.indexOf("document.addEventListener('keydown'"), code.indexOf('// CK-61/CK-79'));
  const guard = handler.indexOf('if (!inField && typingLost())');
  assert.ok(guard > 0, 'the key handler no longer asks about the vanished field');
  assert.match(handler.slice(guard), /^if \(!inField && typingLost\(\)\) \{ if \(e\.key === 'Backspace'\) e\.preventDefault\(\); return; \}/,
    'Backspace on the page after a vanished field is left to the browser, which may navigate back');
  for (const [name, branch] of [
    ['[ / ] switching boards', "matchKey(e, 'prevProject')"],
    ['Delete/Backspace deleting cards', "matchKey(e, 'deleteCard')"],
    ['N creating a task', "matchKey(e, 'newTask')"],
    ['arrows moving the cursor', 'const ARROW ='],
    ['Enter opening a card', "matchKey(e, 'openCard')"],
  ]) assert.ok(guard < handler.indexOf(branch), `${name} runs before the vanished-field check`);
  assert.match(code, /const typingLost = watchTyping\(document\);/);
});

test('a danger window does not take an Enter pressed right as it opened', () => {
  const src = read('public/js/sidebar.js');
  const fn = src.slice(src.indexOf('export function styledConfirm('), src.indexOf('export const styledAlert'));
  assert.match(fn, /if \(danger && \(e\.repeat \|\| Date\.now\(\) - opened < DANGER_ENTER_MS\)\) return;\s*done\(true\);/);
  assert.ok(fn.indexOf('const opened = Date.now();') < fn.indexOf('const onKey'), 'the time the window opened is read before it is set');
  const ms = Number(src.match(/const DANGER_ENTER_MS = (\d+);/)?.[1]);
  assert.ok(ms >= 300 && ms <= 1000, `DANGER_ENTER_MS = ${ms}: too short to catch a typed Enter, or long enough to feel dead`);
});
