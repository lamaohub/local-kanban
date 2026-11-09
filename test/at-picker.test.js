// node:vm over a stand-in of the page (its imports given by the test). The rules of the leaf at-rules.js are pinned in
// at-mention.test.js; here — what only the DOM part decides: which list Enter picks from, where the item goes, whose
// Enter it is (the chat's own onkeydown sends the message), and the Enter that ends a composition of an IME.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_TEMPLATES, atQuery, fileMention, insertAt, matchTemplates } from '../public/js/at-rules.js';

const SRC = readFileSync(new URL('../public/js/at-picker.js', import.meta.url), 'utf8')
  .replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');

/** A page with one field: listeners as a browser runs them at the target — the capturing ones first, then the rest with
    the `on…` handler in the order they were added. Timers are the test's to run. */
function page() {
  const timers = [];
  const layers = [];
  const field = {
    value: '', selectionStart: 0, selectionEnd: 0, tagName: 'TEXTAREA', listeners: [],
    addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: Boolean(capture === true || capture?.capture) }); },
    removeEventListener(type, fn) { this.listeners = this.listeners.filter((l) => l.type !== type || l.fn !== fn); },
    set onkeydown(fn) { this.listeners.push({ type: 'keydown', fn, capture: false }); },
    focus() { doc.activeElement = field; },
    setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; },
    getBoundingClientRect: () => ({ left: 10, right: 410, top: 100, bottom: 160, width: 400, height: 60 }),
    dispatchEvent(e) { return fire(e); },
  };
  function fire(e) {
    let stopped = false;
    e.prevented = false;
    e.preventDefault = () => { e.prevented = true; };
    e.stopImmediatePropagation = () => { stopped = true; };
    e.stopPropagation = () => {};
    const run = (list) => { for (const l of list) { if (stopped) return; l.fn.call(field, e); } };
    const mine = field.listeners.filter((l) => l.type === e.type);
    run(mine.filter((l) => l.capture));
    run(mine.filter((l) => !l.capture));
    return !e.prevented;
  }
  const boxes = [];
  const doc = {
    activeElement: field,
    body: { append: (b) => { b.inPage = true; } },
    createElement() {
      const box = { style: {}, innerHTML: '', inPage: false, setAttribute() {}, addEventListener() {}, querySelector: () => null, remove() { this.inPage = false; } };
      boxes.push(box);
      return box;
    },
  };
  const ctx = {
    document: doc, innerWidth: 1280, innerHeight: 900, Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    api: async () => ({}), esc: (s) => String(s), seg: (s) => s, state: { projects: [] }, tr: (s) => s,
    pushLayer: (k) => layers.push(k), popLayer: (k) => { const i = layers.lastIndexOf(k); if (i >= 0) layers.splice(i, 1); },
    DEFAULT_TEMPLATES, atQuery, fileMention, insertAt, matchTemplates,
  };
  vm.runInNewContext(`${SRC}\nthis.attachAtPicker = attachAtPicker;`, ctx);
  const tick = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => { setImmediate(r); }); };
  return {
    field, layers, boxes, attach: ctx.attachAtPicker,
    /** the timers due now, then what they awaited */
    async wait() { const due = timers.splice(0); for (const t of due) if (t) t(); await tick(); },
    tick,
    type(text) { // letters typed at the caret, one `input` each
      for (const ch of text) {
        const c = field.selectionStart;
        field.value = field.value.slice(0, c) + ch + field.value.slice(field.selectionEnd);
        field.selectionStart = field.selectionEnd = c + 1;
        fire({ type: 'input' });
      }
    },
    key(key, more = {}) { const e = { type: 'keydown', key, shiftKey: false, isComposing: false, keyCode: key === 'Enter' ? 13 : 0, ...more }; fire(e); return e; },
    open: () => boxes.some((b) => b.inPage),
  };
}
// the board's templates; a search that answers later than a letter is typed, as the chat's (files over the network)
const templates = (q) => matchTemplates(DEFAULT_TEMPLATES, q).map((t) => ({ label: `@${t.name}`, insert: t.text }));
const BUG = DEFAULT_TEMPLATES[0].text;
const CRITERIA = DEFAULT_TEMPLATES[1].text;

test('Enter right after more letters picks from the list of those letters, and the letters go with «@»', async () => {
  const p = page();
  p.attach(p.field, async (q) => templates(q));
  p.field.value = 'Z ';
  p.field.selectionStart = p.field.selectionEnd = 2;
  p.type('@');
  await p.wait();
  assert.ok(p.open(), 'the list of «@» did not open');
  p.type('cr'); // the search of «cr» waits its WAIT_MS — Enter comes first
  const e = p.key('Enter');
  assert.equal(e.prevented, true, 'the Enter of the list went on to the field');
  await p.tick();
  assert.equal(p.field.value, `Z ${CRITERIA}`, 'Enter took the item of the list made for the bare «@» (or left «cr» in the text)');
  assert.equal(p.open(), false);
});

test('the item goes where the caret is — the text after it stays after it', async () => {
  const p = page();
  p.attach(p.field, async (q) => templates(q));
  p.field.value = 'Fix  tail';
  p.field.selectionStart = p.field.selectionEnd = 4;
  p.type('@bu');
  await p.wait();
  p.key('Enter');
  await p.tick();
  assert.equal(p.field.value, `Fix ${BUG} tail`, 'the template went in at the end of the field, not at the caret');
  assert.equal(p.field.selectionStart, 4 + BUG.length, 'the caret is not after what went in');
});

test('in the chat the Enter of the list is the list\'s: the field\'s own onkeydown (it sends) never hears it', async () => {
  const p = page();
  const sent = [];
  // chat.js sets input.onkeydown before it attaches the list
  p.field.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sent.push(p.field.value); } };
  p.attach(p.field, async (q) => templates(q));
  p.type('@que');
  await p.wait();
  p.key('Enter');
  await p.tick();
  assert.deepEqual(sent, [], 'the chat sent «@que» instead of putting the template in (the list listens after the field)');
  assert.equal(p.field.value, DEFAULT_TEMPLATES[2].text);
  // no list — Enter is the chat's again
  p.key('Enter');
  assert.equal(sent.length, 1, 'with no list open the chat did not send');
});

test('the Enter that ends a composition (Safari: keyCode 229, isComposing false) picks nothing', async () => {
  const p = page();
  p.attach(p.field, async (q) => templates(q));
  p.type('@b');
  await p.wait();
  const e = p.key('Enter', { keyCode: 229 });
  await p.tick();
  assert.equal(e.prevented, false, 'the IME\'s Enter was taken by the list');
  assert.equal(p.field.value, '@b', 'the IME\'s Enter put a template in');
  assert.ok(p.open(), 'the list closed on the IME\'s Enter');
});

test('an arrow picks; Enter after more letters keeps that pick when the new list has it; nothing by the letters — Enter is the field\'s', async () => {
  const p = page();
  p.attach(p.field, async (q) => templates(q));
  p.type('@');
  await p.wait();
  p.key('ArrowDown'); p.key('ArrowDown'); // question
  p.type('u'); // bug, question hold «u»
  p.key('Enter');
  await p.tick();
  assert.equal(p.field.value, DEFAULT_TEMPLATES[2].text, 'the item picked with the arrows was dropped for the first one');
  const q = page();
  q.attach(q.field, async (s) => templates(s));
  q.type('@zz');
  await q.wait();
  const e = q.key('Enter');
  assert.equal(e.prevented, false, 'Enter over «Nothing by these letters» was swallowed');
  assert.equal(q.open(), false);
});
