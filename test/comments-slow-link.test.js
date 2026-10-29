// core.js and run on a fake DOM with a fake server whose answers the test lets through one by one — the modules pull in
// their DOM neighbours, so node cannot import them.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { canRetry, createRetryQueue, createTurns, refusalLine, refusalText, resendDelay, RESEND_MAX_MS, RESEND_MS, TURN_WAIT_MS } from '../public/js/unsaved.js';

const read = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');
const drawer = read('drawer.js');
const from = (src, name) => (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${name}`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
};
const line = (src, name) => (head) => {
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${name}`);
  return src.slice(at, src.indexOf('\n', at) + 1);
};
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// the comment list of the card: the rows the page wrote, read back as the ids of the comments and the note
function commentsBox() {
  const box = {
    html: '',
    get innerHTML() { return box.html; },
    set innerHTML(h) { box.html = h; },
    insertAdjacentHTML(pos, h) { box.html = pos === 'afterbegin' ? h + box.html : box.html + h; },
    querySelector(sel) {
      if (sel === '.comments-note') return box.html.includes('comments-note') ? { remove: () => { box.html = box.html.replace(/<div class="board-note comments-note">[\s\S]*?<\/button><\/div>/, ''); } } : null;
      if (sel === '.comments-note button') return box.html.includes('comments-note') ? (box.retry = { onclick: null }) : null;
      return null;
    },
    // the × of every comment: a sent one carries data-del, an unsent one data-drop; what the page hangs on each is kept
    querySelectorAll(sel) {
      if (sel !== '.comment-del' && sel !== '.comment-del[data-del]') return [];
      const spans = [...box.html.matchAll(/class="comment-del" data-(del|drop)="(\d+)"/g)].filter((m) => sel === '.comment-del' || m[1] === 'del');
      return spans.map((m) => {
        const x = { dataset: { [m[1]]: m[2] } };
        Object.defineProperty(x, 'onclick', { set(fn) { box.wired.set(`${m[1]}:${m[2]}`, fn); } });
        return x;
      });
    },
    wired: new Map(),
    ids: () => [...box.html.matchAll(/class="comment" data-id="(\d+)"/g)].map((m) => Number(m[1])),
    note: () => (box.html.match(/<div class="board-note comments-note"><span>([^<]*)<\/span>/) || [])[1] || null,
  };
  return box;
}

function card() {
  const els = { comments: commentsBox() };
  const gets = []; // the reads of the comments on their way: { key, ok(list), fail(error) }
  const timers = [];
  const box = {
    $: (id) => els[id],
    state: { drawerKey: 'VV-1' },
    tr: (s) => s, esc: (s) => String(s), ic: () => '', seg: (s) => String(s), relTime: () => 'now',
    canRetry, refusalLine, refusalText, resendDelay,
    api: (method, path) => new Promise((ok, fail) => { gets.push({ key: path.split('/')[3], ok, fail }); }),
    paintUnsent: () => {}, openLightbox: () => {}, deleteComment: (id) => { box.deleted = id; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (id && timers[id - 1]) timers[id - 1].fn = null; },
    Math, Set, Boolean, Number,
  };
  const take = from(drawer, 'drawer.js');
  vm.runInNewContext([
    line(drawer, 'drawer.js')('const COMMENT_AUTHORS = '),
    line(drawer, 'drawer.js')('let commentsShown = '),
    line(drawer, 'drawer.js')('let commentsRead = '),
    line(drawer, 'drawer.js')('let commentsRetry = '),
    line(drawer, 'drawer.js')('let commentsBlank = '),
    line(drawer, 'drawer.js')('const COMMENTS_BLANK_MS = '),
    take('export function renderComments('),
    take('async function readComments('),
    take('function drawComments('),
    take('function commentHTML('),
    take('function wireComments('),
    take('function commentsFailed('),
    take('export function commentArrived('),
  ].join('\n'), box);
  const timersDue = () => timers.filter((t) => t.fn);
  return { box, els, gets, timers, timersDue };
}
const c = (id) => ({ id, author: 'me', body: `comment ${id}`, created_at: '2026-10-26 10:00:00' });

