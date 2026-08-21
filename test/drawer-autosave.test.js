import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const drawer = code(read('drawer.js'));
const core = code(read('core.js'));

test('autosave sends only the fields that actually changed', () => {
  assert.match(drawer, /let drawerSnapshot = null;/, 'the open-time snapshot is gone from drawer.js');
  assert.match(drawer, /function changedFields\(/, 'changedFields is gone — autosave would send everything again');
  assert.match(drawer, /drawerSnapshot \? changedFields\(full, drawerSnapshot\) : full/,
    'doAutosave no longer diffs against the snapshot before PATCHing');
  assert.match(drawer, /drawerSnapshot = fieldsSnapshot\(t\)/, 'openDrawer no longer takes a snapshot');
});

test('fields changed outside are pulled into the open drawer', () => {
  assert.match(drawer, /function refreshDrawerFields\(/, 'the drawer no longer refreshes anything but status');
  assert.match(drawer, /if \(autosaveTimer \|\| drawerLocked\) return;/,
    'refreshDrawerFields no longer yields to a pending edit');
  assert.match(drawer, /'description' in t/,
    'refreshDrawerFields no longer distinguishes the list shape (preview) from the full task');
});

test('renderBoard drops its reference to the previous generation of cards', () => {
  const board = code(read('board.js'));
  assert.match(board, /oldCards\.clear\(\);/, 'renderBoard leaks a generation of cards per render again');
  const exitAt = board.indexOf('card card-exit');
  const clearAt = board.indexOf('oldCards.clear()');
  assert.equal(exitAt > 0 && clearAt > exitAt, true, 'oldCards.clear() moved before the exit animation reads it');
});

test('api() reports the status code, so 404 is not confused with a dead server', () => {
  assert.match(core, /export function apiError\(/, 'apiError is gone from core.js');
  assert.match(core, /throw apiError\(e\.message, \{ offline: true \}\)/, 'a network failure no longer carries offline:true');
  assert.match(core, /throw apiError\(data\.error \|\| res\.status, \{ status: res\.status, body: data \}\)/,
    'an HTTP failure no longer carries its status code and body');
  assert.match(drawer, /e\?\.status === 404/, 'the drawer no longer treats only 404 as "the task is gone"');
});

test('a failed mutation is visible and gets resent', () => {
  const board = code(read('board.js'));
  const sse = code(read('sse.js'));
  assert.match(core, /export function noteUnsaved\(/, 'the "not saved" notice is gone from core.js');
  assert.match(core, /export async function retryUnsaved\(/, 'the resend queue is gone from core.js');
  const drop = board.slice(board.indexOf('async function onDrop('), board.indexOf('async function onDropGroup('));
  assert.match(drop, /catch \(e\) \{\s*renderBoard\(\);/, 'a failed drop no longer rolls the card back');
  assert.match(board, /noteUnsaved\(/, 'a failed drop no longer tells the human anything');
  assert.match(drawer, /if \(e\?\.offline\) \{ noteUnsaved\(doAutosaveOnce\); return undefined; \}/,
    'autosave swallows a network failure again');
  assert.match(sse, /retryUnsaved\(\)/, 'reconnecting no longer resends what did not save');
});
