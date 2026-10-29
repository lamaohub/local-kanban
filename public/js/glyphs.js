
export const CLICK = { speed: [300, 380], reach: [420, 600], life: [3.2, 4], amp: [0.95, 1] };
export const LAYERS = [
  { scale: 58, speed: 16, gain: 0.13, seed: 41, at: 0.63 },
  { scale: 92, speed: 32, gain: 0.2, seed: 7, at: 0.6 },
  { scale: 140, speed: 56, gain: 0.28, seed: 0, at: 0.56 },
];
export const TRAIL_PX = 260;
export const FORM_AT = 0.44;
export const FORM_PX = LAYERS[1].scale;
export const REFRESH_MS = 400;
export const MAX_PINGS = 10;
const CELL_H = 19;
const FONT_PX = 12;
const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function glyphsOn({ design, enabled, reducedMotion, hidden, idle }) {
  return design === 'v3' && enabled !== false && !reducedMotion && !hidden && !idle;
}

export const IDLE_MS = 60000;
export const NARROW_PX = 760;
export const NARROW_FRAME_MS = 50;
export const NARROW_REPAINT_MS = 500;
export function frameWait(narrow) {
  return narrow ? NARROW_FRAME_MS : 0;
}

export function sceneClock() {
  let lost = 0, pausedAt = null;
  return {
    at: (now) => now - lost - (pausedAt === null ? 0 : now - pausedAt),
    pause(now) { if (pausedAt === null) pausedAt = now; },
    resume(now) { if (pausedAt !== null) { lost += now - pausedAt; pausedAt = null; } },
    get paused() { return pausedAt !== null; },
  };
}

function hash(ix, iy) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

export function terrain(x, y, t, layer = 1) {
  const L = LAYERS[layer];
  const s = 1 / L.scale;
  const u = (x + t * L.speed) * s + L.seed, v = y * s + L.seed * 0.7;
  const clouds = 0.55 * noise(u, v - t * 0.012)
    + 0.3 * noise(u * 2.1 + t * 0.02, v * 2.1 + t * 0.012)
    + 0.15 * noise(u * 4.3 + t * 0.03, v * 4.3);
  const warp = noise(u * 0.6 + 17, v * 0.6 - t * 0.01);
  const swell = 0.5 + 0.5 * Math.sin((v * 1.7 + u * 0.6) * 2.4 + warp * 5 + t * 0.15);
  return clouds * 0.72 + swell * 0.28;
}

export function shade(h, hRight, hDown, scale = FORM_PX, at = FORM_AT) {
  const form = Math.min(1, Math.max(0, (h - at) / 0.07));
  if (!form) return 0;
  const k = 0.55 * scale / 12;
  const nx = -(hRight - h) * k, ny = -(hDown - h) * k, nz = 1;
  const len = Math.hypot(nx, ny, nz);
  const light = (nx * -0.55 + ny * -0.6 + nz * 0.58) / len;
  const lift = Math.min(1, (h - at) * 3);
  return form * Math.max(0, Math.min(1, 0.15 + 0.85 * light)) * (0.5 + 0.5 * lift);
}

export function depthShade(shades) {
  for (let i = shades.length - 1; i >= 0; i--) {
    if (shades[i] > 0) return { layer: i, light: shades[i] * LAYERS[i].gain };
  }
  return { layer: -1, light: 0 };
}

const pick = ([lo, hi], rand) => lo + rand() * (hi - lo);

export const BACKGROUND = '.main, .board, .board-spacer, .col, .col-body, .toolbar, .topbar, .topbar-left, .topbar-right, '
  + '.dashboard, .now-view, .now-wrap, .chaos-view, .chaos-wrap, .projset-view, .calendar-view, .horizon-view, .hz-cols, .settings, .boot';
export function isBackground(el) {
  return !!el && typeof el.matches === 'function' && el.matches(BACKGROUND);
}

export function makePing(x, y, at, rand = Math.random) {
  return {
    x, y, at,
    speed: pick(CLICK.speed, rand), reach: pick(CLICK.reach, rand), life: pick(CLICK.life, rand) * 1000, amp: pick(CLICK.amp, rand),
  };
}

export function reveal(p, d, now) {
  const age = now - p.at;
  if (age < 0 || age >= p.life) return 0;
  const front = Math.min(p.reach, (age / 1000) * p.speed);
  if (d > front) return 0;
  const behind = front - d;
  const edge = Math.max(0, 1 - d / p.reach) ** 0.6;
  const crest = Math.exp(-((behind / 22) ** 2)) * 0.6;
  const glow = Math.exp(-behind / TRAIL_PX);
  return p.amp * edge * (1 - age / p.life) ** 1.1 * Math.min(1, glow + crest);
}

