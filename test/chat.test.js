// person's words, what Claude wrote, the steps it took with their time and outcome, "worked N min" — and only what was
// said and done goes out: never what a command returned. Words for the board's Claude go at once to a Claude waiting
// at its prompt, else wait in a queue until it has been idle for two seconds (the rule of the owner's reference).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const SID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const SECRET = 'live-token-should-never-leave-the-machine';
let app, tmp, claude, db, chat, queue, transcript, taskId;

const line = (o) => `${JSON.stringify(o)}\n`;
const at = (s) => `2026-10-22T10:00:${String(s).padStart(2, '0')}.000Z`;
const user = (s, text) => line({ type: 'user', timestamp: at(s), message: { role: 'user', content: text } });
const said = (s, text) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'text', text }] } });
const call = (s, id, name, input) => line({ type: 'assistant', timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (s, id, text, error = false) => line({ type: 'user', timestamp: at(s), message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: error }] } });
const end = (s, ms) => line({ type: 'system', subtype: 'turn_duration', timestamp: at(s), durationMs: ms });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-chat-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-chat-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'projects', '-chat'), { recursive: true });
  transcript = join(claude, 'projects', '-chat', `${SID}.jsonl`);
  writeFileSync(transcript,
    user(1, 'Fix the flaky test')
    + said(2, 'Looking at the test.')
    + call(3, 't1', 'Bash', { command: `curl -H "Authorization: ${SECRET}" x`, description: 'Fetch the fixture' })
    + result(5, 't1', `token ${SECRET}`)
    + call(6, 't2', 'Read', { file_path: '/a/b/src/refresh.ts' })
    + result(6, 't2', 'file text', true)
    + line({ type: 'assistant', isSidechain: true, timestamp: at(7), message: { content: [{ type: 'text', text: 'a helper line' }] } })
    + line({ type: 'user', isMeta: true, timestamp: at(7), message: { content: 'the body of a skill' } })
    + said(8, 'Fixed: the refresh waits for the lock.')
    + end(9, 8000)
    + user(10, 'Now the docs')
    + line({ type: 'user', timestamp: at(11), message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }));
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  chat = await import('../src/chat-feed.js');
  queue = await import('../src/chat-queue.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('ch','CH','chat',3)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='ch'").get().id;
  taskId = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,1,'Chat task','doing')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,2,'Other task','todo')").run(pid);
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:11')").run(taskId, SID);
  app = Fastify();
  await app.register((await import('../src/routes/chat.js')).default);
  await app.ready();
});

after(async () => {
  queue?.clearQueues();
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

test('a transcript reads as turns: words, steps with time and outcome, "worked N", a stop', async () => {
  const c = await chat.transcriptChat(transcript);
  assert.equal(c.turns.length, 2);
  const [first, second] = c.turns;
  assert.equal(first.user, 'Fix the flaky test');
  assert.equal(first.ms, 8000);
  assert.equal(first.open, false);
  assert.deepEqual(first.items.map((i) => i.kind), ['text', 'tool', 'tool', 'text']);
  const [fetch, read] = first.items.filter((i) => i.kind === 'tool');
  assert.equal(fetch.text, 'Fetch the fixture', 'the step is not named by what Claude said it does');
  assert.equal(fetch.ms, 2000);
  assert.equal(fetch.error, false);
  assert.equal(read.error, true, 'a failed step reads as done');
  assert.ok(!first.items.some((i) => /helper line|body of a skill/.test(i.text || '')), 'a helper or a skill body is in the chat');
  assert.equal(second.user, 'Now the docs');
  assert.deepEqual(second.items.map((i) => i.kind), ['stop']);
  assert.equal(second.open, false, 'a stopped turn reads as still going');
});

test('what a command returned never leaves: only what was said and done', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/tasks/CH-1/chat' });
  assert.equal(res.statusCode, 200, res.body);
  assert.doesNotMatch(res.body.replace(/Fetch the fixture/g, ''), new RegExp(SECRET), 'a result of a command went to the page');
  assert.ok(!res.body.includes('file text'));
});

test('only the newest turns go, with how many are earlier; the rest is asked for', async () => {
  const c = await chat.transcriptChat(transcript, { turns: 1 });
  assert.equal(c.turns.length, 1);
  assert.equal(c.turns[0].user, 'Now the docs');
  assert.equal(c.earlier_n, 1);
  const r = (await app.inject({ method: 'GET', url: '/api/tasks/CH-1/chat?turns=1' })).json();
  assert.equal(r.earlier_n, 1);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-1/chat?turns=0' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/CH-1/chat?turns=1&turns=2` })).statusCode, 400);
});

test('a chat is of a session of the task — never another one, never by a path', async () => {
  const r = (await app.inject({ method: 'GET', url: '/api/tasks/CH-1/chat' })).json();
  assert.equal(r.session, SID);
  assert.deepEqual(r.sessions.map((s) => s.session_id), [SID]);
  assert.equal(r.send, false, 'a session the board did not start is said to take words');
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/CH-1/chat?session=${OTHER}` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-1/chat?session=..%2F..%2Fetc' })).statusCode, 400);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-9/chat' })).statusCode, 404);
  const none = (await app.inject({ method: 'GET', url: '/api/tasks/CH-2/chat' })).json();
  assert.equal(none.session, null);
});

test('an answer the page has is `same`; a grown transcript is a new one and rings session.chat', async () => {
  const { bus } = await import('../src/bus.js');
  const first = (await app.inject({ method: 'GET', url: '/api/tasks/CH-1/chat' })).json();
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/tasks/CH-1/chat?seen=${first.v}` })).json(), { same: true, v: first.v });
  assert.ok(chat.watchedChats().includes(transcript), 'a transcript a page looks at is not watched');
  const rang = new Promise((resolve) => {
    const on = (ev) => { if (ev.type === 'session.chat' && ev.data.session === SID) { bus.off('event', on); resolve(true); } };
    bus.on('event', on);
    setTimeout(() => resolve(false), 5000);
  });
  await new Promise((r) => setTimeout(r, 50)); // fs.watch listens from the next turn of the loop
  appendFileSync(transcript, said(12, 'Writing the docs.'));
  assert.equal(await rang, true, 'a grown transcript did not ring session.chat');
  const next = (await app.inject({ method: 'GET', url: `/api/tasks/CH-1/chat?seen=${first.v}` })).json();
  assert.ok(!next.same);
  assert.equal(next.turns.at(-1).items.at(-1).text, 'Writing the docs.');
});

test('words to a task without a Claude of the board are refused: the chat only reads', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/tasks/CH-1/chat', payload: { text: 'hello' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().reason, 'gone');
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/CH-1/chat', payload: { text: '   ' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/tasks/CH-1/chat', payload: { text: 'a\0b' } })).statusCode, 400);
});

