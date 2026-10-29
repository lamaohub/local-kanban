// `kb statusline` in front of the person's own, and the PermissionRequest hook `kb hook permission` — shows the
// change, asks, keeps the previous settings.json in the board's snapshots, and takes off only what it added.
// Every run of the real command here points the Claude folder (KB_CLAUDE_DIR, CLAUDE_CONFIG_DIR, HOME) at a
// temporary directory: the settings of whoever runs the tests are never read or written.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardPorts, chainStatusLine, entryPort, formatLike, HOOK_TIMEOUT_S, hookCommand, isOurs, kbCommand, nodeOnPath, otherBoard, planInstall, planUninstall, shellWord } from '../src/claude-hooks.js';

const CLI = fileURLToPath(new URL('../bin/local-kanban', import.meta.url));
const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const KBC = '/usr/local/bin/node /opt/local-kanban/bin/kb';
// what the owner of this board had: a PreToolUse hook of another tool and a status line of their own
const OWNER = {
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'rtk-rewrite.sh' }] }] },
  statusLine: { type: 'command', command: 'node "/home/user/.claude/hooks/my-statusline.js"', padding: 1 },
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
};
let tmp;

before(() => { tmp = mkdtempSync(join(tmpdir(), 'kb-hooks-')); });
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('install puts the board in front of the status line and adds the hook; nothing else moves', () => {
  const { settings: s, changes } = planInstall(OWNER, KBC);
  assert.equal(s.statusLine.command, `{ ${KBC} statusline 2>/dev/null || cat; } | {\nnode "/home/user/.claude/hooks/my-statusline.js"\n}`);
  assert.equal(s.statusLine.padding, 1, 'a field of the status line was lost');
  assert.deepEqual(s.hooks.PreToolUse, OWNER.hooks.PreToolUse, 'a foreign hook changed');
  assert.deepEqual(s.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(KBC), timeout: HOOK_TIMEOUT_S }] }]);
  assert.equal(HOOK_TIMEOUT_S, 1800, 'the hook must be allowed to wait 30 minutes for the board');
  assert.deepEqual([s.model, s.permissions], [OWNER.model, OWNER.permissions]);
  assert.deepEqual(changes.map((c) => [c.part, c.action]), [['statusLine', 'chain'], ['PermissionRequest', 'add']]);
  assert.equal(OWNER.statusLine.command, 'node "/home/user/.claude/hooks/my-statusline.js"', 'the input object was changed in place');
  // with no status line of the person's own, kb prints a short line itself
  const bare = planInstall({}, KBC).settings;
  assert.deepEqual(bare.statusLine, { type: 'command', command: `${KBC} statusline --line` });
});

test('install twice changes nothing the second time', () => {
  const once = planInstall(OWNER, KBC).settings;
  const twice = planInstall(once, KBC);
  assert.deepEqual(twice.settings, once);
  assert.deepEqual(twice.changes.map((c) => c.action), ['already', 'already']);
});

test('uninstall gives back exactly what was there', () => {
  for (const original of [OWNER, {}, { statusLine: { type: 'command', command: 'a | b', refreshInterval: 5 } },
    { hooks: { PermissionRequest: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'my-approver' }] }] } },
    { statusLine: { type: 'command', command: 'cd ~/x && ./line.sh # mine' } }]) {
    const installed = planInstall(original, KBC).settings;
    assert.deepEqual(planUninstall(installed).settings, original, JSON.stringify(original));
  }
  // the board's hook sharing a group with a foreign one: only the board's leaves
  const shared = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'other' }, { type: 'command', command: `${KBC} hook permission` }] }] } };
  assert.deepEqual(planUninstall(shared).settings, { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'other' }] }] } });
  assert.deepEqual(planUninstall(OWNER).changes, [], 'uninstall took something that was never the board\'s');
  // written by hand the plain way: what follows the pipe is theirs
  assert.deepEqual(planUninstall({ statusLine: { type: 'command', command: 'kb statusline | mine' } }).settings, { statusLine: { type: 'command', command: 'mine' } });
});

