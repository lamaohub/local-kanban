import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../public/drawer-sync.js', import.meta.url), 'utf8');
const sandbox = { self: {} };
vm.runInNewContext(code, sandbox);
const { shouldSyncDrawerStatus, listCopyForDrawer } = sandbox.self.DrawerSync;

test('the status changed externally and the user did not touch the select → sync it', () => {
  assert.equal(shouldSyncDrawerStatus('review', 'review', 'done'), true);
});

test('no external change → no sync', () => {
  assert.equal(shouldSyncDrawerStatus('review', 'review', 'review'), false);
});

test('the user picked a status themselves → their choice is not overwritten', () => {
  assert.equal(shouldSyncDrawerStatus('review', 'done', 'review'), false);
});

test('the user changed the select AND the status moved externally → the user wins', () => {
  assert.equal(shouldSyncDrawerStatus('review', 'doing', 'done'), false);
});

test('any external move syncs while the select is untouched', () => {
  assert.equal(shouldSyncDrawerStatus('todo', 'todo', 'doing'), true);
  assert.equal(shouldSyncDrawerStatus('done', 'done', 'review'), true);
});

test('no status from the server (null/undefined) → no sync, no crash', () => {
  assert.equal(shouldSyncDrawerStatus('review', 'review', null), false);
  assert.equal(shouldSyncDrawerStatus('review', 'review', undefined), false);
});

const listed = [{ key: 'VV-1', status: 'todo' }, { key: 'VV-2', status: 'doing' }];

test('on the board, the open task is taken from the board list', () => {
  assert.deepEqual(listCopyForDrawer(listed, 'VV-2', true), { key: 'VV-2', status: 'doing' });
});

test('off the board (dashboard, Chaos, project settings) the list is not trusted', () => {
  assert.equal(listCopyForDrawer(listed, 'VV-1', false), null, 'a stale copy from the previous board would be used');
});

test('a task the list does not have, or no open task, means asking the server', () => {
  assert.equal(listCopyForDrawer(listed, 'CK-9', true), null);
  assert.equal(listCopyForDrawer(listed, null, true), null);
  assert.equal(listCopyForDrawer(undefined, 'VV-1', true), null);
});

test('the card and the board loader follow the rule', () => {
  const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');
  const drawer = read('drawer.js');
  assert.match(drawer, /DrawerSync\.listCopyForDrawer\(state\.tasks, key, !\$\('board'\)\.classList\.contains\('hidden'\)\)/,
    'syncOpenDrawerStatus trusts state.tasks off the board again');
  const sidebar = read('sidebar.js');
  const load = sidebar.slice(sidebar.indexOf('export async function loadTasks('));
  const clearAt = load.indexOf('if (special) { state.tasks = []; tasksRequest.start(); }');
  assert.ok(clearAt > 0, 'loadTasks no longer clears the list, and cancels the pending list request, on the special screens');
  for (const branch of ['if (state.slug === DASH)', 'if (state.slug === CHAOS)', 'if (state.projSettings && state.projSettings === state.slug)']) {
    assert.ok(clearAt < load.indexOf(branch), `the list is cleared only after "${branch}" has returned`);
  }
});

const { cardLocked, LOCKED_STATUSES } = sandbox.self.DrawerSync;

test('a card is locked while the task is in a column only Claude moves', () => {
  for (const s of ['prep', 'doing', 'deploy']) assert.equal(cardLocked(s, ['bug']), true, `${s} is not locked`);
  for (const s of ['backlog', 'todo', 'review', 'done', 'cancelled']) assert.equal(cardLocked(s, []), false, `${s} is locked`);
  assert.equal(cardLocked('doing', undefined), true, 'a task without labels in work is not locked');
});

test('a manual task (noclaude) is never locked, whatever the column', () => {
  for (const s of ['prep', 'doing', 'deploy']) assert.equal(cardLocked(s, ['ui', 'noclaude']), false, `noclaude in ${s} got locked`);
  assert.equal(cardLocked('doing', ['noclaude-ish']), true, 'only the exact label makes a task manual');
});

test('the lock follows the working columns of the board', () => {
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  const m = board.match(/export const WORKING = new Set\(\[([^\]]*)\]\)/);
  assert.ok(m, 'WORKING is gone from board.js');
  const working = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual([...LOCKED_STATUSES].sort(), working.sort(), 'the card locks on other statuses than the board treats as Claude\'s');
});
