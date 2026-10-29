// the last 16 rows (they cut its question and first options off) and the keys 1 2 3. The screens here keep the layout of
// one captured from Claude Code 2.1.309 at the 45 columns of a card (an AskUserQuestion of three questions, the first
// tab open), with English words in place of the owner's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenQuestion, wholeChoice } from '../src/question-screen.js';

const RULE = '─'.repeat(45);
const ASKED = [
  '⏺ Bash(do something in the background)',
  '  ⎿  Running in the background',
  RULE,
  '←  ☐ Steps  ☐ Wizard  ☐ Phone  ✔ Submit  →',
  '',
  '│ CK-763 "the steps are pressed — nothing is',
  '│ seen, one has to scroll". As I read it: "N',
  '│ steps" stands at the bottom. What to do?',
  '',
  '❯ 1. Open the steps in view right away ',
  '     (Recommended)',
  '     opened "N steps" at the bottom edge — the',
  '     chat scrolls so the steps are on screen',
  '  2. Last steps always seen',
  '     while Claude works, the last 2–3 steps',
  '     show under "N steps"',
  '  3. Both',
  '     both of the above',
  '  4. Type something.',
  RULE,
  '  5. Chat about this',
  '',
  'Enter to select · Tab/Arrow keys to navigate',
  '· Esc to cancel',
  '───────────────────────────────── CK-770 +2 ─',
  '',
  '',
].join('\n');

test('a question of Claude Code: its tabs, its whole text, every option with its description', () => {
  const q = screenQuestion(ASKED);
  assert.deepEqual(q.tabs, [{ label: 'Steps', done: false }, { label: 'Wizard', done: false }, { label: 'Phone', done: false }, { label: 'Submit', done: true }]);
  assert.equal(q.text, 'CK-763 "the steps are pressed — nothing is seen, one has to scroll". As I read it: "N steps" stands at the bottom. What to do?',
    'the rows the terminal wrapped are not put back into one paragraph');
  assert.deepEqual(q.options.map((o) => [o.n, o.label, o.cursor]), [
    [1, 'Open the steps in view right away (Recommended)', true],
    [2, 'Last steps always seen', false],
    [3, 'Both', false],
    [4, 'Type something.', false],
    [5, 'Chat about this', false],
  ], 'a wrapped label was taken for its description, or the reverse');
  assert.equal(q.options[0].note, 'opened "N steps" at the bottom edge — the chat scrolls so the steps are on screen');
  assert.equal(q.options[1].note, 'while Claude works, the last 2–3 steps show under "N steps"');
  assert.equal(q.options[3].other, true, '«Type something» is not the answer of one\'s own');
  assert.equal(q.options[4].other, undefined);
  assert.equal(q.multi, false);
});

test('a permission Claude Code asks in its terminal is a choice too — the command over it is its text', () => {
  const screen = [
    'Claude wants to clean up.',
    RULE,
    ' Bash command',
    '',
    '   rm -rf build',
    '   Remove the build folder',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    "   2. Yes, and don't ask again for rm",
    '      commands in /tmp/xyz/project',
    '   3. No, and tell Claude what to do',
    '      differently (esc)',
    '',
    ' Esc to cancel · Tab to amend',
  ].join('\n');
  const q = screenQuestion(screen);
  assert.deepEqual(q.tabs, []);
  assert.equal(q.text, 'Bash command\n\nrm -rf build\nRemove the build folder\n\nDo you want to proceed?');
  assert.deepEqual(q.options.map((o) => o.label), ['Yes', "Yes, and don't ask again for rm commands in /tmp/xyz/project", 'No, and tell Claude what to do differently (esc)']);
  assert.ok(q.options.every((o) => !o.note));
});

test('several answers: the box of each option says whether it is ticked', () => {
  const screen = [RULE, '│ Which permissions?', '', '❯ 1. [ ] Notifications', '     a line under it', '  2. [✔] Full Disk Access', '  3. [ ] Type something.', '', 'Enter to select · Esc to cancel'].join('\n');
  const q = screenQuestion(screen);
  assert.equal(q.multi, true);
  assert.deepEqual(q.options.map((o) => [o.label, o.checked]), [['Notifications', false], ['Full Disk Access', true], ['Type something.', false]]);
  assert.equal(q.options[2].other, true);
});

test('not a choice: no footer, or a numbered list of Claude\'s own words over its input box', () => {
  assert.equal(screenQuestion(''), null);
  assert.equal(screenQuestion(null), null);
  const words = ['⏺ Done:', '  1. Fixed the test', '  2. Wrote the note', '', RULE, '❯ ', RULE, '  ? for shortcuts'].join('\n');
  assert.equal(screenQuestion(words), null);
  assert.equal(screenQuestion(['Esc to cancel'].join('\n')), null, 'a footer with no options over it');
});

