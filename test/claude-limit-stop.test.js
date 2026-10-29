// 12:50am"); the registry has no word for it, and the board went on saying "working" — no sound, no notification, the
// cards turning as if in work. The board reads it off the screens of its own terminals: the tasks of that Claude say
// "limit reached · until 12:50am", their outline stops, "Claude now" says the same, and the page rings once on the stop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import Fastify from 'fastify';

const S = '11111111-1111-4111-8111-111111111111';
let app, tmp, claude, db, now, live, phantom;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  now = await import('../src/claude-now.js');
  live = await import('../src/claude-live.js');
  phantom = await import('../src/phantom.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','LM','Demo',4)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'demo'").get().id;
  for (const no of [1, 2, 3]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  app = Fastify();
  await app.register((await import('../src/routes/tasks.js')).default);
  await app.ready();
  const move = (key, status) => app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': S }, payload: { status } });
  for (const key of ['LM-1', 'LM-2']) assert.equal((await move(key, 'prep')).statusCode, 200); // a batch of two
  assert.equal((await move('LM-1', 'doing')).statusCode, 200);
  db.prepare('INSERT INTO board_sessions (session_id) VALUES (?)').run(S);
  writeFileSync(join(claude, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: S, status: 'idle', statusUpdatedAt: 1000 }));
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const alive = (pid) => pid === 101;
const SCREEN = ['● Done with the batch so far.', '', `${'─'.repeat(38)} LM-1 ─`, '❯ ', '─'.repeat(45),
  '  ⚠ Usage limit reached · limit resets', '  12:50am · clau.de/wrap-up ·', '  /usage-credits to keep using Claude Code',
  '  ⬆ /gsd-update │ Opus 5.5 (1M context) │ …', '  ⏵⏵ auto mode on · 2 shells · ← for agents'].join('\n');

test('the stop at the limit and its reset are read off the lines under the input box', () => {
  assert.deepEqual(phantom.limitOnScreen(SCREEN), { resets: '12:50am' });
  assert.equal(phantom.backgroundOnScreen(SCREEN), true, 'five status lines hide the background commands');
  assert.deepEqual(phantom.limitOnScreen(SCREEN.replace(/ · limit resets\n.*\n/, '\n')), { resets: null });
  assert.equal(phantom.limitOnScreen(SCREEN.replace(/⚠ Usage limit reached · limit resets/, 'all good')), null);
  // review: the context of the conversation is no limit of the subscription; a reset with a date keeps its date
  assert.equal(phantom.limitOnScreen(SCREEN.replace('⚠ Usage limit reached · limit resets', 'Context limit reached · /compact or /clear').replace('12:50am · ', '')), null);
  assert.deepEqual(phantom.limitOnScreen(SCREEN.replace('Usage limit reached · limit resets', 'Weekly limit reached ∙ resets Oct 9 at').replace('12:50am', '10am')), { resets: 'Oct 9 at 10am' });
  assert.deepEqual(phantom.limitOnScreen(SCREEN.replace('Usage limit reached · limit resets', "You've hit your weekly limit · resets")), { resets: '12:50am' });
  assert.equal(phantom.limitOnScreen('Claude said: the usage limit reached its peak.\n' + `${'─'.repeat(45)}\n❯ \n${'─'.repeat(45)}\n  ⏵⏵ auto mode on`), null,
    'words of Claude above the box are taken for the stop');
});

