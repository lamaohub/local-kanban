// by test/task-move.test.js; here — the open card that follows its task when the move happens in another tab or by kb
// (the real followMovedTask of drawer.js on stand-ins), and the way to the move: the ⋯ menu, the right click, the
// refusals said in the picker, «Moved from» in the log and the words of both languages. The whole path was walked in
// Chromium and WebKit on a board of its own (two tabs, an unsaved edit and a half-typed comment at the moment of the move).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');
const drawer = read('drawer.js');
const fnOf = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };

function follow({ drawerKey = 'ALP-19', openingKey = null, pending = false, drafts = [] } = {}) {
  const log = [];
  const box = {
    state: { drawerKey, openingKey },
    autosaveTimer: pending ? 7 : null,
    commentDrafts: new Map(drafts),
    clearTimeout: (t) => log.push(['clear', t]),
    openDrawer: (k) => log.push(['open', k, box.state.drawerKey]),
    log,
  };
  box.doAutosave = async () => { log.push(['save', box.state.drawerKey]); await null; if (box.switchDuringSave) box.state.drawerKey = box.switchDuringSave; };
  vm.runInNewContext(`${fnOf(drawer, 'export async function followMovedTask(from, to)')}\nthis.followMovedTask = followMovedTask;`, box);
  return box;
}

test('the open card of a task moved elsewhere opens again under its new key, the half-typed comment going along', async () => {
  const b = follow({ drafts: [['ALP-19', 'half a comment'], ['ALP-3', 'another task']] });
  await b.followMovedTask('ALP-19', 'BET-5');
  assert.deepEqual(b.log, [['open', 'BET-5', 'ALP-19']]);
  assert.equal(b.commentDrafts.get('BET-5'), 'half a comment', 'the comment typed into the card is lost on the move');
  assert.ok(!b.commentDrafts.has('ALP-19'), 'the old draft would keep the tab from reloading forever');
  assert.equal(b.commentDrafts.get('ALP-3'), 'another task');
});

test('an edit waiting to be saved is sent before the card opens again — by the old key, which still leads there', async () => {
  const b = follow({ pending: true });
  await b.followMovedTask('ALP-19', 'BET-5');
  assert.deepEqual(b.log, [['clear', 7], ['save', 'ALP-19'], ['open', 'BET-5', 'ALP-19']], 'the card read the task again before the edit reached it');
  assert.equal(b.autosaveTimer, null);
  const moved = follow({ pending: true });
  moved.switchDuringSave = 'ALP-7'; // the person opened another card while the edit was on its way
  await moved.followMovedTask('ALP-19', 'BET-5');
  assert.ok(!moved.log.some(([w]) => w === 'open'), 'the card the person opened meanwhile was replaced');
});

test('the tab that made the move, opening the card under the new key already, is left alone', async () => {
  const b = follow({ openingKey: 'BET-5', pending: true });
  await b.followMovedTask('ALP-19', 'BET-5');
  assert.deepEqual(b.log, [], 'the card of a move made from it opened twice');
});

test('the check of the open card takes an answer under another key for this move', () => {
  const sync = fnOf(drawer, 'export async function syncOpenDrawerStatus(');
  const follows = sync.indexOf('if (t.key && t.key !== key) { await followMovedTask(key, t.key); return; }');
  assert.ok(follows > 0, 'a card whose task moved in another tab keeps its old key (CK-690)');
  assert.ok(follows > sync.indexOf('if (!t || state.drawerKey !== key) return;') && follows < sync.indexOf('followTimeline(key, t, moved);'),
    'the move is followed before the fields of the old card are compared with the task');
});

test('the move is in the ⋯ menu of the card and in its right-click menu, but not for a task Claude is working on', () => {
  const menu = fnOf(drawer, 'function fillDrawerMenu(');
  assert.match(menu, /data-act="move">\$\{tr\('Move to project…'\)\}/);
  assert.match(menu, /act\('move', \(\) => \{ closeDrawerMenu\(\); openMovePicker\(state\.drawerKey\); \}\);/);
  assert.match(menu, /menu\.innerHTML = head \+ \(drawerLocked \? '' :/, 'a locked card offers to move a task in work');
  assert.match(drawer, /: WORKING\.has\(t\.status\) && !taskIsNoclaude\(t\) \? '' : `<div class="dm-item" data-act="move">\$\{tr\('Move to project…'\)\}<\/div>`\)/,
    'the right click offers to move a task Claude is working on — the server refuses it');
  assert.match(drawer, /if \(it\('move'\)\) it\('move'\)\.onclick = \(\) => \{ closeCardMenu\(\); openMovePicker\(group\.length > 1 \? group : t\.key\); \};/);
});

