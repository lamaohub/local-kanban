import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../public/drawer-sync.js', import.meta.url), 'utf8');
const sandbox = { self: {} };
vm.runInNewContext(code, sandbox);
const { shouldSyncDrawerStatus } = sandbox.self.DrawerSync;

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
