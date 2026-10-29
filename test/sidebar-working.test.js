// your check") — on every task.live, in place. The real markNowEntry / workingProjects / applyLive on a stand-in page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const sidebar = read('js/sidebar.js');
const board = read('js/board.js');
function take(src, head) {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
}

test('the projects Claude works in get the class that swaps the dots, and lose it when it stops', () => {
  const row = (slug) => ({ dataset: { slug }, cls: new Set(), classList: { toggle(c, on) { if (on) row.of[slug].cls.add(c); else row.of[slug].cls.delete(c); } } });
  row.of = {};
  for (const slug of ['a', 'b', 'c']) row.of[slug] = row(slug);
  const box = {
    state: { live: {}, tasks: [] },
    document: { querySelector: () => null, querySelectorAll: (sel) => (sel === '#projects .proj[data-slug]' ? Object.values(row.of) : []) },
    repaintLiveBadges: () => {}, repaintCheckButton: () => {},
  };
  vm.runInNewContext([take(sidebar, 'function workingProjects('), take(sidebar, 'export function markNowEntry('), take(board, 'export function applyLive('),
    'this.api = { markNowEntry, applyLive };'].join('\n'), box);
  box.api.applyLive([{ id: 1, project: 'a', claude: 'busy' }, { id: 2, project: 'b', claude: 'waiting' }, { id: 3, project: 'c', claude: 'starting' }]);
  box.api.markNowEntry();
  assert.deepEqual(Object.values(row.of).map((r) => [r.dataset.slug, r.cls.has('ai-working')]), [['a', true], ['b', false], ['c', true]],
    'a project of a busy or starting Claude is not marked, or one whose Claude waits for you is');
  box.api.applyLive([{ id: 1, project: 'a', claude: 'idle' }]);
  box.api.markNowEntry();
  assert.deepEqual(Object.values(row.of).map((r) => r.cls.has('ai-working')), [false, false, false], 'the mark stays after Claude stopped');
  assert.match(sidebar, /el\.classList\.toggle\('ai-working', workingProjects\(\)\.has\(p\.slug\)\);/, 'a redrawn sidebar loses the mark');
  // in Review — the owner's screenshot): "Claude now" showed them at work, the sidebar showed orange or nothing
  box.api.applyLive([{ id: 1, project: 'a', claude: 'background' }]);
  box.state.liveProjects = ['c'];
  box.api.markNowEntry();
  assert.deepEqual(Object.values(row.of).map((r) => r.cls.has('ai-working')), [true, false, true], 'a Claude at work in the background, or past its tasks in work, is not marked');
  box.state.liveProjects = [];
  box.api.applyLive([]);
  box.api.markNowEntry();
  assert.deepEqual(Object.values(row.of).map((r) => r.cls.has('ai-working')), [false, false, false]);
  const sse = read('js/sse.js');
  assert.match(sse, /if \(ev\.type === 'task\.live'\) \{ liveEvents\+\+; state\.liveProjects = ev\.data\?\.projects \|\| \[\];/, 'task.live does not carry the projects of a Claude at work past its tasks');
  assert.match(sse, /state\.liveProjects = live\.projects \|\| \[\];/, 'the first picture does not carry them');
});

test('a Claude at work in the background that comes back to its prompt rings «waiting for you»', () => {
  const sse = read('js/sse.js');
  const rang = [];
  const box = { playReviewSound: () => rang.push(1), getSetting: () => false, tr: (s) => s };
  vm.runInNewContext(`${take(sse, 'function maybeWaitingAlert(')}\nthis.run = maybeWaitingAlert;`, box);
  assert.deepEqual([...box.run([{ id: 1, claude: 'idle', from: 'background' }])], [1], 'back from the background to its prompt, Claude waits silently');
  assert.deepEqual([...box.run([{ id: 2, claude: 'background', from: 'busy' }])], [], 'going on in the background rings «waiting for you»');
});

test('the green dot stands in for the orange one, pulses like it and stills with reduced motion', () => {
  const css = read('style.css');
  assert.match(css, /\.proj\.ai-working \.proj-work \{ display: inline-block; \}/);
  assert.match(css, /\.proj\.ai-working \.proj-todo \{ display: none; \}/);
  assert.match(css, /\.proj-work \{[^}]*background: var\(--done\)/, 'the dot is not green');
  assert.match(css, /\.proj-work::before \{[^}]*animation: dot-pulse/);
});

test('the grey dot and the number of a project row are its tasks in To do', () => {
  const side = read('js/sidebar.js');
  const row = side.slice(side.indexOf('function makeProjEl('), side.indexOf('function makeProjEl(') + 2000);
  assert.match(row, /const ntodo = p\.c_todo \|\| 0;/);
  assert.match(row, /\$\{ntodo \? `<span class="proj-todo"/, 'the dot is not the tasks in To do');
  assert.match(row, />\$\{ntodo \|\| ''\}<\/span>/, 'the number is not the tasks in To do');
  assert.doesNotMatch(row, /c_review|c_doing|c_prep/, 'the row counts more than To do again');
  assert.match(read('style.css'), /\.proj-review, \.proj-todo \{[^}]*background: var\(--muted\)/, 'the dot of To do is not the grey one');
});
