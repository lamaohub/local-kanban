// One session often works through a batch: three tasks moved to prep together, then done one by one.
// session's focus from those changes. These tests pin the rules down on plain data first, then run the
// real route over a fake Claude directory, and finally check that a growing transcript rings the board.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';

const SID = '12345678-1234-4234-8234-123456789abc';
let app, tmp, claude, db, feed, transcript;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  claude = mkdtempSync(join(tmpdir(), 'kb-claude-'));
  process.env.KB_DATA_DIR = tmp;
  process.env.KB_CLAUDE_DIR = claude;
  mkdirSync(join(claude, 'projects', '-work-feed'), { recursive: true });
  transcript = join(claude, 'projects', '-work-feed', `${SID}.jsonl`);
  writeFileSync(transcript, '');
  ({ db } = await import('../src/db.js'));
  const { ghState } = await import('../src/sync/worker.js');
  ghState.available = false; ghState.lastCheck = Date.now() + 1e9;
  feed = await import('../src/work-feed.js');
  db.prepare("INSERT INTO projects (slug, prefix, name, next_task_no) VALUES ('demo','WF','demo',4)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  for (const no of [1, 2, 3]) db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?,?,?,'todo')").run(pid, no, `Task ${no}`);
  const taskRoutes = (await import('../src/routes/tasks.js')).default;
  app = Fastify();
  await app.register(taskRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  for (const d of [tmp, claude]) if (d) rmSync(d, { recursive: true, force: true });
});

const ev = (task_id, status, at) => ({ task_id, status, at });

test('one task: the session is on it from the start until it hands it in', () => {
  assert.deepEqual(feed.sessionWindows([ev(1, 'prep', 10), ev(1, 'doing', 20), ev(1, 'review', 30)]),
    [{ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }]);
});

test('a batch moved to prep together is worked through one by one', () => {
  const w = feed.sessionWindows([
    ev(1, 'prep', 10), ev(2, 'prep', 11), ev(3, 'prep', 12),
    ev(1, 'doing', 20), ev(1, 'review', 30),
    ev(2, 'doing', 40), ev(2, 'review', 50),
    ev(3, 'doing', 60),
  ]);
  assert.deepEqual(w, [
    { task_id: 1, from: -Infinity, to: 30, focusAt: 10 },
    { task_id: 2, from: 30, to: 50, focusAt: 40 }, // reading the next card after handing in the first is its work
    { task_id: 3, from: 50, to: null, focusAt: 60 }, // still on it
  ], 'a batch prep stole the focus, or the stretch between two tasks went missing');
});

test('moving another task into doing takes the focus at once; a session that only talked hands the task back', () => {
  assert.deepEqual(feed.sessionWindows([ev(1, 'prep', 10), ev(2, 'doing', 20), ev(2, 'review', 30)]),
    [{ task_id: 1, from: -Infinity, to: 20, focusAt: 10 }, { task_id: 2, from: 20, to: 30 }]);
  assert.deepEqual(feed.sessionWindows([ev(1, 'prep', 10), ev(1, 'todo', 20)]),
    [{ task_id: 1, from: -Infinity, to: 20, focusAt: 10 }], 'an ask task goes back to To do after the talk');
  assert.deepEqual(feed.sessionWindows([ev(1, 'doing', 10), ev(1, 'review', 20), ev(2, 'backlog', 30)]),
    [{ task_id: 1, from: -Infinity, to: 20, focusAt: 10 }], 'after the last hand-in nothing belongs to any task');
});

test('handing in one of two tasks in work leaves the session on the other', () => {
  assert.deepEqual(feed.sessionWindows([ev(1, 'doing', 10), ev(2, 'doing', 20), ev(2, 'review', 30)]),
    [{ task_id: 1, from: -Infinity, to: 20, focusAt: 10 }, { task_id: 2, from: 20, to: 30 }, { task_id: 1, from: 30, to: null }]);
  assert.deepEqual(feed.sessionWindows([ev(1, 'doing', 10), ev(2, 'doing', 20), ev(3, 'deploy', 25), ev(3, 'review', 30)]).at(-1),
    { task_id: 2, from: 30, to: null }, 'the focus went to a task the session took into work earlier, not the latest');
  assert.deepEqual(feed.sessionWindows([ev(1, 'doing', 10), ev(2, 'doing', 20), ev(1, 'review', 22), ev(2, 'review', 30)]).at(-1),
    { task_id: 2, from: 20, to: 30 }, 'a task handed in before got the focus back');
});

test('a stretch nobody owned starts where the person last spoke before the task', () => {
  const items = [{ kind: 'user', at: 2 }, { kind: 'text', at: 3 }, { kind: 'user', at: 6 }, { kind: 'tool', at: 7 }];
  assert.equal(feed.trimLead({ task_id: 1, from: -Infinity, to: 30, focusAt: 10 }, items).from, 6);
  assert.equal(feed.trimLead({ task_id: 1, from: 8, to: 30, focusAt: 10 }, items).from, 8, 'no word from the person in it — it all belongs');
  assert.equal(feed.trimLead({ task_id: 1, from: 4, to: 30 }, items).from, 4, 'a window that began with a hand-over is not trimmed');
});

