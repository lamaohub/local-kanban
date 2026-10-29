import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import vm from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { HINT_ACTIVITY, HINT_STATUSES, termSuggestion, withPath } from '../public/js/term-input-rules.js';

const src = (file) => readFileSync(new URL(`../public/js/${file}`, import.meta.url), 'utf8');

test('the grey hint is for a Claude waiting for a word on a task whose code is being written', () => {
  const tr = (s) => (s === 'Move {key} to Review, so I can check it later' ? 'Переведи {key} в «Проверяю», чтобы я потом проверил' : s);
  assert.equal(termSuggestion({ key: 'CK-1', status: 'doing', activity: 'idle' }, tr), 'Переведи CK-1 в «Проверяю», чтобы я потом проверил');
  assert.equal(termSuggestion({ key: 'CK-1', status: 'deploy', activity: 'background' }), 'Move CK-1 to Review, so I can check it later');
  for (const activity of ['busy', 'own', 'question', 'limit', null, undefined]) {
    assert.equal(termSuggestion({ key: 'CK-1', status: 'doing', activity }), null, `a Claude that is ${activity} is offered words`);
  }
  for (const status of ['backlog', 'todo', 'prep', 'review', 'done', null]) {
    assert.equal(termSuggestion({ key: 'CK-1', status, activity: 'idle' }), null, `a task in ${status} is offered to go to Review`);
  }
  assert.equal(termSuggestion({ key: null, status: 'doing', activity: 'idle' }), null);
  assert.deepEqual([...HINT_STATUSES], ['doing', 'deploy']);
  assert.deepEqual([...HINT_ACTIVITY], ['idle', 'background']);
  assert.match(src('core.js'), /\n {2}'Move \{key\} to Review, so I can check it later': 'Переведи \{key\} в «Проверяю», чтобы я потом проверил',/, 'no Russian for the hint');
});

test('a picture path goes where the caret is, apart from the words around it', () => {
  assert.deepEqual(withPath('', 0, 0, '/d/a/1.png'), { value: '/d/a/1.png ', caret: 11 });
  assert.deepEqual(withPath('look at', 7, 7, '/d/1.png'), { value: 'look at /d/1.png ', caret: 17 });
  assert.deepEqual(withPath('look  here', 5, 5, '/d/1.png'), { value: 'look /d/1.png here', caret: 13 });
  assert.deepEqual(withPath('a XX b', 2, 4, '/p.png'), { value: 'a /p.png b', caret: 8 }, 'a selection is replaced');
  assert.deepEqual(withPath('', 0, 0, '/My Data/1.png'), { value: '"/My Data/1.png" ', caret: 17 }, 'a path with a space must be read whole');
});

test('the card and the column both offer the hint, take it with Tab and take pictures', () => {
  const drawer = src('drawer.js');
  const init = drawer.slice(drawer.indexOf('export function initTerminal'), drawer.indexOf('\n}\n', drawer.indexOf('export function initTerminal')));
  assert.match(init, /if \(takeTermHint\(e, input\)\) return;[\s\S]*e\.key === 'Enter'/, 'Tab is not taken before Enter in the card');
  assert.match(init, /wireTermImages\(input, \(\) => termKey\)/, 'the card does not take pictures into its field');
  assert.match(drawer, /setTermHint\(\$\('term-input'\), \{ key: termKey, status: drawerTask\?\.key === termKey \? drawerTask\.status : null, activity: termActivity \}\)/);
  assert.match(drawer, /termActivity = off \? null : r\.activity;\n {2}hintCardTerm\(\);/, 'the card\'s hint does not follow the screen');
  const launch = drawer.slice(drawer.indexOf('function renderLaunchButtons'), drawer.indexOf('\n}\n', drawer.indexOf('function renderLaunchButtons')));
  assert.match(launch, /if \(termKey === t\.key\) hintCardTerm\(\);/, 'a task gone to Review keeps offering to move it to Review');
  const take = drawer.slice(drawer.indexOf('export function wireTermImages'), drawer.indexOf('\n}\n', drawer.indexOf('export function wireTermImages')));
  assert.match(take, /e\.stopPropagation\(\)/, 'the card\'s own paste would make an attachment of the picture and leave the field empty');
  assert.match(take, /i\.kind === 'file'/, 'WebKit names no type while a file is dragged — a drop would open the picture instead of the board');
  const img = drawer.slice(drawer.indexOf('async function termImage'), drawer.indexOf('\n}\n', drawer.indexOf('async function termImage')));
  assert.match(img, /uploadAttachment\(blob, key\)/, 'a second copy of the upload and its refusals');
  assert.match(img, /keyOf\(\) !== key\) return;/, 'a path of one task typed into the field of another task\'s terminal');
  assert.match(take, /wirePicturePick\([^;]*\(f, key\) => termImage\(input, keyOf, f, key\), \{ ready, at: keyOf \}\)/, 'the clip of the field takes the task when the picture is picked, not when it is pressed');
  assert.match(drawer, /btn\.onclick = \(\) => \{ if \(!ready\(\)\) return; clicked = at\(\); file\.click\(\); \};/, 'the clip forgets which task it was pressed on');
  assert.match(src('init.js'), /wirePicturePick\(\$\('c-input'\)\.closest\('\.comment-form'\), uploadCommentImage, \{ at: \(\) => state\.drawerKey \}\)/, 'the comment\'s clip posts to the card open when the picture is picked');
  const grow = drawer.slice(drawer.indexOf('export function growTermInput'), drawer.indexOf('\n}\n', drawer.indexOf('export function growTermInput')));
  assert.doesNotMatch(grow, /input\.value =/, 'writing the field\'s value wipes its undo history');
  const hint = drawer.slice(drawer.indexOf('export function takeTermHint'), drawer.indexOf('\n}\n', drawer.indexOf('export function takeTermHint')));
  assert.match(hint, /input\.value \|\| !input\.dataset\.hint\) return false/, 'Tab takes the hint over typed words');
  const cols = src('now-terms.js');
  assert.match(cols, /if \(takeTermHint\(e, input\)\) return;/);
  assert.match(cols, /wireTermImages\(input, \(\) => c\.key\)/);
  assert.match(cols, /setTermHint\(c\.el\.querySelector\('textarea'\), \{ key: c\.key, status: c\.status, activity: c\.activity \?\? null \}\)/);
  assert.match(cols, /c\.activity = live \? r\.activity : null;\n {2}hintColumn\(c\);/);
  assert.match(cols, /if \(board\) hintColumn\(c\);/, 'a status changed under a screen as it was keeps the old hint');
  // and as pictures going with the message, not as a path in its words
  const chat = src('chat.js');
  assert.match(chat, /input\.addEventListener\('paste', \(e\) => \{[\s\S]*?if \(!files\.length \|\| !c\.data\?\.send\) return;[\s\S]*?addImages\(files\);/, 'the chat\'s field does not take pictures');
  assert.doesNotMatch(chat, /wireTermImages|withPath/, 'a picture goes into the chat\'s words as a path again');
});