test('queued words go once Claude has waited at its prompt for two seconds — one at a time, in order', async () => {
  const said = [];
  let now = 'busy';
  let paneGone = false;
  queue.setQueueDeps({ atPrompt: async () => now, gone: async () => paneGone, say: async (t, s, b) => { said.push([t.id, s, b]); return { ok: true }; }, task: (id) => ({ id }), timer: false });
  try {
    assert.ok(queue.enqueue(SID, 7, 'first').id);
    queue.enqueue(SID, 7, 'second');
    assert.deepEqual(queue.queued(SID).map((q) => q.text), ['first', 'second']);
    await queue.queueTick(1000);
    assert.deepEqual(said, [], 'words went to a busy Claude');
    now = 'idle';
    await queue.queueTick(2000);
    await queue.queueTick(3500);
    assert.deepEqual(said, [], 'words went before two seconds of idle');
    await queue.queueTick(4000);
    assert.deepEqual(said, [[7, SID, { text: 'first', key: 'Enter', chat: true }]]);
    await queue.queueTick(4500);
    assert.equal(said.length, 1, 'the next words did not wait their own two seconds');
    now = 'busy'; // the first words started a turn
    await queue.queueTick(5000);
    now = 'idle';
    await queue.queueTick(6000);
    await queue.queueTick(7000);
    assert.equal(said.length, 1, 'a moment of idle inside a turn let the words go');
    await queue.queueTick(8000);
    assert.equal(said[1][2].text, 'second');
    assert.deepEqual(queue.queued(SID), []);
    // a question on the screen holds the queue too
    queue.enqueue(SID, 7, 'third');
    now = 'question';
    await queue.queueTick(9000); await queue.queueTick(20000);
    assert.equal(said.length, 2);
    // taken back before it went
    const id = queue.queued(SID)[0].id;
    assert.equal(queue.unqueue(SID, id), true);
    assert.equal(queue.unqueue(SID, id), false);
    queue.enqueue(SID, 7, 'fourth');
    now = 'gone';
    await queue.queueTick(30000);
    assert.deepEqual(queue.queued(SID).map((q) => q.text), ['fourth'], 'a slow tmux took the queue of a live Claude');
    // a Claude that is gone takes its queue with it
    paneGone = true;
    await queue.queueTick(31000);
    assert.deepEqual(queue.queued(SID), []);
    assert.equal(said.length, 2);
  } finally {
    queue.setQueueDeps(null);
    queue.clearQueues();
  }
});

// comes from the page. They wait in the queue with the words and go with them
test('a chat\'s pictures are the task\'s attachments, by id — never a path, never another task\'s', async () => {
  const other = db.prepare("SELECT id FROM tasks WHERE title = 'Other task'").get().id;
  const own = db.prepare("INSERT INTO task_attachments (task_id, file, mime) VALUES (?, 'own.png', 'image/png')").run(taskId).lastInsertRowid;
  const foreign = db.prepare("INSERT INTO task_attachments (task_id, file, mime) VALUES (?, 'x.png', 'image/png')").run(other).lastInsertRowid;
  const post = (body) => app.inject({ method: 'POST', url: '/api/tasks/CH-1/chat', payload: body });
  for (const images of [[foreign], ['/etc/passwd'], [own, own], 'x', Array.from({ length: 11 }, (_, i) => i + 1)]) {
    assert.equal((await post({ text: 'look', images })).statusCode, 400, JSON.stringify(images));
  }
  assert.equal((await post({ text: '  ' })).statusCode, 400, 'empty words without a picture');
  const many = Array.from({ length: 11 }, (_, i) => db.prepare("INSERT INTO task_attachments (task_id, file, mime) VALUES (?, ?, 'image/png')").run(taskId, `m${i}.png`).lastInsertRowid);
  assert.equal((await post({ text: 'look', images: many })).statusCode, 400, 'eleven pictures of the task in one message');
  assert.equal((await post({ text: 'look', images: many.slice(0, 10) })).json().reason, 'gone', 'ten pictures of the task are refused');
  // a picture alone is a message: it passes the checks and meets the next refusal — no Claude of the board here
  assert.equal((await post({ images: [own] })).json().reason, 'gone');
  const { taskAttachmentPaths } = await import('../src/routes/tasks.js');
  assert.deepEqual(taskAttachmentPaths(taskId, [own]), [join(tmp, 'attachments', String(taskId), 'own.png')]);
  assert.equal(taskAttachmentPaths(taskId, [own, foreign]), null);
  // queued, they wait with the words and go with them; the page sees how many
  const said = [];
  queue.setQueueDeps({ atPrompt: async () => 'idle', gone: async () => false, say: async (t, s, b) => { said.push(b); return { ok: true }; }, task: (id) => ({ id }), timer: false });
  try {
    queue.enqueue(SID, 7, '', ['/d/a.png']);
    assert.equal(queue.queued(SID)[0].images_n, 1);
    await queue.queueTick(1000); await queue.queueTick(4000);
    assert.deepEqual(said, [{ text: '', key: 'Enter', chat: true, images: ['/d/a.png'] }]);
  } finally { queue.setQueueDeps(null); queue.clearQueues(); }
});

// DELIVER_TRIES times in all, then the journal says so
test('queued words that did not reach Claude wait at the head of the queue and go again, a few times', async () => {
  const tries = [];
  queue.setQueueDeps({ atPrompt: async () => 'idle', gone: async () => false, say: async (t, s, b) => { tries.push(b.text); return { refused: 'not-typed' }; }, task: (id) => ({ id }), timer: false });
  try {
    queue.enqueue(SID, 7, 'first');
    queue.enqueue(SID, 7, 'second');
    let now = 1000;
    for (let i = 0; i < 12; i++) { await queue.queueTick(now); now += 2500; }
    assert.deepEqual(tries.slice(0, queue.DELIVER_TRIES), Array(queue.DELIVER_TRIES).fill('first'), 'the second words went before the first');
    assert.equal(tries.filter((x) => x === 'first').length, queue.DELIVER_TRIES, 'words that never arrive are tried for good');
    const { db: d } = await import('../src/db.js');
    assert.ok(d.prepare("SELECT 1 FROM app_errors WHERE message LIKE 'queued words did not reach Claude (not-typed)%'").get(), 'given-up words are not in the journal');
  } finally { queue.setQueueDeps(null); queue.clearQueues(); }
});

// going on; what other sessions and the harness send the same way is not the person's
test('words the person sent while Claude worked stay in its turn; an agent message or a notification is not the person', () => {
  const att = (a) => ({ type: 'attachment', timestamp: at(30), attachment: { type: 'queued_command', ...a } });
  assert.deepEqual(chat.chatItems(att({ prompt: 'why so long?', commandMode: 'prompt', origin: { kind: 'human' } })), [{ at: Date.parse(at(30)), kind: 'said', text: 'why so long?' }]);
  assert.deepEqual(chat.chatItems(att({ prompt: '<agent-message from="x">done</agent-message>', commandMode: 'prompt', origin: { kind: 'agent' } })), []);
  assert.deepEqual(chat.chatItems(att({ prompt: '<agent-message from="x">done</agent-message>', commandMode: 'prompt' })), []);
  const turns = chat.chatTurns([
    { at: 1, kind: 'user', text: 'Fix it' }, { at: 2, kind: 'text', text: 'On it.' },
    ...chat.chatItems(att({ prompt: 'and the docs', origin: { kind: 'human' } })), { at: 4e12, kind: 'text', text: 'Docs too.' },
  ]);
  assert.equal(turns.length, 1, 'words sent mid-turn started a turn of their own');
  assert.deepEqual(turns[0].items.map((i) => i.kind), ['text', 'said', 'text']);
});