test('install again with other paths rewrites the board\'s entries and nothing else', () => {
  const OLD = '/opt/homebrew/Cellar/node/24.1.0/bin/node /old/place/bin/kb';
  const first = planInstall(OWNER, OLD).settings;
  const { settings: again, changes } = planInstall(first, KBC);
  assert.deepEqual(changes.map((c) => [c.part, c.action]), [['statusLine', 'update'], ['PermissionRequest', 'update']],
    'a re-install reported "already" and left the old node in place');
  assert.equal(again.statusLine.command, chainStatusLine(KBC, OWNER.statusLine.command));
  assert.equal(again.statusLine.padding, 1);
  assert.deepEqual(again.hooks.PermissionRequest, [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand(KBC), timeout: HOOK_TIMEOUT_S }] }]);
  assert.deepEqual(again.hooks.PreToolUse, OWNER.hooks.PreToolUse);
  assert.deepEqual(planUninstall(again).settings, OWNER, 'after the rewrite uninstall no longer gives the settings back');
  // `--line`, a hand-written `kb statusline | theirs`, a hook with a shorter timeout — brought up to date the same way
  assert.equal(planInstall({ statusLine: { type: 'command', command: `${OLD} statusline --line` } }, KBC).settings.statusLine.command, `${KBC} statusline --line`);
  assert.equal(planInstall({ statusLine: { type: 'command', command: 'kb statusline | mine' } }, KBC).settings.statusLine.command, chainStatusLine(KBC, 'mine'));
  const short = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'other' }, { type: 'command', command: `${KBC} hook permission`, timeout: 60 }] }] } };
  assert.deepEqual(planInstall(short, KBC).settings.hooks.PermissionRequest[0].hooks,
    [{ type: 'command', command: 'other' }, { type: 'command', command: hookCommand(KBC), timeout: HOOK_TIMEOUT_S }]);
});

test('the person\'s status line keeps all of its input, whatever shape its command has', () => {
  const input = JSON.stringify({ model: { id: 'x' } });
  const kb = kbCommand({ node: process.execPath, kb: KB });
  for (const theirs of ['cd / && cat', 'input=$(cat); printf "got:%s" "$input"', 'cat # my status line', 'cat |\n  cat']) {
    const command = planInstall({ statusLine: { type: 'command', command: theirs } }, kb).settings.statusLine.command;
    const out = execFileSync('/bin/sh', ['-c', command], { input, env: { ...process.env, KB_URL: 'http://127.0.0.1:9' } }).toString();
    assert.equal(out, theirs.startsWith('input') ? `got:${input}` : input, theirs);
  }
  // kb cannot run at all — the node it was written with went away in an upgrade: the JSON still gets through
  const orphan = planInstall({ statusLine: { type: 'command', command: 'cat' } }, kbCommand({ node: '/nonexistent/bin/node', kb: KB })).settings.statusLine.command;
  assert.equal(execFileSync('/bin/sh', ['-c', orphan], { input }).toString(), input);
});

test('node is written by the PATH entry that outlives an upgrade', () => {
  const CELLAR = '/opt/homebrew/Cellar/node/24.9.0/bin/node';
  const real = { [CELLAR]: CELLAR, '/opt/homebrew/bin/node': CELLAR, 'relative/bin/node': CELLAR, '/usr/local/bin/node': '/usr/local/Cellar/node/20.1.0/bin/node' };
  const realpath = (p) => { if (!Object.hasOwn(real, p)) throw new Error(`ENOENT ${p}`); return real[p]; };
  assert.equal(nodeOnPath({ execPath: CELLAR, PATH: 'relative/bin:/usr/local/bin:/opt/homebrew/bin/', realpath }), '/opt/homebrew/bin/node');
  // no PATH entry leads to the running node (nvm, a node started by its full path): its own path it is
  const NVM = '/home/user/.nvm/versions/node/v24.9.0/bin/node';
  assert.equal(nodeOnPath({ execPath: NVM, PATH: '/usr/local/bin:/opt/homebrew/bin', realpath: (p) => (p === NVM ? p : realpath(p)) }), NVM);
  assert.equal(nodeOnPath({ execPath: '/gone/node', PATH: '/opt/homebrew/bin', realpath }), '/gone/node');
});

test('settings it does not understand are left as they are', () => {
  for (const odd of [{ statusLine: { type: 'static', text: 'x' } }, { statusLine: { type: 'command', command: '' } }]) {
    const { settings, changes } = planInstall(odd, KBC);
    assert.deepEqual(settings.statusLine, odd.statusLine);
    assert.equal(changes[0].action, 'skip');
  }
  const weird = planInstall({ hooks: 'nope' }, KBC);
  assert.equal(weird.settings.hooks, 'nope');
  assert.equal(weird.changes[1].action, 'skip');
});

