// Step Permissions of the wizard: each row has a button that grants or checks its thing right there, and nothing is
// asked of the browser before a click. The step's rules (accessLines) are guarded in onboarding.test.js; this guards
// the wiring of the step itself — which button does what, that the step is reachable, and that a failed check of the
// computer leaves the browser's rows standing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const onb = readFileSync(new URL('../public/js/onboarding.js', import.meta.url), 'utf8');
const step = onb.slice(onb.indexOf('const stepAccess'), onb.indexOf('const stepClaude'));
const act = step.slice(step.indexOf('const act = {'), step.indexOf('};', step.indexOf('const act = {')));
const handler = (name) => {
  const m = act.match(new RegExp(`(?:^|\\n)\\s*'?${name}'?: ([^\\n]*),\\n`));
  assert.ok(m, `no button «${name}» in step Permissions`);
  return m[1];
};

test('the step is reachable: it has its place in the steps and its function', () => {
  assert.ok(step.length > 0, 'no step Permissions');
  assert.match(onb, /const STEP = \{[^}]*\baccess: \(\) => stepAccess\(\)/, 'step Permissions is not in the wizard\'s map — it opens the last screen instead');
});

test('each button of the step does its thing', () => {
  assert.match(handler('allow'), /await Notification\.requestPermission\(\)\) === 'granted'\) setSetting\('notifyReview', true\); paint\(\);/,
    'notifications allowed by the browser are not switched on on the board');
  assert.match(handler('on'), /setSetting\('notifyReview', true\); paint\(\);/, '«Turn on» does not turn the board\'s notifications on');
  assert.match(handler('test'), /sendTestNotification\(\$\('onb-perm-notify'\)\)/, '«Send a test» sends nothing');
  assert.match(handler('mac-check'), /look\(\)/, '«Check again» of macOS does not ask the computer again');
  assert.match(handler('install'), /installed = await promptInstall\(\); paint\(\);/, '«Install» does not install');
  assert.match(handler('notify-check'), /paint\(\)/);
  assert.match(handler('app-check'), /paint\(\)/);
});

test('nothing is asked of the browser before a click', () => {
  const outside = step.replace(act, '');
  assert.doesNotMatch(outside, /requestPermission|sendTestNotification\(|promptInstall\(/, 'the step asks the browser by itself');
});

test('a failed check of the computer leaves the browser\'s rows, and the macOS row is drawn when there is one', () => {
  assert.match(step, /api\('GET', '\/api\/claude', undefined, \{ quiet: true \}\)\.catch\(\(\) => null\)\.then\(/, 'a failed GET /api/claude breaks the step');
  assert.match(step, /if \(line\('macos'\)\) \{\n\s*const fix = macRow\?\.fix;/, 'the macOS row is not drawn');
  // the rows of the browser are drawn at once, the computer's answer only adds to them
  assert.match(step, /paint\(\);\n\s*look\(\);/);
});

test('a failed check of the computer says so with a button, and keeps a row it showed', () => {
  assert.match(step, /if \(line\('macos'\) && !macos\) \{\n\s*html \+= row\(line\('macos'\), 'lock', '[^']+', [^\n]*btn\('mac-check', 'Check again'\)\);/,
    'a computer not checked has no row to check it again');
  assert.match(step, /unchecked = !setup;\n\s*if \(!setup\) \{ paint\(\); return; \}/, 'a failed check again throws away the row it showed');
});