test('CK-840: a late answer for the task left behind is not drawn into the card opened since', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.box.state.drawerKey = 'VV-2'; // the person opened another card while the first read was on its way
  k.box.renderComments('VV-2');
  k.gets[1].ok([c(20)]);
  await settle();
  k.gets[0].ok([c(10), c(11)]); // the answer of the first card comes last
  await settle();
  assert.deepEqual(k.els.comments.ids(), [20], 'the comments of the task left behind stand in the open card');
});

test('CK-840: an older read of the same card overtaken by a newer one does not draw over it', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.box.state.drawerKey = 'VV-2';
  k.box.renderComments('VV-2');
  k.box.state.drawerKey = 'VV-1'; // and back
  k.box.renderComments('VV-1');
  k.gets[2].ok([c(10), c(11), c(12)]);
  await settle();
  k.gets[0].ok([c(10)]);
  await settle();
  assert.deepEqual(k.els.comments.ids(), [10, 11, 12], 'the older answer drew the list back to what it was');
});

test('CK-840: a slow read of another task empties the list instead of showing the comments of the one before', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.gets[0].ok([c(10)]);
  await settle();
  k.box.state.drawerKey = 'VV-2';
  k.box.renderComments('VV-2');
  const blank = k.timersDue().find((t) => t.ms === 200);
  assert.ok(blank, 'nothing takes the list of the task before off the card while the new one loads');
  blank.fn();
  assert.deepEqual(k.els.comments.ids(), [], 'the comments of the task before stay under the new card');
});

test('CK-864: an own comment and its event read nothing — the new comment is added to the list', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.gets[0].ok([c(10)]);
  await settle();
  k.box.commentArrived('VV-1', c(11)); // the answer to the person's own comment
  k.box.commentArrived('VV-1', c(11), 2); // and its event
  await settle();
  assert.equal(k.gets.length, 1, 'the own comment downloaded the list again');
  assert.deepEqual(k.els.comments.ids(), [10, 11]);
  k.box.commentArrived('VV-1', c(12), 3); // Claude noted
  assert.equal(k.gets.length, 1, 'a comment of Claude downloaded the whole list');
  assert.deepEqual(k.els.comments.ids(), [10, 11, 12]);
});

test('CK-864: a gap the count shows, a deletion, or an event while a read is on its way read the list', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.gets[0].ok([c(10)]);
  await settle();
  k.box.commentArrived('VV-1', c(13), 3); // two comments, one event: one went missing
  assert.equal(k.gets.length, 2, 'a missed comment is not read');
  k.box.commentArrived('VV-1', c(14), 4); // while that read goes: once more after it, not a third read at once
  assert.equal(k.gets.length, 2, 'a second read started alongside the first');
  k.gets[1].ok([c(10), c(12), c(13)]);
  await settle();
  assert.equal(k.gets.length, 3, 'what came during the read is never read');
  k.gets[2].ok([c(10), c(12), c(13), c(14)]);
  await settle();
  assert.deepEqual(k.els.comments.ids(), [10, 12, 13, 14]);
  k.box.commentArrived('VV-1', undefined, 3); // a deleted one
  assert.equal(k.gets.length, 4, 'a deleted comment stays in the list');
  k.box.commentArrived('VV-9', c(99), 1); // another task
  assert.equal(k.gets.length, 4, 'a comment of another task made the card read');
});

test('CK-854: a read that failed says so, asks again by itself and is never an unhandled error', async () => {
  const k = card();
  const done = k.box.renderComments('VV-1');
  k.gets[0].fail(Object.assign(new Error('Failed to fetch'), { offline: true }));
  await done; // it does not throw: before, every caller left an unhandled rejection
  assert.equal(k.els.comments.note(), 'The comments did not load: no connection to the board — try again');
  const again = k.timersDue().find((t) => t.ms === RESEND_MS);
  assert.ok(again, 'the card does not ask for the comments again by itself');
  again.fn();
  k.gets[1].fail(Object.assign(new Error('boom'), { status: 500 }));
  await settle();
  assert.ok(k.timersDue().some((t) => t.ms === RESEND_MS * 2), 'a server that keeps failing is asked as often as before');
  k.els.comments.retry.onclick(); // «Try now»
  k.gets[2].ok([c(10)]);
  await settle();
  assert.equal(k.els.comments.note(), null, 'the note stays after the comments came');
  assert.deepEqual(k.els.comments.ids(), [10]);
});

