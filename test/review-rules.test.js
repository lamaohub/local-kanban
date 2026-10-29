// The button makes a check task in the project (its title says what a check is, its description lists the tasks
// in Review at that moment) and starts Claude on it. The rules of the section live in public/js/review-rules.js,
// a module without imports or DOM, so they run here for real; the wiring of the page is held by its source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHECK_LABEL, HOLD_STALE_MS, checkDescription, columnCheck, holdsCheck, reviewGroups } from '../public/js/review-rules.js';

const CHECK = 'Check the tasks in Review with different tests and simulate failures, then move them to Done';
const projects = [{ slug: 'kanban', name: 'Claude Kanban' }, { slug: 'shop', name: '' }, { slug: 'villa', name: 'Villa Tap' }, { slug: 'quiet', name: 'Quiet' }];
let id = 0;
const task = (project, key, status, title = `task ${key}`, updated_at = '2026-10-05 10:00:00', labels = []) => ({ id: ++id, project, key, status, title, updated_at, labels });
const check = (project, key, status, title = CHECK) => task(project, key, status, title, '2026-10-05 10:00:00', [CHECK_LABEL]);

test('tasks in Review are grouped by project in the sidebar order, the longest waiting first', () => {
  const tasks = [
    task('shop', 'SH-1', 'review', 'a', '2026-10-05 12:00:00'),
    task('kanban', 'CK-2', 'review', 'b', '2026-10-05 11:00:00'),
    task('kanban', 'CK-1', 'review', 'c', '2026-10-04 09:00:00'),
    task('kanban', 'CK-3', 'doing'),
    task('quiet', 'QT-1', 'todo'),
  ];
  const g = reviewGroups(tasks, projects);
  assert.deepEqual(g.map((x) => [x.project, x.name, x.tasks.map((t) => t.key)]),
    [['kanban', 'Claude Kanban', ['CK-1', 'CK-2']], ['shop', 'shop', ['SH-1']]],
    'a project with nothing in Review is listed, the order is not the sidebar one, or the oldest task is not first');
  assert.deepEqual(g[0].batch, ['CK-1', 'CK-2'], 'a task in work slipped into the check, or a task in Review is missing from it');
  assert.equal(g[0].running, null);
});

test('a check still open for a project is found, so the button does not make a second one', () => {
  const tasks = [
    task('kanban', 'CK-1', 'review'),
    check('kanban', 'CK-7', 'todo'),                         // made, Claude not started yet
    task('shop', 'SH-1', 'review'),
    check('shop', 'SH-4', 'doing', 'the same words in the other language'), // the label is the same in any language
    task('villa', 'VT-1', 'review'),
    check('villa', 'VT-2', 'done'),                          // an accepted check is history, not a running one
    task('villa', 'VT-8', 'todo', CHECK),                    // the words alone, without the label, are just a task
  ];
  const g = Object.fromEntries(reviewGroups(tasks, projects).map((x) => [x.project, x.running]));
  const id = Object.fromEntries(tasks.map((t) => [t.key, t.id]));
  assert.deepEqual(g, { kanban: { id: id['CK-7'], key: 'CK-7', status: 'todo' }, shop: { id: id['SH-4'], key: 'SH-4', status: 'doing' }, villa: null });
});

test('with two open checks the section shows the one that goes first', () => {
  const tasks = [task('kanban', 'CK-1', 'review'), check('kanban', 'CK-3', 'todo'), check('kanban', 'CK-5', 'doing'),
    task('shop', 'SH-1', 'review'), check('shop', 'SH-3', 'todo'), check('shop', 'SH-5', 'todo')];
  const g = Object.fromEntries(reviewGroups(tasks, projects).map((x) => [x.project, x.running?.key]));
  assert.deepEqual(g, { kanban: 'CK-5', shop: 'SH-3' });
});

test('a check task handed in to Review is a report for the person, not a task to check again — and not listed', () => {
  const ru = 'the same title in the language of the board';
  const tasks = [check('villa', 'VT-3', 'review'), check('villa', 'VT-4', 'review', ru), task('villa', 'VT-5', 'review')];
  const [g] = reviewGroups(tasks, projects);
  assert.deepEqual(g.tasks.map((t) => t.key), ['VT-5'], 'the report of a check is listed among the tasks to check');
  assert.deepEqual(g.batch, ['VT-5'], 'a new check would take the reports of the earlier ones (in either language) as tasks');
  assert.deepEqual(reviewGroups([check('villa', 'VT-6', 'review')], projects), [], 'a project with only reports in Review is listed');
  assert.deepEqual(reviewGroups([check('villa', 'VT-6', 'review'), check('villa', 'VT-7', 'doing')], projects), [],
    'a running check over nothing left in Review is listed');
});

