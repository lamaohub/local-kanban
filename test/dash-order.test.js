// on «Month» left the year's button and captions while state.dashRange was month. The real renderDashboard on stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const file = readFileSync(new URL('../public/js/dash.js', import.meta.url), 'utf8');
const head = file.indexOf('export async function renderDashboard(');
const src = `let seq = 0;\n${file.slice(head, file.indexOf('\n}\n', head) + 2).replace(/^export /, '')}`;

test('a late answer of an older range is not drawn over the newer one', async () => {
  const dash = { innerHTML: '' };
  const waits = [];
  const box = {
    $: () => dash, tr: (s) => s, state: { projects: [{ slug: 'demo' }], dashRange: 'year' },
    api: () => new Promise((resolve, reject) => waits.push({ resolve, reject })),
  };
  vm.runInNewContext(`${src}\nthis.render = renderDashboard;`, box);
  const older = box.render();
  box.state.dashRange = 'month';
  const newer = box.render();
  waits[1].reject(new Error('down'));
  await newer;
  assert.match(dash.innerHTML, /Could not load the dashboard/);
  waits[0].resolve({ range: 'year' }); // half an answer: drawing it would throw on the missing parts
  await older;
  assert.match(dash.innerHTML, /Could not load the dashboard/, 'the late answer of the older range was drawn over the newer one');
});
