// board's tmux (`capture-pane -e`), the status rows under the field and the session's name on its rule included.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearKeys, inField, promptBox, tallBox, undim } from '../src/prompt-box.js';

const SCREEN = [
  '❯ an earlier message in the conversation',
  '',
  '\x1b[38;5;244m─────────────────────────────────── GLA-328 ─',
  '\x1b[39m❯ ',
  '\x1b[38;5;244m─────────────────────────────────────────────',
  '\x1b[39m  \x1b[33m⬆ /gsd-update\x1b[38;5;246m │ \x1b[2mOpus 5.5 (1M context)\x1b[0m\x1b[38;5;246m │ \x1b[2m…\x1b[0m',
  '  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m',
  '',
  '  ⏺ main',
  '  ◯ general-purpose 26m 42s · ↓ 278.8k tokens',
];
const rows = (s) => s.map(undim);

test('an empty field is empty, whatever stands under it; the conversation\'s ❯ is not the field', () => {
  assert.deepEqual(promptBox(rows(SCREEN)), { text: '', rows: 1 });
});

test('the words of the field, over several rows; faint text (a suggestion, a placeholder) is not typed', () => {
  const typed = [...SCREEN.slice(0, 3), '❯ fix the flaky', '  test please', ...SCREEN.slice(4)];
  assert.deepEqual(promptBox(rows(typed)), { text: 'fix the flaky\ntest please', rows: 2 });
  const faint = [...SCREEN.slice(0, 3), '\x1b[39m❯ \x1b[2mTry "refactor <filepath>"\x1b[0m', ...SCREEN.slice(4)];
  assert.equal(promptBox(rows(faint)).text, '');
  // the numbers of a colour are not its faintness: 38;2;… is a colour, not "2"
  assert.equal(undim('\x1b[38;2;2;2;2mkept\x1b[0m'), 'kept');
});

test('a question in the field\'s place, or a field running past the bottom — no field', () => {
  assert.equal(promptBox(rows(['Do you want to proceed?', '❯ 1. Yes', '  2. No', '', 'Esc to cancel'])), null);
  assert.equal(promptBox(rows(SCREEN.slice(0, 4))), null);
});

test('the words are in the field however the screen wraps them; a folded paste and pictures count', () => {
  assert.equal(inField('fix the\nflaky test', 'fix the flaky test'), true);
  assert.equal(inField('fix the', 'fix the flaky test'), false);
  const long = 'x'.repeat(30) + 'y'.repeat(200) + 'z'.repeat(30);
  assert.equal(inField(`${'x'.repeat(30)}…${'z'.repeat(30)}`, long), true, 'a long message is known by its two ends');
  assert.equal(inField('[Pasted text #1 +30 lines]', 'a\n'.repeat(30)), true);
  assert.equal(inField('[Image #1] look', 'look', ['/d/a.png']), true);
  assert.equal(inField('/d/a.png look', 'look', ['/d/a.png']), true, 'a picture Claude Code may not read stays its path');
  assert.equal(inField('look', 'look', ['/d/a.png']), false);
  assert.equal(inField('', '', ['/d/a.png']), false);
});

test('the keys that empty the field reach every row of it, from anywhere', () => {
  const keys = clearKeys(3);
  assert.equal(keys.filter((k) => k === 'C-k').length, 14);
  assert.equal(keys.filter((k) => k === 'C-u').length, 14);
  assert.equal(keys.indexOf('C-u'), 14, 'the cut to the end goes first');
});

// between, grew it over the window's top — the window held only its bottom rows, the rule and the status rows.
test('a field taller than the window is read with the history over it, and only one ending in the window', () => {
  const field = ['\x1b[38;5;244m────────────────────────────── IB-475 ─', '\x1b[39m❯\u00a0',
    ...Array(12).fill(''), '  later finish it, pause', ...Array(39).fill(''), '  go on', '', '  how do I find out'];
  const under = ['\x1b[38;5;244m──────────────────────────────────────', '\x1b[39m  \x1b[33m⬆ /gsd-update\x1b[38;5;246m │ \x1b[2mOpus 5.5\x1b[0m',
    '  \x1b[38;5;220m⏵⏵ auto mode on\x1b[39m', '          \x1b[38;5;246mnew task? /clear to save 114.7k tokens\x1b[39m', '', ''];
  const all = rows(['⏺ The words of Claude', '', ...field, ...under]);
  const shown = 40;
  assert.equal(promptBox(all.slice(-shown)), null, 'the window alone has no field');
  const box = tallBox(all, shown);
  assert.equal(box.rows, field.length - 1);
  assert.match(box.text, /^later finish it, pause\n+go on\n\nhow do I find out$/);
  // the whole field in the window — promptBox reads it, tallBox leaves it to it; an old field all in the history
  assert.equal(tallBox(rows([...SCREEN]), SCREEN.length), null);
  const gone = rows([...SCREEN.slice(0, 5), ...Array(30).fill('  ⏺ later words')]);
  assert.equal(tallBox(gone, 30), null);
});
