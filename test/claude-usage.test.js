// What a task cost: tokens, approximate money and how full the conversation memory was, counted from
// the transcripts of the task's Claude sessions with the same cut as the work feed.
// The rules are pinned down on plain data first (prices, one count per API answer, the regions of a
// session's time, the line and the block on screen), then the whole path runs over a fake Claude
// directory: transcript lines → the task's stretches → the database → the card, the dashboard and kb.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { memoryText, moneyText, tokenParts, tokensText, usageLine, usageNotes, usagePanel } from '../public/js/usage-rules.js';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
let app, base, tmp, claude, dir, db, usage, emit;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  dir = join(claude, 'projects', '-usage');
  mkdirSync(dir, { recursive: true });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  usage = await import('../src/claude-usage.js');
  ({ emit } = await import('../src/bus.js'));
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('usage','US','usage',1)").run();
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.register((await import('../src/routes/dashboard.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

/* ── transcript lines ── */
const at = (ms) => new Date(ms).toISOString();
const stamp = (ms) => at(ms).slice(0, 19).replace('T', ' '); // task_events keep UTC seconds
const say = (ms, text) => ({ type: 'user', timestamp: at(ms), message: { role: 'user', content: text } });
const U = (input, output, read, w5 = 0, w1 = 0, extra = {}) => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: w5 + w1,
  cache_creation: { ephemeral_5m_input_tokens: w5, ephemeral_1h_input_tokens: w1 }, service_tier: 'standard', speed: 'standard', ...extra,
});
const reply = (ms, id, usage, { model = 'claude-opus-5-5', content = [{ type: 'text', text: 'ok' }], stop = 'end_turn', side = false } = {}) => ({
  type: 'assistant', timestamp: at(ms), ...(side ? { isSidechain: true } : {}),
  message: { id, model, role: 'assistant', type: 'message', content, stop_reason: stop, usage },
});
const call = (id) => [{ type: 'tool_use', id, name: 'Agent', input: { description: `helper ${id}` } }];
const lines = (list) => list.map((l) => JSON.stringify(l)).join('\n') + '\n';
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg || ''} ${a} != ${b}`);
// the money a route answers with is rounded to a millionth of a dollar
const money = (a, b, msg) => assert.ok(Math.abs(a - b) <= 5e-7, `${msg || ''} ${a} != ${b}`);

let taskNo = 0;
function newTask(title = 'Task') {
  taskNo += 1;
  const pid = db.prepare("SELECT id FROM projects WHERE slug='usage'").get().id;
  const id = Number(db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, 'todo')").run(pid, taskNo, `${title} ${taskNo}`).lastInsertRowid);
  return { id, key: `US-${taskNo}` };
}
// the session moves the task (kb sends its id); the journal keeps whole seconds, so moves are stamped where the test says
async function move(task, status, when, sid) {
  const r = await app.inject({ method: 'PATCH', url: `/api/tasks/${task.key}`, headers: sid ? { 'x-claude-session': sid } : {}, payload: { status } });
  assert.equal(r.statusCode, 200, r.body);
  db.prepare('UPDATE task_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM task_events)').run(stamp(when));
}
const usageOf = async (task) => (await app.inject({ method: 'GET', url: `/api/tasks/${task.key}/usage` })).json().usage;
const file = (sid) => join(dir, `${sid}.jsonl`);

// every byte the count reads goes through FileHandle.read — the same probe as the work feed's tests
async function countReads(fn) {
  const { open } = await import('node:fs/promises');
  const probe = await open(KB, 'r');
  const FH = Object.getPrototypeOf(probe);
  await probe.close();
  const orig = FH.read;
  let bytes = 0;
  FH.read = async function (...a) { const r = await orig.apply(this, a); bytes += r.bytesRead || 0; return r; };
  try { await fn(); } finally { FH.read = orig; }
  return bytes;
}

/* ── prices ── */
test('prices: input, output, cache read and the two cache writes; the fast mode; dated and provider names', () => {
  const M = { input: 1e6, output: 1e6, cache_read: 1e6, cache_5m: 1e6, cache_1h: 1e6 };
  close(usage.costOf('claude-opus-5-5', 0, M), 4 + 20 + 0.2 + 4 * 1.25 + 4 * 2, 'opus 5.5');
  close(usage.costOf('claude-opus-5-5', 1, M), 8 + 40 + 0.4 + 8 * 1.25 + 8 * 2, 'opus 5.5 fast: the premium covers every input kind');
  close(usage.costOf('claude-opus-5', 1, M), 10 + 50 + 1 + 10 * 1.25 + 10 * 2, 'opus 5 fast');
  close(usage.costOf('claude-opus-4-8', 1, M), 10 + 50 + 1 + 10 * 1.25 + 10 * 2, 'opus 4.8 has a fast mode too, at the price of Opus 5\'s');
  close(usage.costOf('claude-fable-5-1', 0, M), 10 + 50 + 0.25 + 12.5 + 20, 'fable 5.1 reads its cache at a quarter of fable 5');
  close(usage.costOf('claude-fable-5', 0, M), 10 + 50 + 1 + 12.5 + 20);
  close(usage.costOf('claude-haiku-4-5-20251001', 0, M), 1 + 5 + 0.1 + 1.25 + 2, 'a dated name is the model it names');
  close(usage.costOf('claude-opus-5-20260101', 0, M), 5 + 25 + 0.5 + 6.25 + 10, 'a dated opus 5 is not opus 5.5');
  close(usage.costOf('claude-opus-4-20250514', 0, M), 15 + 75 + 1.5 + 18.75 + 30, 'the first Claude 4 ids carry no -0');
  close(usage.costOf('us.anthropic.claude-sonnet-4-5-20250929-v1:0', 0, M), 3 + 15 + 0.3 + 3.75 + 6, 'a cloud provider name');
  close(usage.costOf('claude-3-5-haiku-20241022', 0, M), 0.8 + 4 + 0.08 + 1 + 1.6);
  assert.equal(usage.costOf('claude-sonnet-4-5', 1, M), null, 'a model without a fast price has no fast price');
  assert.equal(usage.costOf('claude-opus-5-1', 0, M), null, 'a model the table does not know is not priced as a neighbour');
  assert.equal(usage.costOf('claude-new-9', 0, M), null);
  assert.equal(usage.PRICE_TABLE.asOf, '2026-09-25');
});

test('the memory window: 1M for 4.6+ and 5.x, 200k for Haiku 4.5 and older, 1M for a [1m] name, unknown — null', () => {
  assert.equal(usage.contextWindow('claude-opus-5-5'), 1_000_000);
  assert.equal(usage.contextWindow('claude-sonnet-4-6'), 1_000_000);
  assert.equal(usage.contextWindow('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(usage.contextWindow('claude-sonnet-4-5'), 200_000);
  assert.equal(usage.contextWindow('claude-sonnet-4-5[1m]'), 1_000_000);
  assert.equal(usage.contextWindow('claude-new-9'), null);
});

test('an answer\'s tokens: the cache write split by how long it is kept; without the split it is all 5 minutes', () => {
  assert.deepEqual(usage.answerTokens(U(2, 330, 45804, 0, 55884)), { input: 2, output: 330, cache_read: 45804, cache_5m: 0, cache_1h: 55884 });
  assert.deepEqual(usage.answerTokens({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 600 }),
    { input: 3, output: 4, cache_read: 5, cache_5m: 600, cache_1h: 0 });
  // a split that does not add up to the total: the rest is priced as 5 minutes, never lost
  assert.deepEqual(usage.answerTokens({ ...U(0, 0, 0, 0, 100), cache_creation_input_tokens: 150 }), { input: 0, output: 0, cache_read: 0, cache_5m: 50, cache_1h: 100 });
  assert.equal(usage.answerOf(reply(1000, 'm', U(1, 1, 1), { model: '<synthetic>' })), null, 'a synthetic line is not an answer');
  assert.equal(usage.answerOf({ ...reply(1000, 'm', U(1, 1, 1)), message: { id: 'm', model: 'claude-opus-5-5', content: [] } }), null, 'no usage — not an answer');
  assert.equal(usage.answerOf(reply(1000, 'm', U(1, 1, 1), { side: true })), null, 'a helper\'s line in the session\'s transcript is not the session\'s');
  assert.equal(usage.answerOf(reply(1000, 'm', U(1, 1, 1), { side: true }), true).id, 'm');
});

/* ── whose time it was ── */
test('regions: the stretch before a focus goes to the task that takes it, after the last hand-in to nobody yet', () => {
  const w = [{ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }, { task_id: 2, from: 30, to: 50, focusAt: 40 }];
  const r = usage.regionsOf(w, new Set([1, 2]));
  assert.deepEqual(r.map((x) => [x.a, x.b, x.kind, x.task]), [
    [-Infinity, 10, 'pre', 1], [10, 30, 'own', 1], [30, 40, 'pre', 2], [40, 50, 'own', 2], [50, Infinity, 'pre', undefined],
  ]);
  assert.equal(usage.regionAt(r, 35).task, 2);
  assert.equal(usage.regionAt(r, 10).kind, 'own', 'the focus moment is the task\'s own');
  assert.deepEqual(usage.regionsOf(w, new Set([1])).map((x) => x.task), [1, 1, null, null, undefined], 'a task the session is not tied to gets nothing');
  assert.deepEqual(usage.regionsOf([], new Set()).map((x) => [x.a, x.b, x.task]), [[-Infinity, Infinity, undefined]]);
});

test('the read part is kept when the regions agree on it; an undecided stretch may get its owner, a decided one may not change', () => {
  const was = usage.regionsView(usage.regionsOf([{ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }], new Set([1, 2])), 45);
  const next = usage.regionsView(usage.regionsOf([{ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }, { task_id: 2, from: 30, to: null, focusAt: 60 }], new Set([1, 2])), 45);
  assert.ok(usage.sameView(was, next), 'the next task taking the focus after the read part');
  const moved = usage.regionsView(usage.regionsOf([{ task_id: 1, from: -Infinity, to: 20, focusAt: 10 }], new Set([1, 2])), 45);
  assert.equal(usage.sameView(was, moved), false, 'a hand-in moved back into the read part');
  const decided = usage.regionsView(usage.regionsOf([{ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }, { task_id: 2, from: 30, to: null, focusAt: 60 }], new Set([1, 2])), 45);
  const other = usage.regionsView(usage.regionsOf([{ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }, { task_id: 3, from: 30, to: null, focusAt: 60 }], new Set([1, 3])), 45);
  assert.equal(usage.sameView(decided, other), false, 'the stretch was given to one task and now belongs to another');
  assert.equal(usage.sameView(null, next), false, 'a pass that asked to be counted anew');
});

/* ── on screen: the card's line and the dashboard's block ── */
const F = {
  num: (n, d) => Number(n).toFixed(d), tr: (s) => s, plural: (n, one, many) => (n === 1 ? one : many),
  esc: (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`), date: (s) => `on ${s}`, gap: '',
};
const sample = (over = {}) => ({
  tokens: { input: 3, output: 45_300, cache_read: 1_100_000, cache_write: 90_000 }, total: 1_235_303, answers: 35, partial_answers: 0,
  cost: 4.123, unpriced: 0, unpriced_models: [], models: ['claude-opus-5-5'],
  context: { tokens: 370_000, window: 1_000_000, model: 'claude-opus-5-5', at: '2026-10-05T10:00:00.000Z' }, prices_as_of: '2026-09-25', ...over,
});

