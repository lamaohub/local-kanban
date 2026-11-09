// «Changes», an element pointed at — start a new Claude ONLY when the board has none on the task; a full queue, another
// board's terminal, words not typed or an error are said, and the words are kept (they were lost to a second Claude).
// And when the branch row offers a pull request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORDS_SAID, prButtonShown, prMark, sendWords } from '../public/js/branch-rules.js';

const refused = (status, reason) => Object.assign(new Error(reason || String(status)), { status, body: { error: 'x', ...(reason ? { reason } : {}) } });

test('the words go to the chat; queued is said as queued; a new Claude only when the board has none on the task', async () => {
  const run = async (answer) => {
    const started = [];
    const r = await sendWords('fix it', {
      post: async (text) => { assert.equal(text, 'fix it'); if (answer instanceof Error) throw answer; return answer; },
      launch: async () => { started.push(1); },
    });
    return { ...r, started: started.length };
  };
  assert.deepEqual(await run({ sent: true }), { how: 'chat', started: 0 });
  assert.deepEqual(await run({ queued: true, id: 3 }), { how: 'queued', started: 0 });
  assert.deepEqual(await run(refused(409, 'gone')), { how: 'launch', started: 1 });
  for (const e of [refused(409, 'full'), refused(409, 'other-board'), refused(409, 'not-typed'), refused(409, 'not-sent'), refused(409, 'no-box'),
    refused(409, 'tmux-slow'), refused(409, 'question'), refused(400), refused(500), refused(404), Object.assign(new Error('x'), { offline: true })]) {
    const r = await run(e);
    assert.deepEqual([r.how, r.started, r.error], ['refused', 0, e], `${e.body?.reason || e.status || 'offline'}: a second Claude was started with the words`);
  }
  assert.ok(WORDS_SAID.queued && WORDS_SAID.chat && WORDS_SAID.launch);
});

test('every place that sends such words goes through sendWords and keeps them on a refusal', () => {
  const src = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  const changes = src('changes.js');
  assert.doesNotMatch(changes, /launchInClaude/, 'changes.js starts Claude past the rule');
  assert.match(changes, /wordsToClaude\(/);
  assert.match(changes, /if \(r\.how === 'refused'\) \{[^}]*return; \}/, 'the remarks are dropped on a refusal');
  const drawer = src('drawer.js');
  const words = drawer.slice(drawer.indexOf('export function wordsToClaude('));
  assert.match(words.slice(0, 600), /sendWords\(text, \{/);
  assert.match(drawer, /fix\.onclick = async \(\) => \{[\s\S]{0,700}r\.how === 'refused'/, '«Let Claude resolve it» does not say a refusal');
  assert.match(src('pick.js'), /r\.how === 'refused'/, 'the element pointed at is dropped on a refusal');
});

test('«Open a pull request»: none yet; merged or closed with commits past it; never next to an open one', () => {
  const pr = (state) => ({ url: 'u', number: 7, state });
  assert.equal(prButtonShown({ ahead: 1, pr: null }), true);
  assert.equal(prButtonShown({ ahead: 0, pr: null }), false);
  assert.equal(prButtonShown({ ahead: 2, pr: pr('OPEN'), ahead_of_pr: 1 }), false);
  assert.equal(prButtonShown({ ahead: 2, pr: pr('MERGED'), ahead_of_pr: 1 }), true);
  assert.equal(prButtonShown({ ahead: 2, pr: pr('CLOSED'), ahead_of_pr: null }), true, 'not known — offered');
  assert.equal(prButtonShown({ ahead: 2, pr: pr('MERGED'), ahead_of_pr: 0 }), false, 'nothing new since the merge');
  assert.equal(prButtonShown({ ahead: 0, pr: pr('MERGED'), ahead_of_pr: 1 }), false);
  assert.deepEqual(prMark({ status: 'ready', pr: pr('OPEN') }), { number: 7, state: 'open' });
  assert.deepEqual(prMark({ status: 'review', pr: pr('CLOSED') }), { number: 7, state: 'closed' });
  assert.equal(prMark({ status: 'cancelled', pr: pr('OPEN') }), null);
  assert.equal(prMark({ status: 'doing', pr: null }), null);
});
