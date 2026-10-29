// none of it had a test — Esc that saved, a title without the double click and an empty name sent to the server all
// passed the suite. The real renameInTitle of sidebar.js on stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sidebar = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
const body = sidebar.slice(sidebar.indexOf('function renameInTitle'), sidebar.indexOf("$('project-title').ondblclick"));

function stage({ refuse = false } = {}) {
  const calls = [];
  const said = [];
  let editable = 'inherit';
  const h = {
    textContent: 'Old name',
    get isContentEditable() { return editable === 'true' || editable === 'plaintext-only'; },
    get contentEditable() { return editable; },
    set contentEditable(v) { editable = v; },
    classList: { add() {}, remove() {} },
    focus() {}, removeAttribute() { editable = 'inherit'; },
  };
  const project = { slug: 'demo', name: 'Old name' };
  const box = {
    $: () => h,
    currentProject: () => project,
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    document: { createRange: () => ({ selectNodeContents() {} }) },
    // the payload comes out of the vm's realm: through JSON, for deepEqual
    api: async (method, path, payload) => { calls.push(JSON.parse(JSON.stringify([method, path, payload]))); if (refuse) throw Object.assign(new Error('x'), { status: 500 }); },
    loadProjects() {}, renderTopbar() {}, styledAlert: (s) => said.push(s), refusalLine: (head) => head, tr: (s) => s, seg: (s) => s,
  };
  vm.runInNewContext(`${body}\nthis.renameInTitle = renameInTitle;`, box);
  const key = (k) => h.onkeydown({ key: k, preventDefault() {}, stopPropagation() {} });
  return { h, project, calls, said, start: () => box.renameInTitle(), key };
}
const settle = () => new Promise((r) => setImmediate(r));

test('a double click opens the title for typing, and Enter saves the new name', async () => {
  assert.match(sidebar, /\$\('project-title'\)\.ondblclick = renameInTitle;/, 'a double click on the title renames nothing');
  const s = stage();
  s.start();
  assert.ok(s.h.isContentEditable, 'the title is not open for typing');
  s.h.textContent = '  New   name ';
  s.key('Enter');
  await settle();
  assert.deepEqual(s.calls, [['PATCH', '/api/projects/demo', { name: 'New name' }]]);
  assert.equal(s.project.name, 'New name');
  assert.ok(!s.h.isContentEditable, 'the title stays open after Enter');
});

test('a click away saves too; Esc, an empty or an unchanged name send nothing', async () => {
  let s = stage();
  s.start(); s.h.textContent = 'Away'; s.h.onblur(); await settle();
  assert.deepEqual(s.calls.map((c) => c[2].name), ['Away'], 'a click away lost the name');
  s = stage();
  s.start(); s.h.textContent = 'Typed'; s.key('Escape'); await settle();
  assert.deepEqual(s.calls, [], 'Esc saved the typed name');
  s.h.onblur?.(); await settle();
  assert.deepEqual(s.calls, [], 'the blur after Esc saved it');
  for (const typed of ['   ', 'Old name']) {
    s = stage();
    s.start(); s.h.textContent = typed; s.key('Enter'); await settle();
    assert.deepEqual(s.calls, [], `"${typed}" went to the server`);
  }
});

test('a refusal puts the old name back and says so', async () => {
  const s = stage({ refuse: true });
  s.start(); s.h.textContent = 'Taken'; s.key('Enter'); await settle();
  assert.equal(s.h.textContent, 'Old name', 'the title shows a name the server did not take');
  assert.equal(s.project.name, 'Old name');
  assert.deepEqual(s.said, ['Could not rename the project']);
});
