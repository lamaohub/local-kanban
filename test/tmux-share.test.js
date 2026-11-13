// its own call to tmux (~70 ms each on the Mac, a process started on the main thread). Looks within a moment of each
// other share one call; anything the board does to a terminal (typing, a resize, a start, a stop) makes the next look a
// new one; an ended terminal is remembered until then. A fake tmux first on the PATH counts the calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = '11111111-2222-4333-8444-555555555555';
let dir, log, said, phantom, live, sessions;
const answer = (what) => writeFileSync(said, what);
const calls = () => readFileSync(log, 'utf8').split('\n').filter(Boolean);
const clear = () => writeFileSync(log, '');
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kb-share-'));
  process.env.KB_DATA_DIR = join(dir, 'data');
  process.env.KB_CLAUDE_DIR = join(dir, 'claude');
  process.env.KB_TMUX_SOCKET = `kb-share-${process.pid}`;
  mkdirSync(process.env.KB_CLAUDE_DIR);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  log = join(dir, 'calls');
  said = join(dir, 'answer');
  clear();
  writeFileSync(join(bin, 'tmux'), [
    '#!/bin/sh',
    `echo "$*" >> '${log}'`,
    // a view: the state, then the screen and the joined screen, each after the mark the board asked to be printed
    `case "$*" in *kb-cut-*) cut=$(echo "$*" | grep -o 'kb-cut-[0-9a-f-]*' | head -1); echo "0||120|4242|4141"; echo "$cut"; echo "a screen"; echo "$cut"; echo "a screen"; exit 0;; esac`,
    `case "$*" in *list-panes*) ;; *) exit 0;; esac`, // a resize or a key: done
    `case "$(cat '${said}')" in`,
    '  dead) echo "1|1|120|4242|4141";;',
    '  up) echo "0||120|4242|4141";;',
    'esac',
    '',
  ].join('\n'));
  chmodSync(join(bin, 'tmux'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;
  phantom = await import('../src/phantom.js');
  live = await import('../src/claude-live.js');
  sessions = await import('../src/claude-sessions.js');
});
after(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

test('looks at one session within a moment share one call to tmux, and each caller gets its own answer', async () => {
  answer('up');
  clear();
  const got = await Promise.all(Array.from({ length: 5 }, () => phantom.phantomPane(SID)));
  assert.equal(calls().length, 1, `five looks at once: ${calls().join(' / ')}`);
  assert.ok(got.every((g) => g.dead === false));
  got[0].dead = true;
  assert.equal(got[1].dead, false, 'one caller changed the answer of another');
  await phantom.phantomPane(SID);
  assert.equal(calls().length, 1, 'a look right after the answer asked tmux again');
  await pause(500);
  await phantom.phantomPane(SID);
  assert.equal(calls().length, 2, 'a look past the moment did not ask tmux');
});

test('anything the board does to a terminal makes the next look a new one', async () => {
  answer('up');
  await phantom.phantomPane(SID);
  clear();
  answer('dead');
  await phantom.phantomResize(SID, 80);
  assert.equal((await phantom.phantomPane(SID)).dead, true, 'the look after a resize was the one before it');
  assert.equal(calls().filter((c) => c.includes('list-panes')).length, 1);
});

test('an ended terminal of the board is remembered until the board does something to a terminal', async () => {
  sessions.markBoardSession(SID);
  answer('dead');
  await pause(450); // past the shared moment
  clear();
  const first = await live.boardPaneEnded(SID);
  assert.deepEqual(first, { exit: 1, interrupted: false });
  await pause(450);
  assert.deepEqual(await live.boardPaneEnded(SID), first);
  assert.equal(calls().length, 1, `an ended terminal was asked about again: ${calls().join(' / ')}`);
  answer('up');
  await phantom.phantomResize(SID, 80); // the board touched a terminal — «Continue» starts one the same way
  await pause(450);
  assert.equal(await live.boardPaneEnded(SID), null, 'a terminal started again still read as ended');
});

// The audit of 14.11.2026: the chat and the card's Terminal tab look at one session, and each look at the state of its pane
// was a `tmux list-panes` of its own beside the look at the whole view — 927 of them in 3 minutes under five tabs
test('a look at the pane takes the state from a look at the view of the same session in flight, never from an older one', async () => {
  answer('up');
  await pause(450);
  clear();
  const [view, pane] = await Promise.all([phantom.phantomView(SID), phantom.phantomPane(SID)]);
  assert.equal(view.screen, 'a screen');
  assert.equal(calls().length, 1, `a view and a pane at once: ${calls().join(' / ')}`);
  assert.equal(pane.dead, false);
  assert.equal(pane.cols, 120);
  assert.ok(!('screen' in pane), 'the pane carried the screen of the view');
  // a view already answered does not answer for the pane: typing and «Stop» look at the pane, and the session may have
  // been started anew since by another board
  await phantom.phantomPane(SID);
  assert.equal(calls().length, 2, 'a view already answered answered for the pane');
});
