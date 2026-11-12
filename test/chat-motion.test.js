import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshBlocks, glideBy, liveChanged } from '../public/js/chat-motion-rules.js';

const turn = (at, ...blocks) => ({ at, blocks: blocks.map((b) => (typeof b === 'string' ? { kind: b, label: '', words: '' } : b)) });

test('the first paint and another chat move nothing', () => {
  assert.deepEqual(freshBlocks(null, [turn('a', 'chat-user')]), []);
  assert.deepEqual(freshBlocks([], [turn('a', 'chat-user')]), []);
  assert.deepEqual(freshBlocks([turn('a', 'chat-user')], [turn('b', 'chat-user')]), []);
});

test('what came in at the end rises; what stood there stays', () => {
  const before = [turn('a', 'chat-user', 'chat-claude'), turn('b', 'chat-user', 'chat-run')];
  const after = [turn('a', 'chat-user', 'chat-claude'), turn('b', 'chat-user', 'chat-run', 'chat-claude'), turn('c', 'chat-user')];
  assert.deepEqual(freshBlocks(before, after), [
    { turn: 1, block: 2, how: 'rise' }, { turn: 2, block: 0, how: 'rise' },
  ]);
});

test('a block changed in place fades in, a run line with new words fades its words', () => {
  const run = (label) => ({ kind: 'chat-run', label, words: '' });
  const before = [turn('a', 'chat-user', run('Running a command'), 'chat-claude')];
  const after = [turn('a', 'chat-user', run('Ran a command'), 'chat-done')];
  assert.deepEqual(freshBlocks(before, after), [{ turn: 0, block: 1, how: 'label' }, { turn: 0, block: 2, how: 'fade' }]);
  // the same words, spaced otherwise, are no change
  assert.deepEqual(freshBlocks([turn('a', run('Ran  2 commands'))], [turn('a', run('Ran 2 commands'))]), []);
});

test('turns brought by «Show earlier» stay as they are', () => {
  const before = [turn('b', 'chat-user')];
  const after = [turn('a', 'chat-user', 'chat-claude'), turn('b', 'chat-user')];
  assert.deepEqual(freshBlocks(before, after), []);
});

test('the person\'s words the bubble «sending…» showed come into the turn quietly', () => {
  const words = (w) => ({ kind: 'chat-user', label: '', words: w });
  const before = [turn('a', 'chat-user', 'chat-claude')];
  const after = [turn('a', 'chat-user', 'chat-claude'), turn('b', words('[Image #1] fix  the field'), 'chat-claude')];
  assert.deepEqual(freshBlocks(before, after, ['fix the field']), [{ turn: 1, block: 1, how: 'rise' }]);
  // other words rise as any new block does
  assert.deepEqual(freshBlocks(before, after, ['something else']), [{ turn: 1, block: 0, how: 'rise' }, { turn: 1, block: 1, how: 'rise' }]);
  // and an empty bubble does not stand for any words
  assert.deepEqual(freshBlocks(before, after, ['']).length, 2);
});

test('the chat glides by a step smaller than the view, either way', () => {
  assert.equal(glideBy(100, 160, 500), 60);
  assert.equal(glideBy(100, 100, 500), 0);
  assert.equal(glideBy(160, 100, 500), -60); // a turn folded into its bar: the words come down
  assert.equal(glideBy(0, 900, 500), 0);
  assert.equal(glideBy(900, 0, 500), 0);
});

test('the line over the field fades only its parts whose words changed', () => {
  assert.deepEqual(liveChanged(null, { words: 'x' }), []);
  assert.deepEqual(liveChanged({ words: 'Claude is thinking…', now: '' }, { words: 'Claude is writing…', now: '' }), ['words']);
  assert.deepEqual(liveChanged({ words: 'a', now: 'Runs · ls' }, { words: 'a', now: 'Reads · x.md' }), ['now']);
  assert.deepEqual(liveChanged({ words: 'a', now: 'Runs · ls' }, { words: 'a', now: '' }), []);
});
