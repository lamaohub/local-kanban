import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canRetry, changedFields, createRetryQueue, createUnsentComments, createUnsentEdits, pullExternal, refusalText, sameValue } from '../public/js/unsaved.js';

const opened = () => ({ title: 'orig', description: 'desc', priority: 0, labels: ['bug'], status: 'todo' });

test('only the fields that differ from the snapshot are sent', () => {
  const snap = opened();
  assert.deepEqual(changedFields({ ...snap }, snap), {}, 'an untouched form sends nothing');
  assert.deepEqual(changedFields({ ...snap, priority: 3 }, snap), { priority: 3 });
  assert.deepEqual(changedFields({ ...snap, description: 'desc!', labels: ['bug', 'ask'] }, snap),
    { description: 'desc!', labels: ['bug', 'ask'] });
});

test('labels are compared as a set, not as a list', () => {
  const snap = { ...opened(), labels: ['bug', 'ask'] };
  assert.deepEqual(changedFields({ ...snap, labels: ['ask', 'bug'] }, snap), {}, 'reordered labels are not a change');
  assert.equal(sameValue(['a', 'b'], ['b', 'a']), true);
  assert.equal(sameValue(['a', 'a'], ['a', 'b']), false, 'a duplicate does not stand in for a missing label');
  assert.equal(sameValue(['a'], 'a'), false);
});

test('an outside rename under the cursor is not sent back by the next action', () => {
  const snap = opened();
  const form = opened(); // cursor in the title, nothing typed
  const r = pullExternal(snap, form, { title: 'renamed outside', description: 'desc', priority: 0, labels: ['bug'] }, ['title']);
  assert.deepEqual(r.write, {}, 'the field under the cursor is not overwritten');
  assert.equal(r.snap.title, 'orig', 'the snapshot must not claim what the form does not show');
  // the person now picks a priority in the card
  assert.deepEqual(changedFields({ ...form, priority: 3 }, r.snap), { priority: 3 },
    'the old title would go out with the priority and undo the rename');
});

test('the outside value reaches the field once the cursor has left it', () => {
  const r = pullExternal(opened(), opened(), { title: 'renamed outside' }, []);
  assert.deepEqual(r.write, { title: 'renamed outside' });
  assert.equal(r.snap.title, 'renamed outside');
  assert.deepEqual(changedFields({ ...opened(), title: 'renamed outside' }, r.snap), {}, 'nothing left to send');
});

test('a field the person has changed keeps their value, and it still goes out', () => {
  const snap = opened();
  const form = { ...opened(), description: 'typed by the person' };
  const r = pullExternal(snap, form, { description: 'changed outside', priority: 2 }, []);
  assert.deepEqual(r.write, { priority: 2 }, 'only the untouched field takes the outside value');
  assert.equal(r.snap.description, 'desc');
  assert.deepEqual(changedFields({ ...form, priority: 2 }, r.snap), { description: 'typed by the person' });
});

test('a value the form already shows moves the snapshot without a write', () => {
  const snap = opened();
  const form = { ...opened(), title: 'same on both sides' };
  const r = pullExternal(snap, form, { title: 'same on both sides', labels: ['bug'] }, ['title']);
  assert.deepEqual(r.write, {});
  assert.equal(r.snap.title, 'same on both sides');
  assert.deepEqual(changedFields(form, r.snap), {}, 'a value the server already has is not resent');
});

test('fields the form does not have are ignored, and the inputs are left alone', () => {
  const snap = opened();
  const before = JSON.stringify(snap);
  const r = pullExternal(snap, opened(), { pinned: 1, labels: ['bug', 'ask'] }, []);
  assert.deepEqual(r.write, { labels: ['bug', 'ask'] });
  assert.equal('pinned' in r.snap, false);
  assert.equal(JSON.stringify(snap), before, 'pullExternal returns a new snapshot instead of changing the old one');
  r.write.labels.push('x');
  assert.deepEqual(r.snap.labels, ['bug', 'ask'], 'the snapshot shares no array with what the form gets');
});

test('an edit that did not reach the server is kept as the fields of that task', () => {
  const unsent = createUnsentEdits();
  const fields = { description: 'typed while the server was down' };
  unsent.fail('P2-1', fields);
  fields.description = 'the form moved on';
  assert.deepEqual(unsent.get('P2-1'), { description: 'typed while the server was down' },
    'the queue must hold what failed, not a view of the form');
  assert.equal(unsent.get('VV-1'), undefined, 'another task has nothing queued');
});

