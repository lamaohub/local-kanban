// fix is taken out (each of those breakages shows on screen); the second holds defects found at that acceptance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const drawer = read('public/js/drawer.js');
const sse = read('public/js/sse.js');
const init = read('public/js/init.js');
const fnOf = (head) => { const at = drawer.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return drawer.slice(at, drawer.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };

// — fixes that survived a breakage —
test('CK-842: the event of a checklist reaches the open card', () => {
  assert.match(sse, /ev\.type === 'task\.checklist'\) \{ applyChecklist\(ev\.data\?\.key, ev\.data\?\.checklist\);/, 'the open card no longer draws the list of the event');
});
test('CK-842: a redraw of the list gives the cursor back to the item typed in', () => {
  const r = fnOf('function renderChecklist(');
  assert.match(r, /ta\.focus\(\{ preventScroll: true \}\)/, 'a change from elsewhere takes the cursor out of the item');
  assert.match(r, /setSelectionRange\(typing\.from, typing\.to\)/, 'the caret jumps to the end of the item');
});
test('CK-829: a tick the server refused (4xx) goes back', () => {
  const painted = [];
  const box = { canRetry: () => false, refusalText: () => ({ gone: false }), state: { drawerKey: 'CK-1' }, String, Boolean, painted };
  vm.runInNewContext(`const clUnsent = new Map(); let drawerChecklist = [{ id: 7, done: true }];
const clQueueKey = (k, i) => k + i; const dropUnsaved = () => {}; const noteUnsaved = () => {}; const clNote = () => {}; const editRefusedText = () => 'x';
const paintChecklistItem = (i) => painted.push(i.done);
${fnOf('function clRefused(')}
this.run = clRefused;`, box);
  box.run({ status: 400 }, 'CK-1', 7, { done: true });
  assert.deepEqual(painted, [false], 'the card shows a tick the server did not take');
});
test('CK-846: a change of the list\'s width measures the items again', () => {
  assert.match(drawer, /if \(w && w !== clWidth\) \{ clWidth = w; growChecklist\(\); \}/, 'long items stay cut after the card gets narrower');
  assert.match(drawer, /typeof ResizeObserver === 'function'\) \{\n {2}new ResizeObserver[\s\S]{0,160}\.observe\(\$\('d-checklist'\)\)/, 'nothing watches the width of the list');
});
test('CK-862: the note is drawn again only when it says something else', () => {
  const p = fnOf('function paintDescConflict(');
  assert.match(p, /if \(el\.dataset\.sig === `\$\{key\}\\n\$\{html\}`\) return;/, 'the blur from a click on a button of the note redraws it, and the click is lost');
});

test('CK-862: what is typed after the note came stays the person\'s edit, whatever happens to the card', () => {
  const box = { state: { drawerKey: 'CK-1' }, field: { value: 'typed after' }, Object };
  vm.runInNewContext(`const conflict = { showing: 'mine', mine: 'at the note' }; const descConflicts = new Map([['CK-1', conflict]]);
let descOutside = false; let drawerSnapshot = {}; const paintDescConflict = () => {}; const $ = () => field;
${fnOf('export function descTyped(')}
this.run = descTyped; this.mine = () => conflict.mine;`, box);
  box.run();
  assert.equal(box.mine(), 'typed after', 'the words typed after the note are lost when the card closes before the pick');
});

test('CK-862: the card of another task does not keep the note of the one left', () => {
  assert.match(fnOf('function reopenDescConflict('), /if \(!c\) \{ paintDescConflict\(\); return; \}/, 'the note of a task stays over the description of the next card opened from it');
});
test('CK-829: a deleted item takes what waited for it along', () => {
  assert.match(fnOf('async function deleteChecklistItem('), /clUnsent\.delete\(k\); dropUnsaved\(k\);/, 'the resend of a deleted item says it was deleted elsewhere');
});

// — defects found —
test('CK-836: Enter on a control of the card is not the board\'s «open the card»', () => {
  const at = init.indexOf("if (matchKey(e, 'openCard')");
  assert.ok(at > 0);
  assert.match(init.slice(at, at + 140), /\$\('drawer'\)\.contains\(e\.target\)/, 'Enter that picks in a list reopens the card and wipes the note of the refusal');
});
test('CK-829: a save that reached the server takes the older text that waited off the resend', () => {
  const dropped = [];
  const box = { state: { drawerKey: 'CK-1' }, Object, dropped };
  vm.runInNewContext(`const clUnsent = new Map([['k', { key: 'CK-1', id: 7, body: { text: 'older' } }]]); let clNoteShown = false;
const clQueueKey = () => 'k'; const dropUnsaved = (k) => dropped.push(k); const clNote = () => {};
${fnOf('function clSaved(')}
this.run = clSaved; this.left = () => clUnsent.size;`, box);
  box.run('CK-1', 7, { text: 'newer' });
  assert.equal(box.left(), 0, 'the resend will put the older text over the newer one');
  assert.deepEqual(dropped, ['k']);
});
test('CK-842: an item whose text waits for the resend keeps it when an event of another item comes', () => {
  const box = { drawn: null, state: { drawerKey: 'CK-1' }, String, Boolean, Object, Set, Map, Array, document: { activeElement: null } };
  vm.runInNewContext(`let drawerChecklist = [{ id: 1, text: 'typed', done: false }, { id: 2, text: 'two', done: false }]; const clSaveTimers = {}; const clSending = new Set();
const clUnsent = new Map([['k', { key: 'CK-1', id: 1, body: { text: 'typed' } }]]);
const renderChecklist = (l) => { this.drawn = l; };
${fnOf('export function applyChecklist(')}
this.apply = applyChecklist;`, box);
  box.apply('CK-1', [{ id: 1, text: 'old', done: false }, { id: 2, text: 'two', done: true }]);
  assert.equal(box.drawn[0].text, 'typed', 'the event took the waiting text off the screen');
});
test('CK-862: a save behind one that failed starts from the base of the failed one', () => {
  const save = fnOf('async function doAutosaveOnce(');
  assert.match(save, /queuedBase\.has\(key\) \? \{ \.\.\.body, description_base: queuedBase\.get\(key\) \}/, 'the text that never reached the server is sent as the base: a false «Claude changed it»');
  assert.match(save, /if \('description' in body\) queuedBase\.delete\(key\);/, 'an old base outlives the save that superseded it');
});
test('CK-840: closing the card lets go of a read on its way', () => {
  assert.match(fnOf('export function closeDrawer('), /commentsRead = null;/, 'a read that hangs stands in for the read of the same card opened again: an empty list without a word');
});
