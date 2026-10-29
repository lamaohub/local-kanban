import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvents, eventQueue, inSearch, latestRequest, LIST_ERROR_RETRY_MAX_MS, LIST_ERROR_RETRY_MS, LIST_NOTICE, listErrorDelay, listFailure, listNotice, listRetry, matchesVisible, oneFlight, sameScreen, SEARCH_DELAY_MS, searchInput, silentTooLong, SSE_STALE_MS, streamDead, SWITCH_SKELETON_MS,
} from '../public/js/live-rules.js';
import { readFileSync } from 'node:fs';

function slowRun() {
  const calls = [];
  const run = (key) => new Promise((resolve) => calls.push({ key, done: resolve }));
  return { calls, run };
}
const tick = () => new Promise((r) => setImmediate(r));

test('the work feed: a refresh while one is in flight does not start a second request, it repeats once after', async () => {
  const { calls, run } = slowRun();
  const go = oneFlight(run);
  const first = go('CK-1');
  go('CK-1'); go('CK-1'); go('CK-1');
  await tick();
  assert.equal(calls.length, 1, 'requests piled up on top of the one in flight');
  calls[0].done();
  await tick();
  assert.equal(calls.length, 2, 'the events that came during the request were lost — one more read is owed');
  calls[1].done();
  await first;
  await tick();
  assert.equal(calls.length, 2, 'three events during one request are one repeat, not three');
});

test('the work feed: another card does not wait for the request of the previous one', async () => {
  const { calls, run } = slowRun();
  const go = oneFlight(run);
  go('CK-1');
  go('CK-2');
  await tick();
  assert.deepEqual(calls.map((c) => c.key), ['CK-1', 'CK-2']);
  go('CK-1');
  await tick();
  assert.deepEqual(calls.map((c) => c.key), ['CK-1', 'CK-2', 'CK-1']);
  for (const c of calls) c.done();
  await tick();
  assert.equal(calls.length, 3);
});

function manualTimers() {
  let now = 0;
  const due = new Map();
  let next = 1;
  return {
    setTimeout(fn, ms) { const id = next++; due.set(id, { at: now + ms, fn }); return id; },
    clearTimeout(id) { due.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now) { due.delete(id); t.fn(); }
    },
  };
}

test('search: the board redraws on every key, but asks the server once, after typing stops', () => {
  assert.ok(SEARCH_DELAY_MS >= 250 && SEARCH_DELAY_MS <= 300, `the pause is ${SEARCH_DELAY_MS} ms, shorter than the gap between keys`);
  const timers = manualTimers();
  const drawn = [];
  let loads = 0;
  const type = searchInput({ render: (q) => drawn.push(q), load: () => { loads++; }, timers });
  for (const q of ['п', 'пр', 'про', 'пров', 'прове', 'провер', 'проверк', 'проверка']) {
    type(q);
    timers.advance(150);
  }
  assert.equal(drawn.length, 8, 'the instant prefilter must follow every key');
  assert.equal(loads, 0, 'a request went to the server in the middle of the word');
  timers.advance(SEARCH_DELAY_MS);
  assert.equal(loads, 1, 'one word typed is one request');
});

test('search: only the answer to the LAST request lands on the board; the older one is cancelled', () => {
  const list = latestRequest();
  const short = list.start();
  const long = list.start();
  assert.equal(short.signal?.aborted, true, 'the request that was overtaken is not cancelled');
  assert.equal(list.isLatest(short), false, 'a late answer to «п» would land on the board as the right one');
  assert.equal(list.isLatest(long), true);
  assert.equal(long.signal?.aborted, false);
});

const card = (id, extra = {}) => ({ id, key: `CK-${id}`, title: `Task ${id}`, preview: '', labels: [], status: 'todo', priority: 0, position: id, pinned: 0, comments_n: 0, ...extra });

test('search: the prefilter looks at the title, the key, the start of the description and the labels, in any case', () => {
  assert.ok(matchesVisible(card(1, { title: 'Деплой панели' }), 'деплой'));
  assert.ok(matchesVisible(card(1), 'ck-1'));
  assert.ok(matchesVisible(card(1, { preview: 'Сломан ПОИСК' }), 'поиск'));
  assert.ok(matchesVisible(card(1, { labels: ['bug'] }), 'BUG'));
  assert.ok(!matchesVisible(card(1, { title: 'Деплой' }), 'поиск'));
});