test('the queue has a ceiling', () => {
  queue.setQueueDeps({ timer: false });
  try {
    for (let i = 0; i < queue.QUEUE_MAX; i++) assert.ok(queue.enqueue(OTHER, 1, `w${i}`).id);
    assert.deepEqual(queue.enqueue(OTHER, 1, 'one more'), { full: true });
  } finally { queue.setQueueDeps(null); queue.clearQueues(); }
});

test('words typed a moment ago hold the next ones; typing into one terminal goes one at a time', async () => {
  queue.clearQueues();
  queue.markSaid(SID, 10_000);
  assert.equal(queue.saidLately(SID, 11_000), true, 'words right after words are typed at once');
  assert.equal(queue.saidLately(SID, 12_500), false);
  const order = [];
  const slow = (tag, ms) => queue.typing(SID, async () => { order.push(`${tag}+`); await new Promise((r) => setTimeout(r, ms)); order.push(`${tag}-`); });
  await Promise.all([slow('a', 40), slow('b', 5), queue.typing(OTHER, async () => { order.push('other'); })]);
  assert.deepEqual(order.filter((x) => x !== 'other'), ['a+', 'a-', 'b+', 'b-'], 'two typings into one terminal overlapped');
  assert.ok(order.indexOf('other') < order.indexOf('a-'), 'another terminal waited for this one');
  queue.clearQueues();
});

test('a chat\'s words that would switch Claude Code into a mode go after the task\'s key', async () => {
  const { chatWords } = await import('../src/terminal-say.js');
  assert.equal(chatWords('CH-1', '!important: update the docs'), 'CH-1: !important: update the docs', 'a ! at the start runs a shell command');
  assert.equal(chatWords('CH-1', '/clear'), 'CH-1: /clear');
  assert.equal(chatWords('CH-1', '  # note'), 'CH-1: # note');
  assert.equal(chatWords('CH-1', 'add 2 tests, see @src/a.ts'), 'add 2 tests, see @src/a.ts', 'plain words are changed');
});

test('what the screen shows of an open question goes to the chat: its last lines with words', async () => {
  const { questionLines } = await import('../src/routes/chat.js');
  const screen = `${Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')}\n Do you want to proceed?\n ❯ 1. Yes\n   2. No\n\n Esc to cancel   \n\n\n`;
  const q = questionLines(screen);
  assert.equal(q.split('\n').length, 16);
  assert.match(q, /Do you want to proceed\?[\s\S]*1\. Yes[\s\S]*Esc to cancel$/);
});

