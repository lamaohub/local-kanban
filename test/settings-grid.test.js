import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { EFFORT_LABELS, EFFORTS, effortOf, launchShown } from '../public/js/launch-rules.js';

const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
const take = (head, end = '\n}\n') => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from settings.js`);
  return src.slice(at, src.indexOf(end, at) + end.length).replace(/^export /, '');
};
const line = (head) => { const at = src.indexOf(head); assert.ok(at >= 0, `${head} is gone`); return src.slice(at, src.indexOf('\n', at) + 1); };

const box = { tr: (s) => s, esc: (s) => String(s), fmtLocalStamp: (s) => s };
vm.runInNewContext([line('const CC_MARK = '), line('const CC_WORD = '), take('function ccValue('), take('function ccFix('), take('function ccRow('),
  'this.ccRow = ccRow;'].join('\n'), box);

test('a row in place is a grid row: its path on the left, «in place» on the right, what it is for only as its hint', () => {
  const html = box.ccRow({ id: 'tmux', state: 'ok', title: 'tmux', note: 'Keeps Claude running inside the board.', value: '/opt/homebrew/bin/tmux' });
  assert.match(html, /^<div class="set-row cc-row"/, 'not a row of the grid General has');
  assert.match(html, /title="Keeps Claude running inside the board\."/, 'the sentence is not the hint of the row');
  assert.doesNotMatch(html, /class="cc-note"/, 'a row in place still says what it is for under its name');
  assert.match(html, /<small class="cc-value">\/opt\/homebrew\/bin\/tmux<\/small>/);
  assert.match(html, /<span class="cc-state cc-ok"[^>]*>.*in place<\/span><\/div>$/, 'the state is not a word on the right');
});

test('a row not used says nothing more than «not set up» and the way to set it up', () => {
  const html = box.ccRow({ id: 'tmux', state: 'opt', title: 'tmux', note: 'Not found: Claude cannot run inside the board.', fix: { cmd: 'brew install tmux' } });
  assert.doesNotMatch(html, /class="cc-note"/);
  assert.match(html, /title="Not found: Claude cannot run inside the board\."/);
  assert.match(html, /brew install tmux/, 'the way to set it up is gone');
  assert.match(html, /not set up<\/span><\/div>$/);
});

test('a row that asks for a step keeps its note in sight even when it is fine (an entry of an earlier version)', () => {
  const html = box.ccRow({ id: 'hook', state: 'ok', title: "Claude's questions", note: 'Written by an earlier version of the board — Connect brings the entry up to date.', fix: { connect: true }, say: true });
  assert.match(html, /<small class="cc-note">Written by an earlier version/, 'the step the person has to take is only a hint');
});

test('a row that is wrong says why in sight — once, not as a hint too — and how to fix it', () => {
  for (const state of ['off', 'warn']) {
    const note = 'Not the version this board ships.';
    const html = box.ccRow({ id: 'skill', state, title: "The board's skill", note, fix: { section: 'skills', label: 'Update it in Skills' } });
    assert.match(html, /<small class="cc-note">Not the version this board ships\.<\/small>/, `${state}: the trouble is not said in sight`);
    assert.equal(html.split(note).length - 1, 1, `${state}: the sentence is said twice`);
    assert.match(html, /data-sec="skills"/, `${state}: the fix is gone`);
  }
});

test('the section opens on its rows: no paragraph and no legend of the marks over them', async () => {
  const els = {};
  const body = { innerHTML: '', querySelector: () => ({ checked: false, onchange: null }) };
  const page = {
    tr: (s) => s, esc: (s) => String(s), $: (id) => (els[id] ||= { onclick: null }), buildSelect: () => {},
    loadLaunchOptions: async () => ({}), pickedSetting: () => null, launchShown, EFFORT_LABELS, EFFORTS, effortOf,
    getSetting: () => undefined, setSetting: () => {}, repaintUsage: () => {}, renderLimits: () => {}, loadClaude: async () => {},
    automations: () => ({ on: false, rules: [] }), applyAutomations: () => {},
  };
  vm.runInNewContext(`${line('const CC_MARK = ')}${take('async function renderClaudeSection(')}\nthis.run = renderClaudeSection;`, page);
  await page.run(body);
  const html = body.innerHTML;
  assert.doesNotMatch(html, /cc-legend|kbh-note/, 'the paragraph or the legend is back over the rows');
  assert.match(html, /<div class="sm-h" title="What the board can use of Claude Code[^"]*">Claude Code/, 'what the section is went from its heading too');
});

test('a reload of the backups list keeps More open, and What\'s new asks GitHub only when opened', () => {
  const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(src, /if \(\$\('bk-more'\) && !\$\('bk-more'\)\.innerHTML\) \$\('bk-more'\)\.innerHTML = more;/,
    'More of Backups is drawn anew on every reload of the list and folds under the person');
  const news = src.slice(src.indexOf('const loadNews = async'), src.indexOf("api('GET', `/api/whats-new${remote}`"));
  assert.match(news, /const open = Boolean\(box\.closest\('details'\)\?\.open\);/);
  assert.match(news, /const remote = open && upd\?\.update_available === true/, 'the release page is asked while What\'s new is folded');
});