test('search: what the server found stays; a task that came by an event since is judged by the prefilter', () => {
  const deep = card(1, { title: 'Ничего похожего' });
  const fresh = card(2, { title: 'Другое' });
  const named = card(3, { title: 'Иголка' });
  const view = { search: 'иголка', applied: 'иголка', hits: new Set([1]) };
  assert.equal(inSearch(deep, view), true, 'the server answer was thrown out by the prefilter');
  assert.equal(inSearch(fresh, view), false, 'a task that came by an event is shown although it does not match');
  assert.equal(inSearch(named, view), true);
  assert.equal(inSearch(deep, { ...view, search: 'иголка в' }), false);
  assert.equal(inSearch(fresh, { search: '', applied: '', hits: null }), true, 'no search — everything is shown');
});

test('the stream: a silence longer than the threshold makes it dead, even while the socket looks open', () => {
  const open = { readyState: 1 };
  const now = 1_000_000;
  assert.equal(streamDead(open, now - 10_000, now), false);
  assert.equal(streamDead(open, now - SSE_STALE_MS - 1, now), true, 'a stream silent for longer than the threshold counts as alive');
  assert.equal(streamDead({ readyState: 2 }, now, now), true, 'a closed stream counts as alive');
  assert.equal(streamDead(null, now, now), true);
  assert.equal(silentTooLong(now - SSE_STALE_MS - 1, now), true);
  assert.ok(SSE_STALE_MS > 30_000 * 2, 'the threshold must be longer than two heartbeats of the server');
});

test('the stream: a burst of events is taken whole, not just its last event', () => {
  const q = eventQueue();
  for (let i = 1; i <= 5; i++) q.push({ type: 'task.updated', data: { id: i } });
  assert.equal(q.size, 5);
  assert.deepEqual(q.take().map((e) => e.data.id), [1, 2, 3, 4, 5]);
  assert.equal(q.size, 0);
  assert.deepEqual(q.take(), []);
});

const ALL_VIEW = { slug: '__all__', all: true, special: false, searching: false };
const moved = (t, status) => ({ type: 'task.updated', data: { ...t, status, project: 'kb' } });

test('a batch of moves is applied whole, and the board is redrawn once for it', () => {
  const tasks = [1, 2, 3, 4, 5].map((id) => card(id, { project: 'kb' }));
  const plan = applyEvents(tasks, tasks.map((t) => moved(t, 'review')), ALL_VIEW);
  assert.equal(plan.refresh, false);
  assert.deepEqual(plan.tasks.map((t) => t.status), Array(5).fill('review'), 'a move of the batch was lost');
  assert.equal(plan.render, true);
  assert.equal(plan.counters, true);
  assert.deepEqual(tasks.map((t) => t.status), Array(5).fill('todo'), 'the list was changed in place');
});

test('a note changes the counter on its card, without a refresh of the whole board', () => {
  const tasks = [card(1), card(2)];
  const plan = applyEvents(tasks, [{ type: 'task.comment', data: { task_id: 2, key: 'CK-2', comments_n: 7 } }], ALL_VIEW);
  assert.equal(plan.refresh, false, 'a note refreshes the whole board again');
  assert.equal(plan.render, false);
  assert.equal(plan.counters, false, 'a note does not change the project counters');
  assert.equal(plan.tasks.find((t) => t.id === 2).comments_n, 7);
  assert.ok(plan.changed.has(2) && !plan.loud.has(2), 'only a counter changed — a card off the board needs no redraw');
  const files = applyEvents(tasks, [{ type: 'task.attached', data: { task_id: 1, attachments_n: 2 } }], ALL_VIEW);
  assert.equal(files.tasks.find((t) => t.id === 1).attachments_n, 2);
  assert.equal(applyEvents(tasks, [{ type: 'task.comment', data: { task_id: 2 } }], ALL_VIEW).refresh, true);
});

test('a link event sets the links of both cards; the dashboard ignores notes and links', () => {
  const tasks = [card(1, { linked_ids: [] }), card(2, { linked_ids: [] })];
  const plan = applyEvents(tasks, [{ type: 'task.linked', data: { id: 1, linked: { 1: [2], 2: [1] } } }], ALL_VIEW);
  assert.equal(plan.refresh, false);
  assert.deepEqual(plan.tasks.map((t) => t.linked_ids), [[2], [1]]);
  const dash = { ...ALL_VIEW, all: false, slug: '__dash__', special: true };
  for (const ev of [{ type: 'task.comment', data: { task_id: 1, comments_n: 1 } }, { type: 'task.linked', data: { id: 1, linked: { 1: [] } } }]) {
    const p = applyEvents(tasks, [ev], dash);
    assert.equal(p.refresh, false, `${ev.type} refreshes the dashboard, which does not show it`);
  }
  assert.equal(applyEvents(tasks, [moved(tasks[0], 'done')], dash).refresh, true, 'the dashboard must recount after a move');
});

