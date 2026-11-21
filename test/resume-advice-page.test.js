// conversation quiet past the cache's hour gets a window — continue (and pay the rewrite), or a new session of the task.
// The real function, run in node:vm on stand-ins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resumeWords } from '../public/js/resume-rules.js';

const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
const piece = (head, end = '\n}\n') => {
  const at = sse.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from sse.js`);
  return sse.slice(at, sse.indexOf(end, at) + end.length).replace(/^export /, '');
};

function page({ advice, pick }) {
  const calls = [];
  const box = {
    calls, resumeWords, tr: (s) => s, AbortSignal, ADVICE_WAIT_MS: 5000, getSetting: () => 'auto', startEffort: () => 'high', checksOnly: () => false, state: { tasks: [] },
    api: async (method, path, body) => { calls.push([method, path.split('?')[0], body?.resume ? 'resume' : '']); if (method === 'GET') { if (advice instanceof Error) throw advice; return { advice }; } return { ok: true }; },
    styledConfirm: async (words, o) => { calls.push(['window', words, o.alt]); return pick; },
    launchInClaude: async (o) => { calls.push(['new session', o.text, o.keys.join()]); },
    taskPromptText: (k) => `Do ${k}`,
    refusedManual: () => false, refusedCheck: () => false, askProjectFolder: async () => false, styledAlert() {}, refusalLine: () => '', startRefused() {}, BOARD_WHY: {},
  };
  vm.runInNewContext(piece('export async function resumeOnBoard('), box);
  return box;
}
const btn = () => ({ disabled: false, textContent: 'Continue' });
const big = { tokens: 420_000, idle_ms: 3 * 3600_000, cost: 3.36 };

test('no advice — Continue continues at once, with no window', async () => {
  const b = page({ advice: null });
  assert.equal(await b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: btn() }), true);
  assert.deepEqual(b.calls.map((c) => c[0]), ['GET', 'POST']);
});

test('a second click while the advice is asked starts nothing more (review: two windows, two starts)', async () => {
  const b = page({ advice: null });
  const button = btn();
  const one = b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: button });
  const two = await b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: button });
  assert.equal(two, false);
  assert.equal(await one, true);
  assert.deepEqual(b.calls.map((c) => c[0]), ['GET', 'POST'], 'the second click asked or started again');
});

test('the board does not answer the advice — Continue still continues', async () => {
  const b = page({ advice: new Error('offline') });
  assert.equal(await b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: btn() }), true);
  assert.deepEqual(b.calls.map((c) => c[0]), ['GET', 'POST']);
});

test('a big quiet conversation: the window names the cost; «Continue» resumes, «New session» starts the task anew, Cancel does nothing', async () => {
  let b = page({ advice: big, pick: true });
  assert.equal(await b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: btn() }), true);
  assert.equal(b.calls[1][0], 'window');
  assert.match(b.calls[1][1], /420k .* 3 h: .*\$3\.36/);
  assert.equal(b.calls[1][2], 'New session');
  assert.deepEqual(b.calls[2], ['POST', '/api/launch', 'resume']);

  b = page({ advice: big, pick: 'alt' });
  assert.equal(await b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: btn() }), false);
  assert.deepEqual(b.calls.at(-1), ['new session', 'Do CK-1', 'CK-1']);
  assert.ok(!b.calls.some((c) => c[0] === 'POST'), 'the old session went on as well');

  b = page({ advice: big, pick: false });
  assert.equal(await b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: btn() }), false);
  assert.deepEqual(b.calls.map((c) => c[0]), ['GET', 'window']);
});

// task in its project (by the key's prefix — the server takes a slug or a prefix)
test('the window leaves the button enabled whatever is picked; «New session» names the project', async () => {
  for (const pick of [false, 'alt', true]) {
    const b = page({ advice: big, pick });
    const starts = [];
    b.launchInClaude = async (o) => { starts.push(o.project); };
    const button = btn();
    await b.resumeOnBoard({ key: 'CK-12', session: 's1', btn: button });
    assert.equal(button.disabled, false, `${pick}: the button stayed disabled`);
    if (pick === 'alt') assert.deepEqual(starts, ['CK'], 'the new session was started with no project');
  }
});

// may be named `again`)
test('every Continue of the page goes through resumeOnBoard and asks the advice', () => {
  const files = { 'drawer.js': 1, 'chat.js': 1, 'now.js': 1, 'now-terms.js': 1 };
  for (const [f, n] of Object.entries(files)) {
    const src = readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
    const calls = [...src.matchAll(/resumeOnBoard\(\{([^}]*)\}\)/g)].map((m) => m[1]);
    assert.equal(calls.length, n, `${f}: ${calls.length} calls of resumeOnBoard`);
    for (const c of calls) assert.doesNotMatch(c, /\bagain\s*:/, `${f}: a Continue that skips the advice — ${c}`);
  }
});

// dropped connection the browser keeps waiting on) left the button disabled and the session not continued, for good
test('the advice not answered at all — Continue still continues, and the button comes back', async () => {
  const b = page({ advice: null });
  b.ADVICE_WAIT_MS = 50; // the page's wait, shortened for the test
  b.api = (method, path, body, opts = {}) => {
    b.calls.push([method, path.split('?')[0], body?.resume ? 'resume' : '']);
    if (method !== 'GET') return Promise.resolve({ ok: true });
    return new Promise((_, reject) => opts.signal?.addEventListener('abort', () => reject(new Error('timed out'))));
  };
  const button = btn();
  const r = await Promise.race([b.resumeOnBoard({ key: 'CK-1', session: 's1', btn: button }), new Promise((res) => { setTimeout(() => res('stuck'), 2000); })]);
  assert.equal(r, true, 'Continue waited for the advice for good');
  assert.equal(button.disabled, false);
  assert.deepEqual(b.calls.map((c) => c[0]), ['GET', 'POST']);
});
