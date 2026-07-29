import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

let app, tmp, LABELS, MANAGED_LABELS;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  ({ LABELS, MANAGED_LABELS } = await import('../src/sync/github.js'));

  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  const systemRoutes = (await import('../src/routes/system.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.register(systemRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const palette = async () => JSON.parse((await app.inject({ method: 'GET', url: '/api/labels' })).body);

test('/api/labels returns the server\'s WHOLE palette — no label is lost on the way', async () => {
  const { palette: p } = await palette();
  assert.deepEqual(Object.keys(p).sort(), Object.keys(LABELS).sort());
});

test('colours are returned ready for CSS (with the leading hash)', async () => {
  const { palette: p } = await palette();
  for (const [name, hex] of Object.entries(p)) {
    assert.match(hex, /^#[0-9A-Fa-f]{6}$/, `${name}: ${hex}`);
    assert.equal(hex.slice(1).toUpperCase(), LABELS[name].toUpperCase());
  }
});

test('docs and security can be set from the board', async () => {
  const { selectable } = await palette();
  assert.ok(selectable.includes('docs'), 'docs disappeared from the selectable labels');
  assert.ok(selectable.includes('security'), 'security disappeared from the selectable labels');
});

test('internal labels (priority, blocked) stay out of the pickers — sync ops set them', async () => {
  const { selectable } = await palette();
  for (const m of MANAGED_LABELS) assert.ok(!selectable.includes(m), `${m} must not be selectable`);
});

test('selectable = the whole palette minus the internal ones, nothing extra', async () => {
  const { selectable } = await palette();
  const want = Object.keys(LABELS).filter((n) => !MANAGED_LABELS.has(n));
  assert.deepEqual(selectable.sort(), want.sort());
});

test('public/app.js keeps no label list of its own', () => {
  const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /const\s+LABEL_COLORS\s*=\s*\{\s*[\w'"]/,
    'a hardcoded LABEL_COLORS is back on the front end — the palette must come from /api/labels');
});
