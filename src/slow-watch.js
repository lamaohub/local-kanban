import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logError } from './db.js';

export const WINDOW_MS = 60_000;
export const LOOP_P95_MS = 300;
export const ROUTE_SLOW_MS = 2000;
export const LOG_EVERY_MS = 10 * 60_000;
export const WINDOWS_KEPT = 60;
export const ROUTES_SHOWN = 5;
const STREAM = /^text\/event-stream/i;
/* Answers that are held open on purpose — not slow: the stream of events (its headers go by `raw.writeHead`, so the reply
   does not know its type) and the long poll of a hook waiting for the person's answer (up to POLL_HOLD_MS, 25 s). */
export const HELD_OPEN = new Set(['GET /api/events', 'GET /api/asks/:id/wait']);
export const WAITS = new Set(['GET /api/health', 'GET /api/health/stands', 'GET /api/update-check', 'GET /api/whats-new',
  'POST /api/update', 'POST /api/launch', 'POST /api/tasks/:id/chat', 'POST /api/tasks/:id/chat/queue/:itemId/now',
  // the branch of a task's copy asks GitHub of its pull request (gh, up to 20 s); a pull request pushes and asks gh
  'GET /api/tasks/:id/branch', 'POST /api/tasks/:id/pr',
  'POST /api/voice/warm', 'POST /api/voice']);

const ms = (ns) => Math.round(ns / 1e6);

/** A watch with its own clock, histogram and log (replaceable in tests). */
export function createSlowWatch({ now = Date.now, log = logError, histogram = null } = {}) {
  const loop = histogram || monitorEventLoopDelay({ resolution: 20 });
  let routes = new Map(); // `${method} ${template}` → {n, total, max}
  let started = now();
  const windows = []; // the last WINDOWS_KEPT minutes, oldest first
  let loggedAt = -Infinity;

  /** Fastify `onResponse` hook (root instance): the time of one answer. */
  function onResponse(req, reply, done) {
    const template = req.routeOptions?.url;
    const k = `${req.method} ${template}`;
    if (template && !HELD_OPEN.has(k) && !STREAM.test(String(reply.getHeader?.('content-type') || ''))) {
      const took = Number(reply.elapsedTime);
      if (Number.isFinite(took)) {
        const r = routes.get(k) || routes.set(k, { n: 0, total: 0, max: 0 }).get(k);
        r.n++; r.total += took; r.max = Math.max(r.max, took);
      }
    }
    if (typeof done === 'function') done();
  }

  /** Sum the minute up, keep it, start the next; a slow one goes to the error log. Returns the minute. */
  function tick() {
    const at = now();
    const top = [...routes].map(([route, r]) => ({ route, n: r.n, avg: Math.round(r.total / r.n), max: Math.round(r.max) }))
      .map((r) => (WAITS.has(r.route) ? { ...r, waits: true } : r))
      .sort((a, b) => b.max - a.max).slice(0, ROUTES_SHOWN);
    const win = {
      at, seconds: Math.round((at - started) / 1000),
      loop: loop.count ? { p50: ms(loop.percentile(50)), p95: ms(loop.percentile(95)), max: ms(loop.max) } : null,
      answers: [...routes.values()].reduce((s, r) => s + r.n, 0),
      routes: top,
    };
    loop.reset();
    routes = new Map();
    started = at;
    windows.push(win);
    if (windows.length > WINDOWS_KEPT) windows.shift();
    const slowLoop = win.loop && win.loop.p95 > LOOP_P95_MS;
    const slowRoutes = top.filter((r) => r.max > ROUTE_SLOW_MS && !r.waits);
    if ((slowLoop || slowRoutes.length) && at - loggedAt >= LOG_EVERY_MS) {
      loggedAt = at;
      const what = [
        slowLoop ? `the event loop waited ${win.loop.p95} ms at p95 (max ${win.loop.max} ms)` : null,
        slowRoutes.length ? `answers slower than ${ROUTE_SLOW_MS / 1000} s: ${slowRoutes.map((r) => `${r.route} ${r.max} ms`).join(', ')}` : null,
      ].filter(Boolean).join('; ');
      log('server', 'slow', `The board was slow for a minute — ${what}`, JSON.stringify(win));
    }
    return win;
  }

  /** What «Health» shows: the last minute, the worst minute of the hour, and the slowest routes of the hour. */
  function view() {
    const last = windows.at(-1) || null;
    const worst = windows.reduce((w, x) => (x.loop && (!w || x.loop.p95 > w.loop.p95) ? x : w), null);
    const byRoute = new Map();
    for (const w of windows) for (const r of w.routes) {
      const b = byRoute.get(r.route);
      if (!b || r.max > b.max) byRoute.set(r.route, { route: r.route, max: r.max, at: w.at, ...(r.waits ? { waits: true } : {}) });
    }
    const slowest = [...byRoute.values()].sort((a, b) => b.max - a.max).slice(0, ROUTES_SHOWN);
    return {
      limits: { loop_p95_ms: LOOP_P95_MS, route_ms: ROUTE_SLOW_MS, window_s: WINDOW_MS / 1000 },
      minutes: windows.length,
      last, worst: worst ? { at: worst.at, loop: worst.loop } : null, slowest,
      slow: Boolean(last && ((last.loop && last.loop.p95 > LOOP_P95_MS) || last.routes.some((r) => r.max > ROUTE_SLOW_MS && !r.waits))),
    };
  }

  return { onResponse, tick, view, start: () => loop.enable?.(), stop: () => loop.disable?.() };
}

/** The watch of this process: started by server.js, read by GET /api/health/load. */
export const slowWatch = createSlowWatch();
export function startSlowWatch() {
  slowWatch.start();
  setInterval(() => { try { slowWatch.tick(); } catch { /* a measure never brings the board down */ } }, WINDOW_MS).unref();
}
