import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { columnCheck, reviewGroups } from '../public/js/review-rules.js';

const src = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
const take = (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from board.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const task = (id, key, status, more = {}) => ({ id, project: 'alpha', key, status, title: key, labels: [], updated_at: ago(0.1), ...more });

function board({ tasks, shown = tasks, live = {}, server = tasks }) {
  const said = [];
  const opened = [];
  const started = [];
  const asked = [];
  let refreshed = 0;
  const el = () => ({
    className: '', innerHTML: '', title: '', disabled: false, attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; }, remove() { this.removed = true; },
  });
  const head = {
    isConnected: true, kids: [],
    querySelector(sel) { return sel === '.col-check' ? this.kids.find((k) => !k.removed) || null : null; },
    appendChild(k) { this.kids.push(k); },
  };
  const box = {
    document: { createElement: el },
    state: { slug: 'alpha', tasks, projects: [{ slug: 'alpha', name: 'Alpha' }], live },
    ALL: '__all__',
    ic: () => '', tr: (s) => s, seg: (s) => encodeURIComponent(s),
    columnCheck, reviewGroups,
    heldWhy: (keys) => `held by ${keys.join(', ')}`,
    styledAlert: (m) => said.push(m),
    openDrawer: (k) => opened.push(k),
    refresh: () => { refreshed += 1; },
    refusalLine: (h, e) => `${h}: ${e.message}`,
    startCheckIn: async (project, batch) => { started.push([project, batch]); },
    api: async (method, path) => { asked.push(path); return server; },
  };
  vm.runInNewContext([
    'var checkHead = null; var checkShown = []; var checkSig = "";',
    take('function reviewCheckButton('),
    take('async function pressCheck('),
    take('export function repaintCheckButton('),
  ].join('\n'), box);
  head.appendChild(box.reviewCheckButton(shown));
  box.checkHead = head; box.checkShown = shown;
  vm.runInNewContext('checkHead = this.checkHead; checkShown = this.checkShown;', box);
  const button = () => head.querySelector('.col-check');
  const press = async () => { button().onclick({ stopPropagation() {} }); await new Promise((r) => setTimeout(r, 0)); };
  return { box, head, button, press, said, opened, started, asked, get refreshed() { return refreshed; } };
}

test('a press on the ▶ of Review decides by the project\'s tasks read afresh: a search does not let a check past work', async () => {
  const all = [task(1, 'AL-1', 'review'), task(2, 'AL-2', 'review'), task(3, 'AL-3', 'doing')];
  // the search found AL-1 only: the board's list is narrowed by the server, AL-3 in work is not in it
  const found = [all[0]];
  const b = board({ tasks: found, server: all });
  assert.equal(b.button().attrs['aria-disabled'], undefined, 'the narrowed list does not know of the work (the premise of the test)');
  await b.press();
  assert.deepEqual(b.asked, ['/api/tasks?project=alpha'], 'the press does not read the project\'s tasks');
  assert.deepEqual(b.started, [], 'a check was made while a task of the project is in work');
  assert.deepEqual(b.said, ['held by AL-3'], 'the press does not say which task holds the check');
  assert.equal(b.refreshed, 1, 'the board is not drawn again from the server');
  // nothing in work: the check takes every task of the project in Review, not the found ones only
  const done = board({ tasks: found, server: all.slice(0, 2) });
  await done.press();
  assert.deepEqual(done.started, [['alpha', ['AL-1', 'AL-2']]], 'the check takes only the tasks a search found');
  // a check already open (made in another tab): its card opens, no second one
  const open = board({ tasks: found, server: [...all.slice(0, 2), task(9, 'AL-9', 'doing', { labels: ['check'] })] });
  await open.press();
  assert.deepEqual([open.started, open.opened], [[], ['AL-9']], 'a second check is made over an open one');
});

test('the ▶ of Review follows the states of the Claude sessions that arrive after the board is drawn', async () => {
  const tasks = [task(1, 'AL-1', 'review'), task(2, 'AL-2', 'doing'), task(3, 'AL-3', 'doing', { updated_at: ago(3) })];
  const b = board({ tasks, shown: [tasks[0]] });
  assert.match(b.button().title, /held by AL-2$/, 'with no states yet, the task that moved lately holds');
  b.box.state.live = { 2: { claude: 'gone' }, 3: { claude: 'busy' } };
  b.box.repaintCheckButton();
  assert.match(b.button().title, /held by AL-3$/, 'the button does not follow the states: a closed session holds, a busy Claude does not');
  b.box.state.live = { 2: { claude: 'gone' }, 3: { claude: 'gone' } };
  b.box.repaintCheckButton();
  assert.equal(b.button().attrs['aria-disabled'], undefined, 'nothing holds the check, yet the button stays held');
  // a press on its way is not drawn over
  b.button().disabled = true;
  const pressed = b.button();
  b.box.state.live = { 2: { claude: 'busy' } };
  b.box.repaintCheckButton();
  assert.equal(b.button(), pressed, 'a button whose press is on its way was replaced');
});

test('the states of the sessions reach the button: applyLive draws it again', () => {
  const apply = take('export function applyLive(');
  assert.match(apply, /state\.live = next;[\s\S]*repaintCheckButton\(\);/, 'a change of the states of the sessions does not reach the ▶ of Review');
});
