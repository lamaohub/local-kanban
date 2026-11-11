// `tmux kill-server` leaves the socket file behind (tmux 3.5a on macOS), so a test that only killed its server
// left a file per run (252 of acceptance-terminal), and a run cut off before `after` (a timeout, ^C) left its server
// alive for days. The name carries the pid of the run: a later run of the same test gets rid of the server and file
// of every earlier run whose process is gone — through that socket only (`tmux -L <name> kill-server`), never by
// a process name.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));

/** The folder tmux keeps its sockets in, as tmux itself picks it. */
export const socketDir = () => join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid()}`);

const gone = (pid) => {
  try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
};

/** Kill the server on `socket` and remove its file; nothing there is fine. */
export function dropSocket(socket) {
  if (TMUX) { try { execFileSync(TMUX, ['-L', socket, 'kill-server'], { stdio: 'ignore', timeout: 5000 }); } catch { /* no server */ } }
  rmSync(join(socketDir(), socket), { force: true });
}

/** Sockets `<prefix>-<pid>` of runs whose process is gone; a live pid (this run, a parallel one) is not touched. */
export function staleSockets(prefix) {
  let names;
  try { names = readdirSync(socketDir()); } catch { return []; }
  const own = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d+)$`);
  return names.filter((n) => { const m = own.exec(n); return m && Number(m[1]) !== process.pid && gone(Number(m[1])); });
}

/** `<prefix>-<pid>` for this run: the leftovers of earlier runs go first, this one goes when the process exits. */
export function ownSocket(prefix) {
  for (const s of staleSockets(prefix)) dropSocket(s);
  const socket = `${prefix}-${process.pid}`;
  process.once('exit', () => dropSocket(socket));
  return socket;
}