test('CK-854: a failed read of a task that is gone is not asked again, and its card never shows another task', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.gets[0].ok([c(10)]);
  await settle();
  k.box.state.drawerKey = 'VV-2';
  k.box.renderComments('VV-2');
  k.gets[1].fail(Object.assign(new Error('task not found'), { status: 404 }));
  await settle();
  assert.deepEqual(k.els.comments.ids(), [], 'the comments of the task before stand under the card whose comments did not load');
  assert.match(k.els.comments.note(), /no longer exists/);
  assert.ok(!k.timersDue().some((t) => t.ms === RESEND_MS), 'a 404 is asked again and again');
});

test('CK-843: the reopened stream and a stream back from a silence read the comments of the open card', () => {
  const sse = read('sse.js');
  const open = sse.slice(sse.indexOf('function linkOpened('), sse.indexOf('function streamMessage('));
  assert.match(open, /if \(boardLoadStarted && state\.drawerKey\) renderComments\(state\.drawerKey\);/, 'a reconnect does not catch up the comments of the open card');
  assert.match(sse, /if \(stale\) \{ refresh\(\)\.catch\(\(\) => \{\}\); if \(state\.drawerKey && !ownComment\) renderComments\(state\.drawerKey\); \}/, 'a stream back from a silence does not catch up the comments');
  assert.match(sse, /const ownComment = ev\.type === 'task\.comment' && ev\.data\?\.key === state\.drawerKey;/, 'a comment event after a silence reads the list twice');
  assert.match(sse, /if \(ev\.type === 'task\.comment'\) commentArrived\(ev\.data\.key, ev\.data\.comment, ev\.data\.comments_n\);/);
});

// the send of a comment (init.js), on a fake field and a server that answers when the test says
function sendForm() {
  const init = read('init.js');
  const at = init.indexOf('const commentSending = ');
  const end = init.indexOf('\n};\n', at) + 4;
  assert.ok(at >= 0, 'the comment send is gone from init.js');
  const els = { 'c-input': { value: '' }, 'c-send': {} };
  const posts = [];
  const box = {
    $: (id) => els[id], state: { drawerKey: 'VV-1' }, seg: (s) => s, Map, Date: { now: () => box.now }, now: 1000, Infinity,
    api: (method, path, body) => new Promise((ok) => { posts.push({ body, ok }); }),
    sayRefused: () => {}, queueComment: () => {}, commentDrafts: new Map(), autoGrow: () => {},
    arrived: [], commentArrived: (key, cm) => box.arrived.push(cm.id),
    shown: [], showOwnComment: (key, id) => box.shown.push(id),
  };
  vm.runInNewContext(init.slice(at, end), box);
  return { els, posts, box };
}

test('CK-841: a second press while the comment is on its way does not send it again', async () => {
  const f = sendForm();
  f.els['c-input'].value = 'please check the login';
  f.els['c-send'].onclick();
  f.els['c-send'].onclick(); // a double tap on a slow connection
  f.els['c-send'].onclick();
  assert.equal(f.posts.length, 1, 'the same comment went to the server twice');
  f.posts[0].ok({ id: 7 });
  await settle();
  assert.equal(f.els['c-input'].value, '');
  assert.deepEqual(f.box.arrived, [7]);
  assert.deepEqual(f.box.shown, [7], 'the card did not scroll to the comment just sent');
  f.els['c-input'].value = 'one more';
  f.els['c-send'].onclick();
  assert.equal(f.posts.length, 2, 'after the answer the next comment cannot be sent');
});

test('CK-841: what was typed while the comment was on its way stays in the field', async () => {
  const f = sendForm();
  f.els['c-input'].value = 'first';
  f.els['c-send'].onclick();
  f.els['c-input'].value = 'first and second';
  f.box.commentDrafts.set('VV-1', 'first and second');
  f.posts[0].ok({ id: 7 });
  await settle();
  assert.equal(f.els['c-input'].value, 'and second', 'the answer wiped what the person typed on, or left the sent text to go again');
  assert.equal(f.box.commentDrafts.get('VV-1'), 'and second');
});

test('CK-841: a send that never answers does not lock the field of the task for good', () => {
  const f = sendForm();
  f.els['c-input'].value = 'hello';
  f.els['c-send'].onclick();
  f.els['c-send'].onclick();
  assert.equal(f.posts.length, 1);
  f.box.now += 15000; // the first one still hangs
  f.els['c-send'].onclick();
  assert.equal(f.posts.length, 2, 'a hung request keeps the person from ever sending a comment on the task');
});