export function livePings(pings, now) {
  return pings.filter((p) => now - p.at < p.life);
}

export function addPing(pings, p) {
  return [...pings, p].slice(-MAX_PINGS);
}

export function glyphAt(jw, r, l, t) {
  const phase = hash(jw * 7 + l, r * 13 + 5);
  return CHARS[(hash(jw * 31 + l * 1013, r * 17 + Math.floor(t * 0.7 + phase)) * CHARS.length) | 0];
}

export const REPAINT_MS = 100;
let canvas = null, ctx = null, cols = 0, rows = 0, cellW = 7.4, dpr = 1;
let layers = []; // { canvas, ctx, base, T, h: Float32Array, lit: Float32Array, w }
let pings = [], frame = 0, timer = 0, paintedAt = -Infinity, narrow = false, activeAt = 0;
function next() {
  const wait = frameWait(narrow);
  if (!wait) { frame = requestAnimationFrame(draw); return; }
  frame = -1;
  timer = setTimeout(() => { timer = 0; frame = requestAnimationFrame(draw); }, wait);
}
function cancel() {
  if (timer) clearTimeout(timer);
  if (frame > 0) cancelAnimationFrame(frame);
  timer = 0; frame = 0;
}
const clock = sceneClock();
const colors = { blue: '#4a8fca', grey: '#6f6f6f' };
const opts = { enabled: () => true };

function conditions() {
  return {
    design: document.documentElement.dataset.design,
    enabled: opts.enabled(),
    reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
    hidden: document.hidden,
    idle: performance.now() - activeAt >= IDLE_MS,
  };
}

function running() {
  return !!canvas && glyphsOn(conditions());
}

function halt() {
  const c = conditions();
  if (canvas && (document.hidden || c.idle) && glyphsOn({ ...c, hidden: false, idle: false })) freeze();
  else stop();
}