test('the page: no Chat | Terminal switch on a column, folds that close again, a shutter over the tasks, keys for a question', () => {
  const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
  const terms = read('now-terms.js');
  assert.doesNotMatch(terms, /now-col-views|data-v="chat"/, 'a column has its own switch again');
  assert.match(terms, /const view = !can \? 'none' : !c\.board \? 'chat' : claudeView\(\);/, 'a column does not follow the setting');
  assert.match(terms, /<div class="now-col-tasks"><\/div><button type="button" class="now-col-more" hidden><\/button>/, 'the button is not under the tasks');
  assert.match(terms, /setTasksClosed\(!el\.classList\.contains\('tasks-closed'\)\)/, 'the shutter does not open and close');
  assert.match(terms, /localStore\.getItem\(TASKS_KEY\) !== 'open'/, 'a column opens with all its tasks');
  assert.match(terms, /row\.classList\.toggle\('now-row-cur', row\.dataset\.key === cur\)/, 'closed, the list does not keep the task at work');
  assert.match(readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'), /\.now-col\.tasks-closed \.now-col-tasks \.now-row:not\(\.now-row-cur\) \{ display: none; \}/);
  const chat = read('chat.js');
  assert.match(chat, /if \(c\.opened\.has\(id\)\) c\.opened\.delete\(id\); else c\.opened\.add\(id\);/, 'opened steps cannot be folded again');
  assert.match(chat, /if \(c\.keep\) \{ c\.keep = false; sc\.scrollTop = keepTop; \}/, 'a fold does not keep the reader where they were');
  assert.match(chat, /rightHTML: `<span class="chat-mi-on">\$\{ic\('check', 12\)\}<\/span>`/, 'the session shown has no check in the list');
  assert.match(chat, /if \(chev\) chev\.innerHTML = ic\('chevron', 11\);/, 'the session chip lost its chevron');
  assert.match(readFileSync(new URL('../public/style.css', import.meta.url), 'utf8'), /html\[data-design="v3"\] \.chat-sess-sel \.kbsel-btn \{[^}]*border: none;[^}]*background: none;/, 'the session chip is a framed select again');
  // and the chip and its list take their colours from the tokens (the shadow is the chat menu's own)
  const sessCss = [...readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').matchAll(/[^{}]*\.chat-sess-sel[^{}]*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
  assert.match(sessCss, /html\[data-design="v3"\] \.chat-sess-sel \.kbsel-opt\.active \{ font-weight: 400; \}/, 'the session shown is bold in its list');
  assert.doesNotMatch(sessCss.replace(/box-shadow: 0 14px 36px rgba\(0, 0, 0, \.28\)/, ''), /#[0-9a-f]{3,8}\b|rgba?\(/i, 'a colour of the session chip or its list is not a token');
  // with no word; the list goes back to the session shown and the chat says why
  assert.match(chat, /if \(key === c\.key && mounted\.has\(c\) && c\.data && asked === c\.asked && asked !== c\.shownAsked\) \{\n\s*c\.asked = c\.shownAsked;\n\s*c\.refused = refusalLine\('Could not load the chat', e, tr\);\n\s*top\.dataset\.sig = '';/, 'a session that did not load stays named over the chat of another');
  assert.match(chat, /c\.shownAsked = asked;/, 'the chat does not know which session it shows');
  // head clicked is gone from the page (measured by it, the chat did not move at all)
  assert.match(chat, /if \(!shown\) reveal\(\[\.\.\.log\.querySelectorAll\('\[data-fold\]'\)\]\.find\(\(x\) => x\.dataset\.fold === id\), foldBody\(id\), unfold\(foldBody\(id\), true\)\);/, 'an opened fold grows under the edge again');
  assert.match(chat, /const to = Math\.max\(from, Math\.min\(bottom - view, top\)\);/, 'a tall fold scrolls past its head, or a fold in view moves the chat');
  assert.doesNotMatch(chat, /busy: 'Claude is working/, 'the line under a busy chat is back');
  assert.match(chat, /const on = Boolean\(d\.send && d\.state === 'question' && \(d\.question \|\| d\.choice\)\)/, 'the chat does not answer a question');
  assert.match(chat, /if \(d\.choice\) \{ paintChoice\(d\.choice\); return; \}/, 'a choice off the screen is the tail again');
  assert.match(chat, /const a = d\.session \? questionAsk\(c\.key, d\.session\) : null;\s*if \(a\) \{/, 'a question of the board\'s hook is not a form in the chat');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /#work \.chat-dock \{\s*position: sticky;/, 'the field of the card\'s chat runs off its bottom edge');
  // caret scrolled away (measured: style height 79px, the field 26px, in both engines)
  assert.match(css, /\.chat-form \.chat-box textarea \{\s*display: block; flex: none;/, 'the chat\'s field is held at one line again');
  // row of columns was scrolled to it (measured: 163px under the frame at 1280×800 without these rules)
  assert.match(css, /\.now-col-chat \.chat-log \{ flex-basis: 0; \}/, 'the list of a column takes the room of its question again');
  assert.match(css, /\.now-col-chat \.chat-dock > \.chat-ask\.form \{ flex: 0 1 auto; min-height: 0;/, 'the question of a column does not shrink');
  assert.match(css, /\.now-col-chat \.chat-ask\.form > \.ask \{ flex: 0 1 auto; min-height: 0; \}/, 'the question of a column does not shrink');
  assert.match(css, /\.now-col\.col-full \.now-col-chat \.chat-log \{ flex: 1 1 0;/, 'a column on the full screen pushes its field out again');
});

// for its transcript right then; Claude Code writes the file ten seconds later. The miss was remembered for a minute,
// and the chat of a Claude just started stayed empty all that minute.
test('a transcript written a moment after the launch is in the chat on its next look, not a minute later', async () => {
  const LATE = 'cccccccc-3333-4333-8333-cccccccccccc';
  const pid = db.prepare("SELECT id FROM projects WHERE slug='ch'").get().id;
  const late = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,3,'Late task','prep')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:00')").run(late, LATE);
  const before = (await app.inject({ method: 'GET', url: '/api/tasks/CH-3/chat' })).json();
  assert.equal(before.away, true, 'no file yet — the chat waits for it');
  const { findTranscript } = await import('../src/claude-sessions.js');
  assert.equal(await findTranscript(LATE), null, 'the miss is remembered for the rest of the board');
  writeFileSync(join(claude, 'projects', '-chat', `${LATE}.jsonl`), user(1, 'Do CH-3') + said(2, 'Taking CH-3.'));
  const after = (await app.inject({ method: 'GET', url: '/api/tasks/CH-3/chat' })).json();
  assert.ok(!after.away, 'the chat waited out the remembered miss');
  assert.equal(after.turns[0].user, 'Do CH-3');
  assert.ok(db.prepare('SELECT transcript FROM task_sessions WHERE task_id = ?').get(late).transcript.endsWith(`${LATE}.jsonl`), 'the found transcript is not kept');
});

// ended its turn handing work to four helpers: the chat showed "worked 3 min" and nothing else, as if it were done.
test('a helper in the background is in the chat while it runs — its steps and the one it is on — and ends with its notification', async () => {
  const BG = 'dddddddd-4444-4444-8444-dddddddddddd';
  const dir = join(claude, 'projects', '-chat');
  const pid = db.prepare("SELECT id FROM projects WHERE slug='ch'").get().id;
  const task = db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,4,'Helpers','doing')").run(pid).lastInsertRowid;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:00')").run(task, BG);
  const main = join(dir, `${BG}.jsonl`);
  // the shapes Claude Code 2.1.308 writes: the flag as the string "true", the launch answered at once
  writeFileSync(main, user(1, 'Check the batch')
    + call(2, 'h1', 'Agent', { description: 'Check the site tasks', prompt: 'x', run_in_background: 'true' })
    + call(2, 'c1', 'Bash', { command: 'npm test', description: 'Run the suite', run_in_background: true })
    + result(3, 'h1', 'Async agent launched successfully.')
    + result(3, 'c1', 'Command running in background with ID: b1.')
    + said(4, 'Waiting for the helper.')
    + end(5, 4000));
  mkdirSync(join(dir, BG, 'subagents'), { recursive: true });
  writeFileSync(join(dir, BG, 'subagents', 'agent-a1.meta.json'), JSON.stringify({ toolUseId: 'h1', description: 'Check the site tasks' }));
  const side = (s, id, name, input) => line({ type: 'assistant', isSidechain: true, timestamp: at(s), message: { content: [{ type: 'tool_use', id, name, input }] } });
  writeFileSync(join(dir, BG, 'subagents', 'agent-a1.jsonl'), side(6, 's1', 'Read', { file_path: '/p/a.md' }) + side(7, 's2', 'Bash', { command: 'curl x', description: 'Open the login page' }));
  // the session is alive and busy in Claude Code's registry: it waits for its helper
  mkdirSync(join(claude, 'sessions'), { recursive: true });
  writeFileSync(join(claude, 'sessions', '424242.json'), JSON.stringify({ sessionId: BG, pid: process.pid, status: 'busy' }));
  (await import('../src/routes/chat.js')).forgetRegistry();
  let r = (await app.inject({ method: 'GET', url: '/api/tasks/CH-4/chat' })).json();
  assert.equal(r.working, true, 'a Claude waiting for its helper has no light');
  const steps = () => r.turns.at(-1).items.filter((i) => i.kind === 'tool');
  const [helper, cmd] = steps();
  assert.equal(helper.running, true, 'a helper still at work reads as done');
  assert.equal(helper.ms, undefined, 'the launch is shown as the helper\'s whole time');
  assert.deepEqual(helper.helper, { steps: 2, now: { tool: 'Bash', text: 'Open the login page' } });
  assert.equal(cmd.running, true, 'a command in the background reads as done');
  assert.ok(!JSON.stringify(r).includes('"id"'), 'the ids of the steps went to the page');
  // the helper ends: Claude Code queues its notification and puts it in as an attachment
  const text = '<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>h1</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n</task-notification>';
  appendFileSync(main, line({ type: 'queue-operation', operation: 'enqueue', timestamp: at(30), content: text })
    + line({ type: 'attachment', timestamp: at(30), attachment: { type: 'queued_command', prompt: text, commandMode: 'task-notification', usage: { toolUses: 52, durationMs: 833134 } } }));
  r = (await app.inject({ method: 'GET', url: '/api/tasks/CH-4/chat' })).json();
  const [done, still] = steps();
  assert.equal(done.running, false, 'a helper that ended still runs');
  assert.equal(done.ms, 833134);
  assert.deepEqual(done.helper, { steps: 52 }, 'an ended helper keeps saying what it is on, or not how many steps it took');
  assert.equal(still.running, true, 'the notification of one ended all the background work');
  assert.equal(r.turns.length, 1, 'a notification read as the person\'s words');
  // Claude closed: no light, whatever was left in the background
  writeFileSync(join(claude, 'sessions', '424242.json'), JSON.stringify({ sessionId: BG, pid: 2 ** 30, status: 'busy' }));
  (await import('../src/routes/chat.js')).forgetRegistry();
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-4/chat' })).json().working, false, 'a closed Claude keeps its light');
});

test('the page lights the chat for a Claude at work or waiting for its helpers, and says what runs over the field', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    wireTermImages: () => {}, chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [], document: { addEventListener: () => {} }, setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false, setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false, copyText: async () => true, plainLabel: (x) => String(x).replace(/\s*\(recommended\)\s*$/i, ''),
  };
  vm.runInNewContext(`${src}\nthis.workingLine = workingLine; this.turnHTML = turnHTML; this.liveHTML = liveHTML;`, box);
  const step = (text, more = {}) => ({ kind: 'tool', tool: 'Bash', text, ms: 1000, error: false, ...more });
  const shot = (ref) => `/img/${ref}`;
  const pics = box.turnHTML({ at: 't', user: '[Image #1] [Image #2][Image #3]Look', images: 3, shots: [{ ref: 'u.0', w: 800, h: 400 }, { ref: 'u.1' }], items: [], open: true }, { shot });
  assert.match(pics, /class="chat-user has-shots"><div class="chat-shots"><button[^>]*data-shot="\/img\/u\.0"[^>]*><img src="\/img\/u\.0" alt="" width="220" height="110"/,
    'a thumbnail without its size grows after it decodes and pushes the turn being read');
  assert.match(pics, /<img src="\/img\/u\.1" alt="" decoding/);
  assert.match(pics, /<div class="chat-bubble">\[Image #3\]Look<span class="chat-img"> 1<\/span><\/div>/, 'the words keep «[Image #N]» of a picture shown, or lose that of one not shown');
  assert.doesNotMatch(box.turnHTML({ at: 't', user: '', images: 1, shots: [{ ref: 'u.0' }], items: [], open: true }, { shot }), /chat-bubble/, 'a picture alone gets an empty bubble');
  assert.match(box.turnHTML({ at: 't', user: '', images: 1, items: [], open: true }), /chat-bubble"><span class="chat-img"> 1/, 'a picture alone left no trace');
  const helper = step('Check the site tasks', { tool: 'Agent', running: true, ms: undefined, helper: { steps: 7, now: { tool: 'Read', text: 'a.md' } } });
  const turn = { at: 't', user: 'go', items: [step('one'), helper, step('two'), { kind: 'text', text: 'Waiting.' }], ms: 4000, open: false };
  assert.equal(box.workingLine({ working: false, turns: [turn] }), '', 'a Claude at rest is lit');
  assert.match(box.workingLine({ working: true, turns: [turn] }), /Claude works in the background… · helpers at work: 1/);
  assert.match(box.workingLine({ working: true, turns: [{ ...turn, open: true }] }), /Claude is working…/);
  assert.match(box.workingLine({ working: false, send: true, state: 'busy', turns: [{ ...turn, open: true }] }), /Claude is working…/, 'the board\'s own Claude at a turn is not lit');
  // is in says what it does and for how long, by the light
  const going = { ...turn, items: [step('one'), step('two'), step('three'), step('Post the note', { ms: undefined, at: '2026-01-01T00:00:00.000Z' })], ms: null, open: true };
  const shut = box.turnHTML(going, { working: true });
  assert.match(shut, /class="chat-run now"[^>]*><span class="chat-pulse"><\/span><span class="chat-run-t">Running a command<\/span><span class="chat-run-time" data-since="2026-01-01T00:00:00.000Z">\d+ h \d+ min</,
    'the run Claude is in does not say what it does and since when');
  assert.doesNotMatch(box.turnHTML(going), /chat-run now/, 'a run of a Claude not at work is lit');
  assert.match(box.turnHTML({ ...going, items: going.items.slice(0, 3) }, { working: true }), /class="chat-run"[^>]*><span class="chat-run-t">Ran 3 commands</, 'a run of answered steps is lit');
  assert.doesNotMatch(shut, /class="chat-step/, 'a step of the turn going on is shown with its fold shut');
  assert.equal((box.turnHTML(going, { working: true, opened: new Set(['t|0']) }).match(/class="chat-step"/g) || []).length, 4, 'an opened fold hides steps');
  const html = box.turnHTML(turn, { working: true });
  assert.match(html, /3 steps/, 'the fold does not count the helper still running');
  assert.match(box.turnHTML({ ...turn, ms: null, open: true }, { working: true }), /class="chat-run"[^>]*><span class="chat-run-t">Ran 2 commands, started a helper</,
    'the line does not count the helper still running, or not by kind in the order Claude came to them');
  assert.doesNotMatch(html, /Check the site tasks/, 'a helper still at work shows in the turn with its fold shut');
  // the step in hand is named by the light; a step answered or handed to the background is not
  assert.match(box.workingLine({ working: true, turns: [going] }), /class="chat-working-now"[^>]*>Runs · Post the note</, 'the light does not name the step in hand');
  assert.doesNotMatch(box.workingLine({ working: true, turns: [{ ...going, items: going.items.slice(0, 3) }] }), /chat-working-now/, 'an answered step is named as in hand');
  const live = box.liveHTML({ working: true, turns: [turn] });
  assert.match(live, /Check the site tasks/, 'a helper at work is not said over the field');
  assert.match(live, /7 steps/);
  assert.match(live, /in the background/);
  assert.match(live, /Reads · a\.md/, 'the step the helper is on is not shown');
  assert.match(live, /class="chat-pulse"/);
  assert.match(live, /<\/div><div class="chat-working">[^]*<\/div>$/, 'the light is not the last thing over the field');
  assert.equal(box.liveHTML({ working: false, turns: [turn] }), '', 'a closed Claude\'s helpers are said as running');
});

// log folded behind it, the files it changed with their lines added and taken away, and Claude's last words in sight
test('a finished turn: one bar over its work, the files it changed with their lines, its last words in sight', async () => {
  const feed = await import('../src/chat-feed.js');
  const t0 = '2026-10-23T03:00:00.000Z';
  const use = { type: 'assistant', timestamp: t0, message: { content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/p/src/a.js' } }] } };
  const res = { type: 'user', timestamp: '2026-10-23T03:00:02.000Z', message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'ok' }] },
    toolUseResult: { filePath: '/p/src/a.js', structuredPatch: [{ lines: ['+a', '+b', '-c', ' d'] }], oldString: 'secret', newString: 'code' } };
  const [r] = feed.chatItems(res);
  assert.deepEqual(r.diff, { add: 2, del: 1 });
  assert.doesNotMatch(JSON.stringify(r), /secret|code"/, 'the lines of a change go out');
  const created = feed.editSize({ filePath: 'x', type: 'create', content: 'one\ntwo\n', structuredPatch: [] });
  assert.deepEqual(created, { add: 2, del: 0 });
  const [turn] = feed.chatTurns([{ at: 1, kind: 'user', text: 'go' }, ...feed.chatItems(use), r, { at: 3e12, kind: 'end', ms: 125000 }]);
  assert.deepEqual(turn.items[0].diff, { add: 2, del: 1 }, 'the step does not carry its change');

  const vm = await import('node:vm');
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x), tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [], document: { addEventListener: () => {} }, setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false, setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false, copyText: async () => true, plainLabel: (x) => String(x).replace(/\s*\(recommended\)\s*$/i, ''),
  };
  vm.runInNewContext(`${src}\nthis.turnHTML = turnHTML;`, box);
  const edit = (file, add, del) => ({ kind: 'tool', tool: 'Edit', text: file, ms: 100, diff: { add, del } });
  const done = { at: 't', user: 'fix it', ms: 125000, open: false, items: [
    { kind: 'tool', tool: 'Read', text: 'src/a.js', ms: 50 }, { kind: 'text', text: 'Looking.' }, edit('src/a.js', 2, 1), edit('src/a.js', 3, 0), edit('lib/b.js', 1, 4),
    { kind: 'said', text: 'and the docs' }, { kind: 'text', text: 'Done: fixed.' }] };
  const shut = box.turnHTML(done);
  assert.match(shut, /class="chat-done"[^>]*data-fold="t\|work"[^]*Worked for 2 min[^]*4 steps[^]*2 files/, 'a finished turn has no bar with its time, steps and files');
  assert.doesNotMatch(shut, /Looking\.|class="chat-step"/, 'the work log of a finished turn is in sight with its bar shut');
  assert.match(shut, /Done: fixed\.<\/div><\/div>$/, 'the last words of Claude are not in sight at the end of the turn');
  assert.match(shut, /and the docs/, 'the words the person sent mid-turn are hidden');
  assert.match(shut, /Files changed: 2<\/span><span class="chat-add">\+6<\/span><span class="chat-del">−5</);
  assert.match(shut, /<span class="chat-file-n">a\.js<\/span><span class="chat-file-d">src<\/span><span class="chat-add">\+5<\/span><span class="chat-del">−1</, 'two edits of one file are not one row');
  const open = box.turnHTML(done, { opened: new Set(['t|work']) });
  assert.match(open, /Looking\./);
  assert.equal((open.match(/class="chat-step"/g) || []).length, 4, 'the opened log folds its steps again');
  assert.doesNotMatch(open, /class="chat-fold/);
  // a turn going on keeps its runs folded, as before
  assert.match(box.turnHTML({ ...done, ms: null, open: true }), /class="chat-run"/);
  assert.doesNotMatch(box.turnHTML({ ...done, ms: null, open: true }), /chat-done/);
});

// answered is the person's bubble of the questions and their answers, in a turn going on and in a finished one
test('a question answered shows as the person\'s bubble of questions and answers, not as a step', async () => {
  const vm = await import('node:vm');
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8').replace(/^import [\s\S]*?;$/gm, '').replace(/^export /gm, '');
  const box = {
    esc: (x) => String(x).replace(/</g, '&lt;'), tr: (x) => x, ic: () => '', plural: (n, a, b) => (n === 1 ? a : b), seg: (x) => x, refusalLine: () => '',
    chatText: (s) => String(s), questionAsk: () => null, askBlock: () => null, renderAsks: () => {}, SHORT_MONTHS: [], document: { addEventListener: () => {} }, setTimeout, clearTimeout, modelLabel: () => '', sameModel: () => false, MODELS: [], drawerIsFull: () => false, setDrawerFull: () => {}, openDrawerFull: () => {}, setClaudeView: () => {}, pushLayer: () => {}, popLayer: () => {}, styledConfirm: async () => false, copyText: async () => true, plainLabel: (x) => String(x).replace(/\s*\(recommended\)\s*$/i, ''),
  };
  vm.runInNewContext(`${src}\nthis.turnHTML = turnHTML;`, box);
  const ask = { kind: 'tool', tool: 'AskUserQuestion', text: 'Which way?', ms: 4000, answer: 'User has answered…',
    answers: [{ h: 'Way', q: 'Which way?', a: 'Through inst.bot (Recommended)' }, { q: 'Cache <too>?', a: 'Later' }] };
  const going = { at: 't', user: 'go', ms: null, open: true, items: [{ kind: 'tool', tool: 'Read', text: 'a.js', ms: 5 }, ask, { kind: 'text', text: 'Doing it.' }] };
  const html = box.turnHTML(going);
  assert.match(html, /class="chat-user chat-answers"/);
  assert.match(html, /Way · Which way\?<\/div><div class="chat-qa-a">Through inst\.bot<\/div>/, 'the question or the answer is missing, or the mark of the recommended option stays');
  assert.match(html, /Cache &lt;too>\?/, 'a question goes out unescaped');
  assert.match(html, /Read a file</, 'the answered question is counted as a step');
  const done = box.turnHTML({ ...going, ms: 9000, open: false });
  assert.match(done, /chat-answers/, 'a finished turn hides the answers behind its bar');
  assert.match(done, /1 step</);
  // declined: a step, with what Claude Code wrote
  assert.doesNotMatch(box.turnHTML({ ...going, items: [{ ...ask, answers: undefined, error: true }] }), /chat-answers/);
});

// the task's session read is served by the step's id, never by a path the page names
test('a picture Claude read opens by its step: a picture file of a step of this task, nothing else', async () => {
  const PIC = 'dddddddd-4444-4444-8444-dddddddddddd';
  const png = join(tmp, 'shot.png');
  const bytes = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  writeFileSync(png, bytes);
  writeFileSync(join(tmp, 'notes.txt'), 'private notes');
  writeFileSync(join(claude, 'projects', '-chat', `${PIC}.jsonl`), user(1, 'Look at the screenshot')
    + call(2, 'r1', 'Read', { file_path: png }) + result(3, 'r1', 'an image')
    + call(4, 'r2', 'Read', { file_path: join(tmp, 'notes.txt') }) + result(5, 'r2', 'private notes')
    + call(6, 'r3', 'Read', { file_path: join(tmp, 'gone.png') }) + result(7, 'r3', 'File does not exist', true));
  const other = db.prepare("SELECT id FROM tasks WHERE task_no = 2").get().id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:11')").run(other, PIC);
  const r = (await app.inject({ method: 'GET', url: '/api/tasks/CH-2/chat' })).json();
  const reads = r.turns[0].items.filter((i) => i.kind === 'tool');
  assert.deepEqual(reads.map((i) => i.pic), ['r1', undefined, undefined], 'only a picture read without an error is offered');
  assert.ok(!JSON.stringify(r).includes(tmp), 'the path of the file went to the page');
  const res = await app.inject({ method: 'GET', url: '/api/tasks/CH-2/chat/picture/r1' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.rawPayload, bytes);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-2/chat/picture/r2' })).statusCode, 404, 'a text file Claude read is served');
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-2/chat/picture/r3' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/CH-2/chat/picture/..%2Fshot.png' })).statusCode, 400);
  // a step of another task's session is not this task's to show
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/CH-1/chat/picture/r1` })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/CH-1/chat/picture/r1?session=${PIC}` })).statusCode, 404);
  db.prepare('DELETE FROM task_sessions WHERE session_id = ?').run(PIC);
});

