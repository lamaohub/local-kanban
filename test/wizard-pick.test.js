// The wizard's picture follows what is clicked, never what the mouse passes over (the owner: the picture jumped while
// the mouse went to Next). A point of the welcome and a way of step Claude show their picture on a click, and on focus
// from the keyboard; no hover event of any spelling — a property or addEventListener — reaches the wizard's code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const HOVER = /(?:pointer|mouse)(?:enter|over|leave|out|move)\b/i;

test('no hover event of any spelling drives the wizard or its pictures', () => {
  for (const f of ['onboarding.js', 'onboarding-scenes.js', 'onboarding-rules.js']) {
    assert.doesNotMatch(read(f), HOVER, `${f} listens to the mouse passing over again`);
  }
});

test('a point and a way show their picture to the keyboard too: focus does what a click does', () => {
  const onb = read('onboarding.js');
  const lang = onb.slice(onb.indexOf('const stepLang'), onb.indexOf('const stepAccess'));
  assert.match(lang, /items\.forEach\(\(b, i\) => \{ b\.onclick = \(\) => \{ stopTimer\(\); show\(i\); \}; b\.onfocus = b\.onclick; \}\);/,
    'a point of the welcome reached by Tab does not show its picture');
  const claude = onb.slice(onb.indexOf('const stepClaude'), onb.indexOf('const stepView'));
  assert.match(claude, /const look = \(\) => \{ pointed = b\.dataset\.launch; tab = 'way'; paint\(\); \};/);
  assert.match(claude, /b\.onfocus = look;/, 'a way reached by Tab does not show its picture');
  // focus only looks: the way is written by a click (Enter or Space on a button is a click)
  assert.doesNotMatch(claude, /b\.onfocus = [^;]*setSetting/, 'a way reached by Tab is picked without a click');
});

test('the mouse over a point only tints it, quieter than the picked one', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sels = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , b]) => /background:\s*var\(--hover\)\s*(;|$)/.test(b.trim()))
    .flatMap(([, s]) => s.split(',').map((x) => x.trim()));
  assert.ok(sels.includes('.onb-item.on'), 'the picked point has no plate');
  assert.ok(!sels.some((x) => /^\.onb-item\S*:hover$/.test(x)), 'a point under the mouse looks picked again');
});