// on a card of the selection moved that card alone, and the panel of the selection had no move
test('a card of the selection moves the whole selection, and the panel of the selection has a move of its own', () => {
  const menu = fnOf(drawer, 'export function openCardMenu(e, t)');
  assert.match(menu, /const group = selectedIds\.has\(t\.id\) \? \[\.\.\.selectedIds\]\.map\(\(id\) => state\.tasks\.find\(\(x\) => x\.id === id\)\?\.key\)\.filter\(Boolean\) : \[\];/,
    'the right click does not know the selection');
  assert.match(menu, /group\.length > 1 \? `<div class="dm-item" data-act="move">\$\{tr\('Move to project…'\)\} \(\$\{group\.length\}\)<\/div>`/, 'the menu does not say it moves the selection');
  const board = read('board.js');
  assert.match(board, /tile\('move', ic\('open', 15\), tr\('Move'\)\)/, 'the panel of the selection has no move');
  assert.match(board, /if \(act === 'move'\) \{ openMovePicker\(tasks\.map\(\(t\) => t\.key\)\); return; \}/);
  const picker = fnOf(drawer, 'export function openMovePicker(keys)');
  assert.match(picker, /if \(list\.length > 1\) \{ openGroupMove\(list\); return; \}/);
  const group = fnOf(drawer, 'function openGroupMove(keys)');
  assert.match(group, /api\('POST', `\/api\/tasks\/\$\{seg\(k\)\}\/move`, \{ project: slug \}/);
  assert.match(group, /await moveEach\(keys, slug, \{ post, projectOf, openKey: \(\) => state\.drawerKey, why \}\)/, 'the selection is not moved by moveEach');
  assert.match(group, /if \(!refused\.length\) \{ close\(\); clearSelection\(\); return; \}/);
  assert.match(group, /try \{ await refresh\(\); \} catch/, 'a failed read of the board stops the window saying what moved');
  assert.match(group, /if \(ids\.some\(\(id\) => !selectedIds\.has\(id\)\)\) selectTasks\(ids\);/, 'the refused do not stay selected');
  assert.match(group, /`<div><b>\$\{esc\(k\)\}<\/b> — \$\{esc\(w\)\}<\/div>`/, 'a refused task is not named in the window');
});

test('the picker says why a move is refused, and a moved open card opens under its new key', () => {
  const picker = fnOf(drawer, 'export function openMovePicker(keys)');
  assert.match(picker, /const pool = state\.projects\.filter\(\(p\) => p\.slug !== from\);/, 'the picker offers the project the task is in');
  assert.match(picker, /reason === 'in-work'\) \{ fail\(tr\('Claude is working on this task — it can be moved once it is handed in\.'\)\)/);
  assert.match(picker, /reason === 'check-open'\) \{ fail\(`\$\{tr\('That project already has an open check:'\)\} \$\{e\.body\.key\}`\)/);
  assert.match(picker, /if \(refusalText\(e\)\.gone\) \{ close\(\); sayRefused\(e, key\); return; \}/, 'a task deleted meanwhile is not said in the board\'s words');
  assert.match(picker, /fail\(refusalLine\('Not moved', e, tr\)\);/, 'another refusal is said as a bare message, or not at all');
  assert.match(picker, /if \(key === state\.drawerKey\) openDrawer\(moved\.key, \{ quiet: true \}\);/);
});

test('the log of the card says where the task came from', () => {
  const sse = read('sse.js');
  assert.match(sse, /for \(const mv of \(t\.moves \|\| \[\]\)\) \{\n\s+items\.push\(\{ when: mv\.moved_at, [^\n]*text: `\$\{esc\(tr\('Moved from'\)\)\} \$\{esc\(mv\.key\)\}` \}\);/);
});

test('every word of the move has its Russian', () => {
  const core = read('core.js');
  const at = core.indexOf('const I18N_RU = ') + 'const I18N_RU = '.length;
  const dict = new Function(`return ${core.slice(at, core.indexOf('\n};', at) + 2)}`)();
  for (const s of ['Move to project…', 'Move to another project', 'Project name or key…', 'nothing found', 'no other projects',
    'Claude is working on this task — it can be moved once it is handed in.', 'That project already has an open check:', 'Not moved', 'Moved from', 'Move', 'Moved']) {
    assert.ok(typeof dict[s] === 'string' && /[\u0430-\u044f]/i.test(dict[s]), `«${s}» shows in English on the Russian board`);
  }
});

test('a group move moves every task, a refused one does not stop the rest, the open card opens under its new key', async () => {
  const vm = await import('node:vm');
  const box = {};
  vm.runInNewContext(`${fnOf(drawer, 'export async function moveEach(').replace(/^export /, '')}\nthis.moveEach = moveEach;`, box);
  const sent = [];
  const post = async (k) => { sent.push(k); if (k === 'A-2') throw Object.assign(new Error('in work'), { status: 409 }); return { key: `B-${k.slice(2)}` }; };
  const r = JSON.parse(JSON.stringify(await box.moveEach(['A-1', 'A-2', 'A-3', 'B-9', 'A-4'], 'b', { post, projectOf: (k) => (k.startsWith('B') ? 'b' : 'a'), openKey: () => 'A-3', why: (e) => e.message }))); // out of the vm's realm
  assert.deepEqual(sent, ['A-1', 'A-2', 'A-3', 'A-4'], 'not every task went, or one already there was sent');
  assert.deepEqual(r.moved, ['A-1', 'A-3', 'A-4']);
  assert.deepEqual(r.refused, [['A-2', 'in work']]);
  assert.equal(r.reopen, 'B-3');
});
