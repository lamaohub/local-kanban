import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const selectable = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(([, , body]) => /(^|;|\s)user-select:\s*text/.test(body))
  .flatMap(([, sel]) => sel.split(',').map((x) => x.trim()));

test('every command the board shows to be run can be selected and copied', () => {
  for (const sel of ['.onb-code', '.term-screen', '.comment-body', '.cc-value']) assert.ok(selectable.includes(sel), `${sel} cannot be selected`);
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /<pre class="onb-code cc-cmd">/, 'the install command of Settings → Claude Code is drawn another way');
});