test('tokens in a short form never show a thousand of a unit', () => {
  assert.deepEqual([999, 1000, 12_345, 999_949, 999_950, 1_234_567, 2.5e9].map(tokenParts),
    [[999, ''], [1, 'k'], [12.3, 'k'], [999.9, 'k'], [1, 'M'], [1.2, 'M'], [2.5, 'B']]);
  assert.equal(tokensText(1_234_567, F), '1.2M');
  assert.equal(tokensText(2000, F), '2k', 'a whole number has no decimals');
  assert.equal(tokensText(1_234_567, { ...F, gap: ' ', tr: (s) => ({ M: 'mln' }[s] || s) }), '1.2 mln', 'the unit comes from the dictionary, with the language\'s gap');
});

test('the card\'s line: tokens first, then the money with ≈, then the memory; the tooltip says what the money means', () => {
  const line = usageLine(sample(), F);
  assert.equal(line.text, 'Usage · 1.2M tokens · ≈ $4.12 · memory 37%');
  const notes = line.title.split('\n');
  assert.equal(notes[0], 'Input 3 · output 45.3k · cache read 1.1M · cache write 90k');
  assert.match(notes[1], /^≈ \$4\.12 — what these tokens cost on the API, at the prices of on 2026-09-25\. With a subscription the money is notional/);
  assert.match(line.title, /Conversation memory on the last answer: 370k of 1M \(claude-opus-5-5\)/);
  assert.match(line.title, /Answers of Claude counted, helpers included: 35$/m);
  assert.equal(usageLine(sample({ cost: 0.004 }), F).text, 'Usage · 1.2M tokens · ≈ < $0.01 · memory 37%', 'less than a cent is not "$0.00"');
  assert.equal(moneyText(0.006, F), '$0.01');
  assert.equal(usageLine(sample({ total: 0, context: null }), F), null, 'nothing counted — no line');
  assert.equal(usageLine(null, F), null);
});