test('every task of the stopped batch says "limit", with the reset; it rings once; Claude now says it too', async () => {
  const { bus } = await import('../src/bus.js');
  await live.refreshLive(alive, async () => ({ live: [S], questions: [], background: [], limited: [] }));
  const heard = [];
  const on = (e) => { if (e.type === 'task.live') heard.push(e.data.tasks); };
  bus.on('event', on);
  const look = async () => ({ live: [S], questions: [], background: [], limited: [{ sid: S, resets: '12:50am' }] });
  assert.equal(await live.refreshLive(alive, look), true, 'the stop did not reach the page');
  assert.equal(await live.refreshLive(alive, look), false, 'the same stop rang again');
  bus.off('event', on);
  assert.deepEqual(heard[0].map((t) => [t.key, t.claude, t.resets]), [['LM-1', 'limit', '12:50am'], ['LM-2', 'limit', '12:50am']],
    'a task of the stopped batch still says it is worked on or waited for');
  const d = await now.nowRuns(alive);
  assert.deepEqual(d.runs.map((r) => [r.session, r.claude, r.resets]), [[S, 'limit', '12:50am']]);
  // the warning line gone for one look (a redraw) is not the reset: the state holds, nothing rings again
  const gone = async () => ({ live: [S], questions: [], background: [], limited: [] });
  await live.refreshLive(alive, gone);
  assert.ok(live.currentLive().every((t) => t.claude === 'limit'), 'one look without the line ended the stop');
  // gone for a second look — the limit reset and Claude went on
  await live.refreshLive(alive, gone);
  assert.ok(live.currentLive().every((t) => t.claude !== 'limit'));
  assert.equal((await now.nowRuns(alive)).runs[0].claude, 'idle');
});

test('the page: a card at the limit says so with the reset, stops its outline, and the stop rings once', () => {
  const read = (f) => readFileSync(new URL(`../public/js/${f}.js`, import.meta.url), 'utf8');
  const board = read('board');
  const take = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, ''); };
  const decl = (src, head) => { const at = src.indexOf(head); assert.ok(at >= 0, head); return src.slice(at, src.indexOf('\n};\n', at) + 3); };
  const box = { state: { live: { 7: { claude: 'limit', resets: '12:50am' } } }, WORKING: new Set(['prep', 'doing', 'deploy']), hasAsk: () => false, tr: (s) => s, esc: (s) => String(s) };
  vm.runInNewContext([decl(board, 'const LIVE_BADGE = {'), take(board, 'function liveBadge('), take(board, 'function atLimit('), 'this.api = { liveBadge, atLimit };'].join('\n'), box);
  assert.match(box.api.liveBadge({ id: 7, status: 'doing' }), /class="card-live live-limit"[^>]*>.*limit reached · until 12:50am<\/span>/);
  assert.equal(box.api.atLimit({ id: 7, status: 'doing' }), true);
  assert.equal(box.api.atLimit({ id: 7, status: 'review' }), false);
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.card\.working\.limited:not\(\.drag-ghost\)::before \{ animation: none;[^}]*\}/, 'the glow of a stopped card goes on breathing');
  const sse = read('sse');
  const rang = [];
  const ab = { playReviewSound: () => rang.push(1), getSetting: () => false, tr: (s) => s };
  vm.runInNewContext(`${take(sse, 'function maybeWaitingAlert(')}\nthis.run = maybeWaitingAlert;`, ab);
  assert.deepEqual([...ab.run([{ id: 1, claude: 'limit', from: 'busy' }, { id: 2, claude: 'limit', from: 'limit' }])], [1], 'the stop does not ring, or rings again while it lasts');
  assert.equal(rang.length, 1);
  // a batch of three stops at once: one notification with the three keys (review)
  const sent = [];
  class Note { constructor(title, o) { sent.push([title, o.body]); } }
  Note.permission = 'granted';
  const nb = { playReviewSound: () => {}, getSetting: () => true, tr: (s) => s, Notification: Note, window: {}, openTaskFromNotification: () => {} };
  vm.runInNewContext(`${take(sse, 'function maybeWaitingAlert(')}\nthis.run = maybeWaitingAlert;`, nb);
  nb.run(['A-1', 'A-2', 'A-3'].map((key, i) => ({ id: i + 1, key, title: 't', claude: 'limit', from: 'busy', resets: '3pm' })));
  assert.deepEqual(sent, [['Claude hit the usage limit · until 3pm', 'A-1, A-2, A-3']]);
});

