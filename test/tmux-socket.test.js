import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dropSocket, ownSocket, socketDir, staleSockets } from './tmux-socket.js';

const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p)); // the helper's own, spelled out for test/bin-path.test.js

const skip = !TMUX && 'no tmux on this machine';
let dir, saved;
before(() => {
  saved = process.env.TMUX_TMPDIR;
  dir = mkdtempSync('/tmp/kb-ts-'); // short: a socket path over 103 bytes (tmpdir() resolves to /private/var/folders/…) is refused
  process.env.TMUX_TMPDIR = dir;
});
after(() => {
  for (const s of (() => { try { return readdirSync(socketDir()); } catch { return []; } })()) dropSocket(s);
  if (saved === undefined) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid;
const serve = (socket) => execFileSync(TMUX, ['-L', socket, 'new-session', '-d', '-s', 'x', 'sleep 60'], { stdio: 'ignore' });
const alive = (socket) => { try { execFileSync(TMUX, ['-L', socket, 'has-session'], { stdio: 'ignore' }); return true; } catch { return false; } };

test('dropSocket kills the server and removes the file kill-server leaves behind', { skip }, () => {
  const s = `kb-sock-probe-${process.pid}`;
  serve(s);
  dropSocket(s);
  assert.equal(alive(s), false);
  assert.equal(existsSync(join(socketDir(), s)), false, 'the socket file stayed');
});

test("a later run takes away a dead run's server and file, and leaves a live run alone", { skip }, () => {
  const dead = `kb-sock-${deadPid()}`;
  const deadFile = `kb-sock-${deadPid()}`;
  const live = `kb-sock-${process.ppid}`; // a parallel run of the same test: its process is alive
  const other = `kb-sock-other-${deadPid()}`; // another test's prefix
  for (const s of [dead, live, other]) serve(s);
  writeFileSync(join(socketDir(), deadFile), ''); // a file without a server: a run that did kill its server
  assert.deepEqual(staleSockets('kb-sock').sort(), [dead, deadFile].sort());
  const mine = ownSocket('kb-sock');
  assert.equal(mine, `kb-sock-${process.pid}`);
  assert.equal(alive(dead), false, "a dead run's server lived on");
  assert.equal(existsSync(join(socketDir(), dead)), false);
  assert.equal(existsSync(join(socketDir(), deadFile)), false, "a dead run's file stayed");
  assert.ok(alive(live), "a live run's server was killed");
  assert.ok(alive(other), "another test's server was killed");
});

test('the socket of a run goes when its process exits, even without `after`', { skip }, () => {
  const helper = new URL('./tmux-socket.js', import.meta.url).href;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { execFileSync } from 'node:child_process';
    const { TMUX, ownSocket } = await import(${JSON.stringify(helper)});
    const s = ownSocket('kb-sock-exit');
    execFileSync(TMUX, ['-L', s, 'new-session', '-d', '-s', 'x', 'sleep 60']);
    console.log(s);
    process.exit(1);`], { encoding: 'utf8', env: process.env });
  const s = r.stdout.trim();
  assert.equal(r.status, 1, r.stderr);
  assert.match(s, /^kb-sock-exit-\d+$/);
  assert.equal(alive(s), false, 'the server of a run outlived it');
  assert.equal(existsSync(join(socketDir(), s)), false, 'the socket file of a run outlived it');
});
