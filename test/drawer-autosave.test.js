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
  assert.match(drawer, /import \{[^}]*\bchangedFields\b[^}]*\} from '\.\/unsaved\.js'/, 'changedFields is gone — autosave would send everything again');
  assert.match(drawer, /drawerSnapshot \? changedFields\(full, drawerSnapshot\) : full/,
    'doAutosave no longer diffs against the snapshot before PATCHing');
  assert.match(drawer, /drawerSnapshot = fieldsSnapshot\(t\)/, 'openDrawer no longer takes a snapshot');
});

test('fields changed outside are pulled into the open drawer', () => {
  assert.match(drawer, /function refreshDrawerFields\(/, 'the drawer no longer refreshes anything but status');
  assert.match(drawer, /if \(autosaveTimer \|\| drawerLocked \|\| !drawerSnapshot\) return;/,
    'refreshDrawerFields no longer yields to a pending edit');
  assert.match(drawer, /'description' in t/,
    'refreshDrawerFields no longer distinguishes the list shape (preview) from the full task');
});

test('renderBoard drops its reference to the previous generation of cards', () => {
  const board = code(read('board.js'));
  assert.match(board, /oldNodes\.clear\(\);/, 'renderBoard leaks a generation of cards per render again');
  const exitAt = board.indexOf('card card-exit');
  const clearAt = board.indexOf('oldNodes.clear()');
  assert.equal(exitAt > 0 && clearAt > exitAt, true, 'oldNodes.clear() moved before the exit animation reads it');
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
  assert.doesNotMatch(drawer, /noteUnsaved\(doAutosaveOnce\)/, 'the resend queue holds the form reader again');
  assert.match(drawer, /if \(canRetry\(e\)\) queueTaskEdit\(key, patch\);/, 'a failed edit is not queued as data');
  assert.match(drawer, /if \(canRetry\(e\)\) queueCreate\(formId, body, pend\);/, 'a failed create is not queued as data');
  const resend = drawer.slice(drawer.indexOf('async function resendTaskEdit('), drawer.indexOf('const unsentCreates'));
  assert.match(resend, /const queued = unsentEdits\.get\(key\);/, 'the resend no longer sends what was queued');
  assert.match(resend, /const here = key === state\.drawerKey && drawerShown\(\)/, 'the resend reads a form that shows another task');
  assert.match(resend, /const sent = \{ \.\.\.fields, \.\.\.dirty \};/, 'the resend drops the queued fields or races the form');
  assert.match(resend, /const fields = \{ \.\.\.queued \};[\s\S]*unsentEdits\.settle\(key, fields\);\s*unsentEdits\.settle\(key, dirty\);/,
    'a resend that carried newer form values leaves the older queued ones behind');
  assert.match(resend, /else unsentEdits\.fail\(key, dirty\);/, 'form edits merged into a failed resend are dropped');
  assert.match(drawer, /if \(unsentEdits\.supersede\(key, Object\.keys\(patch\)\)\) dropUnsaved/,
    'a direct save leaves older queued values to be resent over it');
  assert.match(sse, /retryUnsaved\(\)/, 'reconnecting no longer resends what did not save');
});

test('a closed card keeps nothing to save, and Cmd+Enter only saves an open card it is typed in', () => {
  const close = drawer.slice(drawer.indexOf('export function closeDrawer('), drawer.indexOf('export function applyKeepDrawer('));
  for (const line of ["$('d-title').value = '';", "$('d-desc').value = '';", 'state.drawerProject = null;', 'drawerLabels = [];']) {
    assert.ok(close.includes(line), `closeDrawer no longer clears: ${line}`);
  }
  assert.match(drawer, /const drawerShown = \(\) => !\$\('drawer'\)\.classList\.contains\('hidden'\) && !\$\('drawer'\)\.classList\.contains\('is-empty'\);/,
    'the pinned empty sidebar counts as an open card again');
  assert.match(drawer, /if \(drawerLocked \|\| !drawerShown\(\)\) return;/, 'autosave runs on a closed card again');
  const init = code(read('init.js'));
  assert.match(init, /!d\.classList\.contains\('is-empty'\) && d\.contains\(document\.activeElement\)\) \{ doAutosave\(\); return; \}/,
    'Cmd+Enter saves without an open card or without the focus in it');
  const chaos = read('chaos.js');
  assert.match(chaos, /e\.preventDefault\(\); e\.stopPropagation\(\); chaosCreate\(\);/, 'Cmd+Enter in Chaos reaches the board handler again');
});

test('a new board version does not reload the tab over edits waiting to be resent', () => {
  const init = code(read('init.js'));
  const from = init.indexOf('function hasUnsavedInput(');
  assert.ok(from > 0, 'hasUnsavedInput is gone from init.js');
  const guard = init.slice(from, init.indexOf('export async function checkVersion(', from));
  assert.match(guard, /if \(hasUnsaved\(\)\) return true;/, 'a reload for a new board version would drop the edits waiting to be resent');
  assert.match(init, /&& !hasUnsavedInput\(\);/, 'safeToReload no longer asks hasUnsavedInput');
});