test('the description names the tasks of the check, so a task that reaches Review later is not accepted unseen', () => {
  const text = checkDescription(['CK-1', 'CK-2'], { tasks: 'Tasks:', later: 'Later ones are not part of it.', report: 'Report here.' });
  assert.equal(text, 'Tasks: CK-1, CK-2\n\nLater ones are not part of it.\n\nReport here.');
});

// `kb done <KEY>` for each listed task — that command exactly (doneRules, src/review-check.js); the skill said «kb done in
// a batch, by a script», and the loop went past those rules to the auto-mode classifier, which refused it. The check
// itself now says how to move the tasks, so it holds whatever skill the Claude has.
test('the description says how to move what passes: one bare kb done per task, the command the board allows', () => {
  const text = checkDescription(['CK-1'], { tasks: 'Tasks:', later: 'Later.', done: 'One by one: kb done <KEY>.', report: 'Report.' });
  assert.equal(text, 'Tasks: CK-1\n\nLater.\n\nOne by one: kb done <KEY>.\n\nReport.');
  const review = readFileSync(new URL('../public/js/review.js', import.meta.url), 'utf8');
  const at = review.indexOf('done: tr(');
  assert.ok(at > 0, 'the check no longer says how to move its tasks to Done — Claude loops over kb done again');
  const said = review.slice(at, review.indexOf('\n', at));
  assert.match(said, /a command of its own and nothing around it: kb done <KEY>\./);
  assert.ok(!/[A-Z][A-Z0-9]{1,9}-\d/.test(said), 'an example key in the text would be read as a task of the check (checkedKeys)');
  const rules = readFileSync(new URL('../src/review-check.js', import.meta.url), 'utf8');
  assert.match(rules, /map\(\(k\) => `Bash\(kb done \$\{k\}\)`\)/, 'the text promises a permission the board no longer gives');
  const en = said.match(/done: tr\('([^']+)'\)/)[1];
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const at2 = core.indexOf(`'${en}':`);
  assert.ok(at2 > 0, 'the line of the check that says how to move to Done has no Russian');
  assert.match(core.slice(at2 + en.length, core.indexOf('\n', core.indexOf('\n', at2) + 1)), /по одной.*kb done <КЛЮЧ>/);
});