test('a model without a price is counted without money, and the card says so; not a silent zero', () => {
  const line = usageLine(sample({ cost: null, unpriced: 1_235_303, unpriced_models: ['claude-new-9'], context: { tokens: 1500, window: null, model: 'claude-new-9' } }), F);
  assert.equal(line.text, 'Usage · 1.2M tokens · memory 1.5k', 'no money part, the memory in tokens when the window is not known');
  assert.match(line.title, /No price for claude-new-9: 1\.2M tokens counted without money\./);
  assert.equal(memoryText({ tokens: 250_000, window: 200_000 }, F), '125%', 'more than the window is shown as it is, not capped');
});

test('answers recorded without their final count are named: the output and the money were higher', () => {
  assert.match(usageNotes(sample({ partial_answers: 3 }), F).join('\n'), /^Answers recorded without their final count: 3 — Claude Code mostly writes helpers' answers this way/m);
  assert.doesNotMatch(usageNotes(sample(), F).join('\n'), /without their final count/);
});

test('the dashboard block: totals, the tasks that cost the most as rows that open the card, the person\'s text escaped', () => {
  const u = { ...sample(), since: '2026-09-29', tasks: [
    { key: 'US-1', title: 'Big <b>one</b>', project: 'p & q', status: 'review', total: 1_000_000, cost: 3, unpriced: 0 },
    { key: 'US-2', title: 'Small', project: 'p', status: 'done', total: 235_303, cost: 1.123, unpriced: 0 },
    { key: 'US-3', title: 'No price', project: 'p', status: 'done', total: 5000, cost: null, unpriced: 5000 },
  ] };
  const html = usagePanel(u, F);
  assert.deepEqual([...html.matchAll(/class="us-row" data-key="([^"]+)"/g)].map((m) => m[1]), ['US-1', 'US-2', 'US-3']);
  assert.ok(html.includes('Big &#60;b&#62;one&#60;/b&#62;') && !html.includes('<b>one'), 'a title went into the markup unescaped');
  assert.ok(html.includes('p &#38; q'), 'a project name went into the markup unescaped');
  assert.match(html, /<span class="us-big">1\.2M<\/span><span class="us-unit">tokens<\/span><span class="us-money"[^>]*>≈ \$4\.12<\/span>/);
  assert.match(html, /width:100%[\s\S]*width:37%/, 'the bars are shares of the most expensive task');
  assert.match(html, /<span class="us-n">5k<\/span>/, 'a task without a price shows its tokens, not a zero');
  assert.match(html, /with a subscription the money is notional/, 'a phone has no tooltip: the block says it itself');
  assert.match(usagePanel({ ...u, total: 0, tasks: [] }, F), /No Claude usage counted in this period yet/);
  assert.doesNotMatch(html, /recorded only in part/);
  assert.match(usagePanel({ ...u, partial_answers: 2 }, F), /helpers&#39; output is recorded only in part, so their money is higher/);
});

/* ── the whole path: transcript → stretches → base → card ── */
test('one API answer written in several lines is counted once; the output grows to its last line; synthetic lines are not answers', async () => {
  const sid = '10000000-0000-4000-8000-000000000001';
  const task = newTask('Dedup');
  const t0 = Date.now() - 3_600_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([
    // the live shape: one line per block, each with the usage of the same answer; the early lines' output is the stream's start
    reply(t0 + 5000, 'msg_a', U(2, 8, 45_804, 0, 55_884), { content: [{ type: 'thinking', thinking: '' }], stop: null }),
    reply(t0 + 5100, 'msg_a', U(2, 8, 45_804, 0, 55_884), { content: [{ type: 'text', text: 'Reading' }], stop: null }),
    reply(t0 + 5200, 'msg_a', U(2, 330, 45_804, 0, 55_884), { content: call('ignored-not-agent').map((b) => ({ ...b, name: 'Bash' })), stop: 'tool_use' }),
    reply(t0 + 6000, 'msg_s', U(9, 9, 9), { model: '<synthetic>' }),
    { type: 'assistant', timestamp: at(t0 + 6100), message: { id: 'msg_n', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'no usage' }] } },
    reply(t0 + 7000, 'msg_b', U(1, 100, 101_688, 1000, 0)),
  ]));
  const u = await usageOf(task);
  assert.equal(u.answers, 2, 'every line counted as an answer, or a synthetic line counted');
  assert.deepEqual(u.tokens, { input: 3, output: 430, cache_read: 147_492, cache_write: 56_884 });
  money(u.cost, (3 * 4 + 430 * 20 + 147_492 * 0.2 + 1000 * 4 * 1.25 + 55_884 * 4 * 2) / 1e6);
  assert.equal(u.total, 3 + 430 + 147_492 + 56_884);
});

