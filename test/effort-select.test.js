import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EFFORT_LABELS, EFFORTS, checksOnly, effortOf, startEffort } from '../public/js/launch-rules.js';
import { EFFORT_LEVELS } from '../src/launch.js';

const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');

test('the page offers exactly the levels the server takes', () => {
  assert.deepEqual(EFFORTS, EFFORT_LEVELS, 'the select and the server disagree about the levels');
  assert.ok(EFFORTS.every((v) => EFFORT_LABELS[v]), 'a level has no words in the select');
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  for (const l of Object.values(EFFORT_LABELS)) assert.ok(core.includes(`'${l}':`), `"${l}" has no Russian line`);
});

test('the select shows what is stored and stores what is picked', () => {
  const line = settings.split('\n').find((l) => l.includes("buildSelect($('sel-effort')"));
  assert.ok(line, 'the effort select is gone from Settings');
  assert.match(line, /value: effortOf\(getSetting\('effort'\)\) \|\| ''/, 'the select does not show the stored level');
  assert.match(line, /\.\.\.EFFORTS\.map\(/, 'the select offers its own list, not the one the server checks');
  assert.match(line, /onChange: \(v\) => setSetting\('effort', v\)/, 'a picked level is not stored');
});

test('a stored level the server would refuse is sent as nothing, not as a refusal of every start', () => {
  assert.deepEqual(['high', 'max', 'ultracode', 'HIGH', '', null, undefined, 7].map(effortOf), ['high', 'max', undefined, undefined, undefined, undefined, undefined, undefined]);
  assert.match(sse, /const effort = startEffort\(check \?\? checksOnly\(keys, state\.tasks\), getSetting\('effort'\), getSetting\('effortCheck'\)\);/, 'a start picks its level some other way');
  assert.equal((sse.match(/effort(: mode === 'terminal' \? effort : undefined)? \}/g) || []).length, 2, 'a start sends the effort some other way');
  assert.ok(!/effort: [^,}]*getSetting\(/.test(sse), 'a start sends a stored level unchecked');
});

test('a check of Review starts with its own level, every other start with the level of all', () => {
  assert.equal(startEffort(true, 'medium', 'max'), 'max');
  assert.equal(startEffort(false, 'medium', 'max'), 'medium', 'a task that is not a check took the level of checks');
  assert.equal(startEffort(true, 'medium', ''), 'medium', 'a check with no level of its own lost the level of all');
  assert.equal(startEffort(true, 'medium', 'ultracode'), 'medium', 'a refused level of checks was sent');
  assert.equal(startEffort(true, '', ''), undefined);
  const tasks = [{ key: 'A-1', labels: ['check'] }, { key: 'A-2', labels: ['bug'] }, { key: 'A-3', labels: ['check', 'ui'] }];
  assert.equal(checksOnly(['A-1', 'A-3'], tasks), true);
  assert.equal(checksOnly(['A-1', 'A-2'], tasks), false, 'a start mixing a check with work took the level of checks');
  assert.equal(checksOnly(['A-9'], tasks), false, 'an unknown key counted as a check');
  assert.equal(checksOnly([], tasks), false, 'a start with no tasks counted as a check');
  const review = readFileSync(new URL('../public/js/review.js', import.meta.url), 'utf8');
  assert.match(review, /launchInClaude\(\{[^}]*check: true \}\)/, 'the check just made is not started as a check (the page does not know it yet)');
  const line = settings.split('\n').find((l) => l.includes("buildSelect($('sel-effort-check')"));
  assert.ok(line, 'the effort select of checks is gone from Settings');
  assert.match(line, /value: effortOf\(getSetting\('effortCheck'\)\) \|\| ''/, 'the select does not show the stored level');
  assert.match(line, /\.\.\.EFFORTS\.map\(/);
  assert.match(line, /onChange: \(v\) => setSetting\('effortCheck', v\)/, 'a picked level is not stored');
});

test('a list opened in the Settings window keeps inside it', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const fn = core.slice(core.indexOf('export function popoverPlacement('), core.indexOf('\n}\n', core.indexOf('export function popoverPlacement(')));
  assert.match(fn, /closest\?\.\('[^']*\.settings-modal[^']*'\)/, 'the Settings window is not a box the list keeps inside');
});

// gives it the level of checks. The start again after "no folder" lost nothing that was green: it is held here.
test('a start again after the folder window keeps the level of a check', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(sse, /if \(await askProjectFolder\(e\.body\)\) await launchInClaude\(\{ text, project, keys, btn, again: true, check \}\);/,
    'the start again after "no folder" forgets that it starts a check — a new check runs at the level of all tasks');
});
