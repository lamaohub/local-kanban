// list put together from every source. The real attention.js on a stand-in page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), 'utf8');
const src = read('js/attention.js');
const body = src.replace(/^import .*$/gm, '').replace(/^export /gm, '');

function el(id) {
  const cls = new Set();
  return {
    id, innerHTML: '', title: '', dataset: {}, children: [], listeners: {},
    classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    prepend(x) { this.children.unshift(x); x.parent = this; },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    setAttribute() {}, appendChild(x) { this.children.push(x); x.parent = this; },
    querySelector(sel) { return this.parts?.[sel] || null; },
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ bottom: 40, left: 10 }),
  };
}

function page({ live = {}, asks = [], tasks = [] } = {}) {
  const byId = { attn: el('attn') };
  const opened = [];
  const box = {
    state: { live, tasks, slug: 'demo' },
    tr: (s) => `ru:${s}`, esc: (s) => String(s),
    $: (id) => byId[id] || null,
    pendingAsks: () => asks,
    openDrawer: (key) => opened.push(key), selectProject: (slug) => opened.push(`#${slug}`),
    overlayLayer: () => () => {},
    requestAnimationFrame: (f) => f(), setTimeout: (f) => f(),
    document: {
      createElement: () => el(''),
      body: { appendChild: (x) => { if (x.id) byId[x.id] = x; } },
      querySelector: () => null,
    },
    Date,
  };
  vm.runInNewContext(`${body}\nthis.api = { waitingNow, whyText, paintAttention, setTerminalQuestions };`, box);
  return { box, byId, opened, api: box.api };
}

test('every source of waiting goes into one list, one row a task, the most pressing reason first', () => {
  const { api, box } = page({
    live: {
      1: { claude: 'idle', key: 'D-1', project: 'demo', title: 'one', since: 2000, background: true },
      2: { claude: 'busy', key: 'D-2', project: 'demo', title: 'two' },
      3: { claude: 'limit', key: 'D-3', project: 'demo', title: 'three', resets: '12:50am' },
      4: { claude: 'waiting', key: 'D-4', project: 'demo', title: 'four', since: 1000 },
      5: { claude: 'idle', key: 'D-5', project: 'demo', title: 'five', since: 3000 },
    },
    asks: [{ task_id: 5, key: 'D-5', project: 'demo', created_at: new Date(5000).toISOString() }],
  });
  api.setTerminalQuestions([{ id: 1, key: 'D-1', project: 'demo', title: 'one' }]);
  const rows = JSON.parse(JSON.stringify(api.waitingNow())); // out of the stand-in page's realm
  assert.deepEqual(rows.map((r) => [r.key, r.why]), [['D-5', 'ask'], ['D-1', 'question'], ['D-4', 'waiting'], ['D-3', 'limit']],
    'a task at work is listed, a task twice, or the order is not ask → question → waiting → limit → idle');
  assert.equal(rows.find((r) => r.key === 'D-5').title, 'five', 'a request names its task by the title of its live state');
  assert.match(api.whyText({ why: 'idle', since: null, background: true }), /ru:commands in the background/, 'the background is not said');
  assert.equal(api.whyText({ why: 'limit', resets: '12:50am' }), 'ru:limit reached · ru:until 12:50am');
  // nothing waits — the list is empty
  box.state.live = {};
  box.pendingAsks = () => [];
  api.setTerminalQuestions([]);
  assert.equal(api.waitingNow().length, 0);
});

test('the block on top of the sidebar is there only while something waits, and counts it', () => {
  const { api, box, byId } = page({ live: { 7: { claude: 'idle', key: 'D-7', project: 'demo', title: 'seven' } } });
  api.paintAttention();
  assert.equal(byId.attn.classList.contains('hidden'), false, 'the block is hidden while a task waits');
  assert.match(byId.attn.innerHTML, /<span class="attn-n">1<\/span>/);
  box.state.live = {};
  api.paintAttention();
  assert.equal(byId.attn.classList.contains('hidden'), true, 'the block stays when nothing waits');
});

// not want it; the block on top of the sidebar is where what waits is seen
test('the page rings without a note of its own at the bottom right', () => {
  const sse = read('js/sse.js');
  const take = (head) => { const at = sse.indexOf(head); return sse.slice(at, sse.indexOf('\n}\n', at) + 2); };
  let rang = 0;
  const box = { playReviewSound: () => { rang += 1; }, getSetting: () => false, tr: (s) => s };
  vm.runInNewContext(`${take('function maybeWaitingAlert(')}\nthis.run = maybeWaitingAlert;`, box);
  box.run([{ id: 1, key: 'D-1', claude: 'idle', from: 'busy' }, { id: 2, key: 'D-2', claude: 'limit', from: 'busy' }]);
  assert.equal(rang, 1, 'Claude starting to wait does not ring');
  for (const f of ['js/sse.js', 'js/attention.js', 'style.css', 'index.html'])
    assert.doesNotMatch(read(f), /toast/i, `${f} pops a note up again`);
  assert.match(take('function applyTerminalQuestions('), /setTerminalQuestions\(list\)/, 'the questions of the terminals do not reach the block');
  assert.match(read('js/board.js'), /atLimit\(t\)\);[^\n]*\n\s*\}\n\s*paintAttention\(\);/, 'a change of the sessions does not repaint the block');
  assert.match(read('js/init.js'), /\$\('attn'\)\.onclick = openAttentionList;/);
  assert.match(read('index.html'), /<button id="attn" type="button" class="side-attn hidden"><\/button>\s*<div class="sidebar-head">/, 'the block is not on top of the sidebar');
  const core = read('js/core.js');
  for (const w of ['asks a question in the terminal', 'commands in the background', 'Claude waits for your answer', 'Claude is waiting for you', 'Claude is asking you a question', 'Claude hit the usage limit'])
    assert.ok(core.includes(`'${w}': '`), `no Russian for "${w}"`);
});