test('two tasks of one session: each gets its own stretch, the lead-in from the person\'s last word, the tail nobody', async () => {
  const sid = '20000000-0000-4000-8000-000000000002';
  const a = newTask('Batch');
  const b = newTask('Batch');
  const t0 = Date.now() - 3_000_000;
  const n = (ms, id, out) => reply(ms, id, U(1, out, 0));
  writeFileSync(file(sid), lines([
    say(t0, 'Unrelated talk before any task'), n(t0 + 500, 'x0', 1),
    say(t0 + 1000, `Do ${a.key} and ${b.key}`), n(t0 + 1500, 'a0', 10),
  ]));
  await move(a, 'prep', t0 + 3000, sid);
  await move(b, 'prep', t0 + 3000, sid); // the batch is prepped together: B does not take the focus
  appendFileSync(file(sid), lines([n(t0 + 5000, 'a1', 100)]));
  await move(a, 'doing', t0 + 6000, sid);
  appendFileSync(file(sid), lines([n(t0 + 8000, 'a2', 1000)]));
  await move(a, 'review', t0 + 10_000, sid);
  appendFileSync(file(sid), lines([n(t0 + 12_000, 'm1', 3), say(t0 + 13_000, `Now ${b.key}`), n(t0 + 14_000, 'b0', 20_000)]));
  await move(b, 'doing', t0 + 16_000, sid);
  appendFileSync(file(sid), lines([n(t0 + 18_000, 'b1', 200_000)]));
  await move(b, 'review', t0 + 20_000, sid);
  appendFileSync(file(sid), lines([n(t0 + 22_000, 't1', 7_000_000)]));
  const ua = await usageOf(a);
  const ub = await usageOf(b);
  assert.equal(ua.tokens.output, 10 + 100 + 1000, 'A: from "Do A and B" to its hand-in, nothing of the talk before');
  assert.equal(ub.tokens.output, 20_000 + 200_000, 'B: from the person\'s last word before it to its hand-in, nothing after');
  const all = db.prepare('SELECT SUM(output) AS o FROM task_usage WHERE session_id = ?').get(sid).o;
  assert.equal(all, ua.tokens.output + ub.tokens.output, 'the stretch between the tasks before the person spoke, or the tail, went to a task');
});