// and Disconnect wrote back `| cat; } | {…}`: the shell refused it and the person's status line went blank. A chain put
// on one line was not known at all: Disconnect deleted the status line with the person's command in it, and Connect
// called it connected whatever paths it had.
test('a chain edited by hand comes off whole, and one the board cannot take apart is left as it is', () => {
  const theirs = 'node "/home/user/.claude/hooks/my-statusline.js"';
  for (const command of [
    `{ ${KBC} statusline || cat; } | {\n${theirs}\n}`, // 2>/dev/null taken out
    `{  ${KBC} statusline 2>/dev/null  ||  cat ;  }  |  {\n${theirs}\n}`, // other spaces
    `${KBC} statusline 2>/dev/null | ${theirs}`, // by hand, one pipe
  ]) {
    const off = planUninstall({ statusLine: { type: 'command', command, padding: 1 } });
    assert.deepEqual(off.settings.statusLine, { type: 'command', command: theirs, padding: 1 }, command);
    assert.equal(planInstall({ statusLine: { type: 'command', command } }, KBC).changes[0].action, 'update', `not brought to the board's own form: ${command}`);
  }
  const oneLine = `{ ${KBC} statusline 2>/dev/null || cat; } | { ${theirs}; }`;
  const hook = { matcher: '*', hooks: [{ type: 'command', command: `${KBC} hook permission`, timeout: HOOK_TIMEOUT_S }] };
  const odd = { ...OWNER, statusLine: { type: 'command', command: oneLine }, hooks: { ...OWNER.hooks, PermissionRequest: [hook] } };
  const off = planUninstall(odd);
  assert.deepEqual(off.settings.statusLine, odd.statusLine, 'a chain the board cannot take apart was changed or deleted');
  assert.deepEqual(off.changes.find((c) => c.part === 'statusLine'), { part: 'statusLine', action: 'skip', ours: true });
  assert.deepEqual(off.settings.hooks, OWNER.hooks, 'the hook did not come off next to the status line left alone');
  const on = planInstall(odd, KBC);
  assert.deepEqual(on.changes.find((c) => c.part === 'statusLine'), { part: 'statusLine', action: 'skip', ours: true }, 'called connected');
  assert.deepEqual(on.settings.statusLine, odd.statusLine);
  // one line and no 2>/dev/null either: the `||` is still not where the person's command starts
  const bare = `{ ${KBC} statusline || cat; } | { ${theirs}; }`;
  assert.deepEqual(planUninstall({ statusLine: { type: 'command', command: bare } }).settings.statusLine, { type: 'command', command: bare });
  // kb on its own — bare or --line — holds nothing of the person's: it comes off whole
  for (const command of [`KB_URL=http://127.0.0.1:3101 ${KBC} statusline`, `${KBC} statusline --line`]) {
    assert.equal(planUninstall({ statusLine: { type: 'command', command } }).settings.statusLine, undefined, command);
  }
  // kb at the end of the person's own list is not kb on its own: taking it off whole took their part along
  for (const command of [`cd /home/user/x && ${KBC} statusline --line`, `node /home/user/pre.js; ${KBC} statusline`]) {
    const keep = planUninstall({ statusLine: { type: 'command', command } });
    assert.deepEqual(keep.settings.statusLine, { type: 'command', command }, `taken off with the person's part: ${command}`);
    assert.deepEqual(keep.changes, [{ part: 'statusLine', action: 'skip', ours: true }], command);
  }
});

