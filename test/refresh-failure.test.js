// and the refresh with it: an event the page applies by a refresh, a reconnect or a move left «Failed to fetch»
// uncaught — in the console, and in «Settings → Errors» once the board was back — and the list and the open card
// unread, so the list's notice («tasks did not load», read again once the connection is back) never came. Here — the
// real refresh of public/js/sse.js on stand-ins (the module pulls the DOM in, an import cannot take it into node), and
// the card the page opens by itself after a move, which said «The board is not responding» over the move's window.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
const sse = read('sse.js');
const drawer = read('drawer.js');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };
const lineOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n', at) + 1); };

const down = () => Object.assign(new Error('Failed to fetch'), { offline: true });
function page({ loaded, projects }) {
  const calls = [];
  const box = {
    calls,
    loadProjects: async () => { calls.push('projects'); if (projects) throw projects(); },
    loadTasks: async () => { calls.push('tasks'); },
    syncOpenDrawerStatus: async () => { calls.push('card'); },
    loadLive: async () => { calls.push('live'); },
    loadLaunchOptions: () => calls.push('launch'),
    loadLimits: () => calls.push('limits'),
    loadShare: () => calls.push('share'),
    loadAutomations: () => calls.push('automations'),
    loadAsks: () => calls.push('asks'),
    flushSseQueue: () => {},
    setTimeout: () => 0,
  };
  vm.runInNewContext(`let boardLoadStarted = false; let boardLoaded = ${loaded};
${lineOf(sse, 'const serverFailure = ')}${fnOf(sse, 'export async function refresh()')}
this.refresh = refresh;`, box);
  return box;
}

test('the first load still fails when the sidebar does not come — loadUntilDone asks again', async () => {
  const p = page({ loaded: false, projects: down });
  await assert.rejects(p.refresh(), /Failed to fetch/);
  assert.deepEqual(p.calls, ['projects']);
});

test('a refresh of a drawn board with the server away does not throw, and reads the list and the open card', async () => {
  for (const projects of [down, () => Object.assign(new Error('x'), { status: 500 })]) {
    const p = page({ loaded: true, projects });
    await p.refresh(); // rejected — «Failed to fetch» uncaught on every event, reconnect and move
    assert.deepEqual(p.calls.slice(0, 4), ['projects', 'tasks', 'card', 'live'], 'the list was not read: its notice never came');
  }
});

test('a fault of the page itself is not taken for the server away', async () => {
  const p = page({ loaded: true, projects: () => new TypeError("Cannot read properties of undefined (reading 'slug')") });
  await assert.rejects(p.refresh(), TypeError);
});

test('the reconnect\'s refresh hides only a failure of the server', () => {
  assert.match(sse, /if \(boardLoadStarted\) refresh\(\)\.catch\(\(e\) => \{ if \(!serverFailure\(e\)\) throw e; \}\);/);
});

test('a card the page opens by itself after a move says nothing over the window when the board is away', () => {
  const open = fnOf(drawer, 'export function openDrawer(key, { quiet = false } = {})');
  assert.match(open, /if \(!\(quiet && e\?\.offline\)\) styledAlert\(tr\('The board is not responding — try again in a moment\.'\)\)/);
  // the line stands on its own: a condition before it (`if (!quiet)`) would hide a task deleted meanwhile
  assert.match(open, /\n\s*styledAlert\(tr\('This task no longer exists — it was deleted\.'\)\);/, 'a task deleted meanwhile is said, quiet or not');
  // the three opens of a moved task: one task moved from the card, a group, a move seen from another tab or kb
  assert.match(fnOf(drawer, 'export function openMovePicker(keys)'), /openDrawer\(moved\.key, \{ quiet: true \}\)/);
  assert.match(drawer, /if \(reopen\) openDrawer\(reopen, \{ quiet: true \}\);/);
  assert.match(fnOf(drawer, 'export async function followMovedTask(from, to)'), /openDrawer\(to, \{ quiet: true \}\);/);
  // a click opens with its alert: the person asked for that card
  assert.doesNotMatch(drawer, /openDrawer\([^)]*quiet: true[^)]*\)[^\n]*onclick/);
});