test('the page wires the section in: sidebar entry, its view, a check made as a task and started on it', () => {
  const src = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const sse = src('js/sse.js');
  assert.match(sse, /const SPECIAL_VIEWS = \[[^\]]*\bREVIEW\b/, 'a task event would patch a board that is not shown instead of re-reading the section');
  assert.match(sse, /\$\('review'\)\.classList\.toggle\('hidden', view !== 'review'\)/, 'showView does not show or hide the section');
  const sidebar = src('js/sidebar.js');
  assert.match(sidebar, /if \(state\.slug === REVIEW\) \{ showView\('review'\); await renderReview\(\); return; \}/);
  assert.match(sidebar, /const openable = \[[^\]]*\bREVIEW\b/, 'a tab left on the section would fall back to the first project on reload');
  assert.match(sidebar, /reviewEl\.dataset\.slug = REVIEW;/, 'the sidebar entry is not reachable with [ and ]');
  assert.match(src('index.html'), /<div id="review" class="now-view review-view hidden"><\/div>/);
  const review = src('js/review.js');
  // the button makes a task in To do with the owner's words as its title, then starts Claude on that very task
  assert.match(review, /api\('POST', '\/api\/tasks', \{ project, title: words\.title, description, status: 'todo', labels: \[CHECK_LABEL\] \}/,
    'the check is no longer made as a task with its label, so its report and its Claude would have nowhere to stay');
  assert.match(review, /export function checkWords\(\) \{\s*return \{\s*title: tr\(CHECK_TITLE\),/, 'the title of a check is no longer the owner\'s words');
  assert.match(review, /const words = checkWords\(\);\s*const description = checkDescription\(batch, words\);/);
  assert.match(review, /if \(e\.status === 409 && e\.body\?\.reason === 'check-open' && e\.body\.key\) \{\s*openDrawer\(e\.body\.key\);/,
    'a check refused as a second one is reported as a failure instead of opening the one that runs');
  assert.match(review, /launchInClaude\(\{ text: taskPromptText\(task\.key\), project, keys: \[task\.key\], btn, check: true \}\)/,
    'Claude is not started on the check task, or not in the project\'s folder');
  assert.match(review, /if \(g\?\.working\?\.length\) \{ styledAlert\(heldWhy\(g\.working\)\); return; \}[^\n]*\n\s*if \(!g \|\| !g\.batch\.length \|\| g\.running\) return;/, 'a second check of the same tasks can be started');
  // one press, one check: the button goes dead before the first await — a second click while the check task is being
  // made would pass the guard above (the section has not heard of the new task yet) and make a second check and a second Claude
  const board = src('js/board.js');
  assert.match(board, /if \(key === 'review' && tasks\.length\) \{\s*checkHead = head; checkShown = tasks;\s*const btn = reviewCheckButton\(tasks\);/, 'the Review column lost its check button');
  assert.match(board, /startCheckIn\(g\.project, g\.batch, btn, refresh\)/,
    'the Review column does not make a check of its own tasks, or stays a dead ▶ when another tab made the check first');
  assert.match(board, /const g = columnCheck\(shown, state\.tasks, state\.slug, ALL, state\.projects, state\.live\);/, 'the column decides on its own, past the rule');
  assert.match(board, /openDrawer\(g\.running\.key\)/, 'an open check is made again from the Review column instead of opening its card');
  assert.match(review, /await startCheckIn\(g\.project, g\.batch, btn, renderReview\);/, 'the section\'s button does not make the check of its own group');
  const start = review.slice(review.indexOf('export async function startCheckIn('), review.indexOf('export async function renderReview('));
  assert.match(start.slice(0, start.indexOf('await ')), /\bbtn\.disabled = true;/,
    'the button stays live while the check task is being made: a double click makes two checks and starts Claude twice');
  assert.ok(review.includes(`const CHECK_TITLE = '${CHECK}';`), 'the check is made with other words than the owner\'s');
  assert.match(review, /reviewGroups\(list, sidebarOrder\(state\.projects, shown\), state\.live\)/,
    'the groups do not follow the sidebar as it stands');
  // every string the section shows goes through tr() and has a Russian line in the dictionary
  const core = src('js/core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const said = [...review.matchAll(/tr\('((?:[^'\\]|\\.)+)'\)/g)].map((m) => m[1]);
  said.push(CHECK, 'Claude review'); // the title goes through tr(CHECK_TITLE), the entry is drawn by sidebar.js
  const bare = (s) => new RegExp(`\\n\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: '`);
  const missing = said.filter((s) => !dict.includes(`'${s}':`) && !bare(s).test(dict));
  assert.deepEqual(missing, [], 'a string of the section stays English on the Russian board');
});

test('the Review column offers a check only of one project, with something to check, and opens a running one', () => {
  const ALL = '__all__';
  const tasks = [task('kanban', 'CK-1', 'review'), task('shop', 'SH-1', 'review'), check('villa', 'VT-3', 'review'), task('quiet', 'QT-1', 'review'), check('quiet', 'QT-2', 'doing')];
  const shownOf = (...ps) => tasks.filter((t) => t.status === 'review' && ps.includes(t.project));
  assert.equal(columnCheck(shownOf('kanban', 'shop'), tasks, ALL, ALL, projects), null, 'one check was offered for two projects');
  assert.deepEqual(columnCheck(shownOf('shop'), tasks, ALL, ALL, projects)?.batch, ['SH-1'], 'a search down to one project hides the button');
  assert.deepEqual(columnCheck(shownOf('kanban'), tasks, 'kanban', ALL, projects)?.batch, ['CK-1']);
  assert.equal(columnCheck(shownOf('villa'), tasks, 'villa', ALL, projects), null, 'a column of reports of earlier checks offers a check of nothing');
  const g = columnCheck(shownOf('quiet'), tasks, 'quiet', ALL, projects);
  assert.equal(g?.running?.key, 'QT-2', 'a check open in the project is made again instead of opened');
  assert.equal(columnCheck([], [], 'kanban', ALL, projects), null);
});

// button of the section and the ▶ of the Review column wait for them; a task done by hand and a check are not work.
test('a check waits for the tasks of its project still in work', () => {
  const tasks = [task('kanban', 'CK-1', 'review'), task('kanban', 'CK-2', 'prep'), task('kanban', 'CK-3', 'doing'), task('kanban', 'CK-4', 'deploy'),
    task('kanban', 'CK-5', 'todo'), task('kanban', 'CK-6', 'doing', 'by hand', undefined, ['noclaude']), check('kanban', 'CK-7', 'doing'),
    task('shop', 'SH-1', 'review'), task('shop', 'SH-2', 'backlog'), task('villa', 'VT-1', 'doing')];
  const at = Date.parse('2026-10-05T10:30:00Z'); // half an hour after the tasks last moved
  const g = Object.fromEntries(reviewGroups(tasks, projects, {}, at).map((x) => [x.project, x.working]));
  assert.deepEqual(g, { kanban: ['CK-2', 'CK-3', 'CK-4'], shop: [] }, 'work of another project, a check, a manual task or To do counted — or work missed');
  assert.deepEqual(columnCheck(tasks.filter((t) => t.project === 'shop' && t.status === 'review'), tasks, 'shop', '__all__', projects, {}, at).working, []);
  assert.deepEqual(columnCheck(tasks.filter((t) => t.project === 'kanban' && t.status === 'review'), tasks, 'kanban', '__all__', projects, {}, at).working,
    ['CK-2', 'CK-3', 'CK-4'], 'the column does not wait as the section does');
  const src = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
  const review = src('js/review.js');
  const board = src('js/board.js');
  assert.match(review, /if \(g\.working\?\.length\) \{[\s\S]{0,300}?type="button" aria-disabled="true" data-project=/, 'the button of the section is not off while work goes on');
  assert.match(review, /if \(g\?\.working\?\.length\) \{ styledAlert\(heldWhy\(g\.working\)\); return; \}/, 'a press on the held button of the section says nothing, or starts a check');
  assert.match(board, /\} else if \(g\.working\.length\) \{[^}]*btn\.setAttribute\('aria-disabled', 'true'\);[^}]*btn\.onclick = \(e\) => \{ e\.stopPropagation\(\); pressCheck\(g\.project, btn\); \};/,
    'the ▶ of the Review column is not off while work goes on, or a press on it says nothing');
  assert.match(review, /reviewGroups\(list, sidebarOrder\(state\.projects, shown\), state\.live\)/, 'the section does not know which Claude is alive');
  assert.match(board, /columnCheck\(shown, state\.tasks, state\.slug, ALL, state\.projects, state\.live\)/, 'the column does not know which Claude is alive');
});

// nobody on them, and ▶ of Review stayed grey for good: "is it the terminals, or the tasks that did not finish?"
test('only a task Claude is still at work on holds the check: not a blocked one, nor one stuck with no Claude', () => {
  const at = Date.parse('2026-10-12T12:00:00Z');
  const t = (status, updated_at, more = {}) => ({ id: ++id, project: 'kanban', key: `CK-${id}`, status, updated_at, labels: [], ...more });
  const fresh = t('doing', '2026-10-12 11:00:00');
  const stuck = t('doing', '2026-10-05 10:00:00');
  const blocked = t('doing', '2026-10-12 11:59:00', { blocked: 1 });
  assert.equal(holdsCheck(fresh, {}, at), true, 'a task that moved an hour ago does not hold the check');
  assert.equal(holdsCheck(stuck, {}, at), false, 'a task stuck for a week with no Claude holds the check');
  assert.equal(holdsCheck(blocked, {}, at), false, 'a blocked task holds the check');
  assert.equal(holdsCheck(t('prep', new Date(at - HOLD_STALE_MS + 60_000).toISOString().slice(0, 19).replace('T', ' ')), {}, at), true, 'the edge of two hours');
  assert.equal(holdsCheck(t('prep', new Date(at - HOLD_STALE_MS - 60_000).toISOString().slice(0, 19).replace('T', ' ')), {}, at), false, 'the edge of two hours');
  // the state of its Claude decides over the clock: a session at work holds a quiet task, a closed one does not hold a fresh one
  assert.equal(holdsCheck(stuck, { [stuck.id]: { claude: 'busy' } }, at), true, 'a Claude at work on a task that has not moved for long does not hold');
  assert.equal(holdsCheck(stuck, { [stuck.id]: { claude: 'waiting' } }, at), true, 'a Claude waiting for an answer on it does not hold');
  assert.equal(holdsCheck(fresh, { [fresh.id]: { claude: 'gone' } }, at), false, 'a task whose Claude has closed holds the check');
  assert.equal(holdsCheck(t('review', '2026-10-12 11:59:00'), {}, at), false);
  assert.equal(holdsCheck(t('doing', 'garbage'), {}, at), true, 'a task of an unknown time lets a check test code still being written');
  const tasks = [t('review', '2026-10-12 10:00:00'), fresh, stuck, blocked];
  assert.deepEqual(reviewGroups(tasks, projects, {}, at)[0].working, [fresh.key]);
  assert.deepEqual(reviewGroups(tasks, projects, { [fresh.id]: { claude: 'gone' } }, at)[0].working, [], 'state.live is not passed through');
});