test('helpers: one started inside the task\'s stretch is its usage, with the helper it started; one started outside is never read', async () => {
  const sid = '30000000-0000-4000-8000-000000000003';
  const task = newTask('Helpers');
  const t0 = Date.now() - 2_400_000;
  const sub = join(dir, sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  const helper = (name, meta, body) => {
    writeFileSync(join(sub, `${name}.meta.json`), JSON.stringify(meta));
    writeFileSync(join(sub, `${name}.jsonl`), lines(body));
  };
  // a call before the task: its helper is big, and nobody should open it
  writeFileSync(file(sid), lines([say(t0, 'Look around first'), reply(t0 + 500, 'c0', U(1, 1, 0), { content: call('h-out'), stop: 'tool_use' })]));
  const outside = Array.from({ length: 200 }, (_, i) => reply(t0 + 600 + i, `o${i}`, U(1, 1_000_000, 0), { side: true }));
  helper('agent-out', { toolUseId: 'h-out' }, outside);
  appendFileSync(file(sid), lines([say(t0 + 1000, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 3000, sid);
  // one answer makes two calls, the second one minutes later (one prompt after another): each goes where its own line is
  appendFileSync(file(sid), lines([
    reply(t0 + 5000, 'c1', U(1, 10, 0), { content: call('h-in'), stop: null }),
    reply(t0 + 9000, 'c1', U(1, 50, 0), { content: call('h-late'), stop: 'tool_use' }),
  ]));
  helper('agent-in', { toolUseId: 'h-in' }, [
    reply(t0 + 5100, 's1', U(5, 40, 1000, 200), { side: true, model: 'claude-haiku-4-5-20251001' }),
    reply(t0 + 5200, 's2', U(5, 60, 2000), { side: true, model: 'claude-haiku-4-5-20251001', content: [{ type: 'tool_use', id: 'h-nested', name: 'Agent', input: {} }] }),
  ]);
  helper('agent-nested', { toolUseId: 'h-nested', parentAgentId: 'in' }, [reply(t0 + 5300, 'n1', U(7, 70, 0), { side: true })]);
  helper('agent-late', { toolUseId: 'h-late' }, [reply(t0 + 9100, 'l1', U(0, 300, 0), { side: true })]);
  await move(task, 'review', t0 + 7000, sid); // the hand-in falls between the two calls of that one answer
  const outsideBytes = Buffer.byteLength(lines(outside));
  let u;
  const read = await countReads(async () => { u = await usageOf(task); });
  assert.equal(u.tokens.output, 50 + 40 + 60 + 70, 'the answer once, the helper inside with its own helper; not the one started after the hand-in');
  assert.equal(u.answers, 1 + 2 + 1);
  assert.ok(u.models.includes('claude-haiku-4-5-20251001'), 'a helper\'s model is priced as its own');
  money(u.cost, (1 * 4 + 50 * 20) / 1e6 + (10 * 1 + 100 * 5 + 3000 * 0.1 + 200 * 1.25) / 1e6 + (7 * 4 + 70 * 20) / 1e6);
  assert.ok(read < outsideBytes, `the helper started before the task was read (${read} bytes read, it alone is ${outsideBytes})`);
  const late = db.prepare("SELECT state FROM claude_usage_reads WHERE session_id = ?").get(sid);
  assert.equal(JSON.parse(late.state).calls['h-late'] === null || JSON.parse(late.state).park?.calls.includes('h-late'), true,
    'the call made after the hand-in was given to the task');
});

test('the memory: the last answer of the session\'s own in the task\'s stretch — what it read, not what it wrote; not a helper\'s', async () => {
  const sid = '40000000-0000-4000-8000-000000000004';
  const task = newTask('Memory');
  const t0 = Date.now() - 2_000_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([
    reply(t0 + 4000, 'k1', U(2, 500, 100_000, 3000, 0)),
    reply(t0 + 5000, 'k2', U(3, 900, 300_000, 0, 67_000), { content: call('hm'), stop: 'tool_use' }),
  ]));
  const sub = join(dir, sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-m.meta.json'), JSON.stringify({ toolUseId: 'hm' }));
  writeFileSync(join(sub, 'agent-m.jsonl'), lines([reply(t0 + 6000, 'hk', U(1, 1, 900_000), { side: true })]));
  await move(task, 'review', t0 + 8000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 9000, 'k3', U(1, 1, 990_000))])); // after the hand-in: not this task's memory
  const u = await usageOf(task);
  assert.deepEqual({ tokens: u.context.tokens, window: u.context.window, model: u.context.model }, { tokens: 3 + 300_000 + 67_000, window: 1_000_000, model: 'claude-opus-5-5' });
});

test('counted once, then only what was appended: a line still being written waits, an answer that grows adds only the difference', async () => {
  const sid = '50000000-0000-4000-8000-000000000005';
  const task = newTask('Incremental');
  const t0 = Date.now() - 1_800_000;
  const body = lines([say(t0, `Do ${task.key}`)]);
  writeFileSync(file(sid), body);
  await move(task, 'doing', t0 + 2000, sid);
  const first = lines([reply(t0 + 4000, 'i1', U(1, 10, 1000)), reply(t0 + 5000, 'i2', U(1, 8, 2000), { stop: null })]);
  appendFileSync(file(sid), first);
  let u;
  assert.equal(await countReads(async () => { u = await usageOf(task); }), Buffer.byteLength(body + first), 'the first count read more than the transcript');
  assert.equal(u.tokens.output, 18);
  assert.equal(await countReads(() => usageOf(task)), 0, 'nothing appended, yet the transcript was read again');
  // the answer's last line arrives (its output grew), and a new line is only half written
  const grown = lines([reply(t0 + 5100, 'i2', U(1, 400, 2000))]);
  const half = JSON.stringify(reply(t0 + 6000, 'i3', U(1, 7, 3000)));
  appendFileSync(file(sid), grown + half.slice(0, 50));
  const read = await countReads(async () => { u = await usageOf(task); });
  assert.equal(read, Buffer.byteLength(grown) + 50, 'more than the new bytes were read');
  assert.equal(u.tokens.output, 10 + 400, 'the grown answer was counted twice, or its early output was added to its final one');
  assert.equal(u.answers, 2);
  appendFileSync(file(sid), `${half.slice(50)}\n`);
  u = await usageOf(task);
  assert.equal(u.tokens.output, 417, 'the half-written line was lost or misread');
  assert.equal(u.answers, 3);
});

test('when the stretches change in the part already counted, the session is counted anew', async () => {
  const sid = '60000000-0000-4000-8000-000000000006';
  const task = newTask('Recount');
  const t0 = Date.now() - 1_500_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'r1', U(1, 10, 0)), reply(t0 + 8000, 'r2', U(1, 100, 0))]));
  await move(task, 'review', t0 + 10_000, sid);
  assert.equal((await usageOf(task)).tokens.output, 110);
  // the hand-in is now known to have been earlier (a borrowed move gave way to the session's own, a task was deleted…)
  db.prepare("UPDATE task_events SET created_at = ? WHERE task_id = ? AND status = 'review'").run(stamp(t0 + 6000), task.id);
  assert.equal((await usageOf(task)).tokens.output, 10, 'the counted part kept the old stretches');
});

