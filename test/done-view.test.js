// The rule runs here from the page's own source (done.js imports the page's modules and does not load in node).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(fileURLToPath(new URL('../public/js/done.js', import.meta.url)), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not in done.js`);
  return src.slice(a, b).replace(/^export /gm, '');
};

test('the list by time holds every task once, the latest on top, by the time its row shows', () => {
  const ctx = {};
  vm.runInNewContext(`${cut('const whenOf =', '\n')}\n${cut('export function byTime(', 'function viewSwitch(')}; this.byTime = byTime;`, ctx);
  const t = (id, key, handed, done = null) => ({ id, key, handed_at: handed, done_at: done });
  const runs = [
    { tasks: [t(1, 'A-1', '2026-10-29 00:40:00', '2026-10-29 00:58:00'), t(2, 'A-2', '2026-10-29 01:00:00')] },
    { tasks: [t(3, 'B-1', '2026-10-28 23:34:00'), t(4, 'B-2', '2026-10-28 23:42:00')] },
    { tasks: [t(5, 'C-1', '2026-10-28 23:35:00'), t(2, 'A-2', '2026-10-29 01:00:00')] },
  ];
  assert.deepEqual(Array.from(ctx.byTime(runs), (x) => x.key), ['A-2', 'A-1', 'B-2', 'C-1', 'B-1'],
    'an accepted task is placed by its acceptance, as its row shows it; a task in two runs is listed once');
  assert.equal(ctx.byTime([]).length, 0);
});
