// under the questions, which goes with Decline, is not dropped without a word when the person answers
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.KB_DATA_DIR = mkdtempSync(join(tmpdir(), 'kb-ask-notes-'));
const { answerBody } = await import('../public/js/ask-rules.js');
const { decisionFor } = await import('../src/claude-asks.js');

const ask = { kind: 'question', input: { questions: [
  { question: 'Which way?', options: [{ label: 'A (Recommended)' }, { label: 'B' }] },
  { question: 'Tests?', options: [{ label: 'Yes' }, { label: 'No' }] },
] } };

test('a note to a question goes to Claude Code as `annotations[question].notes`', () => {
  const body = answerBody(ask, true, { picks: [{ checked: ['B'], note: '  because of the deadline ' }, { checked: ['Yes'] }] });
  assert.deepEqual(body, { behavior: 'allow', answers: { 'Which way?': 'B', 'Tests?': 'Yes' }, annotations: { 'Which way?': { notes: 'because of the deadline' } } });
  const d = decisionFor(ask, body);
  assert.deepEqual(d.updatedInput.annotations, { 'Which way?': { notes: 'because of the deadline' } });
  assert.deepEqual(d.updatedInput.answers, { 'Which way?': 'B', 'Tests?': 'Yes' });
  // a note to no question of the request, or not a text, does not go (Claude Code would refuse the whole answer)
  const odd = decisionFor(ask, { ...body, annotations: { 'Not asked': { notes: 'x' }, 'Tests?': { notes: 5 }, 'Which way?': 'flat' } });
  assert.equal(odd.updatedInput.annotations, undefined);
  // no notes — no annotations at all
  assert.equal(decisionFor(ask, { behavior: 'allow', answers: { 'Which way?': 'A (Recommended)', 'Tests?': 'No' } }).updatedInput.annotations, undefined);
});

test('the line under the questions is not dropped without a word when the person answers', () => {
  assert.throws(() => answerBody(ask, true, { reason: 'why not', picks: [{ checked: ['B'] }, { checked: ['Yes'] }] }), /goes with Decline/);
  assert.deepEqual(answerBody(ask, false, { reason: 'why not' }), { behavior: 'deny', message: 'why not' });
});

test('the recommended option is marked in Russian too', () => {
  const src = readFileSync(new URL('../public/js/asks.js', import.meta.url), 'utf8');
  const re = new Function(`return ${/const RECOMMENDED = (\/.*\/i);/.exec(src)[1]}`)();
  for (const label of ['Через inst.bot (Рекомендую)', 'Так (Рекомендуется)', 'Go (Recommended)']) assert.match(label, re, label);
  assert.doesNotMatch('Рекомендую подумать', re);
});
