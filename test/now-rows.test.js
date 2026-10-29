// only in a run that handed something in. The real runHTML of now.js on a stand-in page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8')
  .replace(/^import .*$/gm, '').replace(/^export /gm, '');

function runHTML(run) {
  const box = {
    tr: (s) => s, esc: (s) => String(s), ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), state: {}, NOW: '#now',
    STATUS_LABELS: { prep: 'Preparation', doing: 'Doing', review: 'Review', done: 'Done' }, SHORT_MONTHS: [],
    localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, document: { hidden: true }, onPhone: () => false, PHONE_NOW_VIEW: 'terms',
  };
  vm.runInNewContext(`${src}\nthis.run = runHTML;`, box);
  return box.run(run);
}

const task = (o) => ({ project: 'demo', project_name: 'Demo', stale_h: 0, checklist_n: 0, checked_n: 0, blocked: 0, percent: 25, focus: false, ...o });

test('a task in Claude now has no dot in front, a handed-in one has ✓', () => {
  const html = runHTML({ session: 's', claude: 'busy', started_at: '2026-10-15 10:00:00', percent: 33, submitted_n: 1, tasks_n: 3,
    tasks: [task({ id: 1, key: 'D-1', title: 'one', status: 'review' }), task({ id: 2, key: 'D-2', title: 'two', status: 'doing', focus: true }), task({ id: 3, key: 'D-3', title: 'three', status: 'prep' })] });
  assert.equal((html.match(/class="now-row[ "]/g) || []).length, 3);
  assert.equal((html.match(/class="now-mk"/g) || []).length, 3, 'the rows of a run that handed something in lost the column of ✓');
  assert.equal((html.match(/now-check/g) || []).length, 1, 'the task handed in has no ✓');
  assert.doesNotMatch(html.replace(/<div class="now-run-h">.*?<\/div>/, ''), /live-dot|now-queue/, 'a task in Claude now has a dot in front again');
  assert.match(html, /<div class="now-row" data-key="D-2" tabindex="0" role="button">/, 'the task Claude is on is highlighted again');
});

test('a run that handed nothing in has no column of ✓', () => {
  const html = runHTML({ session: 's', claude: 'waiting', since: Date.now(), started_at: '2026-10-15 10:00:00', percent: 0, submitted_n: 0, tasks_n: 1,
    tasks: [task({ id: 1, key: 'D-1', title: 'one', status: 'prep', focus: true })] });
  assert.doesNotMatch(html, /now-mk/, 'an empty column of marks pushes the keys of the run to the right');
});

test('the project of a run is a link to its board', () => {
  const html = runHTML({ session: 's', claude: 'busy', started_at: '2026-10-15 10:00:00', percent: 0, submitted_n: 0, tasks_n: 3,
    tasks: [task({ id: 1, key: 'D-1', title: 'one', status: 'doing' }), task({ id: 2, key: 'D-2', title: 'two', status: 'prep' }),
      task({ id: 3, key: 'O-1', title: 'three', status: 'prep', project: 'other', project_name: 'Other one' })] });
  const links = [...html.matchAll(/<a class="now-proj-link" href="#" data-slug="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[1]}=${m[2]}`);
  assert.deepEqual(links, ['demo=Demo', 'other=Other one'], 'the projects of the run are not links to their boards');
});

// unwired is an «#» that does nothing (Claude review and Claude done draw the same header).
test('a project link opens its board, and Claude now, review and done wire their links', () => {
  const picked = [];
  const box = {
    tr: (s) => s, esc: (s) => String(s), ic: () => '', plural: (n, a) => a, state: {}, NOW: '#now', STATUS_LABELS: {}, SHORT_MONTHS: [],
    localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, document: { hidden: true }, onPhone: () => false, PHONE_NOW_VIEW: 'terms', selectProject: (s) => picked.push(s),
  };
  vm.runInNewContext(`${src}\nthis.wire = wireProjectLinks;`, box);
  const a = { dataset: { slug: 'other' } };
  box.wire({ querySelectorAll: (s) => (s === '.now-proj-link' ? [a] : []) });
  let prevented = false;
  a.onclick({ preventDefault: () => { prevented = true; }, stopPropagation() {} });
  assert.deepEqual(picked, ['other'], 'a click on the project of a run does not open its board');
  assert.ok(prevented, 'the «#» of the link lands in the address');
  const page = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  const fnOf = (s, head) => s.slice(s.indexOf(head), s.indexOf('\n}\n', s.indexOf(head)));
  assert.match(fnOf(src, 'function wireSection('), /wireProjectLinks\(box\)/, 'Claude now draws project links nobody wired');
  const review = page('review.js');
  assert.match(fnOf(review, 'function groupHTML('), /projectLinks\(\[\{ project: g\.project, project_name: g\.name \}\]\)/, 'a group of Claude review names its project as plain text');
  assert.match(fnOf(review, 'function paint('), /wireProjectLinks\(box\)/, 'Claude review draws project links nobody wired');
  const done = page('done.js');
  assert.match(fnOf(done, 'function runHTML('), /projectLinks\(run\.tasks\)/, 'a run of Claude done names its projects as plain text');
  assert.match(fnOf(done, 'function paint('), /wireProjectLinks\(\$\('done'\)\)/, 'Claude done draws project links nobody wired');
});

// task of its terminal — the one way back to its conversation from the list; a run without `ended` has none.
test('a run whose Claude of the board has exited offers Continue for its task, and says interrupted', () => {
  const box = {
    tr: (s) => s, esc: (s) => String(s), ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), state: {}, NOW: '#now',
    STATUS_LABELS: { prep: 'Preparation', doing: 'Doing' }, SHORT_MONTHS: [], termTaskOf: (run) => run.tasks[0].key,
    localStorage: { getItem: () => null, setItem() {} }, setInterval() {}, document: { hidden: true }, onPhone: () => false, PHONE_NOW_VIEW: 'terms',
  };
  vm.runInNewContext(`${src}\nthis.run = runHTML;`, box);
  const run = { session: '0f0f0f0f-0000-4000-8000-000000000001', claude: 'gone', board: true, started_at: '2026-10-15 10:00:00', percent: 0, submitted_n: 0, tasks_n: 1,
    tasks: [task({ id: 1, key: 'D-1', title: 'one', status: 'doing', focus: true })] };
  const html = box.run({ ...run, ended: { exit: 143, interrupted: true } });
  assert.match(html, /class="btn-primary now-resume" data-key="D-1" data-session="0f0f0f0f-0000-4000-8000-000000000001"/, 'an interrupted run has no Continue');
  assert.match(html, /session interrupted/, 'an interrupted run reads «session closed»');
  assert.match(box.run({ ...run, ended: { exit: 0, interrupted: false } }), /now-resume/, 'a Claude that ended itself has no Continue');
  assert.doesNotMatch(box.run(run), /now-resume/, 'Continue over a run whose terminal is gone');
  assert.doesNotMatch(box.run({ ...run, board: false, ended: { exit: 143, interrupted: true } }), /now-resume/, 'Continue over a Claude the board did not start');
});