const at = (ms) => new Date(ms).toISOString();
const userLine = (ms, content, extra = {}) => ({ type: 'user', timestamp: at(ms), message: { role: 'user', content }, ...extra });
const toolLine = (ms, id, name, input) => ({ type: 'assistant', timestamp: at(ms), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const resultLine = (ms, id, content, isError = false) => userLine(ms, [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }]);

test('a transcript line becomes feed items; the harness around the person is left out', () => {
  assert.deepEqual(feed.lineItems(userLine(1000, 'Do WF-1')).map((i) => [i.kind, i.text]), [['user', 'Do WF-1']]);
  assert.deepEqual(feed.lineItems(userLine(1000, 'Base directory for this skill: …', { isMeta: true })), [], 'a skill body is not the person');
  assert.deepEqual(feed.lineItems(userLine(1000, [{ type: 'text', text: '<system-reminder>x</system-reminder>' }])), []);
  assert.deepEqual(feed.lineItems(toolLine(1000, 't1', 'Bash', { command: 'npm test', description: 'Run the tests' })).map((i) => [i.kind, i.tool, i.text]), [['tool', 'Bash', 'Run the tests']]);
  assert.deepEqual(feed.lineItems(toolLine(1000, 't2', 'ToolSearch', { query: 'x' })), [], 'bookkeeping is not a step');
  assert.deepEqual(feed.lineItems(resultLine(1000, 't1', 'boom', true)).map((i) => [i.kind, i.id, i.error]), [['result', 't1', true]]);
  const side = { ...toolLine(1000, 't3', 'Read', { file_path: '/a/b/c.js' }), isSidechain: true };
  assert.deepEqual(feed.lineItems(side), [], 'a side chain is a helper\'s, not the session\'s');
  assert.equal(feed.lineItems(side, true)[0].text, 'b/c.js', 'reading a helper\'s own transcript keeps its lines');
  assert.equal(feed.toolSummary('mcp__Claude_Browser__navigate', { url: 'http://x' }), 'Claude Browser: navigate · http://x');
  assert.equal(feed.toolSummary('Grep', { pattern: 'foo', path: '/x/y/z' }), 'foo · y/z');
});

test('a request the person pasted is their words, not the harness around them', () => {
  // the Claude app wraps pasted text in a tag, and the prompt copied from the board is pasted
  const pasted = '<pasted_content id="ab12">\nRun the kanban skill\nDo the task WF-1\n</pasted_content id="ab12">';
  assert.deepEqual(feed.lineItems(userLine(1000, pasted)).map((i) => [i.kind, i.text]), [['user', 'Run the kanban skill\nDo the task WF-1']]);
  assert.deepEqual(feed.lineItems(userLine(1000, [{ type: 'text', text: pasted }])).map((i) => i.text), ['Run the kanban skill\nDo the task WF-1']);
  assert.deepEqual(feed.lineItems(userLine(1000, [{ type: 'text', text: '<system-reminder>x</system-reminder>' }])), [], 'a reminder is still the harness');
});

test('every kind of line a real transcript holds is read, and what is not a step is left out', () => {
  // in the terminal and in the desktop app), every value scrubbed: the shapes are real, the content is not
  const lines = readFileSync(new URL('./fixtures/transcript-shapes.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 20, `the fixture lost its lines: ${lines.length}`);
  const out = new Set();
  for (const d of lines) for (const it of feed.lineItems({ ...d, timestamp: at(1000) })) out.add(`${d.type}:${it.kind}`);
  assert.deepEqual([...out].sort(), ['assistant:text', 'assistant:tool', 'user:result', 'user:user'],
    'a line kind the feed does not know became a step, or a known one stopped being read');
});

test('the route cuts one session\'s transcript by task, pairs calls with their results and finds helpers', async () => {
  const t0 = Date.now() - 600_000;
  const lines = [
    userLine(t0, 'Unrelated talk before any task'),
    userLine(t0 + 1000, 'Do WF-1 and WF-2'),
  ];
  writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const move = async (key, status, when) => {
    await app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': SID }, payload: { status } });
    db.prepare("UPDATE task_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM task_events)").run(new Date(when).toISOString().slice(0, 19).replace('T', ' '));
  };
  await move('WF-1', 'prep', t0 + 2000);
  await move('WF-2', 'prep', t0 + 3000);
  const more = [
    toolLine(t0 + 4000, 'a1', 'Bash', { command: 'cat notes', description: 'Read the notes for WF-1' }),
    resultLine(t0 + 6000, 'a1', 'ok'),
    toolLine(t0 + 7000, 'q1', 'AskUserQuestion', { questions: [{ question: 'Which color?' }] }),
    resultLine(t0 + 9000, 'q1', 'The user answered: "orange"'),
    toolLine(t0 + 10_000, 'h1', 'Agent', { description: 'Check the layout', subagent_type: 'general-purpose' }),
    resultLine(t0 + 10_500, 'h1', 'launched'),
  ];
  appendFileSync(transcript, more.map((l) => JSON.stringify(l)).join('\n') + '\n');
  await move('WF-1', 'doing', t0 + 3500);
  await move('WF-1', 'review', t0 + 20_000);
  appendFileSync(transcript, JSON.stringify(toolLine(t0 + 25_000, 'b1', 'Edit', { file_path: '/repo/src/two.js' })) + '\n'
    + JSON.stringify(resultLine(t0 + 26_000, 'b1', 'failed', true)) + '\n');
  await move('WF-2', 'doing', t0 + 22_000);
  // the helper's own transcript and its meta, next to the session's transcript
  const sub = join(claude, 'projects', '-work-feed', SID, 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'h1', description: 'Check the layout' }));
  writeFileSync(join(sub, 'agent-x.jsonl'), [
    { ...toolLine(t0 + 11_000, 's1', 'Read', { file_path: '/repo/a.css' }), isSidechain: true },
    { ...toolLine(t0 + 71_000, 's2', 'Bash', { command: 'x', description: 'Shoot the page' }), isSidechain: true },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');

  const one = (await app.inject({ method: 'GET', url: '/api/tasks/WF-1/work' })).json();
  const texts = one.items.map((i) => i.text);
  assert.equal(texts[0], 'Do WF-1 and WF-2', 'the feed starts where the person asked, not with the unrelated talk');
  assert.ok(!texts.includes('Unrelated talk before any task'));
  assert.ok(!texts.includes('src/two.js'), 'a step of WF-2 leaked into WF-1');
  const notes = one.items.find((i) => i.text === 'Read the notes for WF-1');
  assert.equal(notes.ms, 2000, 'the call is not paired with its result');
  assert.equal(notes.error, false);
  assert.equal(one.items.find((i) => i.tool === 'AskUserQuestion').answer, 'The user answered: "orange"');
  assert.deepEqual(one.items.find((i) => i.tool === 'Agent').helper, { steps: 2, ms: 60_000, live: false });
  assert.equal(one.items_n, one.items.length);
  assert.ok(one.items.every((i) => i.kind !== 'result'), 'results are folded into their calls, not shown on their own');

  const two = (await app.inject({ method: 'GET', url: '/api/tasks/WF-2/work' })).json();
  assert.deepEqual(two.items.map((i) => i.text), ['src/two.js'], 'WF-2 gets only what came after WF-1 was handed in');
  assert.equal(two.items[0].error, true);

  const none = (await app.inject({ method: 'GET', url: '/api/tasks/WF-3/work' })).json();
  assert.deepEqual(none, { items: [], items_n: 0, sessions: [] });
});

test('a line still being written is read once it is whole, not lost and not misread', async () => {
  const half = JSON.stringify(toolLine(Date.now(), 'c1', 'Bash', { command: 'x', description: 'Half-written step' }));
  appendFileSync(transcript, half.slice(0, 40));
  let two = (await app.inject({ method: 'GET', url: '/api/tasks/WF-2/work' })).json();
  assert.ok(!two.items.some((i) => i.text === 'Half-written step'));
  appendFileSync(transcript, half.slice(40) + '\n');
  two = (await app.inject({ method: 'GET', url: '/api/tasks/WF-2/work' })).json();
  assert.ok(two.items.some((i) => i.text === 'Half-written step'), 'the second half of a line went missing between two reads');
});

test('two readers at once do not read the same lines twice', async () => {
  // two tabs refresh the same card on one task.work event: both requests land at the same moment
  const base = Date.now();
  const lines = [];
  for (let i = 0; i < 40; i++) lines.push(JSON.stringify(toolLine(base + i, `p${i}`, 'Bash', { command: 'x', description: `Parallel step ${i}` })));
  appendFileSync(transcript, lines.join('\n') + '\n');
  const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'GET', url: '/api/tasks/WF-2/work' })));
  const third = (await app.inject({ method: 'GET', url: '/api/tasks/WF-2/work' })).json();
  for (const feed of [a.json(), b.json(), third]) {
    const steps = feed.items.filter((i) => String(i.text).startsWith('Parallel step '));
    assert.equal(steps.length, 40, `every step once, got ${steps.length}`);
  }
  assert.equal(a.json().items_n, third.items_n, 'the two readers and the next one disagree on how many steps there are');
});