// chain) read as "nothing on the screens" — the stop ended on that look and rang again on the next one, while the line
// never left the screen. Such a look keeps the last picture.
test('a look tmux did not answer keeps the stop: nothing ends, nothing rings again', async () => {
  const { bus } = await import('../src/bus.js');
  const hit = async () => ({ live: [S], questions: [], background: [], limited: [{ sid: S, resets: '12:50am' }] });
  await live.refreshLive(alive, hit);
  assert.ok(live.currentLive().every((t) => t.claude === 'limit'));
  const heard = [];
  const on = (e) => { if (e.type === 'task.live') heard.push(e.data.tasks); };
  bus.on('event', on);
  const failed = async () => ({ live: [], questions: [], background: [], limited: [], failed: true });
  assert.equal(await live.refreshLive(alive, failed), false);
  assert.equal(await live.refreshLive(alive, failed), false);
  assert.ok(live.currentLive().every((t) => t.claude === 'limit'), 'a failed look ended the stop');
  assert.equal(await live.refreshLive(alive, hit), false, 'the stop rang again after a failed look');
  bus.off('event', on);
  assert.deepEqual(heard, []);
  // the screens are as they were, but the registry is read anew: a Claude that exited meanwhile is gone, not stopped
  await live.refreshLive(() => false, failed);
  assert.ok(live.currentLive().every((t) => t.claude === 'gone'), 'a failed look froze the states of the registry too');
  await live.refreshLive(alive, async () => ({ live: [S], questions: [], background: [], limited: [] }));
  await live.refreshLive(alive, async () => ({ live: [S], questions: [], background: [], limited: [] }));
});

// permission to edit a file that quotes the limit's line) read as the stop while Claude was asking.
test('only the lines under the input box are read: a dialog that quotes the limit is no stop', () => {
  const dialog = ['● Update(test/claude-limit-stop.test.js)', '─'.repeat(45), ' Edit file', '─'.repeat(45),
    "  const SCREEN = '⚠ Usage limit reached · limit resets 12:50am';", ' Do you want to make this edit?', ' ❯ 1. Yes', '   2. No',
    ' Esc to cancel'].join('\n');
  assert.equal(phantom.limitOnScreen(dialog), null, 'a dialog quoting the line is taken for the stop');
  const options = ['─'.repeat(45), ' ❯ 1. Yes', '─'.repeat(45), '  ⚠ Usage limit reached · limit resets 12:50am'].join('\n');
  assert.equal(phantom.limitOnScreen(options), null, 'the cursor of a list of options is taken for the input box');
  assert.deepEqual(phantom.limitOnScreen(SCREEN), { resets: '12:50am' }, 'the stop under the input box is not read any more');
});

// dropping the reset or the stop itself passed the whole suite; nor that a card drawn anew keeps its outline stopped.
test('Waiting for you says the stop with its reset; a card drawn anew keeps its outline stopped', async () => {
  const dash = Fastify();
  await dash.register((await import('../src/routes/dashboard.js')).default);
  await dash.ready();
  try {
    await live.refreshLive(alive, async () => ({ live: [S], questions: [], background: [], limited: [{ sid: S, resets: '12:50am' }] }));
    const claude = (await dash.inject({ method: 'GET', url: '/api/dashboard' })).json().waiting.claude;
    assert.deepEqual(claude.map((x) => [x.key, x.claude, x.resets]).sort(), [['LM-1', 'limit', '12:50am'], ['LM-2', 'limit', '12:50am']]);
  } finally { await dash.close(); }
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  const card = board.slice(board.indexOf('function cardParts('), board.indexOf('\n}\n', board.indexOf('function cardParts(')));
  assert.match(card, /\+ \(atLimit\(t\) \? ' limited' : ''\)/, 'a card drawn anew turns its outline again while its Claude is stopped');
});
