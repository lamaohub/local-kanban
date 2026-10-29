// own background (smoothReload in core.js), boot-fallback.js puts the same colour over the next page before anything is
// drawn, and the cover goes once the board — or the wizard that comes back after the reload — is on screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const bootCode = read('boot-fallback.js');

function load(store) {
  const classes = new Set(['booting']);
  const props = {};
  const timers = [];
  vm.runInNewContext(bootCode, {
    window: { addEventListener() {} },
    document: { documentElement: {
      classList: { contains: (c) => classes.has(c), add: (...c) => c.forEach((x) => classes.add(x)), remove: (...c) => c.forEach((x) => classes.delete(x)) },
      style: { setProperty: (k, v) => { props[k] = v; } },
    } },
    location: { origin: 'http://127.0.0.1:3101', reload() {} },
    sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
  });
  return { classes, props, timers };
}

test('the next page starts under the cover of the colour the last one faded into, once', () => {
  const store = new Map([['kb.session.curtain', 'rgb(17, 17, 17)']]);
  const first = load(store);
  assert.ok(first.classes.has('kb-curtain'), 'the page after a smooth reload is drawn without the cover');
  assert.equal(first.props['--curtain'], 'rgb(17, 17, 17)', 'the cover is not the colour the page faded into');
  assert.equal(store.has('kb.session.curtain'), false, 'the cover would come back on the next ordinary reload');
  // the code never lifted it — the timer of boot-fallback.js does
  first.timers.filter((t) => t.ms === 8000).forEach((t) => t.fn());
  assert.equal(first.classes.has('kb-curtain'), false, 'a page whose code failed stays under the cover');
  assert.equal(load(store).classes.has('kb-curtain'), false, 'an ordinary load is covered');
});

test('the key of the cover is one on both sides, and the language is changed by a smooth reload everywhere', () => {
  const core = read('js/core.js');
  assert.match(core, /export const CURTAIN_KEY = 'kb\.session\.curtain';/);
  assert.match(bootCode, /var CURTAIN = 'kb\.session\.curtain';/);
  for (const f of ['js/settings.js', 'js/onboarding.js']) {
    const code = read(f);
    assert.doesNotMatch(code, /setSetting\('lang'[^\n]*location\.reload/, `${f} reloads at once on a change of language`);
    assert.match(code, /smoothReload\(/, `${f} does not reload smoothly`);
  }
  assert.doesNotMatch(read('js/onboarding.js'), /location\.reload/, 'the wizard reloads without the cover');
});

test('the cover goes when the board is drawn, unless the wizard comes back — then the wizard takes it off', () => {
  const init = read('js/init.js');
  const bootDone = init.match(/function bootDone\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(bootDone, /if \(!wizardResumes\(\)\) liftCurtain\(\);/);
  const onb = read('js/onboarding.js');
  const open = onb.slice(onb.indexOf('export function openOnboarding'), onb.indexOf('export function wizardResumes'));
  assert.match(open, /go\(STEPS\.includes\(resume\) \? resume : 'lang'\);\s*liftCurtain\(\);/);
  // the wizard that does not come (done, or no answer) does not leave the board covered
  const maybe = onb.slice(onb.indexOf('export async function maybeOnboarding'), onb.indexOf('export function openOnboarding'));
  assert.equal(maybe.split('liftCurtain()').length, 3);
});

test('the cover fades only by opacity and stands still with reduced motion', () => {
  const css = read('style.css');
  assert.match(css, /html\.kb-curtain::after \{[^}]*position: fixed;[^}]*background: var\(--curtain, var\(--bg\)\);[^}]*pointer-events: none;/);
  assert.match(css, /html\.kb-curtain-out::after \{ opacity: 0; transition: opacity/);
  assert.match(css, /prefers-reduced-motion: reduce\)[\s\S]*html\.kb-curtain::after \{ animation: none; transition: none; \}/);
});