test('a line that is not JSON, or is cut off, is skipped and the rest of the feed stays', async () => {
  appendFileSync(transcript, 'not json at all\n{"type":"assistant","timestamp":"\n'
    + `${JSON.stringify(toolLine(Date.now(), 'g1', 'Bash', { command: 'x', description: 'After the garbage' }))}\n`);
  const r = await app.inject({ method: 'GET', url: '/api/tasks/WF-2/work' });
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().items.some((i) => i.text === 'After the garbage'), 'a broken line took the lines after it down');
});

test('a transcript read in pieces of a few bytes gives the same feed, characters cut across pieces included', async () => {
  // the board reads a transcript a megabyte at a time (84 MB at once took it from 45 to 457 MB); here the
  // pieces are 7 bytes, so every line and every multi-byte character is cut somewhere
  const SID2 = '22222222-3333-4444-8555-666666666666';
  const t2 = join(claude, 'projects', '-work-feed', `${SID2}.jsonl`);
  const t0 = Date.now() - 60_000;
  const words = ['\u00dcn\u00efc\u00f6d\u00e9 \u2014 \u65e5\u672c\u8a9e \u2713 \ud83d\ude42', 'x'.repeat(300), 'plain'];
  writeFileSync(t2, `${JSON.stringify(userLine(t0, 'Do WF-3'))}\n`);
  await app.inject({ method: 'PATCH', url: '/api/tasks/WF-3', headers: { 'x-claude-session': SID2 }, payload: { status: 'doing' } });
  appendFileSync(t2, words.map((w, i) => JSON.stringify(toolLine(Date.now() + i, `m${i}`, 'Bash', { command: 'x', description: w }))).join('\n') + '\n');
  feed.setReadChunk(7);
  try {
    const got = (await app.inject({ method: 'GET', url: '/api/tasks/WF-3/work' })).json().items.map((i) => i.text);
    assert.deepEqual(got, ['Do WF-3', words[0], words[1].slice(0, 159) + '\u2026', words[2]]);
  } finally { feed.setReadChunk(0); }
  await app.inject({ method: 'PATCH', url: '/api/tasks/WF-3', payload: { status: 'review' } });
});