test('a helper whose transcript cannot be read is left out; the task still has its usage', async () => {
  const sid = 'd0000000-0000-4000-8000-00000000000d';
  const task = newTask('Unreadable helper');
  const t0 = Date.now() - 1_300_000;
  const sub = join(dir, sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'x1', U(1, 30, 0), { content: [...call('h-ok'), ...call('h-bad')], stop: 'tool_use' })]));
  writeFileSync(join(sub, 'agent-ok.meta.json'), JSON.stringify({ toolUseId: 'h-ok' }));
  writeFileSync(join(sub, 'agent-ok.jsonl'), lines([reply(t0 + 4100, 'ok1', U(1, 40, 0), { side: true })]));
  writeFileSync(join(sub, 'agent-bad.meta.json'), JSON.stringify({ toolUseId: 'h-bad' }));
  mkdirSync(join(sub, 'agent-bad.jsonl')); // stat says it is there, reading it fails
  const u = await usageOf(task);
  assert.equal(u.tokens.output, 30 + 40, 'one unreadable helper took the count of the task down');
});

test('a transcript written anew (shorter than what was read) is counted anew', async () => {
  const sid = 'e0000000-0000-4000-8000-00000000000e';
  const task = newTask('Rewritten');
  const t0 = Date.now() - 1_250_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'w1', U(1, 1000, 0)), reply(t0 + 5000, 'w2', U(1, 2000, 0))]));
  assert.equal((await usageOf(task)).tokens.output, 3000);
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`), reply(t0 + 4000, 'w9', U(1, 5, 0))]));
  assert.equal((await usageOf(task)).tokens.output, 5, 'the old count stayed, or the new file was read from the old place');
});

test('an answer that never got its final line is counted as partial once the next one begins', async () => {
  const sid = '70000000-0000-4000-8000-000000000007';
  const task = newTask('Partial');
  const t0 = Date.now() - 1_200_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([
    reply(t0 + 4000, 'p1', U(1, 8, 0), { stop: null }), // the stream's start, no final line ever
    reply(t0 + 5000, 'p2', U(1, 50, 0)),
    reply(t0 + 6000, 'p3', U(1, 8, 0), { stop: null }), // the last one may still be coming: not partial yet
  ]));
  assert.equal((await usageOf(task)).partial_answers, 1);
});

test('a model the price table does not know: its tokens are counted, the money of it is not, and its name is said', async () => {
  const sid = '80000000-0000-4000-8000-000000000008';
  const task = newTask('Unknown model');
  const t0 = Date.now() - 1_000_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'u1', U(10, 20, 30), { model: 'claude-new-9' }), reply(t0 + 5000, 'u2', U(1, 2, 3))]));
  const u = await usageOf(task);
  assert.equal(u.total, 60 + 6);
  assert.equal(u.unpriced, 60);
  assert.deepEqual(u.unpriced_models, ['claude-new-9']);
  money(u.cost, (1 * 4 + 2 * 20 + 3 * 0.2) / 1e6, 'the priced part');
  assert.equal(u.context.window, 1_000_000, 'the last answer is a known model');
});

test('two requests for the same task at once count its session once', async () => {
  const sid = '90000000-0000-4000-8000-000000000009';
  const task = newTask('Together');
  const t0 = Date.now() - 900_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines(Array.from({ length: 50 }, (_, i) => reply(t0 + 3000 + i, `t${i}`, U(1, 1, 0)))));
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => usageOf(task)));
  for (const u of [a, b, c]) assert.equal(u.answers, 50, 'the same lines were counted twice');
});

test('the card carries the usage; a task no session worked on has none', async () => {
  const sid = 'a0000000-0000-4000-8000-00000000000a';
  const task = newTask('Card');
  const t0 = Date.now() - 600_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'w1', U(2, 30, 1000, 0, 500))]));
  const card = (await app.inject({ method: 'GET', url: `/api/tasks/${task.key}` })).json();
  assert.deepEqual(Object.keys(card.usage).sort(), ['answers', 'context', 'cost', 'models', 'partial_answers', 'prices_as_of', 'tokens', 'total', 'unpriced', 'unpriced_models']);
  assert.deepEqual(card.usage.tokens, { input: 2, output: 30, cache_read: 1000, cache_write: 500 });
  assert.equal(card.usage.prices_as_of, '2026-09-25');
  const lone = newTask('Lone');
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/${lone.key}` })).json().usage, null);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/tasks/${lone.key}/usage` })).json(), { usage: null });
});

test('the dashboard: usage of the window by local day, the tasks that cost the most first, archived projects not counted', async () => {
  const dash = async (range) => (await app.inject({ method: 'GET', url: `/api/dashboard?range=${range}` })).json().usage;
  emit('task.updated', {}); // the dashboard keeps its answer until an event
  const week = await dash('week');
  const today = new Date();
  const first = new Date(today); first.setDate(first.getDate() - 6);
  assert.equal(week.since, usage.localDay(first.setHours(0, 0, 0, 0)));
  const sumAll = db.prepare('SELECT SUM(input + output + cache_read + cache_5m + cache_1h) AS n FROM task_usage').get().n;
  assert.equal(week.total, sumAll, 'everything counted so far is from today');
  assert.ok(week.tasks.length <= 6);
  const costs = week.tasks.map((t) => t.cost ?? 0);
  assert.deepEqual(costs, [...costs].sort((x, y) => y - x), 'the most expensive tasks are not first');
  assert.ok(week.tasks.every((t) => /^US-\d+$/.test(t.key) && t.title && t.project === 'usage'), 'a row lacks what the block shows');
  // a row forty days old is in the half-year, not in the week; a task of an archived project is in neither
  const old = newTask('Old');
  const day = new Date(); day.setDate(day.getDate() - 40);
  db.prepare("INSERT INTO task_usage (task_id, session_id, day, model, fast, answers, output) VALUES (?, 'x', ?, 'claude-opus-5-5', 0, 1, 1000000)").run(old.id, usage.localDay(day.getTime()));
  emit('task.updated', {});
  assert.equal((await dash('week')).total, sumAll);
  assert.equal((await dash('half')).total, sumAll + 1_000_000);
  assert.equal((await dash('half')).tasks[0].key, old.key, '$20 of output is the most expensive task');
  db.prepare("UPDATE projects SET archived = 1 WHERE slug = 'usage'").run();
  emit('task.updated', {});
  assert.equal((await dash('half')).total, 0, 'an archived project still counts');
  db.prepare("UPDATE projects SET archived = 0 WHERE slug = 'usage'").run();
  db.prepare('DELETE FROM task_usage WHERE task_id = ?').run(old.id);
  emit('task.updated', {});
});

test('kept current: a growing transcript of a task in work is counted on task.work; the never-counted are counted once in the background', async () => {
  const sid = 'b0000000-0000-4000-8000-00000000000b';
  const task = newTask('Live');
  const t0 = Date.now() - 300_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`), reply(t0 + 4000, 'v1', U(1, 5, 0))]));
  await move(task, 'doing', t0 + 2000, sid);
  db.prepare('UPDATE task_sessions SET transcript = ? WHERE session_id = ?').run(file(sid), sid);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM claude_usage_reads WHERE session_id = ?').get(sid).n, 0, 'counted before anyone asked');
  const never = db.prepare(`SELECT COUNT(DISTINCT session_id) AS n FROM task_sessions s
    WHERE NOT EXISTS (SELECT 1 FROM claude_usage_reads r WHERE r.session_id = s.session_id)`).get().n;
  assert.ok(never >= 1);
  const counted = await usage.startUsageWatch({ delayMs: 0, gapMs: 0 });
  assert.equal(counted, never, 'the background pass went through sessions already counted, or skipped some never counted');
  assert.equal(db.prepare('SELECT SUM(output) AS o FROM task_usage WHERE session_id = ?').get(sid).o, 5);
  appendFileSync(file(sid), lines([reply(t0 + 6000, 'v2', U(1, 70, 0))]));
  emit('task.work', { ids: [task.id], keys: [task.key] });
  // passes go one at a time, in order: once a pass asked for after the event is over, the one the event queued is over too
  await usage.countSession('90000000-0000-4000-8000-000000000009');
  assert.equal(db.prepare('SELECT SUM(output) AS o FROM task_usage WHERE session_id = ?').get(sid).o, 75, 'task.work did not count the new line');
});