test('a picture of a step is a picture file by its bytes — not a link to another file, not a folder, not too large', async () => {
  const SID4 = 'ffffffff-6666-4666-8666-ffffffffffff';
  const { symlinkSync, mkdirSync: mk, truncateSync } = await import('node:fs');
  const secret = join(tmp, 'secret.txt');
  writeFileSync(secret, 'root:x:0:0');
  symlinkSync(secret, join(tmp, 'link.png'));
  writeFileSync(join(tmp, 'fake.png'), '<html><script>alert(1)</script>');
  mk(join(tmp, 'dir.png'), { recursive: true });
  writeFileSync(join(tmp, 'huge.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  truncateSync(join(tmp, 'huge.png'), 26 * 1024 * 1024);
  const real = join(tmp, 'real.png');
  writeFileSync(real, Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'));
  symlinkSync(real, join(tmp, 'alias.png'));
  const steps = [['l1', 'link.png'], ['f1', 'fake.png'], ['d1', 'dir.png'], ['h1', 'huge.png'], ['a1', 'alias.png']];
  writeFileSync(join(claude, 'projects', '-chat', `${SID4}.jsonl`), user(1, 'Look')
    + steps.map(([id, f], i) => call(2 + 2 * i, id, 'Read', { file_path: join(tmp, f) }) + result(3 + 2 * i, id, 'an image')).join('')
    + call(20, 'p1', 'Read', { file_path: join(tmp, 'real.png') }) + call(21, 'b1', 'Bash', { command: 'cat', file_path: real }) + result(22, 'b1', 'ok'));
  const other = db.prepare('SELECT id FROM tasks WHERE task_no = 2').get().id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:11')").run(other, SID4);
  const get = (id) => app.inject({ method: 'GET', url: `/api/tasks/CH-2/chat/picture/${id}?session=${SID4}` });
  const link = await get('l1');
  assert.equal(link.statusCode, 404, 'a link named .png served the file it leads to');
  assert.ok(!link.body.includes('root:x'));
  assert.equal((await get('f1')).statusCode, 404, 'a page under a picture\'s name is served');
  assert.equal((await get('d1')).statusCode, 404);
  assert.equal((await get('h1')).statusCode, 413);
  assert.equal((await get('a1')).statusCode, 200, 'a link to a real picture is not served');
  assert.equal((await get('p1')).statusCode, 404, 'a Read with no result yet is served');
  assert.equal((await get('b1')).statusCode, 404, 'a step that is no Read is served');
  const r = (await app.inject({ method: 'GET', url: `/api/tasks/CH-2/chat?session=${SID4}` })).json();
  assert.equal(r.turns[0].items.find((i) => i.text?.endsWith('real.png') && i.tool === 'Read' && i.ms === undefined)?.pic, undefined, 'a Read with no result yet is offered');
  db.prepare('DELETE FROM task_sessions WHERE session_id = ?').run(SID4);
});

// in the line); the chat names it by the line and its place, the board serves it only from this task's session
test('a picture the person sent shows in the chat: by its line and place, of this task, a picture by its bytes', async () => {
  const SID5 = '99999999-7777-4777-8777-999999999999';
  const U1 = '11111111-aaaa-4aaa-8aaa-111111111111';
  const U2 = '22222222-bbbb-4bbb-8bbb-222222222222';
  const U3 = '33333333-cccc-4ccc-8ccc-333333333333';
  // a PNG head with its size (800×400) and a JPEG head, which tells none in its first bytes
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000032000000190080600000000', 'hex');
  const jpg = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
  const img = (data, media = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type: media, data: data.toString('base64') } });
  const said = (s, uuid, content) => line({ type: 'user', uuid, timestamp: at(s), message: { role: 'user', content } });
  const path = join(claude, 'projects', '-chat', `${SID5}.jsonl`);
  writeFileSync(path,
    said(1, U1, [{ type: 'text', text: '[Image #1][Image #2][Image #3]Look at these' }, img(png), img(Buffer.from('<html><script>')), img(jpg, 'image/jpeg')])
    + said(2, U2, [img(png, 'text/html')]));
  const other = db.prepare('SELECT id FROM tasks WHERE task_no = 2').get().id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:11')").run(other, SID5);
  const chat = async () => (await app.inject({ method: 'GET', url: `/api/tasks/CH-2/chat?session=${SID5}` })).json();
  const r = await chat();
  assert.deepEqual(r.turns.map((t) => [t.user, t.images, t.shots]), [
    ['[Image #1][Image #2][Image #3]Look at these', 3, [{ ref: `${U1}.0`, w: 800, h: 400 }, { ref: `${U1}.2` }]],
    ['', 1, undefined],
  ], 'a picture of no picture type, or whose bytes are another thing, is offered — a broken thumbnail in place of the «📎»');
  assert.ok(!JSON.stringify(r).includes(png.toString('base64')), 'the picture itself went with the chat');
  const get = (ref, task = 'CH-2') => app.inject({ method: 'GET', url: `/api/tasks/${task}/chat/image/${ref}?session=${SID5}` });
  const res = await get(`${U1}.0`);
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['content-type'], 'image/png');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(res.rawPayload, png);
  assert.deepEqual((await get(`${U1}.2`)).rawPayload, jpg, 'the third picture of the line is not the third');
  assert.equal((await get(`${U1}.1`)).statusCode, 404, 'a page under a picture\'s type is served');
  assert.equal((await get(`${U2}.0`)).statusCode, 404, 'a picture the chat does not offer is served');
  assert.equal((await get(`${U1}.5`)).statusCode, 404);
  assert.equal((await get('..%2F..%2Fetc.0')).statusCode, 400);
  assert.equal((await get(`${U1}.0`, 'CH-1')).statusCode, 404, 'another task\'s session is served');
  // ten at once — all of them, one reading; a line written later is found where it lies
  const all = await Promise.all(Array.from({ length: 10 }, () => get(`${U1}.0`)));
  assert.ok(all.every((x) => x.statusCode === 200 && x.rawPayload.equals(png)));
  // pictures of 3 MB took the board up by 400 MB; the line read again later is the line as it is then
  const { pictureBlocks } = await import('../src/chat-feed.js');
  const where = [0, readFileSync(path, 'utf8').indexOf('\n')];
  const one = pictureBlocks(path, U1, where);
  assert.equal(pictureBlocks(path, U1, where), one, 'each picture of a line reads and parses the whole line again');
  assert.equal((await one).length, 3);
  assert.notEqual(pictureBlocks(path, U1, [where[0], where[1] - 1]), one, 'a line at another place is taken for the one read');
  const U4 = '44444444-dddd-4ddd-8ddd-444444444444';
  appendFileSync(path, said(3, U4, [{ type: 'text', text: 'and this' }, img(jpg, 'image/jpeg')]));
  assert.deepEqual((await chat()).turns.at(-1).shots, [{ ref: `${U4}.0` }]);
  assert.deepEqual((await get(`${U4}.0`)).rawPayload, jpg);
  // the transcript gone under a chat already read: no picture, not a failure of the board
  const { renameSync } = await import('node:fs');
  renameSync(path, `${path}.gone`);
  assert.equal((await get(`${U1}.0`)).statusCode, 404);
  renameSync(`${path}.gone`, path);
  db.prepare('DELETE FROM task_sessions WHERE session_id = ?').run(SID5);
});

