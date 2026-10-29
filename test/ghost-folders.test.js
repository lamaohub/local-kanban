// by default — thirty of them pushed everything below off the sidebar — and stay unfolded on this computer once opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const src = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
const take = (head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('}\n', src.indexOf('\n', at) - 1) + 1); };

test('folded by default, unfolded once opened, and the rows are drawn only unfolded', () => {
  const store = new Map();
  const box = { localStore: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) } };
  vm.runInNewContext(`${take('function ghostsOpen(')}\n${take('function setGhostsOpen(')}\nthis.api = { ghostsOpen, setGhostsOpen };`, box);
  assert.equal(box.api.ghostsOpen(), false, 'the folders are unfolded on a fresh computer');
  box.api.setGhostsOpen(true);
  assert.equal(box.api.ghostsOpen(), true);
  box.api.setGhostsOpen(false);
  assert.equal(box.api.ghostsOpen(), false);
  // the sidebar: one row with the count, and the "+ add" rows only under an unfolded one
  assert.match(src, /if \(ghosts\.length\) \{[\s\S]{0,400}?className = 'proj proj-ghost-toggle'[\s\S]{0,400}?\$\{ghosts\.length\}/);
  assert.match(src, /if \(ghosts\.length && ghostsOpen\(\)\) \{\s*for \(const folder of ghosts\)/, 'the folders are drawn folded too');
  assert.match(src, /t\.onclick = \(\) => \{ setGhostsOpen\(!open\); renderSidebar\(\); \};/);
});

test('the folding row is in the sidebar, and «+ add» adopts its own folder', () => {
  const from = src.indexOf("    const ghosts = cat === 'Local'");
  // the end: the block that closes before the row «＋ Add project» (by code — the published copy has no comments)
  const to = src.lastIndexOf('\n  }\n', src.indexOf("const addProj = document.createElement('div');", from));
  assert.ok(from > 0 && to > from, 'the piece of renderSidebar that draws the folders is gone');
  const run = (open) => {
    const kids = [];
    const adopted = [];
    let drawn = 0;
    const el = () => {
      const node = { className: '', innerHTML: '', title: '', onclick: null, add: { onclick: null } };
      node.querySelector = (sel) => (sel === '.ghost-add' ? node.add : null);
      return node;
    };
    const box = {
      box: { appendChild: (k) => kids.push(k) }, document: { createElement: el },
      state: { folders: { unregistered: ['one', 'two', 'three'] } }, cat: 'Local',
      ghostsOpen: () => open, setGhostsOpen: (v) => { open = v; }, renderSidebar: () => { drawn++; },
      tr: (s) => s, esc: (s) => s, adoptFolder: (f) => adopted.push(f),
    };
    vm.runInNewContext(src.slice(from, to), box);
    return { kids, adopted, get drawn() { return drawn; }, get open() { return open; } };
  };
  const shut = run(false);
  assert.equal(shut.kids.length, 1, 'the folding row is not put into the sidebar, or the folders are drawn folded');
  assert.match(shut.kids[0].innerHTML, />3</, 'the row does not count the folders');
  shut.kids[0].onclick();
  assert.equal(shut.open, true);
  assert.equal(shut.drawn, 1, 'the click does not draw the sidebar again');
  const open = run(true);
  assert.equal(open.kids.length, 4);
  open.kids[2].add.onclick({ stopPropagation() {} });
  assert.deepEqual(open.adopted, ['two'], '«+ add» adopts another folder than its own');
});
