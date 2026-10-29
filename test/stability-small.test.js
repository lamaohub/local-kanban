import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');

test('the sound diagnostics line of Settings keeps one timer however often General is drawn', () => {
  const src = read('settings.js');
  assert.match(src, /\nlet sndDiagTimer = 0;/, 'the timer is no longer one per module');
  assert.match(src, /clearInterval\(sndDiagTimer\);\s*\n\s*sndDiagTimer = setInterval\(/,
    'a new drawing of General starts a timer without stopping the previous one');
  assert.doesNotMatch(src, /const diagTimer = setInterval/, 'the per-drawing timer is back');
});

test('a hidden tab does not poll the week counters and the sync badge', () => {
  const src = read('init.js');
  assert.doesNotMatch(src, /setInterval\(refreshSync,/, 'the polling ignores a hidden tab again');
  assert.match(src, /const syncTick = \(\) => \{ if \(document\.hidden\) return;/, 'the tick no longer skips a hidden tab');
  assert.match(src, /addEventListener\('visibilitychange', \(\) => \{ if \(Date\.now\(\) - syncSeenAt >= 30000\) syncTick\(\); \}\)/,
    'a tab coming back after a missed tick no longer catches up at once');
});

test('a closed card lets go of the focus in its fields', () => {
  const src = read('drawer.js');
  const close = src.slice(src.indexOf('export function closeDrawer() {'), src.indexOf('\n}\n', src.indexOf('export function closeDrawer() {')));
  assert.match(close, /if \(\$\('drawer'\)\.contains\(document\.activeElement\)\) document\.activeElement\.blur\(\);/,
    'closeDrawer leaves the focus in a field of the hidden card');
});

test('back with a list of the card open closes the list, not the card', () => {
  const src = read('drawer.js');
  const wire = src.slice(src.indexOf('export function wireCardBack() {'), src.indexOf('\n}\n', src.indexOf('export function wireCardBack() {')));
  const list = wire.indexOf("if (document.querySelector('.kbsel.open')) { closeOpenSelect(); holdBack(); return; }");
  assert.ok(list > 0, 'popstate no longer closes an open list first');
  assert.ok(list < wire.indexOf('if (closeTopLayer())'), 'the open list is checked after the layer stack — back would close the card');
});

test('the link lines fade in with the board', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const fade = (sel) => new RegExp(`html\\[data-design="v3"\\] ${sel}[^{]*\\{ animation: v3-fade-in \\.3s ease-out; \\}`);
  assert.match(css, fade('\\.board'), 'the board no longer fades in');
  assert.match(css, fade('\\.link-lines'), 'the link lines show at full strength before the cards again');
});

test('the System theme follows the computer without a reload', () => {
  const src = read('settings.js');
  assert.match(src, /matchMedia\?\.\('\(prefers-color-scheme: dark\)'\)\.addEventListener\?\.\('change', \(\) => \{\s*\n\s*if \(getSetting\('theme'\) === 'system'\) applyTheme\(\);/,
    'nothing listens to the colour scheme of the computer: System stays as it was at the start');
});

test('changing the language asks first when something typed is not saved', () => {
  const src = read('settings.js');
  const at = src.indexOf("const langSelect = () => buildSelect($('sel-lang')");
  assert.ok(at > 0, 'the language list is built elsewhere — check the reload it makes');
  const body = src.slice(at, src.indexOf('\n    langSelect();', at));
  const ask = body.indexOf('hasUnsavedInput() && !(await styledConfirm(');
  assert.ok(ask > 0, 'the language reloads the page without asking about what is typed');
  assert.ok(ask < body.indexOf('smoothReload('), 'the question comes after the reload');
  assert.match(read('init.js'), /\nexport function hasUnsavedInput\(\) \{/);
});

test('the times of the open card comments are rewritten as time goes', () => {
  const src = read('drawer.js');
  assert.match(src, /<span class="comment-time" data-at="\$\{esc\(c\.created_at\)\}">\$\{relTime\(c\.created_at\)\}<\/span>/,
    'a comment no longer carries its moment — nothing can rewrite its time');
  assert.match(src, /\nsetInterval\(refreshCommentTimes, 30000\);/, 'nothing rewrites the times of the comments');
  assert.match(src, /document\.querySelectorAll\('#comments \.comment-time\[data-at\]'\)/);
});

test('an open dashboard is drawn again when the day turns', () => {
  const src = read('dash.js');
  assert.match(src, /if \(ymdLocal\(new Date\(\)\) !== drawnDay\) renderDashboard\(\);/, 'nothing notices the day turning');
  assert.match(src, /\nsetInterval\(dayTurned, 60000\);/);
  assert.match(src, /if \(my !== seq\) return;\n  drawnDay = ymdLocal\(new Date\(\)\);/, 'the dashboard no longer notes the day it was drawn for');
});

test('the running work timer of a card stops at the cap the server counts', async () => {
  const { runInNewContext } = await import('node:vm');
  // the server's cap is read from the text: importing db.js would open a database
  const server = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8').match(/export const WORK_SEGMENT_MAX_S = ([^;]+);/);
  assert.ok(server, 'WORK_SEGMENT_MAX_S is gone from src/db.js');
  const WORK_SEGMENT_MAX_S = eval(server[1]);
  const src = read('board.js');
  const take = (start) => { const at = src.indexOf(start); assert.ok(at >= 0, `${start} is gone`); return src.slice(at, src.indexOf('\n}\n', at) + 2); };
  const cap = src.match(/\nconst WORK_SEGMENT_MAX_S = ([^;]+);/);
  assert.ok(cap, 'the card has no cap of a running segment');
  const box = { tr: (s) => s, ic: () => '', esc: String, now: 0 };
  runInNewContext(`const Date = { now: () => this.now };\nconst WORK_SEGMENT_MAX_S = ${cap[1]};\n${take('export function fmtWork(').replace('export ', '')}\n${take('function workShown(')}\nthis.shown = workShown;`, box);
  assert.equal(eval(cap[1]), WORK_SEGMENT_MAX_S, 'the cap of the card differs from WORK_SEGMENT_MAX_S of the server');
  const started = 1_000_000;
  box.now = started + 30 * 60 * 1000; // half an hour in
  assert.equal(box.shown(600, started, false).html.trim(), '40:00');
  box.now = started + 13 * 3600 * 1000; // the night through
  const night = box.shown(600, started, false);
  assert.equal(night.html.trim(), `≈2h 10m`, 'a night-long segment counts past the cap again');
  assert.match(night.title, /capped/);
  box.now = started;
  assert.match(box.shown(600, 0, true).html, /≈/, 'a capped task lost its «≈»');
  // the tick of the timers draws through the same rule — it used to drop the «≈» a second after the drawing
  assert.match(src, /const w = workShown\(Number\(el\.dataset\.base\), Number\(el\.dataset\.started\), el\.dataset\.cut === '1'\);/);
});

test('a broken keymap or setting of another kind reads as the default', async () => {
  const { runInNewContext } = await import('node:vm');
  const src = read('settings.js');
  const take = (start) => { const at = src.indexOf(start); assert.ok(at >= 0, `${start} is gone`); return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };
  const store = new Map();
  const box = { localStore: { getItem: (k) => (store.has(k) ? store.get(k) : null) }, PHONE_DEFAULTS: {}, onPhone: () => false };
  runInNewContext(`${src.match(/const SETTINGS_DEFAULTS = \{[^\n]+\};/)[0]}\n${take('export function getSetting(')}\n${take('export function customBinding(')}\nthis.get = getSetting; this.custom = customBinding;`, box);
  for (const bad of ['"oops"', 'null', '[1,2]', '5', 'not json']) {
    store.set('kb.set.keymap', bad);
    assert.deepEqual({ ...box.get('keymap') }, {}, `keymap ${bad} is not read as the default`);
    assert.equal(box.custom('search'), null, `keymap ${bad} gives a binding for search`);
  }
  store.set('kb.set.keymap', '{"search":5,"newTask":{"shift":true},"deleteCard":{"code":"KeyD"}}');
  assert.equal(box.custom('search'), null, 'an entry that is not a binding counts');
  assert.equal(box.custom('newTask'), null, 'a binding without a key code counts');
  assert.equal(box.custom('deleteCard').code, 'KeyD', 'a good binding is lost');
  store.set('kb.set.theme', '7');
  assert.equal(box.get('theme'), 'light', 'a theme that is a number is not read as the default');
  store.set('kb.set.sound', 'false');
  assert.equal(box.get('sound'), false, 'a setting of the right kind is changed');
  assert.match(read('init.js'), /const delDefault = !customBinding\('deleteCard'\);/, 'Backspace reads the keymap past the check');
});
