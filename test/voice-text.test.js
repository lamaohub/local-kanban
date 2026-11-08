import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latinWord, numberWords, plural, speechText } from '../src/voice-text.js';

test('numberWords: Russian words, gender, thousands and millions', () => {
  assert.equal(numberWords(0), 'ноль');
  assert.equal(numberWords(21), 'двадцать один');
  assert.equal(numberWords(21, true), 'двадцать одна');
  assert.equal(numberWords(2, true), 'две');
  assert.equal(numberWords(112), 'сто двенадцать');
  assert.equal(numberWords(1000), 'тысяча');
  assert.equal(numberWords(2075), 'две тысячи семьдесят пять');
  assert.equal(numberWords(5000), 'пять тысяч');
  assert.equal(numberWords(1001001), 'один миллион тысяча один');
  assert.equal(numberWords(-1), '-1');
});

test('plural: 1, 2–4, 5+, and the teens', () => {
  const f = ['процент', 'процента', 'процентов'];
  assert.deepEqual([1, 2, 5, 11, 12, 21, 22, 25, 111].map((n) => plural(n, f)), ['процент', 'процента', 'процентов', 'процентов', 'процентов', 'процент', 'процента', 'процентов', 'процентов']);
});

test('latinWord: a known name, an abbreviation by letters, anything else by its sounds', () => {
  assert.equal(latinWord('Claude'), 'клод');
  assert.equal(latinWord('README'), 'ридми');
  assert.equal(latinWord('XYZ'), 'экс уай зед');
  assert.equal(latinWord('drawer'), 'дравер');
  assert.equal(latinWord('cell'), 'селл');
  assert.ok(!/[a-z]/i.test(latinWord('Quickshot')));
});

test('speechText: nothing Latin and no digit is left — the voice would drop them', () => {
  const t = speechText('Claude: 25 задач, 2 бага, 2075 тестов, 12% готово, в 18:52, drawer.js и 1 000 строк, 2.5 с.');
  assert.ok(!/[A-Za-z0-9]/.test(t), t);
  assert.match(t, /^клод: двадцать пять задач, два бага, две тысячи семьдесят пять тестов, двенадцать процентов готово, в восемнадцать пятьдесят две, дравер джей эс и тысяча строк, два и пять с\.$/);
  assert.match(speechText('2 задачи и 1 минута'), /^две задачи и одна минута$/);
  assert.equal(speechText(''), '');
  assert.equal(speechText('Просто текст.'), 'Просто текст.');
});