// upgrade — made a failing hook: Claude Code still asks in its own window, but prints "PermissionRequest hook error …"
// on every request, until the person cleans settings.json by hand. The command now checks that node and kb are there
// and is quiet otherwise; when they are, `exec` gives kb the shell's place — the process Claude Code stops when the
// person answers in its own window. Behind a bare `|| true` the shell would stay kb's parent and kb would live on.
test('a hook whose node or kb is gone keeps quiet, and kb takes the shell\'s place when they are there', () => {
  const dir = mkdtempSync(join(tmp, 'gone-'));
  const node = join(dir, 'node');
  writeFileSync(node, '#!/bin/sh\necho "pid=$$ url=$KB_URL args=$*"\n');
  chmodSync(node, 0o755);
  const kb = join(dir, 'kb');
  writeFileSync(kb, '');
  const input = JSON.stringify({ hook_event_name: 'PermissionRequest', session_id: 'x' });
  const shells = ['/bin/sh', '/bin/dash', '/bin/bash'].filter((p) => existsSync(p));
  for (const sh of shells) {
    for (const [what, k] of [['node', kbCommand({ node: join(dir, 'gone', 'node'), kb })], ['kb', kbCommand({ node, kb: join(dir, 'gone', 'kb') })]]) {
      const r = spawnSync(sh, ['-c', hookCommand(k)], { input });
      assert.deepEqual([r.status, r.stdout.toString(), r.stderr.toString()], [0, '', ''], `${sh}: the hook with its ${what} gone is not quiet`);
    }
    const r = spawnSync(sh, ['-c', `echo outer=$$; ${hookCommand(kbCommand({ node, kb, url: 'http://127.0.0.1:3101' }))}`], { input });
    const [outer, inner = ''] = r.stdout.toString().trim().split('\n');
    assert.equal(inner.match(/pid=(\d+)/)?.[1], outer.match(/outer=(\d+)/)?.[1], `${sh}: kb runs under the shell instead of in its place`);
    assert.match(inner, /url=http:\/\/127\.0\.0\.1:3101 args=.*\/kb hook permission$/, `${sh}: kb did not get its address or its words`);
  }
  assert.ok(shells.length >= 1);
  // still the board's own hook, known and taken off like the plain one
  assert.ok(isOurs(hookCommand(KBC), 'hook'));
  assert.deepEqual(planUninstall(planInstall({}, KBC).settings).settings, {}, 'the guarded hook does not come off');
  assert.equal(hookCommand('kb'), 'kb hook permission', 'a kb not in the board\'s own form is not passed through as it is');
  const plain = { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `${KBC} hook permission`, timeout: HOOK_TIMEOUT_S }] }] } };
  const up = planInstall(plain, KBC).changes.find((c) => c.part === 'PermissionRequest');
  assert.deepEqual([up.action, up.older, up.to], ['update', true, hookCommand(KBC)]);
  const moved = planInstall(plain, kbCommand({ node: '/usr/local/bin/node', kb: '/home/user/elsewhere/bin/kb' })).changes.find((c) => c.part === 'PermissionRequest');
  assert.deepEqual([moved.action, moved.older], ['update', undefined], 'a kb that moved is called only older');
});

test('the board recognises its own commands, written any way', () => {
  for (const c of ['kb statusline', 'kb statusline --line', `${KBC} statusline | x`, chainStatusLine(KBC, 'x'), `'/a b/bin/kb' statusline`, 'KB_URL=http://127.0.0.1:3200 node /x/kb statusline']) assert.ok(isOurs(c, 'statusline'), c);
  for (const c of ['kbx statusline', 'node my-kb-statusline.js', 'statusline kb']) assert.ok(!isOurs(c, 'statusline'), c);
  assert.ok(isOurs(`"/a/bin/kb" hook permission`, 'hook'));
  assert.ok(!isOurs('kb hook other', 'hook'));
});

// other paths (the board or Node moved)". kb is given its board's address (KB_URL=…; none written — the default port),
// and the port is what tells two boards apart on this machine.
test('the board\'s entries tell which board they speak to', () => {
  assert.equal(entryPort('KB_URL=http://127.0.0.1:3101 /n /kb statusline'), 3101);
  assert.equal(entryPort('/n /kb hook permission'), 3100, 'no address written is not the default board');
  assert.equal(entryPort("KB_URL='http://127.0.0.1:3102/' '/a b/n' /kb hook permission"), 3102);
  assert.equal(entryPort(hookCommand(kbCommand({ node: '/n', kb: '/kb', url: 'http://localhost:3103' }))), 3103);
  assert.equal(entryPort('KB_URL=nonsense /n /kb statusline'), null);
  const sandbox = planInstall(OWNER, kbCommand({ node: '/n', kb: '/kb', url: 'http://127.0.0.1:3101' })).settings;
  assert.deepEqual(boardPorts(sandbox), [3101]);
  assert.equal(otherBoard(sandbox, 3100), 'http://127.0.0.1:3101', 'the board on 3100 does not see that another board holds the entries');
  assert.equal(otherBoard(sandbox, 3101), null, 'the board that holds the entries called another one');
  assert.equal(otherBoard(planInstall(OWNER, KBC).settings, 3101), 'http://127.0.0.1:3100');
  assert.equal(otherBoard(OWNER, 3100), null, 'no entries of the board, and still another board');
});

test('paths with spaces and quotes reach the shell as they are', () => {
  for (const p of ['/Users/a b/node', "/opt/it's/kb", '/plain/path/kb', '/x/$HOME/`id`/kb']) {
    assert.equal(execFileSync('/bin/sh', ['-c', `printf '%s' ${shellWord(p)}`]).toString(), p);
  }
  assert.equal(kbCommand({ node: '/n', kb: '/k', url: 'http://127.0.0.1:3200' }), 'KB_URL=http://127.0.0.1:3200 /n /k');
  assert.equal(kbCommand({ node: '/n', kb: '/k' }), '/n /k');
});

