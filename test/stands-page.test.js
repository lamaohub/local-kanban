// front passed (ticks kept after the start, «0.0 GB», a busy stand chosen, «tick all» taking all, no start, codes for words,
// a busy stand among those that can go, no diff). The rules of the leaf in node; the real health-stands.js on a stand-in
// page in node:vm for what stays DOM: the ticks, «tick all», the start and the diff button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as rules from '../public/js/health-rules.js';

const mark = (s) => `«${s}»`;
const fmtNum = (n, digits = 1) => Number(n).toFixed(digits);
const plural = (n, one, many) => (n === 1 ? one : many);
const MB = 1024 ** 2;
const GB = 1024 ** 3;
const st = (name, state, extra = {}) => ({ path: `/r/.claude/worktrees/${name}`, top: '/r', state, why: [], size: 10 * MB, project: { slug: 'p', name: 'P' }, branch: `claude/${name}`, commits: [], ...extra });

test('the groups, the totals and the choice: only what can go is ticked, counted as room, and sent', () => {
  const stands = [st('A', 'free', { size: 2 * GB }), st('B', 'free'), st('C', 'busy', { why: ['session'], size: 5 * GB }), st('D', 'unsent', { why: ['dirty'] }), st('E', 'reading')];
  const g = rules.standGroups(stands);
  assert.deepEqual(Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.map((s) => s.path.split('/').pop())])),
    { free: ['A', 'B'], unsent: ['D'], busy: ['C'], reading: ['E'] }, 'a stand is in the group of another state');
  assert.deepEqual(rules.standTotals(stands), { n: 5, size: 2 * GB + 5 * GB + 30 * MB, freeN: 2, freeSize: 2 * GB + 10 * MB });
  assert.deepEqual(stands.filter(rules.tickable).map((s) => s.path.split('/').pop()), ['A', 'B'], 'a stand that cannot go gets a tick');
  assert.deepEqual(stands.filter(rules.diffable).map((s) => s.path.split('/').pop()), ['D'], 'the diff is offered on a stand without work not in main, or not on one with it');
  const chosen = new Set(stands.map((s) => s.path)); // ticked earlier, while each was still free
  assert.deepEqual(rules.chosenFree(chosen, stands), ['/r/.claude/worktrees/A', '/r/.claude/worktrees/B'], 'a stand no longer free is still sent to the cleanup');
  const tick = new Set();
  rules.tickAll(tick, stands);
  assert.deepEqual([...tick].sort(), ['/r/.claude/worktrees/A', '/r/.claude/worktrees/B'], '«Tick all that can go» took a stand that cannot go');
  rules.tickAll(tick, stands);
  assert.deepEqual([...tick], [], '«Untick all» left a tick');
  tick.add('/r/.claude/worktrees/A');
  rules.tickAll(tick, stands);
  assert.equal(tick.size, 2, 'with some ticked, «Tick all» does not tick the rest');
});

test('the weight of a stand: under a gigabyte in MB, never «0.0 GB»', () => {
  const w = (n) => rules.sizeWords(n, { tr: mark, fmtNum });
  assert.equal(w(5 * MB), `5 ${mark('MB')}`);
  assert.equal(w(1000), `1 ${mark('MB')}`, 'a stand of a few files reads as nothing');
  assert.equal(w(1.5 * GB), `1.5 ${mark('GB')}`);
  assert.equal(w(0), '—');
  assert.equal(w(null), '—');
});