test('CK-841: ⌘/Ctrl+Enter in a new task does nothing while the task is being created', () => {
  const chaos = read('chaos.js');
  const body = chaos.slice(chaos.indexOf('async function chaosCreate() {'), chaos.indexOf("const input = $('chaos-input');", chaos.indexOf('async function chaosCreate() {')));
  assert.match(body, /if \(\$\('chaos-create'\)\.disabled\) return;/, 'the keys create a second task while the first is on its way');
});

test('CK-839: the edits go one at a time — an older answer cannot land over a newer edit', async () => {
  const inTurn = createTurns();
  const order = [];
  const answers = [];
  const send = (word) => () => new Promise((ok, fail) => { order.push(word); answers.push({ ok, fail }); });
  const a = inTurn('VV-1', send('w1'));
  const b = inTurn('VV-1', send('w2'));
  const c3 = inTurn('VV-1', send('w3'));
  await settle();
  assert.deepEqual(order, ['w1'], 'a second edit went while the first was on its way');
  answers[0].fail(new Error('Failed to fetch'));
  await assert.rejects(a);
  await settle();
  assert.deepEqual(order, ['w1', 'w2'], 'a failed edit holds the ones after it for good');
  answers[1].ok('saved w2');
  assert.equal(await b, 'saved w2');
  await settle();
  answers[2].ok('saved w3');
  assert.equal(await c3, 'saved w3');
  assert.deepEqual(order, ['w1', 'w2', 'w3']);
  const other = inTurn('VV-2', send('other task'));
  inTurn('VV-1', send('w4'));
  await settle();
  assert.deepEqual(order.slice(3), ['other task', 'w4'], 'one task waits for the edits of another');
  answers[3].ok(); answers[4].ok();
  await other;
  // both PATCHes of the card's edits go through it
  const save = drawer.slice(drawer.indexOf('async function doAutosaveOnce('), drawer.indexOf('async function createTask('));
  assert.match(save, /await editInTurn\(key, \(\) => api\('PATCH', `\/api\/tasks\/\$\{seg\(key\)\}`, body\)\)/, 'the autosave sends its edit beside the ones before it');
  const resend = drawer.slice(drawer.indexOf('async function resendTaskEdit('), drawer.indexOf('const unsentCreates = '));
  assert.match(resend, /await editInTurn\(key, \(\) => api\('PATCH', `\/api\/tasks\/\$\{seg\(key\)\}`, sent\)\)/, 'the resend of an edit races the autosave');
});

test('CK-844: what did not reach the server is sent again by itself, less and less often, and when the browser is online', async () => {
  assert.equal(resendDelay(0), RESEND_MS);
  assert.equal(resendDelay(1), RESEND_MS * 2);
  assert.equal(resendDelay(30), RESEND_MAX_MS);
  const core = read('core.js');
  const at = core.indexOf('const offlineRetries = createRetryQueue();');
  const end = core.indexOf("window.addEventListener('online'", at);
  const end2 = core.indexOf('\n', end) + 1;
  const timers = [];
  const listeners = {};
  const badge = { classList: { toggle: () => {} }, onclick: null };
  const box = {
    createRetryQueue, resendDelay,
    $: () => badge,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    window: { addEventListener: (ev, fn) => { listeners[ev] = fn; } },
  };
  vm.runInNewContext(`${core.slice(at, end2).replace(/^export /gm, '')}\nthis.hasUnsaved = hasUnsaved;`, box); // a const of the script is not a property of its box
  let up = false;
  let tries = 0;
  box.noteUnsaved(async () => { tries++; if (!up) throw Object.assign(new Error('Failed to fetch'), { offline: true }); }, 'comment:VV-1:1');
  assert.equal(timers.length, 1, 'nothing sends the comment again unless the stream breaks or the badge is clicked');
  assert.equal(timers[0].ms, RESEND_MS);
  timers[0].fn();
  await settle();
  assert.equal(tries, 1);
  assert.equal(timers.length, 2, 'a resend that failed again is not tried any more');
  assert.equal(timers[1].ms, RESEND_MS * 2, 'the board asks a dead server as often as at first');
  up = true;
  listeners.online(); // the browser is online again: at once, not at the next tick
  await settle();
  assert.equal(tries, 2);
  assert.equal(box.hasUnsaved(), false, 'the delivered comment still waits');
  timers[1].fn(); // the tick that was due finds nothing
  await settle();
  assert.equal(tries, 2, 'a delivered comment is sent again');
  assert.equal(timers.length, 2, 'an empty queue keeps ticking');
});

