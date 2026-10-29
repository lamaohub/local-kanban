import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SID = '6a6e0000-0000-4000-8000-000000000546';
let dir, said, phantom, live, sessions;
const answer = (what) => writeFileSync(said, what);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'kb-pane-'));
  process.env.KB_DATA_DIR = dir;
  process.env.KB_TMUX_SOCKET = `kb-pane-test-${process.pid}`;
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  said = join(dir, 'answer');
  writeFileSync(join(bin, 'tmux'), [
    '#!/bin/sh',
    `case "$(cat '${said}')" in`,
    "  gone) echo \"can't find session: =kb-x\" >&2; exit 1;;",
    '  noserver) echo "error connecting to /tmp/tmux-1/kb-x (No such file or directory)" >&2; exit 1;;',
    // a tmux that did not answer in time: the board's call to it is killed (execFile's timeout), with no word of tmux
    '  late) kill -TERM $$;;',
    '  exiting) echo "lost server" >&2; exit 1;;',
    '  dead) echo "1|1|120|4242|4141";;',
    '  up) echo "0||120|4242|4141";;',
    `  chain) case "$*" in *list-panes*) echo "kb-${SID}|0";; *) echo "can't find pane: kb-x" >&2; exit 1;; esac;;`,
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

test('the pane of a board session is gone only on tmux\'s own word — a tmux that did not answer says nothing', async () => {
  answer('gone');
  assert.equal(await phantom.phantomPane(SID), null);
  answer('noserver');
  assert.equal(await phantom.phantomPane(SID), null);
  answer('late');
  assert.deepEqual(await phantom.phantomPane(SID), { dead: false, unknown: true }, 'a tmux that did not answer reads as no pane');
  answer('exiting');
  assert.equal(await phantom.phantomPane(SID), null, 'a tmux server on its way out read as one that did not answer');
  answer('dead');
  assert.equal((await phantom.phantomPane(SID)).dead, true);
  answer('up');
  assert.equal((await phantom.phantomPane(SID)).dead, false);
});

test('a fresh board start is not "session closed" while tmux does not answer — and is, once tmux says the session is not there', async () => {
  sessions.markBoardSession(SID);
  const cases = { late: false, up: false, gone: true, noserver: true, dead: true };
  for (const [what, gone] of Object.entries(cases)) {
    answer(what);
    assert.equal(await live.boardPaneGone(SID), gone, `tmux answering "${what}"`);
  }
});

// on that one look and rang again on the next. Such a look says `failed` — the watch keeps its last picture (claude-live);
// tmux's own word that there is no server is still "no terminals".
test('a look whose capture tmux failed says so, and is not read as screens with nothing on them', async () => {
  sessions.markBoardSession(SID);
  answer('chain');
  assert.equal((await phantom.boardLook()).failed, true, 'a failed capture of the screens reads as nothing on them');
  answer('late');
  assert.equal((await phantom.boardLook()).failed, true, 'a list of panes tmux did not give reads as no terminals');
  answer('noserver');
  const none = await phantom.boardLook();
  assert.deepEqual([none.failed, none.live], [undefined, []], 'no server of tmux is no terminals, not a failed look');
});
