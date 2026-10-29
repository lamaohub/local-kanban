// between tabs, the lock and the clock are stand-ins, the module is the page's own (public/js/live-link.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLink, HELLO_WAIT_MS, LOCK, reconnectDelay, RECONNECT_MS } from '../public/js/live-link.js';
import { SSE_STALE_MS } from '../public/js/live-rules.js';

function world() {
  let now = 0;
  const timers = [];
  let seq = 0;
  const clock = {
    setTimeout(fn, ms) { const id = ++seq; timers.push({ id, at: now + ms, fn }); return id; },
    clearTimeout(id) { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const t = timers[0];
      if (!t || t.at > end) break;
      timers.shift();
      now = t.at;
      t.fn();
      await settle();
    }
    now = end;
    await settle();
  };
  const server = { up: true, refuse: false, streams: [] };
  class FakeEventSource {
    constructor(url) {
      this.url = url; this.readyState = 0; server.streams.push(this);
      queueMicrotask(() => {
        if (this.readyState === 2) return;
        if (server.up && !server.refuse) { this.readyState = 1; this.onopen?.(); } else { this.readyState = 0; this.onerror?.(); }
      });
    }
    close() { this.readyState = 2; }
    send(data) { if (this.readyState === 1) this.onmessage?.({ data }); }
    drop() { if (this.readyState === 1) { this.readyState = 0; this.onerror?.(); } }
  }
  const tabs = new Set();
  const hub = () => {
    const ch = {
      onmessage: null,
      postMessage(m) {
        const copy = structuredClone(m);
        for (const other of tabs) if (other.channel !== ch && !other.closed) queueMicrotask(() => other.channel.onmessage?.({ data: copy }));
      },
    };
    return ch;
  };
  const queue = [];
  const locksOf = (tab) => ({
    request(name, cb) {
      assert.equal(name, LOCK);
      return new Promise((resolve) => { queue.push({ cb, resolve, tab }); grant(); });
    },
  });
  let holder = null;
  function grant() {
    if (holder || !queue.length) return;
    holder = queue.shift();
    queueMicrotask(() => holder.cb());
  }
  const open = (opts = {}) => {
    const tab = { got: [], opens: 0, states: [], closed: false };
    tab.channel = hub();
    tabs.add(tab);
    tab.link = createLink({
      EventSourceImpl: FakeEventSource, channel: opts.noShare ? null : tab.channel, locks: opts.noShare ? null : locksOf(tab),
      timers: clock, now: () => now,
      onOpen: () => { tab.opens++; }, onMessage: (d) => tab.got.push(d), onState: (s) => tab.states.push(s),
      probe: async () => (server.refuse ? 'guests' : false),
    });
    tab.link.start();
    return tab;
  };
  const close = (tab) => {
    tab.closed = true; tabs.delete(tab);
    tab.link.stream?.close();
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i].tab === tab) queue.splice(i, 1);
    if (holder?.tab === tab) { holder = null; grant(); }
  };
  const live = () => server.streams.filter((s) => s.readyState !== 2);
  const say = (data) => { for (const s of live()) s.send(data); };
  return { open, close, advance, server, live, say, get now() { return now; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

test('seven tabs of one browser hold one stream, and every tab hears every message', async () => {
  const w = world();
  const tabs = [];
  for (let i = 0; i < 7; i++) { tabs.push(w.open()); await w.advance(10); }
  assert.equal(w.server.streams.length, 1, 'each tab opened its own stream again');
  assert.equal(tabs.filter((t) => t.link.role === 'leader').length, 1);
  for (const t of tabs) assert.equal(t.opens, 1, 'a tab never learnt that the link is open — its first load would wait');
  w.say('{"type":"task.updated"}');
  await w.advance(1);
  for (const t of tabs) assert.deepEqual(t.got, ['{"type":"task.updated"}']);
});

test('the holder closes — the next tab opens the stream, and every tab catches up', async () => {
  const w = world();
  const a = w.open(); await w.advance(10);
  const b = w.open(); await w.advance(10);
  const c = w.open(); await w.advance(10);
  w.close(a);
  await w.advance(10);
  assert.equal(w.live().length, 1, 'no tab took the link over');
  const lead = [b, c].find((t) => t.link.role === 'leader');
  assert.ok(lead);
  assert.equal(b.opens, 2, 'a tab did not catch up after the handover');
  assert.equal(c.opens, 2);
  w.say('x'); await w.advance(1);
  assert.deepEqual(b.got, ['x']); assert.deepEqual(c.got, ['x']);
});

test('ten minutes without the server: one chain of attempts with growing pauses, not a storm', async () => {
  const w = world();
  const t = w.open(); await w.advance(10);
  w.server.up = false;
  w.live()[0].drop();
  // the liveness check of init.js (20 s), focus and the tab shown, as often as a person might
  for (let s = 0; s < 600; s += 5) {
    await w.advance(5000);
    if (s % 20 === 0) t.link.ensure({});
  }
  const made = w.server.streams.length - 1;
  assert.ok(made <= Math.ceil(600_000 / RECONNECT_MS.at(-1)) + RECONNECT_MS.length, `${made} attempts in ten minutes`);
  // the person comes to the tab: once, at once, and still one chain
  const before = w.server.streams.length;
  t.link.ensure({ urgent: true });
  t.link.ensure({ urgent: true });
  await w.advance(1);
  assert.equal(w.server.streams.length, before + 2);
  w.server.up = true;
  await w.advance(RECONNECT_MS.at(-1));
  assert.equal(w.live().length, 1, 'chains of reconnects run side by side');
  const opens = t.opens;
  await w.advance(120_000);
  assert.equal(t.opens, opens, 'the link opened again and again — every opening reloads the board');
});

test('the pause grows with the failures and stops at its top', () => {
  assert.equal(reconnectDelay(1), RECONNECT_MS[0]);
  assert.ok(reconnectDelay(2) > reconnectDelay(1));
  assert.equal(reconnectDelay(99), RECONNECT_MS.at(-1));
  assert.ok(RECONNECT_MS.at(-1) <= 30_000, 'a tab back from the server waits too long');
});

test('the state of the link: down and refused, said in every tab; up again', async () => {
  const w = world();
  const a = w.open(); await w.advance(10);
  const b = w.open(); await w.advance(10);
  w.server.refuse = true;
  w.live()[0].drop();
  await w.advance(10);
  assert.deepEqual([a.link.state.up, a.link.state.refused], [false, 'guests']);
  assert.deepEqual([b.link.state.up, b.link.state.refused], [false, 'guests'], 'a follower does not know the link is refused');
  w.server.refuse = false; w.server.up = false;
  await w.advance(RECONNECT_MS[0] + 10);
  assert.equal(a.link.state.refused, false, 'a server that went away is still said to refuse');
  w.server.up = true;
  await w.advance(RECONNECT_MS[1] + 10);
  assert.equal(a.link.state.up, true); assert.equal(b.link.state.up, true);
});

test('a holder that froze: a follower hears nothing, asks, and opens a stream of its own', async () => {
  const w = world();
  const a = w.open(); await w.advance(10);
  const b = w.open(); await w.advance(10);
  a.closed = true; // frozen: holds the lock and its stream, hears and says nothing
  w.live()[0].close();
  b.link.ensure({});
  await w.advance(SSE_STALE_MS + 1000);
  b.link.ensure({});
  await w.advance(HELLO_WAIT_MS + 10);
  assert.equal(w.live().length, 1, 'the follower waited for a frozen holder forever');
  assert.equal(b.link.stream?.readyState, 1);
  w.say('y'); await w.advance(1);
  assert.deepEqual(b.got, ['y']);
});

test('a follower whose holder is alive does not open its own stream on a quiet board', async () => {
  const w = world();
  w.open(); await w.advance(10);
  const b = w.open(); await w.advance(10);
  for (let i = 0; i < 10; i++) { await w.advance(30_000); w.say('{"type":"ping"}'); b.link.ensure({}); }
  assert.equal(w.server.streams.length, 1);
});

test('a browser without locks or channels keeps a stream per tab', async () => {
  const w = world();
  w.open({ noShare: true }); w.open({ noShare: true });
  await w.advance(10);
  assert.equal(w.live().length, 2);
});
