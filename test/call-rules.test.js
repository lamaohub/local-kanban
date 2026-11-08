// is there. The leaf public/js/call-rules.js, run in node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  callMemory, callsOf, callWords, intentOf, lastReport, lastWords, lineUp, pickOption, plain, replyOf, speakable, spokenOrdinal, yesNo,
} from '../public/js/call-rules.js';

test('speakable: no code, links, paths or marks — the first few sentences', () => {
  const md = '## Done\n\nFixed the `chat` route in `/home/user/code/board/src/routes/chat.js`, see [the PR](https://x.y/1).\n\n```js\nconst a = 1;\n```\n\n- **first** point\n- second point\n\nAnd a fifth sentence. And a sixth.';
  const s = speakable(md);
  assert.ok(!/```|const a|https?:|\/home|\*\*|##/.test(s), s);
  assert.match(s, /^Done\. Fixed the chat route in chat\.js, see the PR\./);
  assert.ok(s.split(/(?<=[.!?…])\s/).length <= 3, s);
  assert.equal(speakable(''), '');
  assert.equal(speakable('```\nonly code\n```'), '');
});

test('speakable: a cut ending on a lone abbreviation drops it', () => {
  assert.equal(speakable('Кнопка уезжала. Ужал строку. См. drawer.js в коде.'), 'Кнопка уезжала. Ужал строку.');
  assert.equal(speakable('Done. Fixed it. Bye.'), 'Done. Fixed it. Bye.');
  assert.equal(speakable('Готово. Всё работает. Да.'), 'Готово. Всё работает. Да.');
});

test('speakable: a long sentence is cut at a word, within the bound', () => {
  const s = speakable('word '.repeat(200), { chars: 100 });
  assert.ok(s.length <= 101, String(s.length));
  assert.match(s, /…$/);
});

test('plain: case, ё, punctuation', () => {
  assert.equal(plain('  Всё, ПРИНЯТЬ!  '), 'все принять');
});

test('intentOf: short commands are the board\'s, anything longer is words for Claude', () => {
  assert.equal(intentOf('Принять', 'review').act, 'accept');
  assert.equal(intentOf('да, принимаю', 'review').act, 'accept');
  assert.equal(intentOf('accept it', 'review').act, 'accept');
  // «accept» only for a task handed in — elsewhere it is words for Claude
  assert.equal(intentOf('принять', 'waiting').act, 'say');
  assert.equal(intentOf('потом', 'review').act, 'later');
  assert.equal(intentOf('не сейчас', 'waiting').act, 'later');
  assert.equal(intentOf('ну всё, пока', 'review').act, 'hangup');
  assert.equal(intentOf('отбой', 'question').act, 'hangup');
  const long = intentOf('принять можно, но сначала поправь кнопку на телефоне', 'review');
  assert.equal(long.act, 'say');
  assert.equal(long.words, 'принять можно, но сначала поправь кнопку на телефоне');
  assert.equal(intentOf('   ', 'review').act, 'none');
  assert.equal(intentOf('нет, не принимаю', 'review').act, 'say');
});

test('yesNo: no wins, and «не надо» is not «надо»', () => {
  assert.equal(yesNo('да'), true);
  assert.equal(yesNo('Да, давай'), true);
  assert.equal(yesNo('yes'), true);
  assert.equal(yesNo('нет'), false);
  assert.equal(yesNo('не надо'), false);
  assert.equal(yesNo('да нет'), false);
  assert.equal(yesNo('сделай по-другому, через базу данных и кэш'), null);
});

test('pickOption: by number, by the label, by yes / no', () => {
  const labels = ['Оставить как есть (Recommended)', 'Переписать модуль', 'Спросить позже'];
  assert.equal(pickOption('второй', labels), 1);
  assert.equal(pickOption('давай третий', labels), 2);
  assert.equal(pickOption('1', labels), 0);
  assert.equal(pickOption('first', labels), 0);
  assert.equal(pickOption('оставить как есть', labels), 0);
  assert.equal(pickOption('переписать', labels), 1);
  assert.equal(pickOption('что-то совсем другое и длинное про погоду', labels), -1);
  assert.equal(pickOption('да', ['Yes, allow', 'No']), 0);
  assert.equal(pickOption('нет', ['Да', 'Нет, не надо']), 1);
  // a number past the options is no pick
  assert.equal(pickOption('пятый', labels), -1);
});

test('callWords: the words with how to answer, in the board\'s language', () => {
  assert.match(callWords('  поправь кнопку ', 'ru'), /^\[Голосовой звонок с доски\.[^\]]*коротк[^\]]*\] поправь кнопку$/);
  assert.match(callWords('fix it', 'en'), /^\[A voice call from the board\.[^\]]*short[^\]]*\] fix it$/);
  assert.match(callWords('x', 'de'), /^\[A voice call/);
});

test('spokenOrdinal: the n-th option aloud', () => {
  assert.equal(spokenOrdinal(1, 'ru'), 'Второй');
  assert.equal(spokenOrdinal(0, 'en'), 'One');
  assert.equal(spokenOrdinal(9, 'en'), '10');
});

test('replyOf: waits while Claude is at it, then the last words of the turn after the words sent', () => {
  const sent = 1_000_000;
  const old = { at: sent - 60_000, open: false, items: [{ kind: 'text', text: 'old answer' }] };
  assert.deepEqual(replyOf({ turns: [old] }, sent), { kind: 'wait' }); // the words not taken yet
  const going = { at: sent + 1000, open: true, items: [{ kind: 'text', text: 'half' }] };
  assert.deepEqual(replyOf({ turns: [old, going] }, sent), { kind: 'wait' });
  const done = { ...going, open: false, items: [{ kind: 'text', text: 'first' }, { kind: 'tool', tool: 'Bash' }, { kind: 'text', text: 'Готово, поправил.' }] };
  assert.deepEqual(replyOf({ turns: [old, done], working: true }, sent), { kind: 'wait' }); // helpers still at work
  assert.deepEqual(replyOf({ turns: [old, done], queue: [{ id: 1 }] }, sent), { kind: 'wait' });
  assert.deepEqual(replyOf({ turns: [old, done], state: 'idle' }, sent), { kind: 'text', text: 'Готово, поправил.' });
  const silent = { at: sent + 1000, open: false, items: [{ kind: 'tool', tool: 'Bash' }] };
  assert.deepEqual(replyOf({ turns: [silent] }, sent), { kind: 'none' });
  const choice = { text: 'Which?', options: [{ n: 1, label: 'A' }] };
  assert.deepEqual(replyOf({ turns: [going], state: 'question', choice }, sent), { kind: 'question', choice });
  assert.deepEqual(replyOf({ same: true }, sent), { kind: 'wait' });
  assert.deepEqual(replyOf(null, sent), { kind: 'wait' });
});

test('lastWords and lastReport', () => {
  assert.equal(lastWords({ turns: [{ items: [{ kind: 'text', text: 'a' }] }, { items: [{ kind: 'tool' }] }] }), 'a');
  assert.equal(lastWords(null), '');
  assert.equal(lastReport([{ author: 'claude', body: 'first' }, { author: 'me', body: 'mine' }, { author: 'claude', body: 'second' }, { author: 'board', body: 'stat' }]), 'second');
  assert.equal(lastReport([]), '');
  assert.equal(lastReport(undefined), '');
});

test('lineUp: one call a task, the newest reason, unknown reasons left out', () => {
  let line = [];
  line = lineUp(line, { id: 1, key: 'A-1', why: 'waiting' });
  line = lineUp(line, { id: 2, key: 'A-2', why: 'review' });
  line = lineUp(line, { id: 1, key: 'A-1', why: 'review' });
  assert.deepEqual(line.map((x) => `${x.key}:${x.why}`), ['A-2:review', 'A-1:review']);
  assert.equal(lineUp(line, { id: 3, key: 'A-3', why: 'limit' }), line);
  assert.equal(lineUp(line, { id: 3, why: 'review' }), line);
});

test('callsOf: a real move into Review or Ready, a request to the board', () => {
  const m = callMemory();
  const up = (data) => callsOf({ type: 'task.updated', data }, m);
  assert.deepEqual(up({ id: 1, key: 'A-1', project: 'a', title: 'T', status: 'review', prev_status: 'doing' }), [{ id: 1, key: 'A-1', project: 'a', title: 'T', why: 'review' }]);
  assert.equal(up({ id: 1, key: 'A-1', status: 'ready', prev_status: 'doing' })[0].why, 'ready');
  assert.deepEqual(up({ id: 1, key: 'A-1', status: 'review', prev_status: 'review' }), [], 'an edit of a task in Review');
  assert.deepEqual(up({ id: 1, key: 'A-1', status: 'review' }), [], 'no prev_status — not known to be a move');
  assert.deepEqual(up({ id: 1, key: 'A-1', status: 'done', prev_status: 'review' }), []);
  assert.deepEqual(callsOf({ type: 'ask.created', data: { id: 'x', task_id: 3, key: 'A-3', project: 'a' } }, m), [{ id: 3, key: 'A-3', project: 'a', title: '', why: 'ask' }]);
  assert.deepEqual(callsOf({ type: 'ask.removed', data: { id: 'x' } }, m), []);
  assert.deepEqual(callsOf(null, m), []);
});

test('callsOf: a Claude that stopped working to wait — not the first picture, not a limit, a broken answer or Ready', () => {
  const m = callMemory();
  const live = (tasks, questions = []) => callsOf({ type: 'task.live', data: { tasks, questions } }, m).map((x) => `${x.key}:${x.why}`);
  const t = (claude, x = {}) => ({ id: 1, key: 'A-1', status: 'doing', claude, ...x });
  assert.deepEqual(live([t('waiting')], [{ id: 2, key: 'A-2' }]), [], 'the first picture calls about nothing');
  assert.deepEqual(live([t('busy')], [{ id: 2, key: 'A-2' }]), [], 'a question open before stays quiet');
  assert.deepEqual(live([t('waiting')]), ['A-1:waiting']);
  assert.deepEqual(live([t('waiting')]), [], 'still waiting — no second call');
  live([t('background')]);
  assert.deepEqual(live([t('idle')]), ['A-1:waiting']);
  live([t('busy')]);
  assert.deepEqual(live([t('limit')]), []);
  live([t('busy')]);
  assert.deepEqual(live([t('waiting', { broke: 'stuck' })]), []);
  live([t('busy', { status: 'ready' })]);
  assert.deepEqual(live([t('waiting', { status: 'ready' })]), []);
  assert.deepEqual(live([t('busy')], [{ id: 5, key: 'A-5' }]), ['A-5:question']);
  assert.deepEqual(live([t('busy')], [{ id: 5, key: 'A-5' }]), [], 'the same question — one call');
  assert.deepEqual(callsOf({ type: 'task.live', data: {} }, m), []);
});
