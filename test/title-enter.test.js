import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const HEAD = "$('d-title').addEventListener('keydown', ";
const init = readFileSync(new URL('../public/js/init.js', import.meta.url), 'utf8');
const at = init.indexOf(HEAD);
const handlerSrc = init.slice(at + HEAD.length, init.indexOf('\n});', at) + 2);

function card({ locked = false } = {}) {
  const calls = [];
  const desc = { id: 'd-desc', disabled: locked, value: 'some text', focus: () => calls.push('desc.focus'),
    setSelectionRange: (a, b) => calls.push(`select ${a}-${b}`) };
  const box = { $: (id) => (id === 'd-desc' ? desc : null), doAutosave: () => calls.push('save') };
  const handler = vm.runInNewContext(`(${handlerSrc})`, box);
  const press = (o) => {
    const title = { blur: () => calls.push('title.blur') };
    const e = { key: 'Enter', shiftKey: false, isComposing: false, target: title, preventDefault: () => calls.push('prevent'), ...o };
    handler(e);
    return calls.splice(0);
  };
  return { press };
}

test('Enter saves the title and puts the caret at the end of the description', () => {
  assert.deepEqual(card().press({}), ['prevent', 'desc.focus', 'select 9-9', 'save']);
});

test('a locked card only leaves the title, as before', () => {
  assert.deepEqual(card({ locked: true }).press({}), ['prevent', 'title.blur', 'save']);
});

test('Shift+Enter, a composing input method and other keys are left alone', () => {
  const c = card();
  assert.deepEqual(c.press({ shiftKey: true }), []);
  assert.deepEqual(c.press({ isComposing: true }), []);
  assert.deepEqual(c.press({ key: 'a' }), []);
});