// uninstall the same in meaning but not byte for byte
test('the settings file keeps its layout: indent, line ends, the last newline', () => {
  const v = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x' }] }] }, list: [] };
  for (const [indent, eol, last] of [[2, '\n', true], [4, '\n', true], ['\t', '\n', true], [4, '\n', false], [2, '\r\n', true], [3, '\r\n', false]]) {
    let text = JSON.stringify(v, null, indent);
    if (eol !== '\n') text = text.replace(/\n/g, eol);
    if (last) text += eol;
    assert.equal(formatLike(text, v), text, JSON.stringify({ indent, eol, last }));
  }
  // everything on one line stays on one line
  assert.equal(formatLike('{"model":"opus"}', { model: 'opus' }), '{"model":"opus"}');
  assert.equal(formatLike('{"model":"opus"}\n', { model: 'opus', x: 1 }), '{"model":"opus","x":1}\n');
  // nothing to go by: two spaces and a newline, as Claude Code writes it
  assert.equal(formatLike('', { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(formatLike(undefined, { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(formatLike('{}\n', { a: 1 }), '{\n  "a": 1\n}\n');
  assert.equal(formatLike('{}', {}), '{}');
  // a newline inside a value is written escaped, never turned into a line end of the file
  assert.equal(formatLike('{\r\n  "a": 1\r\n}\r\n', { a: 'one\ntwo' }), '{\r\n  "a": "one\\ntwo"\r\n}\r\n');
});

// backups of the board the command asks for its data folder — here it is named (--data), so no board is asked (the
// default address is a real board on the machine that runs the tests)
function cli(args, dir, extra = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args, '--data', extra.KB_DATA_DIR ?? join(dir, 'data')], {
      env: { ...process.env, KB_CLAUDE_DIR: dir, CLAUDE_CONFIG_DIR: dir, HOME: dir, KB_DATA_DIR: join(dir, 'data'), KB_URL: '', ...extra },
    }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
}
const fresh = (settings) => {
  const dir = mkdtempSync(join(tmp, 'claude-'));
  if (settings !== undefined) writeFileSync(join(dir, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  return dir;
};
const read = (dir) => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));

test('local-kanban hooks install shows the change, writes it with --yes, keeps the previous file', async () => {
  const dir = fresh(OWNER);
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const dry = await cli(['hooks', 'install'], dir); // no terminal, no --yes: shown, not written
  assert.equal(dry.code, 0, dry.stderr);
  assert.match(dry.stdout, /statusLine/);
  assert.match(dry.stdout, /PermissionRequest/);
  assert.match(dry.stdout, /--yes/);
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), before, 'written without consent');
  const r = await cli(['hooks', 'install', '--yes'], dir);
  assert.equal(r.code, 0, r.stderr);
  const s = read(dir);
  assert.ok(isOurs(s.statusLine.command, 'statusline') && s.statusLine.command.endsWith('| {\nnode "/home/user/.claude/hooks/my-statusline.js"\n}'));
  assert.ok(s.statusLine.command.includes(KB), 'kb is not called by its absolute path');
  assert.deepEqual(s.hooks.PreToolUse, OWNER.hooks.PreToolUse);
  const snaps = readdirSync(join(dir, 'data', 'backups', 'claude-settings'));
  assert.equal(snaps.length, 1, 'no copy of the previous file');
  assert.equal(readFileSync(join(dir, 'data', 'backups', 'claude-settings', snaps[0]), 'utf8'), before);
  assert.match(snaps[0], /^settings-.*\.json$/, 'the copy of settings.json is not named as a .json file');
  assert.match(r.stdout, new RegExp(snaps[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'the output does not say where the copy is');
  const off = await cli(['hooks', 'uninstall', '--yes'], dir);
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual(read(dir), OWNER, 'uninstall did not give the settings back');
});

test('install and uninstall give back a settings.json kept in another style byte for byte', async () => {
  for (const [indent, eol] of [[4, '\n'], ['\t', '\n'], [2, '\r\n']]) {
    let text = JSON.stringify(OWNER, null, indent);
    if (eol !== '\n') text = text.replace(/\n/g, eol);
    for (const original of [text, text + eol]) {
      const dir = fresh(original);
      const on = await cli(['hooks', 'install', '--yes'], dir);
      assert.equal(on.code, 0, on.stderr);
      const installed = readFileSync(join(dir, 'settings.json'), 'utf8');
      assert.ok(isOurs(JSON.parse(installed).statusLine.command, 'statusline'));
      assert.ok(installed.includes(`${eol}${typeof indent === 'number' ? ' '.repeat(indent) : indent}"statusLine"`), `the installed file lost its indent: ${JSON.stringify(installed.slice(0, 40))}`);
      const off = await cli(['hooks', 'uninstall', '--yes'], dir);
      assert.equal(off.code, 0, off.stderr);
      assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), original, `not given back byte for byte: indent ${JSON.stringify(indent)}, ${JSON.stringify(eol)}, last newline ${original.endsWith(eol)}`);
    }
  }
});

test('a settings file that is not JSON is not touched; a missing one is created', async () => {
  const dir = fresh('{ "statusLine": ');
  const r = await cli(['hooks', 'install', '--yes'], dir);
  assert.equal(r.code, 1);
  assert.equal(readFileSync(join(dir, 'settings.json'), 'utf8'), '{ "statusLine": ');
  const empty = fresh();
  const made = await cli(['hooks', 'install', '--yes', '--port', '3200'], empty);
  assert.equal(made.code, 0, made.stderr);
  const s = read(empty);
  assert.ok(s.statusLine.command.startsWith('KB_URL=http://127.0.0.1:3200 '), 'a board on another port would not be found');
  assert.ok(!existsSync(join(empty, 'data', 'backups', 'claude-settings')), 'a copy of a file that did not exist');
  // the default address is kb's own: it is not written into the command, however KB_URL spells it
  const plain = fresh();
  assert.equal((await cli(['hooks', 'install', '--yes'], plain, { KB_URL: 'http://127.0.0.1:3100/' })).code, 0);
  assert.ok(!read(plain).statusLine.command.includes('KB_URL='), 'the default address was written into the command');
});

test('what install writes actually runs: the status line passes the JSON on to the person\'s own', async () => {
  const dir = fresh({ statusLine: { type: 'command', command: 'cat' } });
  assert.equal((await cli(['hooks', 'install', '--yes'], dir)).code, 0);
  const s = read(dir);
  const input = JSON.stringify({ model: { id: 'x' } });
  // the board is not running: kb must still pass the JSON on, and quickly
  const out = execFileSync('/bin/sh', ['-c', s.statusLine.command], { input, env: { ...process.env, KB_URL: 'http://127.0.0.1:9' } }).toString();
  assert.equal(out, input);
  const hook = s.hooks.PermissionRequest[0].hooks[0].command;
  const h = execFileSync('/bin/sh', ['-c', hook], { input: JSON.stringify({ hook_event_name: 'Stop' }), env: { ...process.env, KB_URL: 'http://127.0.0.1:9' } }).toString();
  assert.equal(h, '', 'the hook said something for an event that is not its own');
});

test('a settings.json that is a link stays a link, and a private one stays private', async () => {
  const dir = fresh();
  const dotfiles = mkdtempSync(join(tmp, 'dotfiles-'));
  const real = join(dotfiles, 'claude-settings.json');
  writeFileSync(real, JSON.stringify(OWNER, null, 2));
  chmodSync(real, 0o600);
  symlinkSync(real, join(dir, 'settings.json'));
  const r = await cli(['hooks', 'install', '--yes'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lstatSync(join(dir, 'settings.json')).isSymbolicLink(), 'the link was replaced by a plain file');
  assert.ok(isOurs(JSON.parse(readFileSync(real, 'utf8')).statusLine.command, 'statusline'), 'the file the link points to was not written');
  assert.equal(statSync(real).mode & 0o777, 0o600, 'a private settings file became readable by others');
  assert.deepEqual(readdirSync(dotfiles), ['claude-settings.json'], 'a temporary file was left next to the real one');
  // and a file open to others stays so under a stricter umask than the one it was made with
  const open = fresh(OWNER);
  chmodSync(join(open, 'settings.json'), 0o644);
  execFileSync('/bin/sh', ['-c', 'umask 077; exec "$@"', 'sh', process.execPath, CLI, 'hooks', 'install', '--yes', '--data', join(open, 'data')], {
    env: { ...process.env, KB_CLAUDE_DIR: open, CLAUDE_CONFIG_DIR: open, HOME: open, KB_DATA_DIR: join(open, 'data'), KB_URL: 'http://127.0.0.1:9' },
  });
  assert.ok(isOurs(read(open).statusLine.command, 'statusline'));
  assert.equal(statSync(join(open, 'settings.json')).mode & 0o777, 0o644, 'the umask changed the mode of the settings file');
});

// Where the command may not write, it says so and leaves everything as it was: no stack trace, no file half
// written, no temporary file left behind, and no settings.json replaced through its folder when the file itself
// was made read-only. Without a copy of the previous file nothing is written either.
test('a settings.json or a folder that cannot be written is reported, and nothing changes', async () => {
  const stack = /\n\s+at |node:fs|EACCES: permission denied, (?:open|mkdir|rename)/;
  const ro = fresh(OWNER);
  const p = join(ro, 'settings.json');
  const before = readFileSync(p, 'utf8');
  chmodSync(p, 0o444);
  const r1 = await cli(['hooks', 'install', '--yes'], ro);
  assert.equal(r1.code, 1);
  assert.match(r1.stdout, /not writable — nothing was written/);
  assert.equal(readFileSync(p, 'utf8'), before, 'a read-only settings.json was replaced through its folder');
  assert.equal(statSync(p).mode & 0o777, 0o444);
  const locked = fresh(OWNER);
  chmodSync(locked, 0o555);
  let r2;
  try { r2 = await cli(['hooks', 'install', '--yes'], locked, { KB_DATA_DIR: join(tmp, 'data-of-locked') }); } finally { chmodSync(locked, 0o755); }
  assert.equal(r2.code, 1);
  assert.doesNotMatch(r2.stderr, stack, 'a raw stack instead of a message');
  assert.match(r2.stdout, /nothing was written/);
  assert.equal(readFileSync(join(locked, 'settings.json'), 'utf8'), JSON.stringify(OWNER, null, 2));
  assert.deepEqual(readdirSync(locked).filter((f) => f.endsWith('.tmp')), [], 'a temporary file was left behind');
  const nocopy = fresh(OWNER);
  const data = mkdtempSync(join(tmp, 'ro-data-'));
  chmodSync(data, 0o555);
  let r3;
  try { r3 = await cli(['hooks', 'install', '--yes'], nocopy, { KB_DATA_DIR: data }); } finally { chmodSync(data, 0o755); }
  assert.equal(r3.code, 1);
  assert.doesNotMatch(r3.stderr, stack, 'a raw stack instead of a message');
  assert.match(r3.stdout, /copy.*nothing was written/s);
  assert.equal(readFileSync(join(nocopy, 'settings.json'), 'utf8'), JSON.stringify(OWNER, null, 2), 'written without a copy of the previous file');
});

// The question needs a terminal: `script` gives the command one. It refuses the socket node hands a child as
// stdin, so a `cat` on each side puts real pipes around it. Its arguments differ between macOS and Linux, so the
// check runs where it is spelled for — the Mac the board is made on.
test('a settings.json changed while the change was on screen is left alone', { skip: process.platform !== 'darwin' && 'needs the macOS `script`', timeout: 20000 }, async () => {
  const dir = fresh(OWNER);
  const p = join(dir, 'settings.json');
  const child = spawn('/bin/sh', ['-c', 'cat | script -q /dev/null "$@" | cat', 'sh', process.execPath, CLI, 'hooks', 'install', '--data', join(dir, 'data')], {
    env: { ...process.env, KB_CLAUDE_DIR: dir, CLAUDE_CONFIG_DIR: dir, HOME: dir, KB_DATA_DIR: join(dir, 'data'), KB_URL: '' },
    detached: true, // its own process group: a question that never comes must not leave `cat` waiting forever
  });
  // a command that writes without asking never gets its stdin closed, and the test would hang instead of failing
  const guard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 15000);
  let out = '';
  let answered = false;
  child.stdout.on('data', (c) => {
    out += c;
    if (!answered && out.includes('[y/N]')) {
      answered = true;
      writeFileSync(p, JSON.stringify({ ...OWNER, model: 'sonnet' }, null, 2)); // Claude Code saved /config meanwhile
      child.stdin.end('y\n');
    }
  });
  await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(guard);
  assert.ok(answered, `the question never came:\n${out}`);
  assert.match(out, /changed while the change was on screen/);
  const s = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(s.model, 'sonnet', 'the change Claude Code made meanwhile was lost');
  assert.ok(!isOurs(s.statusLine.command, 'statusline'), 'written over a file that changed under the question');
});

// settings.json went to the folder this process picks by itself (KB_DATA_DIR, or the default), not to the one the
// person had just typed. The wizard asks only under a terminal — `script`, as above — and runs from a copy of the
// code under node_modules: an npm install keeps whatever else it writes in the data folder, never in this checkout.
test('the wizard keeps the copy of settings.json in the data folder it asked for', { skip: process.platform !== 'darwin' && 'needs the macOS `script`', timeout: 40000 }, async () => {
  const dir = fresh(OWNER);
  const before = readFileSync(join(dir, 'settings.json'), 'utf8');
  const pkg = join(mkdtempSync(join(tmp, 'pkg-')), 'node_modules', 'local-kanban');
  for (const sub of ['bin', 'src']) cpSync(fileURLToPath(new URL(`../${sub}`, import.meta.url)), join(pkg, sub), { recursive: true });
  const chosen = join(tmp, `chosen-data-${Date.now()}`); // what the person types
  const own = join(dir, 'env-data'); //                      where this process would put it by itself
  const answers = [
    [/Board port[^\n]*?\]: /, '\n'],
    [/Data directory[^\n]*?\]: /, `${chosen}\n`],
    [/Mirror tasks to GitHub\?[^\n]*?\]: /, 'n\n'],
    [/Create ecosystem\.config\.cjs[^\n]*?\]: /, 'n\n'],
    [/Install the Claude Code skills[^\n]*?\]: /, 'n\n'],
    [/Show the change and connect\?[^\n]*?\]: /, 'y\n'],
    [/Write these changes\?[^\n]*?\]: /, 'y\n'],
  ];
  const child = spawn('/bin/sh', ['-c', 'cat | script -q /dev/null "$@" | cat', 'sh', process.execPath, join(pkg, 'bin', 'local-kanban')], {
    env: { ...process.env, KB_CLAUDE_DIR: dir, CLAUDE_CONFIG_DIR: dir, HOME: dir, KB_DATA_DIR: own, KB_URL: '' },
    detached: true, // its own process group: a question that never comes must not leave `cat` waiting forever
  });
  const guard = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, 30000);
  let out = '';
  let from = 0;
  const asked = new Set();
  child.stdout.on('data', (c) => {
    out += c;
    for (;;) { // answer each question once, in whatever order they come
      const hits = answers.filter(([re]) => !asked.has(re)).map(([re, a]) => [re, a, re.exec(out.slice(from))]).filter(([, , m]) => m);
      if (!hits.length) break;
      const [re, a, m] = hits.sort((x, y) => x[2].index - y[2].index)[0];
      asked.add(re);
      from += m.index + m[0].length;
      child.stdin.write(a);
    }
    if (asked.has(answers[6][0])) child.stdin.end();
  });
  await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(guard);
  assert.ok(asked.has(answers[6][0]), `the wizard never asked to write the change:\n${out}`);
  assert.ok(isOurs(read(dir).statusLine.command, 'statusline'), `the wizard did not connect the board:\n${out}`);
  const there = join(chosen, 'backups', 'claude-settings');
  const copies = existsSync(there) ? readdirSync(there) : [];
  assert.equal(copies.length, 1, `no copy in the data folder the wizard asked for (${there}):\n${out}`);
  assert.equal(readFileSync(join(there, copies[0]), 'utf8'), before);
  assert.ok(!existsSync(join(own, 'backups', 'claude-settings')), 'the copy went to the folder of this process, not to the one the person chose');
});