test('what cannot be applied in place falls back to one full refresh', () => {
  const tasks = [card(1, { project: 'kb' })];
  const view = { slug: 'kb', all: false, special: false, searching: false };
  assert.equal(applyEvents(tasks, [{ type: 'project.updated', data: { slug: 'kb' } }], view).refresh, true);
  assert.equal(applyEvents(tasks, [moved(card(9), 'doing')], view).refresh, true, 'an update of a task this board does not have');
  const other = applyEvents(tasks, [{ type: 'task.updated', data: { ...card(9), project: 'other' } }], view);
  assert.equal(other.refresh, false, 'a task of another project only changes the counters');
  assert.equal(other.counters, true);
  assert.equal(other.render, false);
});

test('while searching, a new task or a renamed one makes the board ask the server again; a move does not', () => {
  const tasks = [card(1, { project: 'kb', title: 'Иголка' })];
  const view = { ...ALL_VIEW, searching: true };
  const created = applyEvents(tasks, [{ type: 'task.created', data: { ...card(2), project: 'kb' } }], view);
  assert.equal(created.searchStale, true);
  const renamed = applyEvents(tasks, [{ type: 'task.updated', data: { ...tasks[0], title: 'Нитка' } }], view);
  assert.equal(renamed.searchStale, true);
  assert.deepEqual([...renamed.unhit], [1], 'the server answer about a renamed task is still trusted');
  const move = applyEvents(tasks, [moved(tasks[0], 'review')], view);
  assert.equal(move.searchStale, false);
  assert.deepEqual([...move.unhit], [], 'a move does not change what the search finds');
});

const A = { slug: 'alpha', settings: false };
const B = { slug: 'beta', settings: false };
const down = Object.assign(new Error('Failed to fetch'), { offline: true });
const http = (status) => Object.assign(new Error('x'), { status });

test('list failure: a cancelled or overtaken request says nothing and changes nothing', () => {
  assert.equal(listFailure({ error: Object.assign(new Error('aborted'), { aborted: true }), latest: true, wanted: A, shown: A, search: 'п' }), null);
  assert.equal(listFailure({ error: down, latest: false, wanted: A, shown: A, search: 'п' }), null, 'an answer to an old request would still be acted on');
});

test('list failure: a project switch that failed keeps the board on the previous screen and is owed later', () => {
  for (const error of [http(500), http(503), down]) {
    const plan = listFailure({ error, latest: true, wanted: B, shown: A, search: '' });
    assert.deepEqual(plan.back, A, 'the board would stay on the project whose list never came');
    assert.equal(plan.clear, false, 'the board would be emptied');
    assert.equal(plan.notice, 'project');
    assert.deepEqual(plan.retry, B, 'the switch is not tried again when the server is back');
  }
});

test('list failure: a search that failed keeps the list and the project, and is asked again', () => {
  const plan = listFailure({ error: http(500), latest: true, wanted: A, shown: A, search: 'клик' });
  assert.equal(plan.back, null);
  assert.equal(plan.clear, false, 'a failed search empties the board and drops the project');
  assert.equal(plan.notice, 'search');
  assert.deepEqual(plan.retry, A);
  assert.equal(listFailure({ error: down, latest: true, wanted: A, shown: A, search: '' }).notice, 'list', 'a plain refresh is not a search');
});

test('list failure: the first load that failed keeps the project it was opening', () => {
  const plan = listFailure({ error: http(502), latest: true, wanted: B, shown: null, search: '' });
  assert.equal(plan.clear, false);
  assert.equal(plan.back, null);
  assert.equal(plan.notice, 'first');
  assert.deepEqual(plan.retry, B);
  assert.equal(listFailure({ error: down, latest: true, wanted: B, shown: null, search: 'x' }).notice, 'first', 'a first load with a search string has no list either');
});