test('every reason a stand can have is said in words that went through tr — none is left a code', () => {
  // the reasons the server gives: every why.push of standState in src/stands.js
  const src = readFileSync(new URL('../src/stands.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('export function standState('), src.indexOf('\n}\n', src.indexOf('export function standState(')));
  const codes = [...new Set([...body.matchAll(/why\.push\('(\w+)'\)/g)].map((m) => m[1]))].sort();
  assert.ok(codes.length >= 12, `the reasons of standState are not where the test reads them: ${codes}`);
  const s = { branch: 'main', task: { status: 'doing' }, changes: { files: 2 }, ignored: { files: 3 }, commits: [{ found: null }, { found: null, merge: true }, { found: 'patch' }] };
  const said = codes.map((w) => [w, rules.whyWords({ ...s, why: [w] }, { tr: mark, plural, statusWord: (x) => `[${x}]` })]);
  for (const [w, text] of said) {
    assert.notEqual(text, w, `the reason ${w} is shown as its code`);
    assert.match(text, /«[^»]+»/, `the reason ${w} did not go through tr: ${text}`);
  }
  assert.equal(new Set(said.map(([, t]) => t)).size, codes.length, `two reasons read the same: ${JSON.stringify(said)}`);
  const text = Object.fromEntries(said);
  assert.match(text.task, /\[doing\]/, 'the column of the task is not said');
  assert.match(text.main, /\(main\)/, 'the branch kept is not named');
  assert.match(text.commits, /: 1 commit$/, 'the commits not in main are not counted apart from the merge');
  assert.match(text.merge, /: 1$/);
  assert.equal(rules.whyWords({ why: ['session', 'process'] }, { tr: mark, plural }), `${mark('a Claude session is open in the folder')} · ${mark('a process runs in the folder')}`);
});

test('how each commit stands against main, in words', () => {
  const c = (x) => rules.commitWords(x, mark);
  assert.equal(c({ found: 'patch' }), mark('in main as the same change'));
  assert.equal(c({ found: 'content' }), mark('its changes are in main'));
  assert.equal(c({ found: null, merge: true }), mark('a merge with changes of its own'));
  assert.equal(c({ found: null, like: 'title' }), mark('not in main: its title is, the changes differ'));
  assert.equal(c({ found: null, like: 'issue' }), mark('not in main: its issue is, the changes differ'));
  assert.equal(c({ found: null }), mark('not in main'));
  // each word the page says has its Russian
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const leaf = readFileSync(new URL('../public/js/health-rules.js', import.meta.url), 'utf8');
  const dict = new Function(`return (${core.slice(core.indexOf('const I18N_RU = ') + 16, core.indexOf('\n};', core.indexOf('const I18N_RU = ')) + 2)})`)();
  const words = [...leaf.matchAll(/\btr\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(words.length > 15);
  assert.deepEqual(words.filter((w) => !dict[w]), [], 'a word of the stands has no Russian');
});

/* The page itself — the real module on a stand-in DOM (the one of test/health-fix.test.js: tags read back from innerHTML). */
function fakeBox() {
  let html = '';
  const tags = () => [...html.matchAll(/<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>/g)].map((m) => {
    const attrs = Object.fromEntries([...m[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1], a[2] ?? '']));
    const dataset = {};
    for (const [k, v] of Object.entries(attrs)) if (k.startsWith('data-')) dataset[k.slice(5)] = v;
    return { tag: m[1], attrs, classes: (attrs.class || '').split(/\s+/).filter(Boolean), dataset, checked: 'checked' in attrs, disabled: 'disabled' in attrs, onclick: null, onchange: null };
  });
  const matches = (el, sel) => sel.split(/\s*,\s*/).some((one) => {
    const [, tag, cls] = one.match(/^(\w+)?(?:\.([\w-]+))?$/);
    return (!tag || el.tag === tag) && (!cls || el.classes.includes(cls));
  });
  return {
    all: [],
    get innerHTML() { return html; },
    set innerHTML(v) { html = v; this.all = tags(); },
    querySelectorAll(sel) { return this.all.filter((el) => matches(el, sel)); },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
}
const until = async (ok) => { for (const end = Date.now() + 5000; !ok() && Date.now() < end;) await new Promise((r) => setTimeout(r, 5)); };

function standsPage(picture) {
  const box = fakeBox();
  const asked = [];
  const launched = [];
  const api = async (method, url, body) => {
    asked.push({ method, url, body });
    if (method === 'GET' && url.startsWith('/api/health/stands/diff')) return { text: 'diff text' };
    if (method === 'GET') return structuredClone(picture);
    if (method === 'POST' && url === '/api/health/stands/task') return { tasks: [{ key: 'P-9', project: 'p', n: body.paths.length }] };
    throw new Error(`unexpected ${method} ${url}`);
  };
  const stubs = {
    $: (id) => { assert.equal(id, 'health'); return box; }, HEALTH: 'health', api, state: { slug: 'health' }, tr: (s) => s, fmtNum, ic: () => '',
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
    keepFocus: (_el, fn) => fn(), plural,
    styledAlert: (s) => { throw new Error(`alert: ${s}`); }, styledConfirm: async () => false, refusalLine: (s) => s, openDrawer: () => {},
    SHORT_MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'], STATUS_LABELS: {},
    launchInClaude: async (o) => { launched.push({ keys: [...o.keys], project: o.project, text: o.text }); }, taskPromptText: (k) => `Take ${k}`,
    ...rules,
  };
  const src = readFileSync(new URL('../public/js/health-stands.js', import.meta.url), 'utf8');
  const imported = [...src.matchAll(/^import \{([^}]*)\} from '[^']+';$/gm)].flatMap((m) => m[1].split(',').map((n) => n.trim()).filter(Boolean));
  assert.ok(imported.length > 10, 'the imports of health-stands.js are not where the test reads them');
  assert.deepEqual(imported.filter((n) => !(n in stubs)), [], 'health-stands.js imports a name the test does not give');
  const body = src.replace(/^import .*;$/gm, '').replace(/^export /gm, '');
  const ctx = vm.createContext({ ...stubs, setTimeout, clearTimeout, Date, JSON, Set, Map });
  vm.runInContext(`${body}\nthis.page = { renderStands, stopStands };`, ctx);
  return { page: ctx.page, box, asked, launched };
}
const picks = (box) => box.querySelectorAll('.st-pick').map((c) => [c.dataset.path.split('/').pop(), c.checked]);

test('the page: ticks only on what can go, «tick all» takes those, the start opens the task, starts it and clears the ticks', async () => {
  const picture = { at: Date.now(), running: false, done: 4, total: 4, error: null, repos: [{ top: '/r', main: 'origin/main', free: 50 * GB, projects: [] }],
    // A and C hold commits main has: their rows open, and only work not in main may offer its diff
    stands: [st('A', 'free', { commits: [{ sha: '0123456789ab', title: 'Landed', found: 'patch' }] }), st('B', 'free'),
      st('C', 'busy', { why: ['task'], task: { status: 'doing' }, commits: [{ sha: '123456789abc', title: 'Landed too', found: 'patch' }] }),
      st('D', 'unsent', { why: ['commits'], commits: [{ sha: 'abcdef012345', title: 'Lost work', found: null, like: 'title' }] })] };
  const { page, box, asked, launched } = standsPage(picture);
  await page.renderStands('<div class="tabs"></div>');
  assert.deepEqual(picks(box), [['A', false], ['B', false]], 'a stand that cannot go has a tick');
  assert.deepEqual(box.querySelectorAll('.st-diff-btn').map((b) => b.dataset.path.split('/').pop()), ['D'], '«Show what is not in main» is not on the stand with work not in main alone');
  assert.equal(box.querySelector('.st-go').disabled, true, 'the start is open with nothing ticked');
  assert.match(box.innerHTML, /<span class="st-why">its task is in work \(doing\)<\/span>/, 'the reason of a busy stand is not said in words');
  assert.match(box.innerHTML, />not in main: its title is, the changes differ</, 'how a commit stands against main is not said in words');
  box.querySelector('.st-all').onclick();
  assert.deepEqual(picks(box), [['A', true], ['B', true]], '«Tick all that can go» did not tick what can go');
  assert.match(box.querySelector('.st-all') ? box.innerHTML : '', /Untick all/);
  // the busy stand is free at the next walk: «tick all» pressed before took only what could go then — it is not ticked now
  picture.at += 1;
  picture.stands[2] = { ...picture.stands[2], state: 'free', why: [], task: null };
  await page.renderStands('<div class="tabs"></div>', { force: true });
  assert.deepEqual(picks(box), [['A', true], ['B', true], ['C', false]], '«Tick all» chose a stand that could not go, and it came ticked once free');
  box.querySelector('.st-go').onclick();
  await until(() => launched.length);
  assert.deepEqual(asked.filter((a) => a.method === 'POST').map((a) => a.body.paths.map((p) => p.split('/').pop())), [['A', 'B']], 'the task was not asked for the ticked stands that can go');
  assert.deepEqual(launched, [{ keys: ['P-9'], project: 'p', text: 'Take P-9' }], 'the task of the cleanup was opened but not started');
  await until(() => !picks(box).some(([, on]) => on));
  assert.deepEqual(picks(box), [['A', false], ['B', false], ['C', false]], 'the ticks stayed after the task was opened — pressed again, it would open a second');
  // a tick by hand, then the diff of the stand with work not in main
  const a = box.querySelector('.st-pick');
  a.checked = true; a.onchange();
  assert.deepEqual(picks(box), [['A', true], ['B', false], ['C', false]]);
  box.querySelector('.st-diff-btn').onclick();
  await until(() => box.innerHTML.includes('diff text'));
  assert.match(box.innerHTML, /<pre class="st-diff">diff text<\/pre>/, 'the diff is not shown');
  assert.deepEqual(picks(box), [['A', true], ['B', false], ['C', false]], 'showing a diff lost the ticks');
  page.stopStands();
});

test('CK-983/CK-984: a stand without a project is named by its repository; a walk draws its bar', async () => {
  const picture = { at: Date.now(), running: true, done: 1, total: 4, error: null, repos: [{ top: '/r', main: 'origin/main', free: GB, projects: [] }],
    stands: [st('loose', 'free', { project: null, repo_name: 'shared-root' }), st('K-1', 'free', { project: { slug: 'k', name: 'Claude Kanban' } })] };
  const { page, box } = standsPage(picture);
  await page.renderStands('<div class="tabs"></div>');
  page.stopStands(); // the walk «runs»: the page would ask again every 2 s and hold the test open
  const rows = box.innerHTML.split('class="hl-row st-row"').slice(1);
  const row = (name) => rows.find((r) => r.includes(`>${name}</span>`)) || '';
  assert.match(row('loose'), /<span class="hl-what"><span>shared-root<\/span>/, 'a stand without a project is not named by its repository');
  assert.match(row('K-1'), /<span class="hl-what"><span>Claude Kanban<\/span>/);
  assert.match(box.innerHTML, /class="hl-walk"[^>]*aria-valuenow="1"/, 'the walk of the stands draws no bar');
  assert.match(box.innerHTML, /1 \/ 4/);
  page.stopStands();
});