test('a second failure on the same task merges, the newer value wins', () => {
  const unsent = createUnsentEdits();
  unsent.fail('VV-1', { description: 'a', priority: 2 });
  unsent.fail('VV-1', { description: 'ab', labels: ['bug'] });
  assert.deepEqual(unsent.get('VV-1'), { description: 'ab', priority: 2, labels: ['bug'] });
  assert.equal(unsent.size, 1, 'one entry per task, not one per failure');
});

test('what got through is settled field by field; a newer value of the same field keeps waiting', () => {
  const unsent = createUnsentEdits();
  unsent.fail('VV-1', { description: 'abc', priority: 3 });
  const sent = { ...unsent.get('VV-1') };
  unsent.fail('VV-1', { description: 'abcd' });
  assert.equal(unsent.settle('VV-1', sent), false, 'the newer description has not been sent yet');
  assert.deepEqual(unsent.get('VV-1'), { description: 'abcd' });
  assert.equal(unsent.settle('VV-1', { description: 'abcd', title: 'x' }), true);
  assert.equal(unsent.get('VV-1'), undefined);
  assert.equal(unsent.settle('VV-9', { title: 'x' }), true, 'nothing queued means nothing waits');
});

test('a direct save supersedes the queued value of every field it carried, however old', () => {
  const unsent = createUnsentEdits();
  unsent.fail('VV-1', { description: 'base one', priority: 3 });
  assert.equal(unsent.supersede('VV-1', ['description']), false, 'the priority is still waiting');
  assert.deepEqual(unsent.get('VV-1'), { priority: 3 }, 'the older description would be resent over the newer one');
  assert.equal(unsent.supersede('VV-1', ['priority', 'title']), true);
  assert.equal(unsent.get('VV-1'), undefined);
});

test('the retry queue keeps one job per key and retries only what failed for lack of a connection', async () => {
  const q = createRetryQueue();
  const runs = [];
  q.note('task:VV-1', async () => { runs.push('old'); });
  q.note('task:VV-1', async () => { runs.push('new'); });
  const offline = Object.assign(new Error('Failed to fetch'), { offline: true });
  let downOnce = true;
  q.note('new:3', async () => { runs.push('create'); if (downOnce) { downOnce = false; throw offline; } });
  q.note('task:VV-2', async () => { runs.push('gone'); throw Object.assign(new Error('task not found'), { status: 404 }); });
  q.note('task:VV-3', async () => { runs.push('busy'); throw Object.assign(new Error('busy'), { status: 503 }); });
  assert.equal(q.size, 4, 'a second note for the same key replaces the first');
  await q.retry();
  assert.deepEqual(runs, ['new', 'create', 'gone', 'busy']);
  assert.equal(q.size, 2, 'the offline create and the 5xx stay queued, the done one and the 404 do not');
  await q.retry();
  assert.equal(q.size, 1, 'the create went through on the second pass');
});

test('a job queued again while the retry runs is not overwritten by the old one', async () => {
  const q = createRetryQueue();
  const offline = Object.assign(new Error('Failed to fetch'), { offline: true });
  const newer = async () => {};
  q.note('task:VV-1', async () => { q.note('task:VV-1', newer); throw offline; });
  await q.retry();
  assert.equal(q.size, 1);
  q.drop('task:VV-1');
  assert.equal(q.size, 0, 'drop removes the job once the edit got through another way');
});

test('the card takes the rule from unsaved.js', () => {
  const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');
  assert.doesNotMatch(read('unsaved.js'), /^\s*import\s/m, 'unsaved.js imports something — it has to stay a leaf');
  const drawer = read('drawer.js');
  assert.match(drawer, /import \{[^}]*\bchangedFields\b[^}]*\bpullExternal\b[^}]*\} from '\.\/unsaved\.js'/);
  assert.doesNotMatch(drawer, /function changedFields\(/, 'drawer.js grew its own copy of the rule again');
  assert.match(drawer, /pullExternal\(drawerSnapshot, drawerForm\(\), drawerFresh, skip\)/,
    'refreshDrawerFields no longer goes through pullExternal');
});

test('a project form sends only what was changed in it, not what changed elsewhere since it opened', () => {
  const opened = { name: 'Board', description: 'orig desc', category: 'Other', pinned: 1, domain: 'a.example', path: null, server: null, server_path: null, deploy_skill: null, pm2_services: null };
  const form = { ...opened, name: 'Board renamed' };
  assert.deepEqual(changedFields(form, opened), { name: 'Board renamed' },
    'pinned and domain from the form would undo the outside changes');
});

