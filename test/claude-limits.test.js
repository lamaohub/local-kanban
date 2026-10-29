// status line of the terminal Claude Code: `kb statusline` forwards `rate_limits` from the JSON Claude Code pipes
// into it and passes that JSON on unchanged, so it can stand in front of a status line the person already has.
// The board merges readings of several sessions without going back in time, forgets a window once it has reset,
// and the sidebar footer shows what is left with the time the board heard of it.
// The real bin/kb runs against the real route on a real socket: kb speaks HTTP, `inject` cannot stand in for it.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const KB = fileURLToPath(new URL('../bin/kb', import.meta.url));
const NOW_S = Math.floor(Date.now() / 1000);
const FIVE = NOW_S + 2 * 3600; // the 5-hour window resets in two hours
const WEEK = NOW_S + 3 * 86400;
let app, tmp, base, limits, events;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = tmp;
  await import('../src/db.js');
  limits = await import('../src/claude-limits.js');
  const { bus } = await import('../src/bus.js');
  events = [];
  bus.on('event', (e) => { if (e.type === 'limits.updated') events.push(e.data); });
  app = Fastify();
  await app.register((await import('../src/routes/claude.js')).default);
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

// pretty-printed with a trailing newline: a kb that re-serialised the JSON would not pass it on byte for byte
const statusJson = (five, week, extra = {}) => `${JSON.stringify({
  session_id: 'abc', model: { id: 'claude-opus-5-5', display_name: 'Opus' },
  context_window: { used_percentage: 8, context_window_size: 1000000 },
  rate_limits: { five_hour: { used_percentage: five, resets_at: FIVE }, seven_day: { used_percentage: week, resets_at: WEEK } },
  ...extra,
}, null, 2)}\n`;

