import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

process.env.KB_DATA_DIR = mkdtempSync(join(tmpdir(), 'kb-turn-ends-')); // the feed reaches the board's database
const { answersOf, chatItems, chatTurns, commandWords } = await import('../src/chat-feed.js');

function page() {
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [], document: { addEventListener: () => {} },
    setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false, setDrawerFull: () => {}, openDrawerFull: () => {},
    setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false, copyText: async () => true, plainLabel: (x) => String(x),
  };
  vm.runInNewContext(`${src}\nthis.turnHTML = turnHTML; this.carryOpened = carryOpened; this.answersHTML = answersHTML;`, box);
  return box;
}
const step = (text, more = {}) => ({ kind: 'tool', tool: 'Bash', text, ms: 1000, error: false, ...more });

test('a turn woken after its end goes on, and its time is the sum of its runs', () => {
  const [t] = chatTurns([{ kind: 'user', at: 1, text: 'go' }, { kind: 'text', at: 2, text: 'a' }, { kind: 'end', at: 3, ms: 1000 },
    { kind: 'text', at: 4, text: 'woken by a helper' }]);
  assert.equal(t.open, true, 'Claude at work again showed a finished bar with the new work hidden in it');
  const [u] = chatTurns([{ kind: 'user', at: 1, text: 'go' }, { kind: 'end', at: 3, ms: 1000 }, { kind: 'text', at: 4, text: 'b' }, { kind: 'end', at: 5, ms: 500 }]);
  assert.equal(u.ms, 1500, 'the second end took the place of the first');
  assert.equal(u.open, false);
});

test('the person\'s next words end the turn before — the Claude app writes no end of a turn', () => {
  const turns = chatTurns([{ kind: 'user', at: 1, text: 'one' }, { kind: 'text', at: 2, text: 'a' }, { kind: 'user', at: 3, text: 'two' }, { kind: 'text', at: 4, text: 'b' }]);
  assert.deepEqual(turns.map((t) => [t.open, t.ms]), [[false, null], [true, null]]);
  const box = page();
  const html = box.turnHTML({ ...turns[0], at: 't', items: [step('ls'), { kind: 'text', text: 'Done here.' }] });
  assert.match(html, /class="chat-done"[^]*Done/, 'a finished turn of the app has no bar');
  assert.match(html, /Done here\./);
  // a stopped turn keeps its runs and its «Stopped»
  assert.match(box.turnHTML({ at: 't', user: 'x', ms: null, open: false, items: [step('ls'), { kind: 'stop' }] }), /class="chat-run"/);
});

test('steps opened while the turn went on stay open when it ends', () => {
  const box = page();
  const opened = new Set(['t|0', 'u|1']);
  const turn = { at: 't', user: 'go', ms: 2000, open: false, items: [step('one'), step('two'), { kind: 'text', text: 'ok' }] };
  box.carryOpened([turn], opened);
  assert.ok(opened.has('t|work'), 'the open run shut itself when the turn ended');
  assert.ok(!opened.has('t|0'));
  assert.ok(opened.has('u|1'), 'a run of another turn was touched');
  assert.match(box.turnHTML(turn, { opened }), /class="chat-done open"/);
});

test('a change of unknown size shows no numbers, not «+0 −0»', () => {
  const box = page();
  const turn = { at: 't', user: 'go', ms: 2000, open: false, items: [step('a.ipynb', { tool: 'NotebookEdit' }), { kind: 'text', text: 'ok' }] };
  const html = box.turnHTML(turn);
  assert.match(html, /Files changed: 1/);
  assert.doesNotMatch(html, /chat-add/, 'a notebook edit read as nothing changed');
  const known = box.turnHTML({ ...turn, items: [step('a.js', { tool: 'Edit', diff: { add: 0, del: 3 } }), { kind: 'text', text: 'ok' }] });
  assert.match(known, /\+0<\/span><span class="chat-del">−3/);
});

test('a question takes only its own answer, and an answer with quotes in it whole', () => {
  assert.deepEqual(answersOf([{ q: 'Q' }, { q: 'Q2' }], null, 'User has answered your questions: "Q2"="two". You can now continue.'), [{ q: 'Q2', a: 'two' }],
    'Q took the answer of Q2');
  assert.deepEqual(answersOf([{ q: 'Q' }, { q: 'Q2' }], { Q2: 'two' }, ''), [{ q: 'Q2', a: 'two' }], 'Q took the answer of Q2 from the answers map');
  assert.deepEqual(answersOf([{ q: 'Which?' }, { q: 'And?' }], null,
    'User has answered your questions: "Which?"="the "big" one, yes", "And?"="x". You can now continue with the user\'s answers in mind.'),
  [{ q: 'Which?', a: 'the "big" one, yes' }, { q: 'And?', a: 'x' }]);
  assert.deepEqual(answersOf([{ q: 'A long question…' }], null, '"A long question that the board clipped"="yes"'), [{ q: 'A long question…', a: 'yes' }]);
});

test('a slash command the person typed (a skill from the menu) is their words; /model and /compact are not', () => {
  const line = (text) => ({ type: 'user', timestamp: '2026-10-23T03:00:00.000Z', message: { role: 'user', content: text } });
  const [said] = chatItems(line('<command-message>deploy-acc</command-message>\n<command-name>/deploy-acc</command-name>\n<command-args>roll out AC-1</command-args>'));
  assert.equal(said?.kind, 'user', 'a skill called from the chat made no turn');
  assert.equal(said.text, '/deploy-acc roll out AC-1');
  assert.equal(commandWords('<command-name>/model</command-name><command-args>claude-sonnet-5-5</command-args>'), null);
  assert.equal(commandWords('<command-name>/compact</command-name>'), null);
  assert.equal(commandWords('<command-name>/demo</command-name><command-args></command-args>'), '/demo');
});

