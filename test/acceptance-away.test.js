// touch that wakes it, the switch and the row that opens the card have a check. (They were seen working in a browser too.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(fileURLToPath(new URL('../public/js/away.js', import.meta.url)), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '');
function load(over = {}) {
  const heard = [];
  const asked = [];
  const opened = [];
  const rows = [];
  const overlay = { innerHTML: '', className: '', querySelector: () => ({ focus() {}, set onclick(f) {} }), querySelectorAll: () => rows };
  const ctx = {
    Number, String, Math, Date, JSON, console,
    localStore: { v: String(Date.now() - 9 * 3600_000), getItem() { return this.v; }, setItem(k, v) { this.v = v; } },
    document: { hidden: false, addEventListener: (e) => heard.push(e), createElement: () => overlay, body: { appendChild() {} } },
    tr: (s) => s, esc: (s) => s, plural: () => '', overlayLayer: () => () => {}, openDrawer: (k) => opened.push(k),
    awayDue: (last, now) => now - last >= 8 * 3600_000, hasNews: () => true, loadAutomations: async () => {},
    automations: () => ({ on: over.on ?? true }),
    api: async (m, url) => { asked.push(url); return { handed: { n: 1, tasks: [{ key: 'A-1', title: 't', project: 'p' }] } }; },
  };
  vm.runInNewContext(`${src}\nthis.startAway = startAway; this.look = look; this.showSummary = showSummary;`, ctx);
  return { ctx, heard, asked, opened, rows };
}

test('the first touch wakes it, not only the start and the tab', () => {
  const { ctx, heard } = load();
  ctx.startAway();
  for (const e of ['pointerdown', 'keydown', 'wheel', 'visibilitychange']) assert.ok(heard.includes(e), `${e} does not wake the summary`);
});
test('with the automations off nothing is asked', async () => {
  const { ctx, asked } = load({ on: false });
  await ctx.look();
  assert.equal(asked.length, 0, 'the summary was asked for with the automations off');
});
test('a row opens the card of its task', () => {
  const { ctx, opened, rows } = load();
  const row = { dataset: { key: 'A-1' } };
  rows.push(row);
  ctx.showSummary({ handed: { n: 1, tasks: [{ key: 'A-1', title: 't', project: 'p' }] } });
  row.onclick();
  assert.deepEqual(opened, ['A-1'], 'the row did not open the card');
});