// kb with stdin piped in; resolves when the process exits, with when its stdout ended
function kb(args, input, env = {}) {
  let child;
  const run = new Promise((resolve) => {
    const started = Date.now();
    child = spawn(process.execPath, [KB, ...args], { env: { ...process.env, KB_URL: base, ...env } });
    let stdout = '';
    let stderr = '';
    let stdoutEndedAt = null;
    child.stdout.on('data', (c) => { stdout += c; });
    child.stdout.on('end', () => { stdoutEndedAt = Date.now() - started; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => resolve({ code, stdout, stderr, stdoutEndedAt, ms: Date.now() - started }));
    child.stdin.end(input);
  });
  run.child = child;
  return run;
}

test('the status line windows are taken as they are written; anything else is dropped at the door', () => {
  const n = limits.normalizeLimits({
    five_hour: { used_percentage: 23.46, resets_at: FIVE },
    seven_day: { used_percentage: 41.2, resets_at: WEEK * 1000 }, // milliseconds are recognised
    spend_limit: { used_percentage: 62.8, resets_at: WEEK, used_usd: 314.12, limit_usd: 500, period: 'monthly' },
    hourly: { used_percentage: 5, resets_at: FIVE },
    __proto__: { polluted: true },
  });
  assert.deepEqual(Object.keys(n).sort(), ['five_hour', 'seven_day', 'spend_limit']);
  assert.deepEqual(n.five_hour, { used: 23.5, resets_at: FIVE });
  assert.equal(n.seven_day.resets_at, WEEK);
  assert.deepEqual(n.spend_limit, { used: 62.8, resets_at: WEEK, used_usd: 314.12, limit_usd: 500, period: 'monthly' });
  for (const bad of [{ used_percentage: '23', resets_at: FIVE }, { used_percentage: 23 }, { used_percentage: -1, resets_at: FIVE },
    { used_percentage: 5000, resets_at: FIVE }, { used_percentage: 5, resets_at: 12345 }, null, [], 'x']) {
    assert.deepEqual(limits.normalizeLimits({ five_hour: bad }), {}, `taken: ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(limits.normalizeLimits(null), {});
  assert.deepEqual(limits.normalizeLimits([1, 2]), {});
});

test('readings of several sessions merge without going back in time', () => {
  const now = NOW_S;
  const old = { five_hour: { used: 30, resets_at: FIVE } };
  const stale = { five_hour: { used: 12, resets_at: FIVE + 20 } }; // the same window, an idle session's older figure
  assert.equal(limits.mergeLimits(old, stale, now).five_hour.used, 30, 'an older reading of the same window replaced a newer one');
  assert.equal(limits.mergeLimits(stale, old, now).five_hour.used, 30, 'a newer reading of the same window was not taken');
  const next = { five_hour: { used: 2, resets_at: FIVE + 5 * 3600 } }; // a new window after the reset
  assert.deepEqual(limits.mergeLimits(old, next, now).five_hour, next.five_hour, 'a new window lost to the old one');
  const gone = { five_hour: { used: 99, resets_at: now - 1 } };
  assert.equal(limits.mergeLimits(gone, {}, now).five_hour, undefined, 'a window past its reset was kept');
  assert.equal(limits.mergeLimits({ seven_day: { used: 40, resets_at: WEEK } }, old, now).seven_day.used, 40,
    'a running window the new reading does not carry was dropped');
});

// ends sooner than the held one and is still running belongs to another account (/login into another one, or two at
// once). The old rule kept whichever window ends later and stamped it with the time of the newest reading: after a
// switch the footer showed the previous account's figures as fresh ones, for hours on the 5-hour bar, days on the week.
test('another account\'s reading replaces the held one, whichever window ends later', () => {
  const now = NOW_S;
  const a = { five_hour: { used: 80, resets_at: now + 4 * 3600 }, seven_day: { used: 65, resets_at: now + 6 * 86400 } };
  const b = { five_hour: { used: 10, resets_at: now + 3600 }, seven_day: { used: 5, resets_at: now + 2 * 86400 } };
  assert.deepEqual(limits.mergeLimits(a, b, now), b, 'switched to an account whose windows end sooner, the footer kept the previous one');
  assert.deepEqual(limits.mergeLimits(b, a, now), a, 'switched back, the footer kept the other account');
  const idle = { five_hour: { used: 7, resets_at: now + 3600 + 60 } }; // B's own window again, an idle session's older figure
  assert.equal(limits.mergeLimits(b, idle, now).five_hour.used, 10, 'an older figure of the same window went back in time');
});

test('POST /api/limits keeps the reading and GET gives it back with the time it came', async () => {
  const r = await app.inject({ method: 'POST', url: '/api/limits', payload: { rate_limits: { five_hour: { used_percentage: 24, resets_at: FIVE }, seven_day: { used_percentage: 41, resets_at: WEEK } }, model: 'claude-opus-5-5' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { stored: true });
  const g = (await app.inject({ method: 'GET', url: '/api/limits' })).json();
  assert.deepEqual(g.windows, { five_hour: { used: 24, resets_at: FIVE }, seven_day: { used: 41, resets_at: WEEK } });
  assert.ok(Math.abs(Date.parse(g.at) - Date.now()) < 5000, `at: ${g.at}`);
  assert.equal(g.model, 'claude-opus-5-5');
  // a session before its first API response has no rate_limits — it changes nothing
  const none = await app.inject({ method: 'POST', url: '/api/limits', payload: { model: 'x' } });
  assert.deepEqual(none.json(), { stored: false });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/limits' })).json().windows, g.windows);
  for (const payload of ['[1]', '"x"', 'null']) {
    const bad = await app.inject({ method: 'POST', url: '/api/limits', headers: { 'content-type': 'application/json' }, payload });
    assert.equal(bad.statusCode, 400, payload);
  }
});

test('the page is told when a figure moves, not on every status line run', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const post = (five) => app.inject({ method: 'POST', url: '/api/limits', payload: { rate_limits: { five_hour: { used_percentage: five, resets_at: FIVE }, seven_day: { used_percentage: 41, resets_at: WEEK } } } });
  await post(25);
  events.length = 0;
  for (let i = 0; i < 5; i++) await post(25); // the same reading, the same minute
  assert.equal(events.length, 0, 'an unchanged reading was sent to the page');
  await post(26);
  assert.equal(events.length, 1, 'a moved figure did not reach the page');
  assert.equal(events[0].windows.five_hour.used, 26);
  t.mock.timers.tick(61000); // the footer prints the minute — a new minute is news even with the same figures
  await post(26);
  assert.equal(events.length, 2, 'the new time of the reading did not reach the page');
});

test('a window past its reset is not given out at all', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: (FIVE + 60) * 1000 }); // the 5-hour window has reset
  const g = (await app.inject({ method: 'GET', url: '/api/limits' })).json();
  assert.equal(g.windows.five_hour, undefined, 'the reset window was still shown');
  assert.ok(g.windows.seven_day, 'the running week was dropped too');
});

test('the footer shows only running windows, the bar never past full', async () => {
  const { limitsView } = await import('../public/js/limits-rules.js');
  const at = new Date(NOW_S * 1000).toISOString();
  const v = limitsView({ at, windows: { seven_day: { used: 41.2, resets_at: WEEK }, five_hour: { used: 23.5, resets_at: FIVE }, spend_limit: { used: 130, resets_at: WEEK } } }, NOW_S * 1000);
  assert.deepEqual(v.rows.map((r) => [r.kind, r.used, r.bar]), [['five_hour', 24, 24], ['seven_day', 41, 41], ['spend_limit', 130, 100]]);
  assert.equal(v.at, NOW_S * 1000);
  const later = limitsView({ at, windows: { five_hour: { used: 23.5, resets_at: FIVE } } }, (FIVE + 1) * 1000);
  assert.deepEqual(later, { rows: [], at: null }, 'a reset window is old numbers shown as current');
  assert.deepEqual(limitsView(null, Date.now()), { rows: [], at: null });
  assert.deepEqual(limitsView({ windows: {} }, Date.now()), { rows: [], at: null });
});

// kb hangs up a moment after its request is out, so the board may take the reading after kb is gone: wait for it
async function reading(check, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const g = (await app.inject({ method: 'GET', url: '/api/limits' })).json();
    if (check(g) || Date.now() > until) return g;
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('kb statusline passes the JSON on unchanged and the board gets the limits', async () => {
  const input = statusJson(31.5, 42);
  const r = await kb(['statusline'], input);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, input, 'the JSON for the next status line changed on the way');
  const g = await reading((x) => x.windows.five_hour?.used === 31.5);
  assert.equal(g.windows.five_hour?.used, 31.5, 'the board never got the reading kb sent');
  assert.equal(g.windows.seven_day.used, 42);
});

test('kb statusline --line prints a short line of its own', async () => {
  const r = await kb(['statusline', '--line'], statusJson(23.6, 41.2));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '5h 24% · 7d 41% · ctx 8%\n');
  // and sends the limits all the same (a figure above the ones before: within a window the board keeps the higher)
  assert.equal((await kb(['statusline', '--line'], statusJson(55, 60))).code, 0);
  assert.equal((await reading((x) => x.windows.five_hour?.used === 55)).windows.five_hour?.used, 55, 'the reading of --line never reached the board');
  const bare = await kb(['statusline', '--line'], JSON.stringify({ model: { id: 'x' } }));
  assert.equal(bare.stdout, '\n', 'without figures the line is empty, not "undefined"');
});

test('kb statusline never breaks the status line: the board down, or input that is not JSON', async () => {
  const input = statusJson(10, 20);
  const down = await kb(['statusline'], input, { KB_URL: 'http://127.0.0.1:9' });
  assert.equal(down.code, 0, down.stderr);
  assert.equal(down.stdout, input);
  assert.equal(down.stderr, '', 'an error went to the status line');
  const held = (await app.inject({ method: 'GET', url: '/api/limits' })).json();
  const junk = await kb(['statusline'], 'not json at all');
  assert.equal(junk.code, 0);
  assert.equal(junk.stdout, 'not json at all');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/limits' })).json().windows, held.windows);
});

// A board that takes the request and never answers (its process hangs). Claude Code waits for the whole status line
// command, and the shell of `{ kb statusline … || cat; } | { … }` waits for kb — so kb must not wait long for an answer:
// reads the body a moment late — test/statusline-board.test.js) and hangs up. kb gives up on the board after a second
// at the latest, so a kb that waited for the answer hangs up a second after the request at the soonest; one that
// waits a moment, within moments.
test('kb statusline waits a moment for the answer, no longer — a board that never answers costs the status line a moment, not a second', { timeout: 20000 }, async () => {
  let got;
  const seen = new Promise((resolve) => { got = resolve; });
  const sockets = [];
  const silent = createServer((s) => {
    sockets.push(s);
    let at = null;
    let text = '';
    s.on('data', (c) => { text += c; if (at === null && text.includes('"rate_limits"')) at = Date.now(); });
    s.on('end', () => got({ text, heldMs: at === null ? null : Date.now() - at }));
  });
  await new Promise((r) => silent.listen(0, '127.0.0.1', r));
  const input = statusJson(5, 6);
  const run = kb(['statusline'], input, { KB_URL: `http://127.0.0.1:${silent.address().port}` });
  try {
    const r = await Promise.race([run, new Promise((_, no) => setTimeout(() => no(new Error('kb waited for the board with no time limit')), 10000))]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, input);
    const req = await Promise.race([seen, new Promise((_, no) => setTimeout(() => no(new Error('the board never saw kb hang up')), 5000))]);
    assert.match(req.text, /^POST \/api\/limits /, 'the request never reached the board');
    assert.ok(req.heldMs !== null && req.heldMs < 600, `kb hung up ${req.heldMs} ms after its request — it waited for the board's answer as long as it takes`);
  } finally {
    run.child.kill();
    for (const s of sockets) s.destroy();
    silent.close();
  }
});

// A board that cannot even be connected to: its accept queue is full (the process is stuck), so the connection is
// never made. The output goes first, so the person's status line has it at once; kb itself stops at its time limit.
// A full queue drops a new connection like this on macOS; Linux completes it and holds the data instead, and there
// kb would hang up at once — so the check runs where it is spelled for, the Mac the board is made on.
test('kb statusline closes its output before it reaches the board', { skip: process.platform !== 'darwin' && 'a full accept queue keeps a connection waiting only on macOS', timeout: 20000 }, async () => {
  const stuck = spawn(process.execPath, ['-e', `const s = require('net').createServer();
    s.listen({ port: 0, host: '127.0.0.1', backlog: 1 }, () => process.stdout.write(s.address().port + '\\n', () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)));`]);
  const held = [];
  try {
    const port = await new Promise((resolve) => stuck.stdout.once('data', (d) => resolve(Number(String(d).trim()))));
    // fill the queue: connect until a connection is left waiting
    for (let i = 0; i < 8; i++) {
      const c = createConnection(port, '127.0.0.1');
      held.push(c);
      c.on('error', () => {});
      const made = await new Promise((resolve) => { c.once('connect', () => resolve(true)); setTimeout(() => resolve(false), 300); });
      if (!made) break;
    }
    const input = statusJson(7, 8);
    const r = await Promise.race([kb(['statusline'], input, { KB_URL: `http://127.0.0.1:${port}` }),
      new Promise((_, no) => setTimeout(() => no(new Error('kb waited for the board with no time limit')), 10000))]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, input);
    assert.ok(r.stdoutEndedAt !== null && r.ms - r.stdoutEndedAt > 300, `the output closed ${r.ms - r.stdoutEndedAt} ms before kb exited — it waited for the board first`);
    // its own limit is a second; left to itself the system keeps trying the connection for about eight
    assert.ok(r.ms < 5000, `kb gave up on a board it cannot reach only after ${r.ms} ms — it has no time limit of its own`);
  } finally {
    for (const c of held) c.destroy();
    stuck.kill('SIGKILL');
  }
});

// last in the file: it leaves the board holding another account's windows
test('switching accounts shows the new account\'s figures with the time they came', async () => {
  const post = (five, fiveAt, week, weekAt) => app.inject({ method: 'POST', url: '/api/limits',
    payload: { rate_limits: { five_hour: { used_percentage: five, resets_at: fiveAt }, seven_day: { used_percentage: week, resets_at: weekAt } } } });
  await post(80, NOW_S + 4 * 3600, 65, NOW_S + 6 * 86400); // account A
  await post(10, NOW_S + 3600, 5, NOW_S + 2 * 86400); // account B, whose windows end sooner
  const g = (await app.inject({ method: 'GET', url: '/api/limits' })).json();
  assert.deepEqual(g.windows, { five_hour: { used: 10, resets_at: NOW_S + 3600 }, seven_day: { used: 5, resets_at: NOW_S + 2 * 86400 } },
    'the footer shows the previous account\'s figures');
  assert.ok(Math.abs(Date.parse(g.at) - Date.now()) < 5000, `at: ${g.at}`);
});
