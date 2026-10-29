
export function oneFlight(run) {
  let flight = null;
  const go = async (key) => {
    if (flight && flight.key === key) { flight.again = true; return; }
    const me = { key, again: false };
    flight = me;
    try { await run(key); } finally { if (flight === me) flight = null; }
    if (me.again) await go(key);
  };
  return go;
}

export const SEARCH_DELAY_MS = 280;

export function searchInput({ render, load, delay = SEARCH_DELAY_MS, timers = globalThis }) {
  let timer = null;
  return (value) => {
    render(value);
    timers.clearTimeout(timer);
    timer = timers.setTimeout(load, delay);
  };
}

export function latestRequest() {
  let n = 0;
  let ctrl = null;
  return {
    start() {
      if (ctrl) ctrl.abort();
      ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      n += 1;
      return { n, signal: ctrl ? ctrl.signal : undefined };
    },
    isLatest(req) { return req.n === n; },
  };
}

/** The same screen: the same project or section, and the same page of it (its board or its settings). */
export function sameScreen(a, b) {
  return Boolean(a && b) && a.slug === b.slug && Boolean(a.settings) === Boolean(b.settings);
}

/** A request for the task list of the board failed. `wanted` — the screen it was for, `shown` — the screen whose
    list the board holds (null before the first load), both { slug, settings }; `search` — the string it carried.
    null — not a failure: the request was cancelled or overtaken by a newer one, say nothing. Otherwise:
    back   — the screen to put back: the request was switching away from it, and the new one never showed;
    clear  — the server refused a project of the current screen (it is gone): an empty board;
    notice — what to tell the person: 'project' (a switch), 'search', 'list', or 'first' (the board has no list
             to show yet: its first load); null for a refusal;
    retry  — the screen to load again once the server answers (the stream reconnects, a click on the notice);
    answered — the server did answer, with an error (5xx): no reconnect of the stream is coming to retry, the board
             tries again by itself (`listErrorDelay`). */
export function listFailure({ error, latest, wanted, shown, search }) {
  if (!latest || (error && error.aborted)) return null;
  const offline = Boolean(error && error.offline);
  const retriable = offline || (error && error.status) >= 500;
  const switched = Boolean(shown) && !sameScreen(shown, wanted);
  let notice = null;
  if (retriable) notice = !shown ? 'first' : (switched ? 'project' : (search ? 'search' : 'list'));
  return {
    back: switched ? shown : null,
    clear: !retriable && !switched,
    notice,
    retry: retriable ? wanted : null,
    answered: retriable && (!offline || Boolean(error.cut)),
  };
}

export const LIST_ERROR_RETRY_MS = 3000;
export const LIST_ERROR_RETRY_MAX_MS = 60000;
export const listErrorDelay = (n) => Math.min(LIST_ERROR_RETRY_MAX_MS, LIST_ERROR_RETRY_MS * 2 ** Math.max(0, n));

export const SWITCH_SKELETON_MS = 250;

/** What a failed list load (`pending` = { from: the screen the person stayed on, to: the screen that did not load })
    is owed once the server answers again. The person may have moved on since — their newer choice wins and nothing
    is repeated. 'switch' — open `to` (a project switch that failed), 'reload' — read the list of the current screen
    again, null — nothing. */
export function listRetry(pending, current) {
  if (!pending || !sameScreen(pending.from, current)) return null;
  return sameScreen(pending.from, pending.to) ? 'reload' : 'switch';
}

export const LIST_NOTICE = {
  project: {
    label: 'project did not open',
    title: 'The server did not answer, so the board stayed on the previous screen. The project opens by itself once the connection is back — or click to try now.',
    error: 'The server answered with an error, so the board stayed on the previous screen. It tries again by itself in a few seconds — or click to try now.',
    alert: 'The project did not open: the board is not responding. You stay on the previous screen; the project opens by itself once the connection is back.',
    alertError: 'The project did not open: the server answered with an error. You stay on the previous screen; the board tries again by itself in a few seconds.',
  },
  search: {
    label: 'search did not reach the server',
    title: 'The server did not answer: the board shows the matches by title, key, labels and the start of the description. The search is asked again once the connection is back — or click to try now.',
    errorLabel: 'search failed',
    error: 'The server answered with an error: the board shows the matches by title, key, labels and the start of the description. The search is asked again by itself in a few seconds — or click to try now.',
  },
  list: {
    label: 'tasks did not load',
    title: 'The server did not answer, so the board shows the list it had. It is read again once the connection is back — or click to try now.',
    error: 'The server answered with an error, so the board shows the list it had. It is read again by itself in a few seconds — or click to try now.',
  },
  first: {
    label: 'tasks did not load',
    title: 'The server did not answer, so the tasks of this board did not load. They load by themselves once the connection is back.',
    error: 'The server answered with an error, so the tasks of this board did not load. The board tries again by itself in a few seconds.',
  },
};

