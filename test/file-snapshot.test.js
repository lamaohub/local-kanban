import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let tmp, src, snapshotFile, snapshotDir;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  ({ snapshotFile, snapshotDir } = await import('../src/file-snapshot.js'));
  src = join(tmp, 'SKILL.md');
  writeFileSync(src, 'original');
});

after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

// a snapshot of this label: the date, then `T` (UTC, the names made before the offset came in) or `_` (local time and its offset)
const own = (kind, label) => readdirSync(snapshotDir(kind))
  .filter((f) => new RegExp(`^${label}-\\d{4}-\\d{2}-\\d{2}[T_]`).test(f));

test('a skill and its namesakes (deploy, deploy-tickets, deploy-villatap) never rotate each other away', () => {
  const dir = snapshotDir('skills');
  mkdirSync(dir, { recursive: true });
  for (const label of ['deploy-tickets', 'deploy-villatap']) {
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `${label}-2026-09-01T10-00-0${i}.md`), `${label} ${i}`);
  }
  const made = snapshotFile('skills', 'deploy', src);
  assert.ok(made && existsSync(made), `the answer names a snapshot that is gone: ${made}`);
  assert.equal(own('skills', 'deploy-tickets').length, 10, 'saving deploy wiped snapshots of deploy-tickets');
  assert.equal(own('skills', 'deploy-villatap').length, 10, 'saving deploy wiped snapshots of deploy-villatap');
});

test('two saves in the same second keep both previous texts', () => {
  const file = join(tmp, 'CLAUDE.md');
  writeFileSync(file, 'first');
  const a = snapshotFile('docs', 'proj-CLAUDE.md', file);
  writeFileSync(file, 'second');
  const b = snapshotFile('docs', 'proj-CLAUDE.md', file);
  assert.notEqual(a, b, 'two snapshots got one name — the first text is lost');
  assert.equal(readFileSync(a, 'utf8'), 'first');
  assert.equal(readFileSync(b, 'utf8'), 'second');
});

test('a file keeps its ten newest snapshots, the oldest go first', () => {
  const made = [];
  for (let i = 0; i < 12; i++) { writeFileSync(src, `v${i}`); made.push(snapshotFile('skills', 'busy', src)); }
  const left = own('skills', 'busy');
  assert.equal(left.length, 10, `${left.length} snapshots kept, expected 10`);
  assert.ok(!existsSync(made[0]) && !existsSync(made[1]), 'the two oldest snapshots should be gone');
  assert.ok(existsSync(made[11]), 'the newest snapshot was rotated away');
});

test('the snapshot just taken survives the rotation even when the clock went back', () => {
  const dir = snapshotDir('skills');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 10; i++) writeFileSync(join(dir, `clock-2099-01-01T00-00-${String(i).padStart(2, '0')}-000-${i + 1}.md`), 'later');
  writeFileSync(src, 'text before the save');
  const made = snapshotFile('skills', 'clock', src);
  assert.ok(existsSync(made), `the snapshot just taken was rotated away: ${made}`);
  assert.equal(readFileSync(made, 'utf8'), 'text before the save');
});

test('a label cannot take the snapshot out of its directory', () => {
  const made = snapshotFile('docs', '../../esc', src);
  assert.equal(dirname(made), snapshotDir('docs'), `the snapshot landed outside backups/docs: ${made}`);
});

function inZone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

test('a snapshot is named by the local clock and its offset, in any time zone', async () => {
  const { stampTime } = await import('../src/stamp.js');
  for (const tz of ['Asia/Bangkok', 'America/Los_Angeles']) {
    const t0 = Date.now();
    const [name, offset] = inZone(tz, () => {
      const made = snapshotFile('docs', 'zone-CLAUDE.md', src).split('/').pop();
      const off = -new Date().getTimezoneOffset();
      return [made, `${off < 0 ? '-' : '+'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}${String(Math.abs(off) % 60).padStart(2, '0')}`];
    });
    const t1 = Date.now();
    const m = /^zone-CLAUDE\.md-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}([+-]\d{4}))-\d+\.md$/.exec(name);
    assert.ok(m, `${tz}: the name is not the local time with its offset: ${name}`);
    assert.equal(m[2], offset, `${tz}: the offset in the name is not the zone's: ${name}`);
    const when = stampTime(m[1]);
    assert.ok(when >= t0 && when <= t1, `${tz}: the name does not say when the snapshot was taken (UTC digits?): ${name}`);
  }
});

