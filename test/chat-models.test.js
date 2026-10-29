import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, modelLabel, sameModel } from '../public/js/chat-models.js';

test('a model is named short: a known one by the list, a dated or long-context one as the same, an unknown by its words', () => {
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelLabel('claude-sonnet-5-5-20261001'), 'Sonnet 5.5', 'a dated id is another model to the person');
  assert.equal(modelLabel('claude-opus-5-5[1m]'), 'Opus 5.5');
  assert.equal(modelLabel('claude-nova-7-2'), 'Nova 7.2');
  assert.equal(modelLabel('claude-nova-7'), 'Nova 7');
  assert.equal(modelLabel('some-model'), 'some-model');
  assert.equal(modelLabel(null), '');
  assert.equal(modelLabel(''), '');
});

test('the transcript names the model picked — dated or not', () => {
  assert.ok(sameModel('claude-haiku-5-5-20261001', 'claude-haiku-5-5'));
  assert.ok(!sameModel('claude-opus-5-5', 'claude-sonnet-5-5'));
  assert.ok(!sameModel(null, 'claude-opus-5-5'), 'no model yet reads as the one picked');
});

test('every model of the list has a name, a cost mark and an id the board may type into the terminal', () => {
  assert.ok(MODELS.length >= 3);
  for (const m of MODELS) {
    assert.match(m.id, /^claude-[a-z]+-\d+(-\d+)?$/, `${m.id}: «/model <id>» would be typed with whatever this is`);
    assert.match(m.cost, /^\$+$/);
    assert.equal(modelLabel(m.id), m.label);
  }
});