test('no rule over the dialog (scrolled off): only the block right over the options is its text', () => {
  const screen = ['an old line of the conversation', '', '│ Pick one?', '', '❯ 1. A', '  2. B', '', 'Enter to select · Esc to cancel'].join('\n');
  const q = screenQuestion(screen);
  assert.equal(q.text, 'Pick one?');
  assert.deepEqual(q.options.map((o) => o.label), ['A', 'B']);
});

// captures the screen with its attributes, and the faint rows are the description.
test('a faint row under an option is its description, however near the edge the label ends', () => {
  const dim = (s) => `\x1b[2m${s}\x1b[22m`;
  const screen = [RULE, '│ Как открывать воронки на телефоне?', '',
    `\x1b[36m❯\x1b[39m ${dim('1.')} \x1b[36mОставить как есть (Recommended)\x1b[39m`,
    `     ${dim('Карточка открывает «Инструменты» —')}`, `     ${dim('список воронок.')}`,
    `  ${dim('2.')} Открывать общий экран с плитками и`, '     состоянием каждой',
    `     ${dim('как на втором скрине')}`,
    `  ${dim('3.')} Type something.`, '', 'Enter to select · ↑/↓ to navigate · Esc to', 'cancel'].join('\n');
  const q = screenQuestion(screen);
  assert.deepEqual(q.options.map((o) => [o.label, o.note]), [
    ['Оставить как есть (Recommended)', 'Карточка открывает «Инструменты» — список воронок.'],
    ['Открывать общий экран с плитками и состоянием каждой', 'как на втором скрине'],
    ['Type something.', ''],
  ], 'a description taken for the label it follows, or a wrapped label for a description');
  assert.equal(q.text, 'Как открывать воронки на телефоне?', 'the escapes of the screen went into the words');
  // a permission: the command and its faint description are two lines, not one wrapped
  const perm = screenQuestion([RULE, ' Bash command', '', '   rm -rf build && npm run build -- --prod', `   ${dim('Remove the build folder')}`, '',
    ' Do you want to proceed?', ` \x1b[36m❯\x1b[39m ${dim('1.')} Yes`, `   ${dim('2.')} No`, '', ' Esc to cancel'].join('\n'));
  assert.equal(perm.text, 'Bash command\n\nrm -rf build && npm run build -- --prod\nRemove the build folder\n\nDo you want to proceed?');
  // no attributes on the screen (a capture without them): the width decides, as before
  assert.equal(screenQuestion(ASKED).options[0].note, 'opened "N steps" at the bottom edge — the chat scrolls so the steps are on screen');
});

// Claude Code wraps a little short of the window's edge (WRAP_SLACK): «— the» went to the next row at 42 of 45. Breaking
// the slack left the suite green
test('a row Claude Code wrapped a little short of the edge is one line of the question', () => {
  const screen = [RULE, '│ The steps of a turn are pressed and the', '│ log has to be scrolled to see them', '', '❯ 1. A', '  2. B', '', 'Enter to select · Esc to cancel'].join('\n');
  assert.equal(screenQuestion(screen).text, 'The steps of a turn are pressed and the log has to be scrolled to see them');
});

// captured live — the layout is its own, the words of a card's 45 columns
const DIM = (s) => `\x1b[2m${s}\x1b[22m`;
const PLAN = [
  '⏺ The plan is in the plan file.',
  RULE,
  ' Ready to code?',
  '',
  ' Here is Claude\'s plan:',
  '  1. Read the screen with its history',
  '  2. Take the plan without a footer',
  '',
  RULE,
  DIM(' Claude has written up a plan and is ready'),
  DIM(' to execute. Would you like to proceed?'),
  '',
  ' ❯ 1. Yes, and switch to \x1b[1mauto (no routine\x1b[22m',
  '      \x1b[1mprompts; a reviewer model screens\x1b[22m',
  '      \x1b[1mactions)\x1b[22m for this session',
  '   2. Yes, manually approve edits',
  '   3. No, keep planning',
  DIM('      shift+tab to approve with this feedback'),
  '',
  DIM(' ctrl+g to edit in Vim · ~/.claude/plans/a.md'),
  '',
].join('\n');

test('the approval of a plan has no footer — still a choice: its question, its options, «keep planning» takes words', () => {
  const q = screenQuestion(PLAN);
  assert.ok(q, 'the approval of a plan is not read — the chat shows the cut tail of the screen');
  assert.equal(q.text, 'Claude has written up a plan and is ready to execute. Would you like to proceed?');
  assert.deepEqual(q.options.map((o) => [o.n, o.label, o.cursor]), [
    [1, 'Yes, and switch to auto (no routine prompts; a reviewer model screens actions) for this session', true],
    [2, 'Yes, manually approve edits', false],
    [3, 'No, keep planning', false],
  ]);
  assert.equal(q.options[2].note, 'shift+tab to approve with this feedback');
  assert.equal(q.options[2].other, true, 'the words of «keep planning» have no field');
  assert.equal(q.options[0].other, undefined);
});