// sends them so — as PNG; a thumbnail without its size grew when it decoded), a JPEG turned by its EXIF has its sides
// swapped; a picture over PICTURE_MAX is neither offered nor served; a line half-written when the board indexed the
// transcript is found once it is whole; a transcript written anew (shorter) is indexed anew
test('a picture of the person: its size from a WebP and a JPEG, not over the limit, found in a line written in two goes', async () => {
  const { shotOf, PICTURE_MAX } = await import('../src/chat-feed.js');
  const b64 = (buf, media) => ({ type: 'image', source: { type: 'base64', media_type: media, data: buf.toString('base64') } });
  // WebP: VP8X (the Claude app's), VP8L, VP8 — each names its size in its head
  const vp8x = Buffer.from('524946460000000057454250565038580a000000100000003f0100c70000', 'hex'); // 320×200
  assert.deepEqual(shotOf(b64(vp8x, 'image/webp')), { type: 'image/webp', w: 320, h: 200 });
  assert.deepEqual(shotOf({ type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==' } }), { type: 'image/webp', w: 1, h: 1 });
  const vp8 = Buffer.from('52494646000000005745425056503820000000000000009d012a4001f000', 'hex'); // 320×240
  assert.deepEqual(shotOf(b64(vp8, 'image/webp')), { type: 'image/webp', w: 320, h: 240 });
  // JPEG: the size of its SOF, after an APP0 and a table; an EXIF orientation 6 (a quarter turn) swaps the sides
  const seg = (m, body) => Buffer.concat([Buffer.from([0xff, m]), Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const sof = seg(0xc0, Buffer.from([8, 0x01, 0x90, 0x06, 0x40, 3])); // 1600×400
  const jpg = (...segs) => Buffer.concat([Buffer.from([0xff, 0xd8]), ...segs, Buffer.from([0xff, 0xda, 0, 2])]);
  const app0 = seg(0xe0, Buffer.from('4a46494600010100000100010000', 'hex'));
  const dqt = seg(0xdb, Buffer.alloc(65));
  assert.deepEqual(shotOf(b64(jpg(app0, dqt, sof), 'image/jpeg')), { type: 'image/jpeg', w: 1600, h: 400 });
  const tiff = Buffer.from('4d4d002a00000008000101120003000000010006000000000000', 'hex');
  const exif = seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
  assert.deepEqual(shotOf(b64(jpg(exif, dqt, sof), 'image/jpeg')), { type: 'image/jpeg', w: 400, h: 1600 }, 'a JPEG turned by its EXIF keeps a place of the other shape');
  assert.deepEqual(shotOf(b64(Buffer.from('ffd8ffe0', 'hex'), 'image/jpeg')), { type: 'image/jpeg' }, 'a JPEG cut short has no size, and no failure');
  // a picture over the limit: a PNG head and padding past PICTURE_MAX
  const png = Buffer.from('89504e470d0a1a0a0000000d494844520000032000000190080600000000', 'hex');
  const big = Buffer.concat([png, Buffer.alloc(PICTURE_MAX + 16)]);
  assert.equal(shotOf(b64(big, 'image/png')), null, 'a picture over PICTURE_MAX is offered');
  const SID6 = '99999999-8888-4888-8888-999999999999';
  const U = '55555555-eeee-4eee-8eee-555555555555';
  const U2 = '66666666-ffff-4fff-8fff-666666666666';
  const path = join(claude, 'projects', '-chat', `${SID6}.jsonl`);
  const said = (s, uuid, content) => line({ type: 'user', uuid, timestamp: at(s), message: { role: 'user', content } });
  const pic = (uuid) => said(1, uuid, [{ type: 'text', text: 'look' }, b64(png, 'image/png')]);
  writeFileSync(path, said(0, '77777777-0000-4000-8000-777777777777', [{ type: 'text', text: 'start' }]) + line({ type: 'user', uuid: U2, timestamp: at(2), message: { role: 'user', content: [{ type: 'text', text: 'huge' }, b64(big, 'image/png')] } }));
  const other = db.prepare('SELECT id FROM tasks WHERE task_no = 2').get().id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:11')").run(other, SID6);
  const get = (ref) => app.inject({ method: 'GET', url: `/api/tasks/CH-2/chat/image/${ref}?session=${SID6}` });
  const look = async () => (await app.inject({ method: 'GET', url: `/api/tasks/CH-2/chat?session=${SID6}` })).json();
  assert.equal((await look()).turns.at(-1).shots, undefined);
  assert.equal((await get(`${U2}.0`)).statusCode, 404, 'a picture over PICTURE_MAX is served');
  // a line written in two goes: the board indexes (for a picture already offered) while the next one is half there
  const U3 = '88888888-1111-4111-8111-888888888888';
  appendFileSync(path, pic(U));
  assert.deepEqual((await look()).turns.at(-1).shots, [{ ref: `${U}.0`, w: 800, h: 400 }]);
  const next = pic(U3);
  appendFileSync(path, next.slice(0, 40));
  assert.equal((await get(`${U}.0`)).statusCode, 200);
  appendFileSync(path, next.slice(40));
  assert.deepEqual((await look()).turns.at(-1).shots, [{ ref: `${U3}.0`, w: 800, h: 400 }]);
  assert.equal((await get(`${U3}.0`)).statusCode, 200, 'a line half-written when the board indexed is lost for good');
  // the transcript written anew, shorter, with the picture at another place
  writeFileSync(path, pic(U));
  assert.equal((await look()).turns.at(-1).shots?.[0]?.ref, `${U}.0`);
  const again = await get(`${U}.0`);
  assert.equal(again.statusCode, 200, 'a transcript written anew is read by the places of the old one');
  assert.deepEqual(again.rawPayload, png);
  db.prepare('DELETE FROM task_sessions WHERE session_id = ?').run(SID6);
});

// sentence (a permission: «Bash command rm -rf … Do you want to proceed?»), and a wide thumbnail beside a tall one was
// stretched to its height — a white box with a strip in it
test('the page keeps the lines of a question off the screen, and each thumbnail at its own height', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(css, /\.ask-screen \.ask-q-text \{ white-space: pre-line; \}/, 'the lines of a question off the screen run together');
  assert.match(css, /\.chat-shots \{[^}]*align-items: flex-end;/, 'thumbnails of one row are stretched to the tallest');
});

test('a Read that failed serves no picture, even when the file is there now', async () => {
  const SID3 = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
  const png = join(tmp, 'denied.png');
  writeFileSync(png, Buffer.from('89504e47', 'hex'));
  writeFileSync(join(claude, 'projects', '-chat', `${SID3}.jsonl`), user(1, 'Look')
    + call(2, 'd1', 'Read', { file_path: png }) + result(3, 'd1', 'Permission to read denied', true));
  const other = db.prepare('SELECT id FROM tasks WHERE task_no = 2').get().id;
  db.prepare("INSERT INTO task_sessions (task_id, session_id, first_seen, last_seen) VALUES (?, ?, '2026-10-22 10:00:00', '2026-10-22 10:00:11')").run(other, SID3);
  assert.equal((await app.inject({ method: 'GET', url: `/api/tasks/CH-2/chat/picture/d1?session=${SID3}` })).statusCode, 404);
  db.prepare('DELETE FROM task_sessions WHERE session_id = ?').run(SID3);
});