/** What the notice of a failure says: { label, title } — the variant for an error the server answered with, or for
    no connection. null — nothing to say. */
export function listNotice(kind, answered) {
  const n = LIST_NOTICE[kind];
  if (!n) return null;
  return { label: (answered && n.errorLabel) || n.label, title: answered ? n.error : n.title };
}

export function matchesVisible(t, q) {
  const s = String(q).toLowerCase();
  const has = (v) => String(v ?? '').toLowerCase().includes(s);
  return has(t.title) || has(t.key) || has(t.preview) || (t.labels || []).some(has);
}

export function inSearch(t, { search, applied, hits }) {
  if (!search) return true;
  if (search === applied && hits && hits.has(t.id)) return true;
  return matchesVisible(t, search);
}

export const SSE_STALE_MS = 75000;
export const silentTooLong = (lastAt, now) => now - lastAt > SSE_STALE_MS;

export function streamDead(es, lastAt, now) {
  return !es || es.readyState === 2 || silentTooLong(lastAt, now);
}

export const FIRST_LOAD_RETRY_MS = 3000;
export function loadUntilDone(load, { delay = FIRST_LOAD_RETRY_MS, timers = globalThis } = {}) {
  const attempt = () => Promise.resolve().then(load);
  const first = attempt();
  first.catch(() => {
    const again = () => { attempt().catch(() => { timers.setTimeout(again, delay); }); };
    timers.setTimeout(again, delay);
  });
  return first;
}

export function eventQueue() {
  let q = [];
  return {
    push(ev) { q.push(ev); },
    take() { const all = q; q = []; return all; },
    get size() { return q.length; },
  };
}

const TASK_EVENTS = new Set(['task.created', 'task.updated', 'task.deleted']);
const COUNTERS = { 'task.comment': 'comments_n', 'task.attached': 'attachments_n' };
const ORDERING = ['status', 'priority', 'position', 'pinned'];
const SEARCHED = ['title', 'key', 'preview'];
const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

export function applyEvents(tasks, events, view) {
  const out = { refresh: false, tasks, render: false, changed: new Map(), loud: new Set(), counters: false, drawer: false, unhit: new Set(), searchStale: false };
  let list = null;
  const own = () => { if (!list) list = [...tasks]; return list; };
  const at = (id) => own().findIndex((t) => t.id === id);
  const put = (i, next) => { if (!out.changed.has(list[i].id)) out.changed.set(list[i].id, list[i]); list[i] = next; };
  for (const ev of events) {
    const d = ev && ev.data;
    if (TASK_EVENTS.has(ev.type)) {
      if (view.special || !d || d.id == null) { out.refresh = true; break; }
      out.counters = true;
      out.drawer = true;
      if (!view.all && d.project !== view.slug) continue;
      const i = at(d.id);
      if (ev.type === 'task.deleted') { if (i >= 0) { list.splice(i, 1); out.render = true; } continue; }
      if (i < 0) {
        if (ev.type !== 'task.created') { out.refresh = true; break; }
        list.push(d);
        out.render = true;
        if (view.searching) out.searchStale = true;
        continue;
      }
      const before = list[i];
      const after = { ...before, ...d };
      put(i, after);
      out.loud.add(d.id);
      if (ORDERING.some((k) => before[k] !== after[k])) out.render = true;
      if (SEARCHED.some((k) => before[k] !== after[k]) || !sameList(before.labels, after.labels)) {
        out.unhit.add(d.id);
        if (view.searching) out.searchStale = true;
      }
    } else if (COUNTERS[ev.type]) {
      const field = COUNTERS[ev.type];
      if (!d || typeof d[field] !== 'number') { out.refresh = true; break; }
      if (view.special) continue;
      const i = at(d.task_id);
      if (i >= 0) put(i, { ...list[i], [field]: d[field] });
    } else if (ev.type === 'task.linked') {
      if (!d || !d.linked || typeof d.linked !== 'object') { out.refresh = true; break; }
      if (view.special) continue;
      for (const [id, ids] of Object.entries(d.linked)) {
        const i = at(Number(id));
        if (i >= 0 && !sameList(list[i].linked_ids, ids)) put(i, { ...list[i], linked_ids: ids });
      }
    } else { out.refresh = true; break; }
  }
  out.tasks = list || tasks;
  return out;
}