test('local-kanban hooks uninstall says it leaves a chain it cannot take apart as it is', async () => {
  const oneLine = `{ ${KBC} statusline 2>/dev/null || cat; } | { node mine.js; }`;
  const dir = fresh({ statusLine: { type: 'command', command: oneLine },
    hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: `${KBC} hook permission`, timeout: HOOK_TIMEOUT_S }] }] } });
  const r = await cli(['hooks', 'uninstall', '--yes'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /statusLine: goes through the board, but in a shape this command cannot take apart — left as it is/);
  const s = read(dir);
  assert.equal(s.statusLine.command, oneLine, 'the status line was touched');
  assert.equal(s.hooks, undefined, 'the hook did not come off');
});

test('local-kanban hooks install says whose entries it takes over', async () => {
  const dir = fresh(planInstall(OWNER, kbCommand({ node: '/n', kb: '/kb', url: 'http://127.0.0.1:3999' })).settings);
  const r = await cli(['hooks', 'install'], dir);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /another board is connected now — http:\/\/127\.0\.0\.1:3999; this takes it over/);
  const own = await cli(['hooks', 'install', '--port', '3999'], dir);
  assert.equal(own.code, 0, own.stderr);
  assert.doesNotMatch(own.stdout, /another board/, 'the board that holds the entries is called another one');
});

test('local-kanban hooks does not make a KB_CLAUDE_DIR folder that is not there', async () => {
  const dir = join(tmp, `not-there-${Date.now()}`);
  const r = await cli(['hooks', 'install', '--yes'], dir, { KB_DATA_DIR: join(tmp, 'data-not-there') });
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stdout, /does not exist — check KB_CLAUDE_DIR; nothing was written/);
  assert.equal(existsSync(dir), false, 'the folder was made');
});