test('the answer in the person\'s bubble is escaped', () => {
  const html = page().answersHTML([{ q: 'Q', a: '<img src=x onerror=alert(1)>' }]);
  assert.doesNotMatch(html, /<img/);
});

test('the chat holds the parts of CK-765 together', () => {
  const chat = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');
  assert.match(chat, /carryOpened\(d\.turns, c\.opened\);\s*log\.innerHTML =/, 'the opened runs are not carried before the chat is drawn');
  // an answered form fades out before the request leaving takes it
  assert.match(chat, /function dropAsk\(\) \{\s*if \(!c\.askId\) return;[^]*?if \(c\.askFading\)/, 'the request leaving cuts the fade');
  assert.match(chat, /c\.askFading = going \? \{ going \} : null;/);
  // the request leaves before the answer's own POST comes back: the fade starts there, not after
  assert.match(chat, /if \(!c\.askFading && isSending\(c\.askId\)\) fadeAsk\(c\.askId\);/);
  assert.match(chat, /if \(c\.askId\) \{ dropAsk\(\);[^\n]*if \(c\.askFading\) return; \}/, 'the tail of the screen wipes the fading form');
  // a refusal is said for a Claude outside the board too, and ✕ on a queued model goes back to the one picked before
  assert.match(chat, /: c\.refused \|\| ended \|\| \(!d\.send \? tr\('This Claude does not run inside the board/);
  assert.match(chat, /c\.modelWant = c\.modelWant\.prev \|\| null;/);
  // an answer that never reached Claude takes its bubble back and says so at the field
  assert.match(chat, /onLost: \(why\) => answerLost\(a, why\)/);
  assert.match(chat, /function answerLost\(a, why\) \{[^]*?x\.ask !== a\.id[^]*?c\.refused = tr\(why\)/);
  // a thumbnail redrawn mid-slide goes on from where it was
  assert.match(chat, /animation-delay: -\$\{t\}ms/);
  const asks = readFileSync(new URL('../public/js/asks.js', import.meta.url), 'utf8');
  assert.match(asks, /if \(e\.status === 404 \|\| e\.status === 409\) \{[^]*?lost\?\.\(why\)[^]*?chatAsksChanged\(\);/, 'a refused form stays frozen in the chat');
  assert.match(asks, /lostHandlers\.get\(d\.id\)[^]*?d\.outcome !== 'decided' && sending\.has\(d\.id\)/);
  assert.match(asks, /chatAsksChanged\(\);(?:\s*\/\/[^\n]*)*\s*if \(ev\.type !== 'ask\.created'\) sending\.delete\(d\.id\);/, 'the answer on its way is forgotten before the chat sees its request go — the form vanishes');
});

test('a run of steps says what Claude did: one change by its file and lines, kinds in order, a picture it read', () => {
  const box = page();
  const going = (items) => box.turnHTML({ at: 't', user: 'go', ms: null, open: true, items: [...items, { kind: 'text', text: 'ok' }] },
    { pic: (id) => `/pic/${id}` });
  const edit = (file, diff, more = {}) => step(file, { tool: 'Edit', diff, ...more });
  assert.match(going([edit('/p/notes/note.md', { add: 33, del: 34 })]),
    /<span class="chat-run-t">Updated <span class="chat-run-file" title="\/p\/notes\/note\.md">note\.md<\/span><\/span><span class="chat-add">\+33<\/span><span class="chat-del">−34</);
  const mixed = going([step('ls'), edit('a.js', { add: 2, del: 1 }), step('x', { tool: 'Read' }), edit('b.js', { add: 1, del: 0 }), step('y', { tool: 'Grep', error: true })]);
  assert.match(mixed, /Ran a command, edited 2 files, read a file, searched the code<\/span><span class="chat-add">\+3<\/span><span class="chat-del">−1<\/span><span class="chat-x">✗ 1</);
  assert.doesNotMatch(going([edit('a.js', { add: 1, del: 0 }), edit('n.ipynb', undefined, { tool: 'NotebookEdit' })]), /chat-add/, 'a change of unknown size summed to numbers');
  assert.match(going([step('Check the docs', { tool: 'Agent', bg: true, running: false }), step('tests', { bg: true, running: true, ms: undefined })]),
    /Finished a background task, started a background task</);
  const seen = going([step('shot.png', { tool: 'Read', pic: 'toolu_1' })]);
  assert.match(seen, /<img class="chat-run-pic" data-pic="toolu_1" src="\/pic\/toolu_1"/, 'the picture Claude read is not on its line, or does not open on a click');
  assert.match(box.turnHTML({ at: 't', user: 'go', ms: null, open: true, items: [step('a & <b>')] }, { opened: new Set(['t|0']) }),
    /class="chat-unfold chat-runbox" data-of="t\|0"><div class="chat-step"[^]*a &amp; &lt;b&gt;/, 'an opened run does not show its steps in a frame, escaped');
});

test('the run Claude is in: any step still unanswered of the last run, and none while a question waits for the person', () => {
  const box = page();
  const turn = { at: 't', user: 'go', ms: null, open: true, items: [step('long tests', { ms: undefined, at: '2026-01-01T00:00:00.000Z' }), step('a.js', { tool: 'Read', ms: 50 })] };
  assert.match(box.turnHTML(turn, { working: true }), /class="chat-run now"[^]*Running a command/, 'a step side by side answered first put the light out');
  assert.doesNotMatch(box.turnHTML(turn, { working: true, asking: true }), /chat-run now/, 'a step waiting on a question ticks as running');
});
