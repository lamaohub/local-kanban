// The time in a snapshot's name: the local clock with its offset, and the moment a name stands for —
// for the names made now and for the UTC ones made before. The time zone of the process is switched for
// each check (Node reads TZ anew on every assignment), so the suite means the same in any zone it runs in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localStamp, stampTime, zonedStamp } from '../src/stamp.js';

function inZone(tz, fn) {
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try { return fn(); } finally { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; }
}

const at = Date.UTC(2026, 9, 5, 8, 9, 30, 123); // 08:09:30.123 UTC

test('a name says the local time and its offset from UTC', () => {
  const cases = {
    'Asia/Bangkok': '2026-10-05_15-09-30+0700',        // the owner's +7
    'Asia/Yekaterinburg': '2026-10-05_13-09-30+0500',
    'America/Los_Angeles': '2026-10-05_01-09-30-0700', // daylight saving time
    'Asia/Kolkata': '2026-10-05_13-39-30+0530',        // half an hour
    'America/St_Johns': '2026-10-05_05-39-30-0230',
    UTC: '2026-10-05_08-09-30+0000',
  };
  for (const [tz, want] of Object.entries(cases)) {
    assert.equal(inZone(tz, () => zonedStamp(new Date(at))), want, tz);
    assert.equal(inZone(tz, () => zonedStamp(new Date(at), true)), want.replace(/([+-]\d{4})$/, '-123$1'), `${tz}, with milliseconds`);
    assert.equal(inZone(tz, () => stampTime(zonedStamp(new Date(at), true))), at, `${tz}: the name does not stand for the moment it was made`);
  }
  assert.equal(inZone('America/Los_Angeles', () => localStamp(new Date(at), true)), '2026-10-05-01-09-30');
  assert.equal(inZone('Asia/Bangkok', () => localStamp(new Date(at), false)), '2026-10-05');
});

test('a name made before the offset came in is read as UTC', () => {
  assert.equal(stampTime('2026-10-05-08-09-30'), Date.UTC(2026, 9, 5, 8, 9, 30)); // a snapshot before a migration
  assert.equal(stampTime('2026-10-05T08-09-30'), Date.UTC(2026, 9, 5, 8, 9, 30)); // a skill, before milliseconds
  assert.equal(stampTime('2026-10-05T08-09-30-123'), at);                         // a skill, with them
  for (const bad of ['2026-10-05', '2026-10-05_08-09-30', '2026-10-05T08-09-30+0700', 'notes', '2026-10-05-08-09-30-1'])
    assert.ok(Number.isNaN(stampTime(bad)), `"${bad}" was read as a time`);
});

test('the hour that repeats when daylight saving time ends gives two names in their true order', () => {
  // 01:30 in Los Angeles happens twice on 2026-11-01: first in summer time (-0700), then in winter time (-0800)
  const first = Date.UTC(2026, 10, 1, 8, 30);
  const second = Date.UTC(2026, 10, 1, 9, 30);
  const [a, b] = inZone('America/Los_Angeles', () => [zonedStamp(new Date(first)), zonedStamp(new Date(second))]);
  assert.deepEqual([a, b], ['2026-11-01_01-30-00-0700', '2026-11-01_01-30-00-0800']);
  assert.ok(stampTime(a) < stampTime(b), 'the later snapshot reads as the earlier one');
});