let app, tmp;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  const { db } = await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo', 'DM', 'demo', 2)").run();
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES ((SELECT id FROM projects WHERE slug = 'demo'), 1, 'Task 1', 'doing')").run();
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
});
after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test('an attachment answers with its path on disk — the field puts it into the terminal', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/tasks/DM-1/attachments', payload: Buffer.from('png'), headers: { 'content-type': 'image/png' } });
  assert.equal(r.statusCode, 201);
  const { path, file } = r.json();
  assert.ok(path && path.startsWith(tmp) && path.endsWith(file), `not a path in the board's data: ${path}`);
  assert.ok(existsSync(path), 'the path does not lead to the file');
  assert.equal(readFileSync(path, 'utf8'), 'png');
});

test('a pasted picture is the field\'s own: the card does not make a second attachment of it', () => {
  const drawer = src('drawer.js');
  const at = drawer.indexOf("input.addEventListener('paste'");
  const paste = drawer.slice(at, drawer.indexOf('\n  });', at));
  assert.match(paste, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);/, 'the card\'s onDrawerPaste would attach the picture once more and leave the field empty');
});

test('an upload hands the server\'s answer back — the field takes the path from it', () => {
  const drawer = src('drawer.js');
  const at = drawer.indexOf('export async function uploadAttachment');
  const up = drawer.slice(at, drawer.indexOf('\n}\n', at));
  assert.match(up, /r = await apiBlob\(/);
  assert.match(up, /\n {2}return r;$/, 'the answer with its path is dropped: a picture never reaches the field');
  assert.match(drawer, /const r = await uploadAttachment\(blob, key\);\n(?: *\/\/[^\n]*\n)* {2}if \(!r\?\.path/);
});

test('the field grows to the whole grey hint, not to its empty value', () => {
  const drawer = src('drawer.js');
  const fn = (name) => { const at = drawer.indexOf(name); return drawer.slice(at, drawer.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };
  const box = { autoGrow: (el) => { el.style.height = '30px'; } };
  vm.runInNewContext(`${fn('export function growTermInput')}\n${fn('function hintHeight')}\nthis.growTermInput = growTermInput;`, box);
  const probe = { style: {}, scrollHeight: 50, offsetHeight: 32, clientHeight: 30, removeAttribute() {}, remove() {} };
  const input = { value: '', dataset: { hint: 'Move CK-1 to Review, so I can check it later' }, placeholder: 'Move CK-1 … — Tab',
    offsetParent: {}, offsetWidth: 282, style: {}, cloneNode: () => probe, after() {} };
  Object.defineProperty(input, 'offsetHeight', { get: () => parseFloat(input.style.height) || 0 });
  box.growTermInput(input);
  assert.equal(input.style.height, '52px', 'the second line of the hint is cut off');
  assert.equal(probe.value, input.placeholder, 'the height is measured on another text');
  input.value = 'typed';
  box.growTermInput(input);
  assert.equal(input.style.height, '30px', 'typed words are sized by themselves');
});