test('the chat shows what the transcript says as text, never as markup', async () => {
  const src = readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8');
  const html = src.slice(src.indexOf('function stepRow('), src.indexOf('const STATE_NOTE'));
  assert.ok(html.length > 500, 'the chat\'s drawing is not where this guard looks for it');
  assert.deepEqual(html.match(/\$\{(?!esc\(|chatText\()[^}]*\b(it|t|r\.it)\.(text|user|answer|tool)\b[^}]*\}/g) || [], [],
    'a value from the transcript goes into the markup unescaped');
  const paint = src.slice(src.indexOf('function paint('), src.indexOf('async function load('));
  assert.deepEqual(paint.match(/\$\{(?!esc\()[^}]*\bq\.(text|id)\b[^}]*\}/g) || [], [], 'queued words go into the markup unescaped');
  // Claude's text is escaped before any markup is put in: run chatText on hostile text
  assert.match(src, /import \{ (?:SHELL_LANGS, )?chatText \} from '\.\/chat-md\.js';/);
  const { chatText } = await import('../public/js/chat-md.js');
  const box = { out: chatText };
  const out = box.out('<img src=x onerror=alert(1)> **b** `<x>` [a](javascript:alert(1)) [ok](https://e.x/"q)\n```\n<script>\n```');
  assert.doesNotMatch(out, /<img|<script|<x>|href="javascript/);
  assert.match(out, /<strong>b<\/strong>/);
  assert.match(out, /<pre class="chat-code">&lt;script&gt;<\/pre>/);
});

test('a growing transcript of a task in work rings the board with the task key', async () => {
  const { bus } = await import('../src/bus.js');
  assert.equal(await feed.refreshWorkWatch(), 1, 'the transcript of WF-2 (in doing) is not watched');
  const heard = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no task.work within 6 s')), 6000);
    bus.on('event', (e) => { if (e.type === 'task.work') { clearTimeout(t); resolve(e.data); } });
  });
  // fs.watch starts listening on the next turn of the event loop: a change made in the same turn as
  // watch() is never reported. On the board the transcript keeps growing, so the next line wakes it.
  await new Promise((r) => setTimeout(r, 50));
  appendFileSync(transcript, JSON.stringify(toolLine(Date.now(), 'd1', 'Bash', { command: 'x', description: 'A new step' })) + '\n');
  const data = await heard;
  assert.deepEqual(data.keys, ['WF-2'], 'WF-1 is in review, so only WF-2 is still being worked on');
  await app.inject({ method: 'PATCH', url: '/api/tasks/WF-2', payload: { status: 'review' } });
  assert.equal(await feed.refreshWorkWatch(), 0, 'a task out of work is still watched');
});

test('the card applies task.work to its own feed and does not refresh the whole board on it', () => {
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(sse, /if \(ev\.type === 'task\.work'\) \{[^\n]*refreshWork\(state\.drawerKey\); return; \}/,
    'task.work would fall into the queue and refresh the whole board every second and a half');
});

