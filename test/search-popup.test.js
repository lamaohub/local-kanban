// public/js/search.js run in node; the wiring is held by the source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const src = read('js/search.js');
const box = {};
vm.runInNewContext(`${src.replace(/^import .*$/gm, '').replace(/^export /gm, '')}\nthis.api = { findProjects, orderTasks, MIN_TASK_QUERY };`, box);
const plain = (x) => JSON.parse(JSON.stringify(x));

test('projects are found by name, key or folder, the ones starting with the word first, archived ones never', () => {
  const projects = [
    { slug: 'villa-tap', prefix: 'VT', name: 'villa-tap' },
    { slug: 'claude-kanban', prefix: 'CK', name: 'Claude Kanban' },
    { slug: 'old', prefix: 'OLD', name: 'Old Kanban', archived: 1 },
    { slug: 'my-kanban-fork', prefix: 'MKF', name: 'Fork of the board' },
  ];
  assert.deepEqual(plain(box.api.findProjects(projects, 'kan')).map((p) => p.slug), ['claude-kanban', 'my-kanban-fork'], 'an archived project is found, or one is missed');
  assert.deepEqual(plain(box.api.findProjects(projects, 'ck')).map((p) => p.slug), ['claude-kanban'], 'a project is not found by its key');
  assert.deepEqual(plain(box.api.findProjects(projects, 'fork')).map((p) => p.slug), ['my-kanban-fork'], 'by its name, any case');
  assert.deepEqual(plain(box.api.findProjects(projects, 'v')).map((p) => p.slug)[0], 'villa-tap', 'a name starting with the word is not first');
  assert.equal(box.api.findProjects(projects, '  ').length, 0);
});

test('tasks: open ones first, then the most recently changed', () => {
  const tasks = [
    { id: 1, status: 'done', updated_at: '2026-10-15 10:00:00' },
    { id: 2, status: 'todo', updated_at: '2026-10-01 10:00:00' },
    { id: 3, status: 'doing', updated_at: '2026-10-14 10:00:00' },
    { id: 4, status: 'cancelled', updated_at: '2026-10-16 10:00:00' },
  ];
  assert.deepEqual(plain(box.api.orderTasks(tasks)).map((t) => t.id), [3, 2, 4, 1]);
  assert.equal(box.api.orderTasks(Array.from({ length: 90 }, (_, i) => ({ id: i, status: 'todo' }))).length, 40, 'the list has no ceiling');
});

test('the window asks the server over every project and draws only the last answer; the button sits in the Settings row', () => {
  assert.match(src, /api\('GET', `\/api\/tasks\?all=1&limit=\$\{SEARCH_LIMIT\}&q=\$\{encodeURIComponent\(q\.trim\(\)\)\}`/, 'tasks are not searched over every project and status');
  assert.match(src, /if \(!open \|\| seq !== open\.seq \|\| open\.input\.value !== q\) return;/, 'an older answer is drawn over a newer word');
  assert.match(src, /if \(open && seq === open\.seq && open\.input\.value === q\) paint\(q, findProjects\(state\.projects \|\| \[\], q\), 'error'\);/, 'a refusal for an older word is drawn over a newer one');
  assert.match(src, /const short = q\.trim\(\)\.length < MIN_TASK_QUERY;[\s\S]*if \(!short\) open\.timer = setTimeout/, 'one letter asks the server for the whole board');
  assert.equal(box.api.MIN_TASK_QUERY ?? 2, 2);
  const sidebar = read('js/sidebar.js');
  assert.match(sidebar, /class="btn-icon proj-search"/);
  assert.match(sidebar, /setEl\.querySelector\('\.proj-search'\)\.onclick = \(e\) => \{ e\.stopPropagation\(\); openSide\(false\); openSearch\(\); \};/, 'the search button opens Settings too, or nothing');
  const core = read('js/core.js');
  for (const w of ['Search projects and tasks', 'Search projects and tasks…', 'Tasks', 'searching…', 'No tasks found', 'The board did not answer — try again', 'Tasks are searched from two letters'])
    assert.ok(core.includes(`'${w}': '`), `no Russian for "${w}"`);
});

// caret is not pulled back to the field under it
test('closing the search without a pick gives the caret back to the field it was opened from', () => {
  assert.match(src, /const back = document\.activeElement;/);
  assert.match(src, /open = \{[^}]*\bback: typing \};/, 'the field the person typed in is not kept for the close');
  assert.match(src, /onClose: \(\) => \{[\s\S]*?to\.focus\(\{ preventScroll: true \}\)/, 'the window closes and the caret is lost');
  const choose = src.slice(src.indexOf('function choose('));
  assert.ok(choose.indexOf('open.back = null;') > 0 && choose.indexOf('open.back = null;') < choose.indexOf('open.close();'), 'a pick puts the caret back into the field under the task it opened');
});
