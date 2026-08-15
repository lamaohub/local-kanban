import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CONFIG = fileURLToPath(new URL('../src/config.js', import.meta.url));
const probe = (env) => new Promise((resolve, reject) => {
  const code = `import('${CONFIG}').then((m) => console.log(JSON.stringify({ data: m.DATA_DIR, root: m.localRoot() })))`;
  execFile(process.execPath, ['-e', code], { env: { ...process.env, ...env } },
    (err, stdout) => (err ? reject(err) : resolve(JSON.parse(stdout))));
});

test('a tilde in KB_DATA_DIR is expanded, not taken literally', async () => {
  const r = await probe({ KB_DATA_DIR: '~/kanban-data' });
  assert.equal(r.data, join(homedir(), 'kanban-data'),
    'the board would create a real directory named "~" and then die on a raw @fastify/static stack');
});

test('a relative KB_DATA_DIR becomes absolute', async () => {
  const r = await probe({ KB_DATA_DIR: './some-data' });
  assert.equal(r.data.startsWith('/'), true, `still relative: ${r.data}`);
  assert.equal(r.data.endsWith('/some-data'), true, r.data);
});

test('an isolated instance keeps its project folders to itself', async () => {
  const r = await probe({ KB_DATA_DIR: '/tmp/kb-isolated', KB_LOCAL_ROOT: '' });
  assert.equal(r.root, '/tmp/kb-isolated/projects',
    'an instance with its own data directory still answers with the live ~/claude-projects of the owner');
});

test('the owner\'s own board is untouched: no KB_DATA_DIR means the usual root', async () => {
  const r = await probe({ KB_DATA_DIR: '', KB_LOCAL_ROOT: '' });
  assert.equal(r.root, join(homedir(), 'claude-projects'),
    'the change moved the project folders of a normal installation');
});

test('an explicit KB_LOCAL_ROOT still wins, and it is expanded too', async () => {
  const r = await probe({ KB_DATA_DIR: '/tmp/kb-isolated', KB_LOCAL_ROOT: '~/elsewhere' });
  assert.equal(r.root, join(homedir(), 'elsewhere'));
});
