// the rules run from their module, the light from the page's own chat.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { paceOnScreen } from '../src/phantom.js';
import { chatTurns } from '../src/chat-feed.js';
import { STALL_MS, paceStep, paceWords, stalled } from '../public/js/pace-rules.js';

const BOX = '─────────────────────────────────────────────\n❯ \n─────────────────────────────────────────────\n  ⬆ /gsd-update │ Opus 5.5 │ claude-kanban…\n  ⏵⏵ auto mode on (shift+tab to cycle)\n';
const on = (spinner, under = '') => `● Reading the file\n  ⎿  Read 12 lines\n\n${spinner}\n${under}${BOX}`;

test('the spinner in every form Claude Code draws it', () => {
  assert.deepEqual(paceOnScreen(on('✻ Flambéing… (38s · ↓ 3.2k tokens)')), { tokens: 3200 });
  assert.deepEqual(paceOnScreen(on('✽ Fiddle-faddling… (1m 3s · thinking)')), { thinking: true });
  assert.deepEqual(paceOnScreen(on('✳ Fiddle-faddling… (50s · thought for 3s)')), { thinking: true });
  assert.deepEqual(paceOnScreen(on('✶ Fiddle-faddling… (1m 11s)')), {});
  assert.deepEqual(paceOnScreen(on('· Architecting… (1h 6m 51s · ↓ 57 tokens)')), { tokens: 57 });
  assert.deepEqual(paceOnScreen(on('✻ Writing… (6m 51s · ↑ 1.2m tokens)')), { tokens: 1200000 });
  assert.deepEqual(paceOnScreen(on('✻ Compacting conversation… (1m 2s)')), { compacting: true });
  assert.deepEqual(paceOnScreen(on('✶ Fiddle-faddling… (9m 17s · ↓ 49.8k tokens · thinking)')), { tokens: 49800, thinking: true }, 'a wide window keeps both');
  assert.deepEqual(paceOnScreen(on('· Fiddle-faddling… (9m 6s · thinking more)')), { thinking: true });
  assert.deepEqual(paceOnScreen(on('· Fiddle-faddling… (16s · still thinking)')), { thinking: true });
});

test('tips and the to-do list stand under the spinner, a narrow window wraps it', () => {
  assert.deepEqual(paceOnScreen(on('✻ Flambéing… (38s · ↓ 3.2k tokens)', '  ⎿  Tip: Use /btw to ask a quick side\n     question without interrupting Claude\'s\n     current work\n')), { tokens: 3200 });
  assert.deepEqual(paceOnScreen(on('✻ Fiddle-faddling-and-more… (1m 3s · ↓ 12.3k\n  tokens)')), { tokens: 12300 });
});

test('nothing else is taken for the spinner', () => {
  assert.equal(paceOnScreen(on('✻ Cooked for 2m 29s · done 2:43 PM')), null, 'the end of a turn');
  assert.equal(paceOnScreen(on('● Done… (38s · ↓ 3.2k tokens)')), null, 'words of Claude');
  assert.equal(paceOnScreen('✻ Flambéing… (38s · ↓ 3.2k tokens)\nno input box here\n'), null, 'no input box: a dialog, or no Claude');
  assert.equal(paceOnScreen(''), null);
});

test('a step tells how long Claude took to write it', () => {
  const at = (s) => Date.parse('2026-10-30T12:00:00Z') + s * 1000;
  const items = [
    { kind: 'user', at: at(0), text: 'go' },
    { kind: 'tool', at: at(91), id: 'a', tool: 'Bash', text: 'script' },
    { kind: 'result', at: at(110), id: 'a' },
    { kind: 'tool', at: at(111), id: 'b', tool: 'Read', text: 'moments after the answer' },
    { kind: 'tool', at: at(112), id: 'c', tool: 'Read', text: 'one answer, side by side' },
    { kind: 'result', at: at(113), id: 'b' },
    { kind: 'result', at: at(113), id: 'c' },
    { kind: 'tool', at: at(113 + 3600), id: 'd', tool: 'Bash', text: 'after a pause of an hour' },
  ];
  const [turn] = chatTurns(items);
  const steps = Object.fromEntries(turn.items.filter((it) => it.kind === 'tool').map((it) => [it.id, it]));
  assert.equal(steps.a.wrote, 91000);
  assert.equal(steps.a.ms, 19000, 'running it stays apart');
  assert.equal(steps.b.wrote, undefined);
  assert.equal(steps.c.wrote, undefined);
  assert.equal(steps.d.wrote, undefined, 'a pause is no writing');
});

