import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/js/${rel}`, import.meta.url)), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const sidebar = code(read('sidebar.js'));
const loadTasks = sidebar.slice(sidebar.indexOf('export async function loadTasks('), sidebar.indexOf('export async function loadTasks(') + 4000);

test('the list loader keeps only the answer to its latest request, under the string that request was sent with', () => {
  assert.ok(loadTasks.length > 100, 'loadTasks is not found in sidebar.js');
  assert.match(loadTasks, /const q = state\.search;/, 'the string is no longer taken when the request is sent');
  assert.match(loadTasks, /const req = tasksRequest\.start\(\);/, 'the request is no longer numbered by the tested rule');
  assert.equal((loadTasks.match(/\{ signal: req\.signal \}/g) || []).length, 2, 'an overtaken request of a project board or of All projects is no longer cancelled');
  assert.match(loadTasks, /if \(!tasksRequest\.isLatest\(req\)\) return;\s*state\.tasks = list;/, 'an answer that is not the latest lands on the board');
  assert.match(loadTasks, /state\.searchApplied = q;/,
    'the list is marked as filtered under the CURRENT string, not the one its request was sent with: the prefilter goes quiet over a wrong answer');
});

test('a cancelled request is not a network failure', () => {
  assert.match(code(read('core.js')), /if \(e\?\.name === 'AbortError'\) throw apiError\(e\.message, \{ aborted: true \}\);/,
    'an aborted request is reported as a network failure');
});

test('while searching, a batch drops the hits it made stale and asks the server again; the loader keeps what the server found', () => {
  const sse = code(read('sse.js'));
  const batch = sse.slice(sse.indexOf('async function applyBatch('), sse.indexOf('export function connectSSE('));
  assert.match(batch, /if \(state\.searchHits\) for \(const id of plan\.unhit\) state\.searchHits\.delete\(id\);/,
    'a task renamed away from the search keeps its hit and stays on the board until the server answers again');
  assert.match(batch, /if \(plan\.searchStale\) reloadSearchSoon\(\);/, 'a task that came by an event during a search is never asked of the server');
  assert.match(loadTasks, /state\.searchHits = q \? new Set\(list\.map\(\(t\) => t\.id\)\) : null;/,
    'the hits of the server are not kept: the prefilter throws out the tasks found deep in their description');
});
