// did not. Words left in Claude's field are cleared first; the board sees its words arrive before Enter, and see them go
// after it. Run against a stand-in of Claude Code's field (FIELD_SRC below) in a real tmux.
// Run: node --test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let TMUX = null;
for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) if (existsSync(p)) { TMUX = p; break; }
const skip = !TMUX && 'tmux is not installed';
const SOCKET = `kb-deliver-${process.pid}`;
// A stand-in for Claude Code's input field, drawn as Claude Code draws it (a rule, "❯ " and the words, a rule, a faint
// status row; a faint placeholder when empty), taking what tmux types: a bracketed paste (a paste that is the path of a
// picture becomes "[Image #N]", one of many lines "[Pasted text #N +M lines]", as Claude Code folds them), Ctrl+K, Ctrl+U
// and Enter. Every sent message is one JSON line in FAKE_LOG. FAKE_MODE: "nopaste" drops pastes, "noenter" ignores Enter.
// Kept here, not as a file of test/: node --test would run any .cjs there as a test.
const FIELD_SRC = String.raw`const fs = require('fs');
const mode = process.env.FAKE_MODE || '';
let buf = process.env.FAKE_START || '';
let paste = null;
let images = 0;
let folded = 0;
const sent = [];
function draw() {
  const rule = '\x1b[38;5;244m' + '─'.repeat(40) + '\x1b[39m';
  const field = buf ? buf.split('\n').join('\r\n  ') : '\x1b[2mTry "fix lint errors"\x1b[0m';
  const said = sent.map((x) => '❯ ' + x.replace(/\n/g, ' ') + '\r\n').join('');
  process.stdout.write('\x1b[2J\x1b[H' + said + rule + '\r\n❯ ' + field + '\r\n' + rule + '\r\n  \x1b[2mstatus\x1b[0m');
}
function key(ch) {
  if (ch === '\r') {
    if (mode === 'noenter') return;
    fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(buf) + '\n');
    sent.push(buf);
    buf = '';
  } else if (ch === '\x15') buf = buf.endsWith('\n') ? buf.slice(0, -1) : buf.slice(0, buf.lastIndexOf('\n') + 1);
  else if (ch !== '\x0b') buf += ch; // Ctrl+K: the caret is at the end, nothing after it
}
process.stdout.write('\x1b[?2004h'); // bracketed paste on, as Claude Code turns it on: else tmux pastes bare bytes
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  let s = d;
  while (s) {
    if (paste !== null) {
      const end = s.indexOf('\x1b[201~');
      if (end < 0) { paste += s; break; }
      paste += s.slice(0, end);
      s = s.slice(end + 6);
      const lines = paste.split('\n').length;
      if (mode !== 'nopaste') {
        if (/^\/\S.*\.(png|jpe?g|gif|webp)$/.test(paste.trim())) buf += '[Image #' + (++images) + '] ';
        else if (lines > 5) buf += '[Pasted text #' + (++folded) + ' +' + lines + ' lines]';
        else buf += paste;
      }
      paste = null;
    } else if (s.startsWith('\x1b[200~')) { paste = ''; s = s.slice(6); } else { key(s[0]); s = s.slice(1); }
  }
  draw();
});
draw();
`;
let tmp, phantom, FIELD, n = 0;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-deliver-'));
  FIELD = join(tmp, 'prompt-field.cjs');
  writeFileSync(FIELD, FIELD_SRC);
  Object.assign(process.env, { KB_DATA_DIR: tmp, KB_TMUX_SOCKET: SOCKET });
  phantom = await import('../src/phantom.js');
  phantom.setDeliverWait(1500);
});
after(() => {
  if (TMUX) { try { execFileSync(TMUX, ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' }); } catch { /* none left */ } }
  rmSync(join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`, SOCKET), { force: true });
  delete process.env.KB_TMUX_SOCKET;
  rmSync(tmp, { recursive: true, force: true });
});

/** A session of the board's socket with the stand-in field in it: {sid, sent()} — the messages it got. */
async function field(env = {}, cmd = null) {
  const sid = `0000000${++n}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
  const log = join(tmp, `${sid}.log`);
  const vars = Object.entries({ FAKE_LOG: log, ...env }).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  execFileSync(TMUX, ['-L', SOCKET, 'new-session', '-d', '-s', `kb-${sid}`, '-x', '60', '-y', '20', ...vars, ...(cmd || [process.execPath, FIELD])]);
  const start = Date.now();
  while (cmd === null && !execFileSync(TMUX, ['-L', SOCKET, 'capture-pane', '-p', '-t', `=kb-${sid}:`]).toString().includes('status')) {
    if (Date.now() - start > 15000) throw new Error('the stand-in did not draw its field');
    await new Promise((r) => { setTimeout(r, 50); });
  }
  return { sid, sent: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

test('words left in Claude\'s field are cleared before the chat\'s words, which go alone', { skip }, async () => {
  const f = await field({ FAKE_START: 'half typed\nin the terminal' });
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: 'the chat\'s words' }), { err: null });
  assert.deepEqual(f.sent(), ['the chat\'s words'], 'the words went glued to what was left in the field');
});

test('pictures go first, each as one; a long message goes whole', { skip }, async () => {
  const f = await field();
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: 'what is on them', images: ['/d/a.png', '/d/b.png'] }), { err: null });
  const long = Array.from({ length: 30 }, (_, i) => `line ${i} of a long message`).join('\n');
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: long }), { err: null });
  assert.deepEqual(f.sent(), ['[Image #1] [Image #2] what is on them', '[Pasted text #1 +30 lines]']);
});

test('words that never show in the field are not sent, and the field is emptied', { skip }, async () => {
  const f = await field({ FAKE_MODE: 'nopaste' });
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: 'lost' }), { refused: 'not-typed' });
  assert.deepEqual(f.sent(), [], 'Enter went with no words in the field');
});

test('words Enter does not send are said to be in the field', { skip }, async () => {
  const f = await field({ FAKE_MODE: 'noenter' });
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: 'stuck' }), { refused: 'not-sent' });
});

test('words left in a field taller than the window are cleared too, and the chat\'s words go (CK-890)', { skip }, async () => {
  // 30 rows of a field in a window of 20: its "❯" row is over the window's top, in the history
  const f = await field({ FAKE_START: ['left', ...Array(26).fill(''), 'over', '', 'the top'].join('\n') });
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: 'the chat\'s words' }), { err: null });
  assert.deepEqual(f.sent(), ['the chat\'s words']);
  assert.equal(await phantom.fieldEmpty(f.sid), true);
});

test('no field on the screen — nothing is typed', { skip }, async () => {
  const f = await field({}, ['sleep', '30']);
  assert.deepEqual(await phantom.deliverChat(f.sid, { text: 'to nobody' }), { refused: 'no-box' });
});