function setFont(c) {
  c.font = `${FONT_PX}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  c.textBaseline = 'top';
}

function size() {
  dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setFont(ctx);
  cellW = ctx.measureText('M').width + 1.4;
  cols = Math.ceil(innerWidth / cellW);
  rows = Math.ceil(innerHeight / CELL_H);
  narrow = innerWidth <= NARROW_PX;
  const w = cols + 4;
  layers = LAYERS.map(() => {
    const c = document.createElement('canvas');
    c.width = Math.round(w * cellW * dpr);
    c.height = canvas.height;
    const x = c.getContext('2d');
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    setFont(x);
    return { canvas: c, ctx: x, base: 0, T: 0, w, h: new Float32Array((w + 1) * (rows + 1)), lit: new Float32Array(w * rows) };
  });
  paintedAt = -Infinity;
}

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  colors.blue = cs.getPropertyValue('--glyph').trim() || colors.blue;
  colors.grey = cs.getPropertyValue('--glyph-ambient').trim() || colors.grey;
  paintedAt = -Infinity;
}

function heightAtScreen(L, l, x, r) {
  const f = (x + LAYERS[l].speed * L.T / 1000) / cellW - 0.5 - L.base;
  const i = Math.min(L.w - 1, Math.max(0, Math.floor(f))), a = f - i, base = r * (L.w + 1) + i;
  return L.h[base] + (L.h[base + 1] - L.h[base]) * a;
}

function repaint(T) {
  const t = T / 1000;
  for (let l = 0; l < LAYERS.length; l++) {
    const L = layers[l], S = LAYERS[l];
    L.T = T;
    L.base = Math.floor((S.speed * t) / cellW) - 1;
    for (let r = 0; r <= rows; r++) {
      const y = r * CELL_H + CELL_H / 2;
      for (let i = 0; i <= L.w; i++) L.h[r * (L.w + 1) + i] = terrain((L.base + i) * cellW + cellW / 2 - S.speed * t, y, t, l);
    }
  }
  for (let l = LAYERS.length - 1; l >= 0; l--) {
    const L = layers[l], S = LAYERS[l], g = L.ctx, W = L.w + 1;
    g.clearRect(0, 0, L.w * cellW, innerHeight);
    g.fillStyle = colors.grey;
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < L.w; i++) {
        const k = r * L.w + i, j = r * W + i, h = L.h[j];
        L.lit[k] = 0;
        if (h < S.at) continue;
        const x = (L.base + i) * cellW + cellW / 2 - S.speed * t;
        let hidden = false;
        for (let n = l + 1; n < LAYERS.length && !hidden; n++) hidden = heightAtScreen(layers[n], n, x, r) >= LAYERS[n].at;
        if (hidden) continue;
        const s = shade(h, h + (L.h[j + 1] - h) * 12 / cellW, h + (L.h[j + W] - h) * 12 / CELL_H, S.scale, S.at);
        if (!s) continue;
        L.lit[k] = s * (0.55 + 0.45 * (l / (LAYERS.length - 1)));
        const v = depthShade(LAYERS.map((_, n) => (n === l ? s : 0))).light;
        if (v < 0.03) continue;
        g.globalAlpha = v;
        g.fillText(glyphAt(L.base + i, r, l, t), i * cellW, r * CELL_H + 3);
      }
    }
    g.globalAlpha = 1;
  }
}

function paintLayers(t) {
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  for (let l = 0; l < LAYERS.length; l++) {
    const L = layers[l];
    const dx = Math.round((L.base * cellW - LAYERS[l].speed * t) * dpr) / dpr;
    ctx.drawImage(L.canvas, dx, 0, L.w * cellW, innerHeight);
  }
}

function draw(now) {
  frame = 0;
  if (!running()) { halt(); return; }
  next();
  const T = clock.at(now);
  if (T - paintedAt >= (narrow ? NARROW_REPAINT_MS : REPAINT_MS)) { repaint(T); paintedAt = T; }
  pings = livePings(pings, now);
  const t = T / 1000;
  paintLayers(t);
  if (!pings.length) return;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pings) {
    const front = Math.min(p.reach, ((now - p.at) / 1000) * p.speed);
    x0 = Math.min(x0, p.x - front); x1 = Math.max(x1, p.x + front);
    y0 = Math.min(y0, p.y - front); y1 = Math.max(y1, p.y + front);
  }
  const r0 = Math.max(0, Math.floor(y0 / CELL_H)), r1 = Math.min(rows - 1, Math.ceil(y1 / CELL_H));
  ctx.fillStyle = colors.blue;
  for (let l = 0; l < LAYERS.length; l++) {
    const L = layers[l], shift = LAYERS[l].speed * t;
    const i0 = Math.max(0, Math.floor((x0 + shift) / cellW) - L.base - 1), i1 = Math.min(L.w - 1, Math.ceil((x1 + shift) / cellW) - L.base + 1);
    for (let r = r0; r <= r1; r++) {
      const y = r * CELL_H + CELL_H / 2;
      for (let i = i0; i <= i1; i++) {
        const s = L.lit[r * L.w + i];
        if (!s) continue;
        const x = (L.base + i) * cellW - shift;
        let lit = 0;
        for (const q of pings) lit += reveal(q, Math.hypot(x + cellW / 2 - q.x, y - q.y), now);
        const v = Math.min(1, Math.min(1, lit) * s * 1.8);
        if (v < 0.05) continue;
        ctx.globalAlpha = v;
        ctx.fillText(glyphAt(L.base + i, r, l, L.T / 1000), x, r * CELL_H + 3);
      }
    }
  }
  ctx.globalAlpha = 1;
}

function wake() {
  if (frame || !running()) return;
  clock.resume(performance.now());
  next();
}

function freeze() {
  cancel();
  const now = performance.now();
  if (pings.length && Number.isFinite(paintedAt)) paintLayers(clock.at(now) / 1000);
  pings = [];
  clock.pause(now);
}

function stop() {
  cancel();
  pings = [];
  if (ctx) ctx.clearRect(0, 0, innerWidth, innerHeight);
}

export function syncGlyphs() {
  if (!canvas) return;
  if (!running()) { halt(); return; }
  readColors();
  wake();
}

export function pulse(x, y) {
  if (!running()) return false;
  pings = addPing(pings, makePing(x, y, performance.now()));
  wake();
  return true;
}

export function initGlyphs({ enabled } = {}) {
  if (canvas) return;
  if (enabled) opts.enabled = enabled;
  activeAt = performance.now();
  canvas = document.createElement('canvas');
  canvas.id = 'glyph-bg';
  canvas.setAttribute('aria-hidden', 'true');
  document.body.prepend(canvas);
  ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); canvas = null; return; }
  size();
  addEventListener('resize', () => { size(); wake(); });
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !isBackground(e.target)) return;
    pulse(e.clientX, e.clientY);
  }, { capture: true, passive: true });
  document.addEventListener('visibilitychange', syncGlyphs);
  const active = () => { activeAt = performance.now(); if (!frame) syncGlyphs(); };
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) document.addEventListener(ev, active, { capture: true, passive: true });
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener?.('change', syncGlyphs);
  syncGlyphs();
}