// the listener startUsageWatch installed in the test above stays for the rest of the file
test('kept current: a status change counts the session at once — the dashboard has the last stretch without the card being opened', async () => {
  const sid = 'b1000000-0000-4000-8000-0000000000b1';
  const task = newTask('Hand-in');
  const t0 = Date.now() - 250_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  db.prepare('UPDATE task_sessions SET transcript = ? WHERE session_id = ?').run(file(sid), sid);
  // written in the last second and a half before the hand-in: no task.work came for it, the task is in Review by then
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'h1', U(1, 42, 0))]));
  await move(task, 'review', t0 + 6000, sid);
  await usage.countSession('90000000-0000-4000-8000-000000000009'); // passes go one at a time, in order
  assert.equal(db.prepare('SELECT SUM(output) AS o FROM task_usage WHERE session_id = ?').get(sid).o, 42,
    'the hand-in did not count the session: the dashboard misses the task\'s last stretch until its card is opened');
});

test('a helper\'s answer written in several lines is counted once, as the session\'s own are', async () => {
  const sid = 'b2000000-0000-4000-8000-0000000000b2';
  const task = newTask('Helper lines');
  const t0 = Date.now() - 240_000;
  const sub = join(dir, sid, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'm1', U(1, 5, 0), { content: call('h-lines'), stop: 'tool_use' })]));
  writeFileSync(join(sub, 'agent-lines.meta.json'), JSON.stringify({ toolUseId: 'h-lines' }));
  writeFileSync(join(sub, 'agent-lines.jsonl'), lines([
    reply(t0 + 4100, 'hl1', U(3, 8, 2000, 500), { side: true, content: [{ type: 'thinking', thinking: '' }], stop: null }),
    reply(t0 + 4200, 'hl1', U(3, 8, 2000, 500), { side: true, content: [{ type: 'text', text: 'Looking' }], stop: null }),
    reply(t0 + 4300, 'hl1', U(3, 120, 2000, 500), { side: true }),
  ]));
  const u = await usageOf(task);
  assert.equal(u.answers, 2, 'every line of the helper\'s answer counted as an answer');
  assert.deepEqual(u.tokens, { input: 1 + 3, output: 5 + 120, cache_read: 2000, cache_write: 500 },
    'the helper\'s answer was counted once per line, or its early output added to its final one');
  assert.equal(u.partial_answers, 0);
});

