
import { SSE_STALE_MS, streamDead } from './live-rules.js';

export const LOCK = 'kb-live-link';
export const CHANNEL = 'kb-live-link';
export const RECONNECT_MS = [3000, 6000, 15000, 30000];
/** Pause before the n-th attempt in a row (n from 1): 3 s, then longer, at most 30 s. */
export const reconnectDelay = (n) => RECONNECT_MS[Math.min(Math.max(n, 1), RECONNECT_MS.length) - 1];
export const HELLO_WAIT_MS = 3000;

export function createLink({
  url = '/api/events', EventSourceImpl, channel = null, locks = null, timers = globalThis, now = () => Date.now(),
  onOpen = () => {}, onMessage = () => {}, onState = () => {}, probe = null, staleMs = SSE_STALE_MS,
} = {}) {
  let es = null; // this tab's own stream: the holder's, a follower's while the holder is silent, or the only one
  let timer = null;
  let failures = 0;
  let role = 'alone'; // 'alone' | 'leader' | 'follower'
  let lastAt = now(); // the last word of the stream, own or passed on
  let heardAt = now(); // the last word of the holder (a follower)
  let helloAt = 0;
  let helloTimer = null;
  let opened = false; // a follower got its first «open»
  let state = { up: false, since: now(), refused: false };

  const post = (msg) => { if (role === 'leader' && channel) { try { channel.postMessage(msg); } catch { /* the channel is closed */ } } };
  const setState = (next) => {
    if (next.up === state.up && next.refused === state.refused) return;
    state = { ...next, since: next.up !== state.up ? next.since ?? now() : state.since };
    onState(state);
    post({ k: 'state', state });
  };
  const own = () => Boolean(es);

  function connect() {
    timers.clearTimeout(timer); timer = null;
    if (es) { try { es.close(); } catch { /* closed already */ } }
    const s = new EventSourceImpl(url);
    es = s;
    s.onopen = () => {
      if (es !== s) return;
      failures = 0; lastAt = now();
      setState({ up: true, refused: false });
      onOpen();
      post({ k: 'open' });
    };
    s.onmessage = (e) => {
      if (es !== s) return;
      lastAt = now();
      onMessage(e.data);
      post({ k: 'msg', d: e.data });
    };
    s.onerror = () => {
      try { s.close(); } catch { /* closed already */ }
      if (es !== s) return; // a stream replaced since: its own error schedules nothing
      failures++;
      setState({ up: false, refused: state.refused });
      timer = timers.setTimeout(connect, reconnectDelay(failures));
      if (probe) {
        Promise.resolve().then(probe).then((full) => {
          if (es === s && !state.up) setState({ up: false, refused: full || false });
        }, () => {});
      }
    };
  }

  function becomeLeader() {
    role = 'leader';
    helloAt = 0; timers.clearTimeout(helloTimer);
    // a follower that opened its own stream (the holder was silent) keeps it: the link goes on without a gap
    if (!es || es.readyState === 2) connect();
    else post({ k: 'state', state });
  }

  function hear(msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.k === 'hello') { if (role === 'leader') post({ k: 'state', state }); return; }
    if (msg.k === 'retry') { if (role === 'leader' && !state.up) connect(); return; } // a follower's click on the notice
    if (role !== 'follower') return;
    heardAt = now();
    if (own()) return; // its own stream speaks for it until the lock comes
    if (msg.k === 'msg') { lastAt = now(); onMessage(msg.d); return; }
    if (msg.k === 'open') { lastAt = now(); opened = true; setState({ up: true, refused: false }); onOpen(); return; }
    if (msg.k === 'state' && msg.state) {
      if (msg.state.up && !opened) { opened = true; lastAt = now(); setState(msg.state); onOpen(); return; }
      setState(msg.state);
    }
  }

  /** Start the link: the holder of the lock opens the stream, the rest listen. */
  function start() {
    if (!channel || !locks?.request) { connect(); return; }
    role = 'follower';
    channel.onmessage = (e) => hear(e.data);
    locks.request(LOCK, () => { becomeLeader(); return new Promise(() => {}); }).catch(() => { role = 'alone'; connect(); });
    // the holder says its state: a tab opened beside a live link learns it at once (the first load waits for it)
    try { channel.postMessage({ k: 'hello' }); } catch { /* the channel is closed */ }
    helloAt = now();
  }

  /** The liveness check (a timer, focus, the tab shown). `urgent` — the person came to the tab: try now. */
  function ensure({ urgent = false, hidden = false } = {}) {
    if (role === 'follower' && !own()) {
      if (hidden || now() - heardAt <= staleMs) return;
      if (helloAt > heardAt && now() - helloAt >= HELLO_WAIT_MS) { connect(); return; } // the holder froze: our own
      if (helloAt > heardAt) return;
      helloAt = now();
      try { channel.postMessage({ k: 'hello' }); } catch { /* the channel is closed */ }
      timers.clearTimeout(helloTimer);
      helloTimer = timers.setTimeout(() => ensure({ hidden }), HELLO_WAIT_MS);
      return;
    }
    // the holder checks hidden too — the other tabs live by its stream
    if (hidden && role !== 'leader') return;
    if (timer && !urgent) return; // a reconnect waits its pause
    if (streamDead(es, lastAt, now())) connect();
  }

  return {
    start, ensure,
    /** Try the stream now (a click on the notice). */
    retry: () => {
      if (role !== 'follower' || own()) { connect(); return; }
      try { channel.postMessage({ k: 'retry' }); } catch { /* the channel is closed */ }
    },
    get role() { return role; },
    get state() { return state; },
    get lastAt() { return lastAt; },
    get stream() { return es; },
    get waiting() { return Boolean(timer); },
  };
}
