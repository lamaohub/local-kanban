// of the sidebar, New task, opens the quick-capture screen (as New chat opens an empty conversation in the Claude app)
// with the cursor in its field; there is no separate Chaos row. The screen itself stays — a start screen can still be it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const core = src('core.js');
const sidebar = src('sidebar.js');

test('the sidebar has no Chaos row, and New task opens the quick-capture screen with the cursor in its field', () => {
  const sections = /export const SIDEBAR_SECTIONS = (\[[^\n]*\])/.exec(core)?.[1];
  assert.ok(sections, 'the list of sidebar sections is gone');
  assert.doesNotMatch(sections, /CHAOS/, 'Chaos is a row of the sidebar again');
  const row = sidebar.slice(sidebar.indexOf("newEl.className = 'proj-new'"), sidebar.indexOf('box.appendChild(newEl)'));
  assert.match(row, /state\.slug === CHAOS \? ' active' : ''/, 'the New task row is not marked while its screen is open');
  assert.match(row, /newEl\.onclick = \(\) => selectProject\(CHAOS\)\.then\(\(\) => \$\('chaos-input'\)\?\.focus\(\)\)/,
    'New task does not open the quick-capture screen with the cursor in the field');
  assert.match(sidebar, /renderSidebar\(\); renderTopbar\(\);\n\s*return loadTasks\(\);/, 'selectProject does not wait for the screen it opens — the field is not there to focus');
  assert.match(sidebar, /state\.slug === CHAOS\) \{ \$\('project-title'\)\.textContent = tr\('New task'\)/, 'the title of the screen still says Chaos');
  assert.match(sidebar, /const openable = \[[^\]]*\bCHAOS\b/, 'the screen can no longer be opened on start');
  assert.match(src('settings.js'), /\{ value: 'chaos', label: tr\('New task'\) \}/, 'the start screen setting still offers Chaos');
  assert.doesNotMatch(core, /^ {2}'Chaos': /m, 'the dictionary keeps a word nothing shows');
});

// added from outside right after another (kb add in a batch) did not show until the next event.
test('New task lists the tasks added last, newest first, and a throttled refresh comes later instead of never', () => {
  const chaos = src('chaos.js');
  const fn = chaos.slice(chaos.indexOf('async function renderChaosRecent'), chaos.indexOf('async function chaosCreate'));
  assert.match(fn, /\.sort\(\(a, b\) => b\.id - a\.id\)\.slice\(0, RECENT_N\)/, 'the list is not the newest tasks first');
  assert.match(fn, /if \(!force && wait > 0\) \{\s*ncLater \?\?= setTimeout\(\(\) => \{ ncLater = null; renderChaosRecent\(\); \}, wait\);\s*return;/,
    'a refresh inside the throttle window is dropped, not put off');
  const create = chaos.slice(chaos.indexOf('async function chaosCreate'));
  assert.match(create, /renderChaosRecent\(true\);/, 'a task created here does not show at once');
});