test('kb show and kb take print the line the card shows, right under the sessions line; no usage — no line', async () => {
  const sid = 'c0000000-0000-4000-8000-00000000000c';
  const task = newTask('Kb');
  const t0 = Date.now() - 200_000;
  writeFileSync(file(sid), lines([say(t0, `Do ${task.key}`)]));
  await move(task, 'doing', t0 + 2000, sid);
  appendFileSync(file(sid), lines([reply(t0 + 4000, 'q1', U(2, 1500, 120_000, 0, 30_000))]));
  const run = (args) => new Promise((resolve) => {
    const env = { ...process.env, KB_URL: base };
    delete env.CLAUDE_CODE_SESSION_ID; // the suite runs inside a Claude session and without one alike
    execFile(process.execPath, [KB, ...args], { env }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr }));
  });
  const r = await run(['show', task.key]);
  assert.equal(r.code, 0, r.stderr);
  const out = r.stdout.split('\n');
  const i = out.findIndex((l) => l.startsWith('claude sessions:'));
  assert.ok(i >= 0, r.stdout);
  assert.equal(out[i + 1], 'claude usage: 151.5k tokens (input 2, output 1.5k, cache read 120k, cache write 30k) · ≈$0.29 at API prices of 2026-09-25 · context 15% of 1M (claude-opus-5-5)');
  const lone = newTask('Kb lone');
  const none = await run(['show', lone.key]);
  assert.equal(none.stdout.split('\n').some((l) => l.startsWith('claude usage:')), false);
  // kb take prints the card too: a task in To do that a session worked on before (sent back for rework)
  const pid = Number(db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('take-usage','TU','take-usage',2)").run().lastInsertRowid);
  const back = Number(db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 1, 'Sent back', 'todo')").run(pid).lastInsertRowid);
  db.prepare("INSERT INTO task_sessions (task_id, session_id) VALUES (?, 'f0000000-0000-4000-8000-00000000000f')").run(back);
  db.prepare("INSERT INTO task_usage (task_id, session_id, day, model, fast, answers, input, output) VALUES (?, 'f0000000-0000-4000-8000-00000000000f', ?, 'claude-sonnet-5-5', 0, 1, 1000, 2000)")
    .run(back, usage.localDay(Date.now()));
  const took = await run(['take', 'take-usage']);
  assert.equal(took.code, 0, took.stderr);
  assert.ok(took.stdout.split('\n').includes('claude usage: 3k tokens (input 1k, output 2k, cache read 0, cache write 0) · ≈$0.02 at API prices of 2026-09-25'), took.stdout);
});

test('the card and the dashboard draw it through the shared rules, escaped, every word in the dictionary', () => {
  const src = (p) => readFileSync(new URL(`../public/${p}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sse = src('js/sse.js');
  assert.match(sse, /const line = usageLine\(u, usageFmt\);\s*return line \? `<div class="dm-info dm-usage" title="\$\{esc\(line\.title\)\}">\$\{esc\(line\.text\)\}<\/div>` : '';/,
    'the card\'s usage line is not drawn through usageLine, or not escaped');
  assert.match(sse, /return sessions \+ usageHTML\(cardClaude\.usage\);/, 'the line is not under the sessions line');
  assert.match(sse, /box\.innerHTML = toggle \+ rows\.join\(''\) \+ cycle;/, 'the log of statuses shows Claude again');
  assert.match(sse, /if \(open\) refreshUsage\(state\.drawerKey\);/, 'task.work no longer refreshes the open card\'s usage');
  assert.match(src('js/dash.js'), /dashPanel\(tr\('Claude usage'\), usagePanel\(d\.usage, usageFmt\), phRange\)/, 'the dashboard lost the block');
  const core = src('js/core.js');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const rules = readFileSync(new URL('../public/js/usage-rules.js', import.meta.url), 'utf8');
  const said = [...new Set([...rules.matchAll(/f\.tr\((['"])((?:(?!\1)[^\\]|\\.)+)\1\)/g)].map((m) => m[2]).concat(['k', 'M', 'B', 'Claude usage']))];
  assert.ok(said.length > 15, `the rules draw their words without f.tr(): ${said.length}`);
  const has = (s) => dict.includes(`'${s}':`) || dict.includes(`"${s}":`) || new RegExp(`\\n\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: '`).test(dict);
  assert.deepEqual(said.filter((s) => !has(s)), [], 'a word of the usage line stays English on the Russian board');
  const plurals = src('js/settings.js');
  assert.match(plurals, /\n\s+token: \[/, 'tokens are not declined in Russian');
});
