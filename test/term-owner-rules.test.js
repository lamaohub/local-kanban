// refusal came only after a press. The page's rule (public/js/term-owner-rules.js, a leaf) says what the Terminal tab and
// the chat offer for a look; a tmux that did not say whose the terminal is keeps the field. Against real looks — the
// server's side — in test/terminal-silent.test.js; here the rule alone, and its words in the dictionary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NO_BOARD_LINE, OTHER_BOARD_LINE, otherBoardLine, otherBoardOf, termControls } from '../public/js/term-owner-rules.js';

const tr = (s) => `ru:${s}`; // a forgotten translation shows

test('another board\'s terminal is looked at, not managed: no field, no «Stop», no «Continue», no note that types', () => {
  const live = { session: 's1', dead: false, other: { port: 3922 } };
  assert.deepEqual(termControls(live), { field: false, stop: false, resume: false, notes: false, other: true });
  assert.deepEqual(termControls({ ...live, dead: true }), { field: false, stop: false, resume: false, notes: false, other: true });
  assert.equal(otherBoardLine(live, tr), `ru:${OTHER_BOARD_LINE} 3922`);
  // no board's address in it at all: nobody's — managed where it was started, no port to name
  const nobodys = { session: 's1', dead: false, other: { port: null } };
  assert.equal(otherBoardOf(nobodys), null);
  assert.equal(termControls(nobodys).field, false);
  assert.equal(otherBoardLine(nobodys, tr), `ru:${NO_BOARD_LINE}`);
});

test('the board\'s own terminal, and one tmux did not say about, keep the field and the buttons', () => {
  for (const other of [undefined, { port: null, silent: true }]) {
    const what = other ? 'a silent tmux' : 'its own';
    assert.deepEqual(termControls({ session: 's1', dead: false, other }), { field: true, stop: true, resume: false, notes: true, other: false }, what);
    assert.deepEqual(termControls({ session: 's1', dead: true, exit: 0, other }), { field: false, stop: true, resume: true, notes: true, other: false }, what);
    assert.equal(otherBoardOf({ session: 's1', other }), undefined, what);
    assert.equal(otherBoardLine({ session: 's1', other }, tr), '', what);
  }
  assert.deepEqual(termControls({ session: null }), { field: false, stop: false, resume: false, notes: false, other: false }, 'no terminal');
  assert.equal(otherBoardLine({ session: null }), '');
});

test('the words of another board\'s terminal are in the Russian dictionary', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const k of [OTHER_BOARD_LINE, NO_BOARD_LINE]) assert.ok(core.includes(`  '${k}': '`), `no translation of «${k}»`);
});