test('CK-839: an edit that never answers holds the next one of its task only for a while', async () => {
  assert.equal(TURN_WAIT_MS, 15000);
  const inTurn = createTurns(30);
  const order = [];
  inTurn('VV-1', () => { order.push('hung'); return new Promise(() => {}); });
  const next = inTurn('VV-1', async () => { order.push('next'); return 'saved'; });
  await settle();
  assert.deepEqual(order, ['hung']);
  const got = await Promise.race([next, new Promise((r) => setTimeout(() => r('still waiting'), 1000))]);
  assert.equal(got, 'saved', 'a request that never answers holds the edits behind it for good');
});

test('CK-854: the «Try now» of a card left behind does not stop the read of the open card', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.gets[0].fail(Object.assign(new Error('Failed to fetch'), { offline: true }));
  await settle();
  const oldTry = k.els.comments.retry.onclick;
  k.box.state.drawerKey = 'VV-2';
  k.box.renderComments('VV-2');
  oldTry(); // clicked within the 200 ms the old note is still there
  k.gets[1].ok([c(20)]);
  await settle();
  assert.deepEqual(k.els.comments.ids(), [20], 'the open card lost its comments to the button of the card before');
  assert.equal(k.gets.length, 2);
});

test('CK-854: another card starts from the shortest wait, not from the one the card before reached', async () => {
  const k = card();
  const off = () => Object.assign(new Error('Failed to fetch'), { offline: true });
  k.box.renderComments('VV-1');
  for (let i = 0; i < 4; i++) { k.gets[i].fail(off()); await settle(); k.timersDue().at(-1).fn(); }
  k.box.state.drawerKey = 'VV-2';
  k.box.renderComments('VV-2');
  k.gets.at(-1).fail(off());
  await settle();
  assert.equal(k.timersDue().at(-1).ms, RESEND_MS, 'a new card waits as long as the failures of the one before it');
});

test('CK-864: a comment added to the list keeps the × of an unsent one taking it back, not deleting', async () => {
  const k = card();
  k.box.renderComments('VV-1');
  k.gets[0].ok([c(10)]);
  await settle();
  k.els.comments.html += '<div class="comment unsent" data-unsent="1"><span class="comment-del" data-drop="1">×</span></div>';
  const takeBack = () => 'take back';
  k.els.comments.wired.set('drop:1', takeBack);
  k.box.commentArrived('VV-1', c(11), 2);
  assert.equal(k.els.comments.wired.get('drop:1'), takeBack, 'the × of the unsent comment now asks to delete a comment');
  k.els.comments.wired.get('del:11')();
  assert.equal(k.box.deleted, '11');
});

test('CK-844: one resend at a time — a second call while it goes neither hides the badge nor counts the queue empty', async () => {
  const core = read('core.js');
  const at = core.indexOf('const offlineRetries = createRetryQueue();');
  const end = core.indexOf('\n', core.indexOf("window.addEventListener('online'", at)) + 1;
  const shown = [];
  const box = {
    createRetryQueue, resendDelay,
    $: () => ({ classList: { toggle: (c, on) => shown.push(!on) }, onclick: null }),
    setTimeout: () => 1,
    window: { addEventListener: () => {} },
  };
  vm.runInNewContext(`${core.slice(at, end).replace(/^export /gm, '')}\nthis.hasUnsaved = hasUnsaved;`, box);
  let release;
  let runs = 0;
  box.noteUnsaved(() => { runs++; return new Promise((ok) => { release = ok; }); }, 'task:VV-1');
  const first = box.retryUnsaved();
  shown.length = 0;
  const second = box.retryUnsaved();
  await settle();
  assert.equal(runs, 1, 'two resends of the same edit went at once');
  assert.deepEqual(shown, [], 'a second resend hid the badge while the first was still sending');
  assert.equal(box.hasUnsaved(), true, 'a resend on its way counts as nothing waiting — the tab may reload under it');
  release();
  await first; await second;
  assert.equal(box.hasUnsaved(), false);
});
