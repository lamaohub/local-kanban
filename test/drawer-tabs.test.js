import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
const rule = (sel) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel)).map(([, , b]) => b).join(';');

test('the tabs of a card share one row, and only their words give way', () => {
  assert.match(rule('.d-tabs .dash-range'), /display:\s*flex/, 'the tabs do not share the row');
  const btn = rule('.d-tabs .dr-btn');
  assert.match(btn, /white-space:\s*nowrap/, 'a tab breaks onto a second line');
  assert.match(btn, /min-width:\s*0/);
  assert.match(rule('.d-tabs .d-tab-l'), /text-overflow:\s*ellipsis/, 'a long word pushes the row wide instead of giving way');
  for (const sel of ['.d-tabs .d-tab-n', '.d-tabs .term-dot']) assert.match(rule(sel), /flex:\s*none/, `${sel} is squeezed into the ellipsis`);
  for (const tab of ['Comments', 'Chat', 'Terminal']) {
    assert.ok(drawer.includes(`<span class="d-tab-l">\${tr(${tab.includes("'") ? `"${tab}"` : `'${tab}'`})}</span>`), `the words of ${tab} are not in a span of their own`);
  }
});
