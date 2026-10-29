// `--settings` — the chat answers them with a form — unless the person connected the hook in settings.json already.
// by `pkill -f "kb hook permission"` of a stand cleaning up its hooks, and all 16 live sessions of the board died (143).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const data = mkdtempSync(join(tmpdir(), 'kb-ask-hook-'));
process.env.KB_DATA_DIR = data;
const { askHook, phantomSpec, writeAskHook } = await import('../src/phantom.js');
const none = () => ({ settings: {} });
test.after(() => rmSync(data, { recursive: true, force: true }));

test('the board\'s Claude gets the hook for its questions only, by the board\'s own kb and address', () => {
  const args = askHook(3101, none);
  assert.equal(args.length, 2);
  assert.equal(args[0], '--settings');
  assert.equal(args[1], join(data, 'ask-hook-3101.json'), 'the hook is not a file of the board\'s data');
  const s = JSON.parse(readFileSync(args[1], 'utf8'));
  const groups = s.hooks.PermissionRequest;
  assert.equal(groups.length, 1);
  assert.equal(groups[0].matcher, 'AskUserQuestion', 'permission requests and plans would leave the terminal too');
  const [h] = groups[0].hooks;
  assert.equal(h.type, 'command');
  assert.match(h.command, /bin\/kb hook permission \|\| true$/);
  assert.match(h.command, /KB_URL=http:\/\/127\.0\.0\.1:3101 exec /, 'the hook would ask another board');
  assert.equal(h.timeout, 1800);
  assert.deepEqual(Object.keys(s), ['hooks'], 'more than the hook goes to Claude');
  assert.equal(statSync(args[1]).mode & 0o077, 0, 'the file is open to other users of the machine');
});

test('the hook\'s text is not on the command line of the board\'s Claude — `pkill -f "kb hook permission"` kills none', () => {
  const spec = phantomSpec({ sid: '00000000-0000-4000-8000-000000000000', name: 'AH-1', text: 'go', folder: '/tmp', port: 3101, read: none });
  assert.ok(!spec.args.join(' ').includes('kb hook permission'));
  assert.ok(!spec.args.join(' ').includes('hook permission'));
});

test('written whole every launch: no half-written file left, the same path for the board', () => {
  const a = writeAskHook(3199, '{"hooks":{}}');
  const b = writeAskHook(3199, '{"hooks":{"x":1}}');
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(readFileSync(b, 'utf8')), { hooks: { x: 1 } });
  assert.deepEqual(readdirSync(data).filter((f) => f.includes('.part')), [], 'a temporary file stayed behind');
});

test('a file that cannot be written — the hook goes as text, the questions still come to the board', () => {
  const args = askHook(3101, none, () => { throw new Error('read-only'); });
  assert.equal(args[0], '--settings');
  assert.equal(JSON.parse(args[1]).hooks.PermissionRequest[0].matcher, 'AskUserQuestion');
});

test('a person who connected the hook gets no second one — every question would come twice', () => {
  const connected = () => ({ settings: { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: '/opt/node /x/bin/kb hook permission' }] }] } } });
  assert.deepEqual(askHook(3101, connected), []);
  // someone else's hook is not ours
  const other = () => ({ settings: { hooks: { PermissionRequest: [{ matcher: '*', hooks: [{ type: 'command', command: 'ghostex-notify.sh' }] }] } } });
  assert.equal(askHook(3101, other)[0], '--settings');
  // a settings file that cannot be read — the hook goes in
  assert.equal(askHook(3101, () => { throw new Error('unreadable'); })[0], '--settings');
});

test('the hook goes on the command line of Claude, before its tools', () => {
  const spec = phantomSpec({ sid: '00000000-0000-4000-8000-000000000000', name: 'AH-1', text: 'go', folder: '/tmp', port: 3101, read: none });
  const at = spec.args.indexOf('--settings');
  assert.ok(at > 0, 'the board\'s Claude starts without the hook');
  assert.ok(at < spec.args.indexOf('--allowedTools'));
});
