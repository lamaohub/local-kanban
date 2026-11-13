// The audit of 14.11.2026: pm2 restarted the owner's board seven times in two weeks at max_memory_restart 200M — «All
// projects» and a few searches of a 6 600-task board go past it, and a restart cuts the live stream of every tab. The
// example config and the config the wizard writes carry one limit, with room above those peaks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const limit = (file) => {
  const m = /max_memory_restart: '(\d+)M'/.exec(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
  assert.ok(m, `${file} sets no max_memory_restart`);
  return Number(m[1]);
};

test('the memory limit of pm2 leaves room above the board\'s peaks, the same in the example and the wizard', () => {
  const example = limit('ecosystem.example.cjs');
  assert.ok(example >= 400, `max_memory_restart ${example}M`);
  assert.equal(limit('bin/local-kanban'), example);
});
