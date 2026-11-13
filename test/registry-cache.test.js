// parsed every file again (1.7 s of a 27 s profile on the owner's board). A file is parsed again only when it changed,
// and what a caller gets is its own; a change is seen at once (no read is shared: one already under way would hand out the
// file as it was before the write — review).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const S1 = '11111111-2222-4333-8444-555555555555';
const S2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
let live, dir, temps = [];
const reg = (name, d) => writeFileSync(join(dir, name), JSON.stringify(d));

before(async () => {
  process.env.KB_DATA_DIR = mkdtempSync(join(tmpdir(), 'kb-reg-'));
  const claude = mkdtempSync(join(tmpdir(), 'kb-reg-claude-'));
  process.env.KB_CLAUDE_DIR = claude;
  temps = [process.env.KB_DATA_DIR, claude];
  dir = join(claude, 'sessions');
  mkdirSync(dir);
  live = await import('../src/claude-live.js');
});
// at the top level: an `after` called inside `before` runs as soon as that hook ends, not after the tests
after(() => { for (const d of temps) rmSync(d, { recursive: true, force: true }); });

test('an unchanged file is not read again; a changed, a new and a removed one are seen at once', { skip: process.getuid?.() === 0 }, async () => {
  reg('1.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  assert.equal((await live.readRegistry()).get(S1).status, 'busy');
  // unreadable now, but its mtime and size are the same: the answer comes from what was parsed
  chmodSync(join(dir, '1.json'), 0o000);
  try {
    assert.equal((await live.readRegistry()).get(S1)?.status, 'busy', 'an unchanged file was read again');
  } finally { chmodSync(join(dir, '1.json'), 0o644); }
  reg('1.json', { pid: process.pid, sessionId: S1, status: 'idle', statusUpdatedAt: 1001 }); // same size, rewritten in place
  assert.equal((await live.readRegistry()).get(S1).status, 'idle', 'a file rewritten in place is read again');
  reg('2.json', { pid: process.pid, sessionId: S2, status: 'waiting', statusUpdatedAt: 2000 });
  assert.equal((await live.readRegistry()).get(S2).status, 'waiting');
  rmSync(join(dir, '2.json'));
  assert.equal((await live.readRegistry()).has(S2), false);
  writeFileSync(join(dir, '3.json'), '{"half');
  assert.equal((await live.readRegistry()).size, 1, 'a half-written file is skipped');
  rmSync(join(dir, '3.json'));
});

test('calls at once each read the folder and get their own answer', async () => {
  reg('1.json', { pid: process.pid, sessionId: S1, status: 'busy', statusUpdatedAt: 1000 });
  const [a, b] = await Promise.all([live.readRegistry(), live.readRegistry()]);
  assert.notEqual(a, b);
  a.get(S1).alive = false;
  a.delete(S1);
  assert.equal(b.get(S1).alive, true, 'one caller changed the answer of another');
  assert.equal((await live.readRegistry()).get(S1).alive, true);
});

test('a process that ended is read as gone though its file did not change', async () => {
  reg('9.json', { pid: 2 ** 31 - 2, sessionId: S2, status: 'busy', statusUpdatedAt: 1000 });
  assert.equal((await live.readRegistry()).get(S2).alive, false);
  assert.equal((await live.readRegistry((pid) => pid === 2 ** 31 - 2)).get(S2).alive, true, 'liveness is asked on every read');
  rmSync(join(dir, '9.json'));
});