test('the project page, the editors and the reload guard follow the rules', () => {
  const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');
  const project = read('project.js');
  const save = project.slice(project.indexOf('async function saveProjectSettings('), project.indexOf('function flashSaved('));
  assert.match(save, /const body = changedFields\(readProjectForm\(\), psSnap\);/, 'Save no longer diffs against the values the form was filled from');
  assert.doesNotMatch(save, /\bp\.(pinned|domain|description|name|category|deploy_skill|pm2_services)\b/,
    'Save compares the form with the fresh project again');
  assert.match(project, /psSnap = projectValues\(p\);/, 'the form takes no snapshot when it is filled');
  assert.match(project, /confirmClose: \(\) => !dirty\(\) \|\| confirmDiscard\(\)/, 'the file editor closes over unsaved text without asking');
  const sidebar = read('sidebar.js');
  const layer = sidebar.slice(sidebar.indexOf('export function overlayLayer('), sidebar.indexOf('export function styledPrompt('));
  assert.match(layer, /openLayers\[openLayers\.length - 1\]\?\.key !== overlay/, 'Esc is taken by a window that is not on top again');
  assert.match(layer, /if \(backdrop\) overlay\.addEventListener\('click', \(e\) => \{ if \(e\.target === overlay\) requestClose\(\); \}\);/,
    'a click on the backdrop closes without asking again');
  const settings = read('settings.js');
  const modal = settings.slice(settings.indexOf('export function openSettingsModal('), settings.indexOf('async function renderSection('));
  assert.match(modal, /pushLayer\('settings-overlay', requestCloseSettings\)/, 'Esc closes Settings over an unsaved skill without asking');
  for (const [where, re] of [
    ['the close button', /\.sm-close'\)\.onclick = requestCloseSettings;/],
    ['another section', /n\.onclick = async \(\) => \{\s*if \(!await leaveSkillEditor\(\)\) return;/],
    ['another skill', /row\.onclick = async \(\) => \{ if \(await leaveSkillEditor\(\)\) selectSkillRow\(row\.dataset\.name\); \};/],
  ]) assert.match(settings, re, `the skill editor is left without asking: ${where}`);
  const init = read('init.js');
  const unsaved = init.slice(init.indexOf('function hasUnsavedInput('), init.indexOf('export async function checkVersion('));
  assert.match(unsaved, /projectSettingsDirty\(\) \|\| fileEditorHasChanges\(\) \|\| skillDirty\(\)/,
    'a reload for a new version can wipe a filled-in form that has lost the focus');
});

test('the project page and the skill editor see a change typed into them, and only that', () => {
  const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');
  const take = (src, head) => {
    const at = src.indexOf(head);
    assert.ok(at >= 0, `${head} is gone`);
    return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
  };
  const project = read('project.js');
  const fieldsAt = project.indexOf('const FIELDS = {');
  assert.ok(fieldsAt >= 0, 'FIELDS is gone from project.js');
  const els = {};
  const el = (props = {}) => ({ value: '', checked: false, dataset: {}, classList: { contains: () => false }, ...props });
  const box = { $: (id) => els[id] || null, changedFields, selVal: (host) => host.dataset.value, skillSel: null, psSnap: null, out: {} };
  vm.runInNewContext([
    project.slice(fieldsAt, project.indexOf('};', fieldsAt) + 2),
    take(project, 'function readProjectForm('),
    take(project, 'export function projectSettingsDirty('),
    take(read('settings.js'), 'export function skillDirty('),
    'out.project = projectSettingsDirty; out.skill = skillDirty;',
  ].join('\n'), box);

  assert.equal(box.out.skill(), false, 'no skill is open');
  box.skillSel = { name: 'deploy', saved: 'the text on disk' };
  els['sk-text'] = el({ value: 'the text on disk' });
  assert.equal(box.out.skill(), false, 'an untouched skill counts as unsaved');
  els['sk-text'].value = 'the text on disk, edited';
  assert.equal(box.out.skill(), true, 'a skill with typed text counts as saved: closing it would drop the text without asking');

  assert.equal(box.out.project(), false, 'no project page is open');
  box.psSnap = { name: 'Board', description: 'desc', category: 'Other', pinned: 1, deploy_skill: null, pm2_services: null,
    path: '/work/board', server: null, server_path: null, domain: null };
  Object.assign(els, {
    projset: el(), 'ps-name': el({ value: 'Board' }), 'ps-desc': el({ value: 'desc' }), 'ps-category': el({ dataset: { value: 'Other' } }),
    'ps-category-new': el(), 'ps-pinned': el({ checked: true }), 'ps-skill': el({ dataset: { value: '' } }), 'ps-pm2': el(),
    'ps-path': el({ value: '/work/board' }), 'ps-server': el(), 'ps-spath': el(), 'ps-domain': el(),
  });
  assert.equal(box.out.project(), false, 'a project page filled from the project and not touched counts as unsaved');
  els['ps-name'].value = 'Board renamed';
  assert.equal(box.out.project(), true, 'a renamed project counts as saved: a new board version would reload the tab over it');
  els.projset.classList.contains = (c) => c === 'hidden';
  assert.equal(box.out.project(), false, 'a hidden project page still holds the tab back');
});

test('a comment that did not go waits per task, in the order typed', () => {
  const unsent = createUnsentComments();
  const a = unsent.add('VV-1', 'first');
  const b = unsent.add('VV-1', 'second');
  unsent.add('VV-2', 'elsewhere');
  assert.equal(a.again, false);
  assert.notEqual(a.id, b.id);
  assert.deepEqual(unsent.list('VV-1').map((c) => c.body), ['first', 'second']);
  assert.deepEqual(unsent.list('VV-2').map((c) => c.body), ['elsewhere'], 'a comment shows up on another task');
  assert.equal(unsent.size, 3);
  unsent.list('VV-1')[0].body = 'changed by a reader';
  assert.equal(unsent.get('VV-1', a.id).body, 'first', 'a reader can change what waits to be sent');
});

test('the same text typed again while it waits is that comment, not a second one', () => {
  const unsent = createUnsentComments();
  const first = unsent.add('VV-1', 'please check the login');
  const again = unsent.add('VV-1', 'please check the login');
  assert.equal(again.again, true, 'the second send of the same text queues a duplicate');
  assert.equal(again.id, first.id);
  assert.equal(unsent.list('VV-1').length, 1);
  assert.equal(unsent.add('VV-2', 'please check the login').again, false, 'the same words on another task are another comment');
  assert.equal(unsent.add('VV-1', 'please check the login!').again, false);
});

test('a delivered or dropped comment leaves the list, and the same text can be sent again after', () => {
  const unsent = createUnsentComments();
  const c = unsent.add('VV-1', 'ok');
  unsent.done('VV-1', c.id);
  assert.deepEqual(unsent.list('VV-1'), []);
  assert.equal(unsent.get('VV-1', c.id), null);
  assert.equal(unsent.size, 0);
  assert.equal(unsent.add('VV-1', 'ok').again, false, 'a comment delivered once blocks the same words forever');
  unsent.done('VV-9', 1); // nothing there — nothing breaks
});

test('only a missing connection or a failing server is worth sending again', () => {
  assert.equal(canRetry(Object.assign(new Error('Failed to fetch'), { offline: true })), true);
  assert.equal(canRetry({ status: 502 }), true);
  assert.equal(canRetry({ status: 404 }), false, 'a comment on a deleted task would wait forever');
  assert.equal(canRetry({ status: 400 }), false);
  assert.equal(canRetry(undefined), false);
});

test('a refusal is said in the words of the board, and a gone task leaves the board', () => {
  const gone = refusalText({ status: 404, message: 'task not found' });
  assert.equal(gone.gone, true);
  assert.equal(gone.refresh, true, 'the ghost card stays on the board to be clicked again');
  assert.doesNotMatch(gone.text, /task not found/);
  const stale = refusalText({ status: 400, message: 'cannot go straight from "todo" to "done" — it has to pass through the working statuses' });
  assert.equal(stale.gone, false);
  assert.equal(stale.refresh, true, 'the card that showed an old column is not read again');
  for (const e of [{ status: 400, message: 'priority: an integer 0-3' }, { status: 403, message: 'Forbidden' }, { status: 503, message: 'Service Unavailable' }]) {
    const r = refusalText(e);
    assert.equal(r.gone, false);
    assert.doesNotMatch(r.text, new RegExp(e.message), `the server's words leak into ${e.status}`);
  }
  assert.notEqual(refusalText({ status: 503 }).text, refusalText({ status: 400, message: 'x' }).text, 'a failing server reads as a refusal');
});

test('what a refusal and an unsent comment say is in the Russian dictionary', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const texts = [
    refusalText({ status: 404 }).text, refusalText({ status: 500 }).text, refusalText({ status: 418 }).text,
    refusalText({ status: 400, message: 'cannot go straight from "todo" to "done"' }).text,
  ];
  assert.equal(new Set(texts).size, 4);
  assert.deepEqual(texts.filter((s) => !dict.includes(`'${s}':`)), [], 'a refusal stays English on the Russian board');
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  for (const s of ['not sent — goes out once the connection is back', 'Do not send']) {
    assert.ok(drawer.includes(`tr('${s}')`), `${s} is not said by the card`);
    assert.ok(dict.includes(`'${s}':`), `${s} stays English on the Russian board`);
  }
});