test('the words of the light', () => {
  assert.equal(paceWords({ tokens: 10 }, false), 'Claude is writing…');
  assert.equal(paceWords({ thinking: true }, false), 'Claude is thinking…');
  assert.equal(paceWords({}, false), 'Claude is working…');
  assert.equal(paceWords({ tokens: 10 }, true), 'Claude is working…', 'a step runs: the tokens are of what came before');
  assert.equal(paceWords({ compacting: true, tokens: 10 }, false), 'Claude is working…');
});

test('a Claude is silent only when it should be writing', () => {
  const mark = paceStep(null, 's', 0);
  assert.equal(paceStep(mark, 's', 5000), mark, 'the same words keep their moment');
  assert.equal(paceStep(mark, 'other', 5000).at, 5000);
  assert.equal(stalled({ tokens: 10 }, false, mark, STALL_MS - 1), false);
  assert.equal(stalled({ tokens: 10 }, false, mark, STALL_MS), true);
  assert.equal(stalled({}, false, mark, STALL_MS), false, 'no counter on the line: it may not fit the window, the 10 KB script of 2.1.314 wrote under such a line');
  assert.equal(stalled({ tokens: 10 }, true, mark, STALL_MS), false, 'a long command');
  assert.equal(stalled({ thinking: true }, false, mark, STALL_MS), false, 'thinking has no counter to watch');
  assert.equal(stalled({ compacting: true }, false, mark, STALL_MS), false);
  assert.equal(stalled(null, false, mark, STALL_MS), false, 'no spinner: a Claude outside the board');
});

function page() {
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), paceWords,
    document: { addEventListener: () => {} }, globalThis: { navigator: {} }, setTimeout, clearTimeout,
  };
  vm.runInNewContext(`${src}\nthis.workingLine = workingLine; this.turnHTML = turnHTML;`, box);
  return box;
}
const AT = '2026-10-30T12:00:00.000Z';
const step = { kind: 'tool', tool: 'Bash', text: 'Render', at: AT, ms: 19000 };

test('the light says for how long, in a text that stays the same between looks', () => {
  const box = page();
  const turn = { at: AT, open: true, items: [step] };
  const html = box.workingLine({ working: true, turns: [turn], pace: { tokens: 100 } });
  assert.match(html, /chat-working-t">Claude is writing…</);
  assert.match(html, /data-since="2026-10-30T12:00:19\.000Z"/, 'from the end of the last step: the transcript is silent since');
  assert.equal(box.workingLine({ working: true, turns: [turn], pace: { tokens: 900 } }), html, 'a new count draws the light anew, and the pulse starts over');
  assert.match(box.workingLine({ working: true, turns: [{ ...turn, open: false }] }), /background/);
  assert.doesNotMatch(box.workingLine({ working: true, turns: [{ ...turn, open: false }] }), /chat-working-m/, 'a turn over: no time to tell');
});

test('the light of a silent Claude says so, and since when', () => {
  const box = page();
  const html = box.workingLine({ working: true, turns: [{ at: AT, open: true, items: [step] }], pace: { tokens: 5 } }, Date.parse(AT));
  assert.match(html, /class="chat-working stalled"/);
  assert.match(html, /no answer for <span class="chat-run-time" data-since="2026-10-30T12:00:00\.000Z"/);
});

test('a step and a run tell writing from running', () => {
  const box = page();
  const row = box.turnHTML({ at: AT, open: true, items: [{ ...step, wrote: 91000 }] }, { opened: new Set([`${AT}|0`]), working: false });
  assert.match(row, /chat-run-times[^>]*>wrote for 1 min 31 s · ran for 19 s</);
  assert.match(row, /chat-step-d[^>]*>wrote for 1 min 31 s · ran for 19 s ✓</);
  const quick = box.turnHTML({ at: AT, open: true, items: [{ ...step, wrote: 4000 }] }, { opened: new Set(), working: false });
  assert.doesNotMatch(quick, /chat-run-times/, 'a step written in moments keeps the line short');
});