test('without a footer only a list under ❯ at the very bottom is a choice — not the input box, not Claude\'s own list', () => {
  const typed = ['⏺ Done.', '', RULE, '❯ 1. what I type in the box', RULE, '  ⏵⏵ auto mode on', ''].join('\n');
  assert.equal(screenQuestion(typed), null, 'words typed in the input box were read as a choice');
  const listed = ['⏺ What I did:', '', '  1. Fixed the screen', '  2. Added a test', ''].join('\n');
  assert.equal(screenQuestion(listed), null, 'Claude\'s numbered list was read as a choice');
  const status = ['⏺ Done.', '', RULE, '❯ 1. what I type', RULE, '                              CK-782 +2', ''].join('\n');
  assert.equal(screenQuestion(status), null, 'a status row standing right under the input box was read as an option');
  const far = [...PLAN.split('\n').slice(0, -3), 'one', 'two', 'three', 'four', ''].join('\n');
  assert.equal(screenQuestion(far), null, 'options with Claude\'s text under them were read as an open choice');
});

test('a question taller than the window is read from the history over it, at the width of its own rules', () => {
  const asked = ASKED.split('\n');
  const at = asked.indexOf('│ steps" stands at the bottom. What to do?');
  const long = Array.from({ length: 60 }, (_, k) => `│ point ${k + 1}`);
  const screen = ['an old line of a wider window', '─'.repeat(80), 'more of it', ...asked.slice(0, at + 1), '│', ...long, ...asked.slice(at + 1)].join('\n');
  const q = screenQuestion(screen);
  assert.ok(q.text.startsWith('CK-763 "the steps are pressed — nothing is seen, one has to scroll". As I read it:'),
    `the top of a tall question is lost, or wrapped at the width of an old rule: ${q.text.slice(0, 80)}`);
  assert.ok(q.text.endsWith('point 60'));
  assert.equal(q.text.split('\n').filter((l) => /^point /.test(l)).length, 60);
  assert.equal(q.tabs.length, 4, 'the tabs over a tall question are lost');
  assert.equal(q.cut, undefined, 'a question read whole says it is cut');
  // the window alone: the question goes over its top — the chat is told to read it again with the history
  const window = screen.split('\n').slice(-40).join('\n');
  assert.equal(screenQuestion(window).cut, true, 'a question cut at the top of the window does not say so');
  assert.equal(screenQuestion(ASKED).cut, undefined);
  assert.equal(q.ruled, true);
  // a question with no bar at the top of the window is not cut; history over it with a rule of the input box is not it
  const box = ['Ready.', RULE, '❯ ', RULE, '  ? for shortcuts', ' Do you want to make this edit?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel'].join('\n');
  assert.equal(screenQuestion(box.split('\n').slice(-5).join('\n')).cut, undefined, 'a short dialog at the top of the window asks for the history');
  assert.equal(screenQuestion(box).ruled, undefined, 'the rule of the input box was taken for the top of the dialog');
  // no rule within reach: only the block right over the options, not the conversation above
  const plain = ['⏺ old words', ...Array.from({ length: 250 }, (_, k) => `line ${k}`), '', 'Which one?', '', '❯ 1. This', '  2. That', '', 'Enter to select · Esc to cancel'].join('\n');
  assert.equal(screenQuestion(plain).text, 'Which one?');
});

// whole suite green
test('the chat reads a question cut at the top of the window again with the history over it, and only a ruled one', async () => {
  const asked = ASKED.split('\n');
  const at = asked.indexOf('│ steps" stands at the bottom. What to do?');
  const long = Array.from({ length: 60 }, (_, k) => `│ point ${k + 1}`);
  const history = ['an old line', ...asked.slice(0, at + 1), '│', ...long, ...asked.slice(at + 1)].join('\n');
  const window = history.split('\n').slice(-40).join('\n');
  let asks = 0;
  const q = await wholeChoice(window, async () => { asks += 1; return history; });
  assert.equal(asks, 1);
  assert.ok(q.text.startsWith('CK-763'), `the top of a tall question is lost: ${q.text.slice(0, 60)}`);
  assert.equal(q.tabs.length, 4);
  assert.equal('cut' in q || 'ruled' in q, false, 'the marks of reading go out to the page');
  // the history has no rule over the dialog — the window's own reading stays
  const bare = history.split('\n').filter((l) => !/^─+$/.test(l)).join('\n');
  const kept = await wholeChoice(window, async () => bare);
  assert.equal(kept.text, screenQuestion(window).text);
  // a question whole in the window asks nothing more; no capture — the window's reading
  asks = 0;
  assert.equal((await wholeChoice(ASKED, async () => { asks += 1; return ''; })).tabs.length, 4);
  assert.equal(asks, 0);
  assert.equal((await wholeChoice(window, async () => null)).text, screenQuestion(window).text);
  assert.equal(await wholeChoice('no question here', async () => history), null);
});