test('the rotation orders UTC names and local ones by the moment they stand for', () => {
  const dir = snapshotDir('skills');
  mkdirSync(dir, { recursive: true });
  // ten snapshots of one skill, oldest first; by their text the third would go first
  const names = (label) => [
    `${label}-2026-01-02_10-00-00-000+0700-1.md`, // 03:00 UTC
    `${label}-2026-01-02T05-00-00-000-2.md`, //      05:00 UTC, a name made before the offset came in
    `${label}-2026-01-01_22-00-00-000-0800-3.md`, // 06:00 UTC the next day
    `${label}-2026-01-02T07-00-00.md`, //            07:00 UTC, the oldest shape of all
    `${label}-2026-01-02_00-00-00-000-0800-4.md`, // 08:00 UTC
    `${label}-2026-01-02_16-00-00-000+0700-5.md`, // 09:00 UTC
    ...[1, 2, 3, 4].map((d) => `${label}-2026-02-0${d}T00-00-00-000-${5 + d}.md`),
  ];
  for (const tz of ['Asia/Bangkok', 'America/Los_Angeles']) {
    const label = `mixed-${tz.split('/')[1].toLowerCase()}`;
    const old = names(label);
    for (const f of old) writeFileSync(join(dir, f), f);
    const made = inZone(tz, () => snapshotFile('skills', label, src));
    const left = own('skills', label);
    assert.equal(left.length, 10, `${tz}: ${left.length} snapshots kept, expected 10`);
    assert.ok(!left.includes(old[0]), `${tz}: the oldest snapshot (03:00 UTC, a local name) should be the one to go: ${left.join(', ')}`);
    assert.ok(existsSync(made), `${tz}: the snapshot just taken was rotated away`);
  }
});

test('in a real transition the snapshots of the last hours, under UTC names, go before the new local one', () => {
  // west of Greenwich the UTC digits of a snapshot made an hour ago read LATER than the local name made now
  const dir = snapshotDir('skills');
  const utc = (ms, n) => `${new Date(ms).toISOString().replace(/[:.]/g, '-').slice(0, 23)}-${n}`; // how names were made before
  for (const tz of ['Asia/Bangkok', 'America/Los_Angeles']) {
    const label = `moved-${tz.split('/')[1].toLowerCase()}`;
    // every half hour for the last five hours: less than the seven or eight hours Los Angeles is behind
    const old = Array.from({ length: 10 }, (_, i) => `${label}-${utc(Date.now() - (10 - i) * 1_800_000, i + 1)}.md`);
    for (const f of old) writeFileSync(join(dir, f), f);
    const made = inZone(tz, () => snapshotFile('skills', label, src));
    const left = own('skills', label);
    assert.deepEqual(left.sort(), [...old.slice(1), made.split('/').pop()].sort(),
      `${tz}: the rotation did not drop the snapshot of five hours ago (and only it)`);
  }
});

test('a copy keeps the extension of the file it copies', () => {
  const settings = join(tmp, 'settings.json');
  writeFileSync(settings, '{"a": 1}\n');
  assert.match(snapshotFile('claude-settings', 'ext', settings).split('/').pop(), /^ext-\d{4}-.*-\d+\.json$/);
  assert.match(snapshotFile('skills', 'ext-md', src).split('/').pop(), /^ext-md-\d{4}-.*-\d+\.md$/);
  const bare = join(tmp, 'run');
  writeFileSync(bare, '#!/bin/sh\n');
  assert.match(snapshotFile('skills', 'ext-bare', bare).split('/').pop(), /^ext-bare-\d{4}-[^.]*-\d+$/, 'a file without an extension got one');
  const odd = join(tmp, 'notes.we ird');
  writeFileSync(odd, 'x');
  assert.match(snapshotFile('skills', 'ext-odd', odd).split('/').pop(), /^ext-odd-\d{4}-[^ ]*-\d+$/, 'an odd extension went into the name');
});

test('the copies made before as .md are rotated together with the new ones', () => {
  const dir = snapshotDir('claude-settings');
  mkdirSync(dir, { recursive: true });
  const old = Array.from({ length: 10 }, (_, i) => `rot-2026-01-0${(i % 9) + 1}_10-00-00-000+0700-${i + 1}.md`);
  for (const f of old) writeFileSync(join(dir, f), f);
  const settings = join(tmp, 'settings.json');
  writeFileSync(settings, '{}\n');
  const made = snapshotFile('claude-settings', 'rot', settings);
  const left = own('claude-settings', 'rot');
  assert.equal(left.length, 10, `${left.length} copies kept, expected 10: the old .md ones are not counted with the new`);
  assert.ok(existsSync(made));
});

test('a copy can go to the data folder of another board', () => {
  const other = mkdtempSync(join(tmpdir(), 'kb-test-other-'));
  try {
    const made = snapshotFile('claude-settings', 'elsewhere', src, { dataDir: other });
    assert.equal(dirname(made), join(other, 'backups', 'claude-settings'));
    assert.ok(!existsSync(join(snapshotDir('claude-settings'), made.split('/').pop())), 'the copy went to this board\'s folder too');
  } finally { rmSync(other, { recursive: true, force: true }); }
});