test('list failure: an error the server answered with is told apart from no connection', () => {
  for (const status of [500, 502, 503]) {
    assert.equal(listFailure({ error: http(status), latest: true, wanted: B, shown: A, search: '' }).answered, true, `${status}`);
  }
  assert.equal(listFailure({ error: down, latest: true, wanted: B, shown: A, search: '' }).answered, false, 'no connection reads as an answer');
  assert.equal(listFailure({ error: http(404), latest: true, wanted: B, shown: A, search: '' }).answered, false, 'a refusal is retried');
  for (const kind of ['project', 'search', 'list', 'first']) {
    const off = listNotice(kind, false);
    const err = listNotice(kind, true);
    assert.equal(off.title, LIST_NOTICE[kind].title);
    assert.equal(err.title, LIST_NOTICE[kind].error);
    assert.notEqual(off.title, err.title, `${kind}: an error says it waits for the connection`);
    assert.doesNotMatch(err.title, /connection is back|did not answer/, `${kind}: an error says it waits for the connection`);
    assert.match(err.title, /by itself/, `${kind}: an error does not say the board tries again`);
  }
  assert.equal(listNotice('search', true).label, 'search failed', 'a search the server answered says it did not reach the server');
  assert.equal(listNotice('project', true).label, LIST_NOTICE.project.label);
  assert.equal(listNotice(null, true), null);
  assert.doesNotMatch(LIST_NOTICE.project.alertError, /not responding|connection is back/);
});

test('list failure: after an error the board asks again soon, then less often, and never more often than the cap', () => {
  assert.equal(listErrorDelay(0), LIST_ERROR_RETRY_MS);
  const delays = [0, 1, 2, 3, 4, 5, 6, 10, 50].map(listErrorDelay);
  for (let i = 1; i < delays.length; i++) assert.ok(delays[i] >= delays[i - 1], `the ${i}th retry comes sooner than the one before`);
  assert.ok(delays[1] > delays[0], 'the delay does not grow');
  assert.equal(listErrorDelay(50), LIST_ERROR_RETRY_MAX_MS);
  assert.ok(LIST_ERROR_RETRY_MS >= 1000 && LIST_ERROR_RETRY_MAX_MS <= 120000, 'a failing server is asked too often, or forgotten');
  assert.ok(SWITCH_SKELETON_MS >= 100 && SWITCH_SKELETON_MS <= 600, 'a quick switch blinks the skeleton, or a slow one shows the old cards too long');
});

test('list failure: a project the server refuses (gone) is not retried', () => {
  assert.deepEqual(listFailure({ error: http(404), latest: true, wanted: B, shown: null, search: '' }),
    { back: null, clear: true, notice: null, retry: null, answered: false });
  assert.equal(listFailure({ error: http(404), latest: true, wanted: A, shown: A, search: '' }).clear, true);
  // a click on a project deleted meanwhile: back where the person was, nothing to retry
  assert.deepEqual(listFailure({ error: http(404), latest: true, wanted: B, shown: A, search: '' }),
    { back: A, clear: false, notice: null, retry: null, answered: false });
});

test('list failure: the settings page of a project is another screen than its board', () => {
  const page = { slug: 'alpha', settings: true };
  assert.equal(sameScreen(A, page), false);
  assert.equal(sameScreen(A, { slug: 'alpha', settings: false }), true);
  assert.equal(sameScreen(null, A), false);
  assert.deepEqual(listFailure({ error: down, latest: true, wanted: A, shown: page, search: '' }).back, page,
    'leaving the settings page for the board and failing would not put the page back');
});

test('list retry: what a failed load is owed once the server answers, unless the person moved on', () => {
  assert.equal(listRetry({ from: A, to: B }, A), 'switch');
  assert.equal(listRetry({ from: A, to: A }, A), 'reload');
  assert.equal(listRetry({ from: A, to: B }, { slug: '#dash', settings: false }), null, 'the switch would be made over a newer choice');
  assert.equal(listRetry({ from: A, to: B }, { slug: 'alpha', settings: true }), null);
  assert.equal(listRetry(null, A), null);
});

test('list failure: what the notice says is in the Russian dictionary', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  const said = Object.values(LIST_NOTICE).flatMap((n) => Object.values(n));
  assert.equal(said.length, 15);
  assert.deepEqual(said.filter((s) => !dict.includes(`'${s}':`)), [], 'the notice stays English on the Russian board');
  assert.deepEqual(Object.keys(LIST_NOTICE).sort(), ['first', 'list', 'project', 'search']);
});