test('the card reads the chat only while its tab is shown, one request at a time, and catches up when the tab opens', () => {
  const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const drawer = strip(readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8'));
  const chat = strip(readFileSync(new URL('../public/js/chat.js', import.meta.url), 'utf8'));
  assert.match(drawer, /const workShown = \(\) => !\$\('work-block'\)\.classList\.contains\('hidden'\) && !document\.hidden;/,
    'the card no longer asks whether the Chat tab is on screen');
  assert.match(drawer, /cardChat\.show\(workShown\(\)\);/, 'behind another tab the card reads the chat anyway');
  assert.match(drawer, /cardChat\?\.show\(cur === 'chat'\);/, 'opening the Chat tab does not read what it missed');
  assert.match(chat, /if \(!c\.shown \|\| document\.hidden\) \{ c\.stale = true; return undefined; \}/, 'a hidden chat is read');
  assert.match(chat, /if \(c\.flight\) \{ c\.again = true; return c\.flight; \}/, 'the chat requests are no longer one at a time');
  assert.match(chat, /c\.show = \(on\) => \{[^}]*c\.shown = on;\s*if \(on\) grow\(\);\s*if \(on && \(c\.stale \|\| !c\.data\)\) refresh\(\);/, 'a chat shown again does not catch up, or keeps the field measured while hidden');
});

test('a session whose kb sent no session id still has its feed: the unsigned moves of its tasks since it was tied are its own', async () => {
  // sends no session id. Every move of that Claude was written unsigned, and the card showed "no steps yet"
  // although the terminal had done the whole task.
  const SID3 = '44444444-5555-4666-8777-888888888888';
  const { tieLaunched, markBoardSession, bindSession } = await import('../src/claude-sessions.js');
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  const id = Number(db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, 4, 'Task 4', 'todo')").run(pid).lastInsertRowid);
  const stamp = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const unsigned = async (status, when) => {
    await app.inject({ method: 'PATCH', url: '/api/tasks/WF-4', payload: { status } });
    db.prepare('UPDATE task_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM task_events)').run(stamp(when));
  };
  const t0 = Date.now() - 120_000;
  await unsigned('prep', t0 - 60_000); // before the board started this session: somebody else's
  await unsigned('todo', t0 - 50_000);
  tieLaunched(id, SID3);
  markBoardSession(SID3); // the board started it itself (▶ inside the board)
  db.prepare('UPDATE task_sessions SET first_seen = ? WHERE session_id = ?').run(stamp(t0), SID3);
  writeFileSync(join(claude, 'projects', '-work-feed', `${SID3}.jsonl`), [
    userLine(t0 + 1000, 'Do WF-4'),
    toolLine(t0 + 3000, 'k1', 'Bash', { command: 'kb show WF-4', description: 'Show WF-4' }),
    toolLine(t0 + 8000, 'k2', 'Bash', { command: 'kb review WF-4 x', description: 'Hand WF-4 in' }),
    toolLine(t0 + 12_000, 'k3', 'Bash', { command: 'echo bye', description: 'After the hand-in' }),
  ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  await unsigned('prep', t0 + 2000);
  await unsigned('review', t0 + 9000);
  assert.deepEqual(feed.sessionEvents(SID3).map((e) => e.status), ['prep', 'review'], 'moves made before the session began were taken as its own');
  const got = (await app.inject({ method: 'GET', url: '/api/tasks/WF-4/work' })).json();
  assert.deepEqual(got.items.map((i) => i.text), ['Do WF-4', 'Show WF-4', 'Hand WF-4 in'], 'the feed of a session that did not sign its moves is empty or cut wrong');
  // a session that signs its moves never borrows the unsigned ones
  const signed = db.prepare('SELECT COUNT(*) AS n FROM task_events WHERE session_id = ?').get(SID).n;
  assert.ok(signed > 0);
  assert.equal(feed.sessionEvents(SID).length, signed);
  // nor does one the board did not start: it only left a note (an acceptance pass), and the moves around it
  // are the person's, made by hand (found by the review)
  const NOTED = '66666666-7777-4888-8999-aaaaaaaaaaaa';
  bindSession(id, 'review', NOTED);
  await app.inject({ method: 'PATCH', url: '/api/tasks/WF-4', payload: { status: 'doing' } }); // the person, by hand
  assert.deepEqual(feed.sessionEvents(NOTED), [], 'a session that only left a note took the person\'s moves for its own');
  assert.deepEqual(feed.sessionEvents(SID3).map((e) => e.status), ['prep', 'review', 'doing'], 'the board\'s own session lost the moves it borrows');
});

async function countReads(fn) {
  const { open } = await import('node:fs/promises');
  const probe = await open(transcript, 'r');
  const FH = Object.getPrototypeOf(probe);
  await probe.close();
  const orig = FH.read;
  let bytes = 0;
  FH.read = async function (...a) { const r = await orig.apply(this, a); bytes += r.bytesRead || 0; return r; };
  try { await fn(); } finally { FH.read = orig; }
  return bytes;
}
const stampOf = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
const newTask = (no) => {
  const pid = db.prepare("SELECT id FROM projects WHERE slug='demo'").get().id;
  db.prepare("INSERT INTO tasks (project_id, task_no, title, status) VALUES (?, ?, ?, 'todo')").run(pid, no, `Task ${no}`);
};
// the journal keeps whole seconds: the tests stamp the move two seconds after the person's request,
// so that the request is surely before it and starts the task's stretch
async function startWork(key, sid, when) {
  await app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': sid }, payload: { status: 'doing' } });
  db.prepare('UPDATE task_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM task_events)').run(stampOf(when));
}
const lines = (list) => list.map((l) => JSON.stringify(l)).join('\n') + '\n';

test('the feed keeps the NEWEST 400 items and counts all of them; ?count=1 gives only the count', async () => {
  const SID4 = '55555555-6666-4777-8888-999999999999';
  newTask(5);
  const t0 = Date.now() - 3_600_000;
  const steps = Array.from({ length: 450 }, (_, i) => toolLine(t0 + 3000 + i, `n${i}`, 'Bash', { command: 'x', description: `Step ${i}` }));
  writeFileSync(join(claude, 'projects', '-work-feed', `${SID4}.jsonl`), lines([userLine(t0, 'Do WF-5'), ...steps]));
  await startWork('WF-5', SID4, t0 + 2000);
  const got = (await app.inject({ method: 'GET', url: '/api/tasks/WF-5/work' })).json();
  assert.equal(got.items_n, 451, 'the person\'s request and 450 steps');
  assert.equal(got.items.length, 400);
  assert.equal(got.items[0].text, 'Step 50', 'the card got the oldest steps instead of the newest');
  assert.equal(got.items.at(-1).text, 'Step 449');
  const n = await app.inject({ method: 'GET', url: '/api/tasks/WF-5/work?count=1' });
  assert.deepEqual(n.json(), { items_n: 451 }, 'the tab counter got more than its number');
});

test('a session with 30 helpers: a helper is read once, then only what it appended; one outside the task is never read', async () => {
  const SID5 = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  newTask(6);
  const dir = join(claude, 'projects', '-work-feed');
  const sub = join(dir, SID5, 'subagents');
  mkdirSync(sub, { recursive: true });
  const t0 = Date.now() - 1_800_000;
  const main = [toolLine(t0, 'hx', 'Agent', { description: 'Before the task' }), userLine(t0 + 100, 'Do WF-6')];
  const helper = (i, at) => lines([
    { ...userLine(at, `Helper ${i}, go`), isSidechain: true },
    { ...toolLine(at + 10, `s${i}a`, 'Read', { file_path: `/repo/${i}.js` }), isSidechain: true },
    { ...toolLine(at + 20, `s${i}b`, 'Bash', { command: 'x', description: `Helper ${i} step` }), isSidechain: true },
  ]);
  let inside = 0;
  for (let i = 0; i < 30; i++) {
    const at = t0 + 3000 + i * 100;
    main.push(toolLine(at, `h${i}`, 'Agent', { description: `Helper ${i}` }));
    writeFileSync(join(sub, `agent-${i}.meta.json`), JSON.stringify({ toolUseId: `h${i}` }));
    const body = helper(i, at);
    writeFileSync(join(sub, `agent-${i}.jsonl`), body);
    inside += Buffer.byteLength(body);
  }
  // the helper of a call made BEFORE the task's stretch: big, and nobody should open it
  writeFileSync(join(sub, 'agent-x.meta.json'), JSON.stringify({ toolUseId: 'hx' }));
  writeFileSync(join(sub, 'agent-x.jsonl'), lines(Array.from({ length: 300 }, (_, i) => ({ ...toolLine(t0 + i, `x${i}`, 'Bash', { command: 'x', description: 'Not this task' }), isSidechain: true }))));
  const mainBody = lines(main);
  writeFileSync(join(dir, `${SID5}.jsonl`), mainBody);
  await startWork('WF-6', SID5, t0 + 2000);

  let feed;
  const first = await countReads(async () => { feed = (await app.inject({ method: 'GET', url: '/api/tasks/WF-6/work' })).json(); });
  assert.equal(feed.items.filter((i) => i.helper).length, 30);
  assert.deepEqual(feed.items.find((i) => i.text === 'Helper 7').helper, { steps: 2, ms: 20, live: false });
  assert.equal(first, Buffer.byteLength(mainBody) + inside, 'the first open read more than the transcript and the helpers of this task');

  const again = await countReads(() => app.inject({ method: 'GET', url: '/api/tasks/WF-6/work' }));
  assert.equal(again, 0, 'nothing changed, yet the feed read the transcripts again (the cache of 24 overflowed?)');

  const more = `${JSON.stringify({ ...toolLine(t0 + 9000, 's7c', 'Bash', { command: 'x', description: 'One more' }), isSidechain: true })}\n`;
  appendFileSync(join(sub, 'agent-7.jsonl'), more);
  const third = await countReads(async () => { feed = (await app.inject({ method: 'GET', url: '/api/tasks/WF-6/work' })).json(); });
  assert.equal(third, Buffer.byteLength(more), 'a helper that grew was read from the start instead of from where it stopped');
  assert.deepEqual(feed.items.find((i) => i.text === 'Helper 7').helper, { steps: 3, ms: 9000 - 3700, live: false });
});

test('two requests for the feed of one task at the same time are built once', async () => {
  const fsp = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const orig = fsp.stat;
  let stats = 0;
  fsp.stat = function (p, ...a) { if (String(p).includes('77777777-8888')) stats++; return orig.call(this, p, ...a); };
  syncBuiltinESMExports();
  try {
    await app.inject({ method: 'GET', url: '/api/tasks/WF-6/work' });
    const one = stats;
    assert.ok(one > 0, 'the probe sees nothing: the feed does not stat its transcripts through node:fs/promises');
    stats = 0;
    const [a, b] = await Promise.all([1, 2].map(() => app.inject({ method: 'GET', url: '/api/tasks/WF-6/work' })));
    assert.equal(stats, one, 'two requests at once built the feed twice');
    assert.deepEqual(a.json(), b.json());
  } finally {
    fsp.stat = orig;
    syncBuiltinESMExports();
  }
});

test('the tab counter says the same number as the feed, results of calls not counted; a helper meta is read once', async () => {
  const SID6 = '88888888-9999-4aaa-8bbb-cccccccccccc';
  newTask(7);
  const dir = join(claude, 'projects', '-work-feed');
  const sub = join(dir, SID6, 'subagents');
  mkdirSync(sub, { recursive: true });
  const t0 = Date.now() - 1_200_000;
  const main = [userLine(t0, 'Do WF-7')];
  for (let i = 0; i < 3; i++) {
    main.push(toolLine(t0 + 3000 + i * 100, `c${i}`, 'Bash', { command: 'x', description: `Step ${i}` }));
    main.push(resultLine(t0 + 3050 + i * 100, `c${i}`, 'ok'));
  }
  main.push(toolLine(t0 + 4000, 'hh', 'Agent', { description: 'A helper' }));
  main.push(resultLine(t0 + 4500, 'hh', 'done'));
  writeFileSync(join(sub, 'agent-h.meta.json'), JSON.stringify({ toolUseId: 'hh' }));
  writeFileSync(join(sub, 'agent-h.jsonl'), lines([{ ...toolLine(t0 + 4100, 'hs', 'Read', { file_path: '/r/a.js' }), isSidechain: true }]));
  writeFileSync(join(dir, `${SID6}.jsonl`), lines(main));
  await startWork('WF-7', SID6, t0 + 2000);
  const full = (await app.inject({ method: 'GET', url: '/api/tasks/WF-7/work' })).json();
  assert.equal(full.items_n, 5, 'the person, three steps and the helper');
  assert.deepEqual(full.items.find((i) => i.text === 'A helper').helper, { steps: 1, ms: 0, live: false });
  const n = (await app.inject({ method: 'GET', url: '/api/tasks/WF-7/work?count=1' })).json();
  assert.deepEqual(n, { items_n: full.items_n }, 'the counter behind another tab counted the results of the calls: the number jumps when the tab is opened');

  const fsp = (await import('node:fs/promises')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const orig = fsp.readFile;
  let metas = 0;
  fsp.readFile = function (p, ...a) { if (String(p).endsWith('.meta.json')) metas++; return orig.call(this, p, ...a); };
  syncBuiltinESMExports();
  try {
    writeFileSync(join(sub, 'agent-z.meta.json'), JSON.stringify({ toolUseId: 'zz' })); // a helper of another call
    await app.inject({ method: 'GET', url: '/api/tasks/WF-7/work' });
    assert.equal(metas, 1, 'the probe does not see the new meta, or the known one was read again');
    metas = 0;
    await app.inject({ method: 'GET', url: '/api/tasks/WF-7/work' });
    assert.equal(metas, 0, 'the metas of the helpers are read on every request');
  } finally {
    fsp.readFile = orig;
    syncBuiltinESMExports();
  }
});

test('a helper whose transcript cannot be read is left out; the feed still answers', async () => {
  const SID7 = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
  newTask(8);
  const dir = join(claude, 'projects', '-work-feed');
  const sub = join(dir, SID7, 'subagents');
  mkdirSync(sub, { recursive: true });
  const t0 = Date.now() - 900_000;
  const main = [userLine(t0, 'Do WF-8'), toolLine(t0 + 3000, 'ok1', 'Agent', { description: 'Readable helper' }), toolLine(t0 + 3100, 'bad1', 'Agent', { description: 'Broken helper' })];
  writeFileSync(join(sub, 'agent-ok.meta.json'), JSON.stringify({ toolUseId: 'ok1' }));
  writeFileSync(join(sub, 'agent-ok.jsonl'), lines([{ ...toolLine(t0 + 3010, 'r1', 'Read', { file_path: '/r/a.js' }), isSidechain: true }]));
  writeFileSync(join(sub, 'agent-bad.meta.json'), JSON.stringify({ toolUseId: 'bad1' }));
  mkdirSync(join(sub, 'agent-bad.jsonl')); // stat says it is there, reading it fails
  writeFileSync(join(dir, `${SID7}.jsonl`), lines(main));
  await startWork('WF-8', SID7, t0 + 2000);
  const r = await app.inject({ method: 'GET', url: '/api/tasks/WF-8/work' });
  assert.equal(r.statusCode, 200, `one unreadable helper took the whole feed down: ${r.body.slice(0, 160)}`);
  const got = r.json();
  assert.deepEqual(got.items.find((i) => i.text === 'Readable helper').helper, { steps: 1, ms: 0, live: false });
  assert.equal(got.items.find((i) => i.text === 'Broken helper').helper, undefined, 'a helper that cannot be read got a summary');
});

const wholeSecond = (ms) => Math.floor(ms / 1000) * 1000;
async function moveAt(key, status, sid, when) {
  await app.inject({ method: 'PATCH', url: `/api/tasks/${key}`, headers: { 'x-claude-session': sid }, payload: { status } });
  db.prepare('UPDATE task_events SET created_at = ? WHERE id = (SELECT MAX(id) FROM task_events)').run(stampOf(when));
}
const texts = async (key) => (await app.inject({ method: 'GET', url: `/api/tasks/${key}/work` })).json().items;

test('the hand-in step made in the same second as the move it makes stays in the feed, with its result', async () => {
  const SID8 = 'abababab-cdcd-4efe-8a0a-121212121212';
  newTask(9);
  const s0 = wholeSecond(Date.now() - 500_000); // the moves below are stamped in whole seconds from here
  writeFileSync(join(claude, 'projects', '-work-feed', `${SID8}.jsonl`), lines([
    userLine(s0, 'Do WF-9'),
    toolLine(s0 + 3000, 'w9', 'Bash', { command: 'x', description: 'Work on WF-9' }),
    resultLine(s0 + 3100, 'w9', 'ok'),
    // the move below is stamped s0 + 5000 although it happened after this call, somewhere in that second
    toolLine(s0 + 5231, 'r9', 'Bash', { command: 'kb review WF-9 done', description: 'Hand WF-9 in' }),
    resultLine(s0 + 6050, 'r9', 'WF-9 -> review'), // a slow answer: past the end of the move's second
    toolLine(s0 + 7000, 'e9', 'Bash', { command: 'x', description: 'The report after the hand-in' }),
  ]));
  await moveAt('WF-9', 'doing', SID8, s0 + 2000);
  await moveAt('WF-9', 'review', SID8, s0 + 5000);
  const items = await texts('WF-9');
  assert.deepEqual(items.map((i) => i.text), ['Do WF-9', 'Work on WF-9', 'Hand WF-9 in'],
    'the step that handed the task in fell out of its feed (or the tail after the hand-in came in)');
  const handIn = items.find((i) => i.text === 'Hand WF-9 in');
  assert.equal(handIn.ms, 819, 'the hand-in is shown without its result: the result came after the window ended');
  assert.equal(handIn.error, false);
  assert.equal((await app.inject({ method: 'GET', url: '/api/tasks/WF-9/work?count=1' })).json().items_n, 3);
});

test('one second that ends one task and starts the next gives each step to exactly one of them', async () => {
  const SID9 = 'cdcdcdcd-efef-4a1a-8b2b-343434343434';
  for (const no of [10, 11, 12]) newTask(no);
  const s1 = wholeSecond(Date.now() - 400_000);
  const step = (ms, id, description) => toolLine(s1 + ms, id, 'Bash', { command: 'x', description });
  writeFileSync(join(claude, 'projects', '-work-feed', `${SID9}.jsonl`), lines([
    userLine(s1, 'Do WF-10, then WF-11'),
    step(3000, 'a10', 'Work on WF-10'),
    // the hand-in of WF-10 and the take of WF-11 fall into one second, s1 + 5000
    step(5100, 'r10', 'Hand WF-10 in'),
    resultLine(s1 + 5300, 'r10', 'ok'),
    step(5600, 't11', 'Take the next task'),
    resultLine(s1 + 5800, 't11', 'WF-11'),
    step(6400, 'o11', 'Open WF-11'), // the second right after the shared one is the next task's
    step(7000, 'a11', 'Work on WF-11'),
    // a direct switch, no hand-in between: WF-11 is still in doing when WF-12 is moved there at s1 + 9000
    step(9100, 's12', 'Switch to WF-12'),
    step(10_400, 'o12', 'Open WF-12'),
    step(11_000, 'a12', 'Work on WF-12'),
  ]));
  await moveAt('WF-10', 'doing', SID9, s1 + 2000);
  await moveAt('WF-10', 'review', SID9, s1 + 5000);
  await moveAt('WF-11', 'doing', SID9, s1 + 5000);
  await moveAt('WF-12', 'doing', SID9, s1 + 9000);
  const got = {};
  for (const key of ['WF-10', 'WF-11', 'WF-12']) got[key] = (await texts(key)).map((i) => i.text);
  // the rule: a move splits the stream at the END of its second, and that second goes to the stretch before it
  assert.deepEqual(got, {
    'WF-10': ['Do WF-10, then WF-11', 'Work on WF-10', 'Hand WF-10 in', 'Take the next task'],
    'WF-11': ['Open WF-11', 'Work on WF-11', 'Switch to WF-12'],
    'WF-12': ['Open WF-12', 'Work on WF-12'],
  });
  const all = ['Do WF-10, then WF-11', 'Work on WF-10', 'Hand WF-10 in', 'Take the next task', 'Open WF-11', 'Work on WF-11', 'Switch to WF-12', 'Open WF-12', 'Work on WF-12'];
  for (const t of all) {
    const n = Object.values(got).flat().filter((x) => x === t).length;
    assert.equal(n, 1, `"${t}" is in ${n} feeds: a step of a shared second was lost or given to two tasks`);
  }
});
