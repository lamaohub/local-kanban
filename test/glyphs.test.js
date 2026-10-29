import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  glyphsOn, frameWait, IDLE_MS, sceneClock, makePing, reveal, livePings, addPing, terrain, shade, depthShade, glyphAt, isBackground, BACKGROUND, LAYERS, MAX_PINGS, FORM_AT, FORM_PX,
} from '../public/js/glyphs.js';

const mid = () => 0.5;

test('CK-679: a hidden tab stops the scene clock, and the scene goes on from the same place when the tab is back', () => {
  const c = sceneClock();
  assert.equal(c.at(1000), 1000);
  c.pause(2000);
  assert.equal(c.at(2000), 2000);
  assert.equal(c.at(60000), 2000, 'while hidden the scene stands where it was hidden');
  c.pause(70000);
  assert.equal(c.at(80000), 2000, 'a second hide does not move the moment it stopped at');
  c.resume(90000);
  assert.equal(c.at(90000), 2000, 'back on the tab — the same picture, not one a minute and a half later');
  assert.equal(c.at(90500), 2500, 'and it moves on at the usual pace');
  c.resume(91000);
  assert.equal(c.at(91000), 3000, 'a resume without a pause changes nothing');
  assert.equal(c.paused, false);
});

test('CK-679: a hidden tab keeps the last frame instead of wiping it', () => {
  const src = readFileSync(new URL('../public/js/glyphs.js', import.meta.url), 'utf8');
  const halt = src.slice(src.indexOf('function halt()'), src.indexOf('\n}\n', src.indexOf('function halt()')));
  assert.match(halt, /document\.hidden[\s\S]*freeze\(\)/, 'hidden → freeze');
  const freeze = src.slice(src.indexOf('function freeze()'), src.indexOf('\n}\n', src.indexOf('function freeze()')));
  assert.doesNotMatch(freeze, /clearRect\(0, 0, innerWidth/, 'freeze must not wipe the canvas');
  assert.match(src, /document\.addEventListener\('visibilitychange', syncGlyphs\)/);
  assert.match(src.slice(src.indexOf('export function syncGlyphs'), src.indexOf('export function pulse')), /halt\(\)/);
});

test('the background runs only in design v3 with the switch on, without reduced motion, on a visible tab', () => {
  const ok = { design: 'v3', enabled: true, reducedMotion: false, hidden: false };
  assert.equal(glyphsOn(ok), true);
  assert.equal(glyphsOn({ ...ok, design: 'v2' }), false);
  assert.equal(glyphsOn({ ...ok, design: undefined }), false);
  assert.equal(glyphsOn({ ...ok, enabled: false }), false);
  assert.equal(glyphsOn({ ...ok, reducedMotion: true }), false);
  assert.equal(glyphsOn({ ...ok, hidden: true }), false);
});

test('the clouds drift from right to left instead of popping up', () => {
  for (let l = 0; l < LAYERS.length; l++) {
    let shifted = 0, still = 0, n = 0;
    for (let y = 30; y < 900; y += 47) for (let x = 20; x < 1300; x += 37) {
      const now = terrain(x, y, 11, l);
      shifted += Math.abs(now - terrain(x + LAYERS[l].speed, y, 10, l));
      still += Math.abs(now - terrain(x, y, 10, l));
      n++;
    }
    assert.ok(shifted / n < (still / n) * 0.4, `layer ${l} does not drift to the left (${(shifted / n).toFixed(3)} vs ${(still / n).toFixed(3)})`);
  }
});

test('the layers are depth: the far one is smaller, dimmer and slower, the near one hides it', () => {
  for (let i = 1; i < LAYERS.length; i++) {
    const far = LAYERS[i - 1], near = LAYERS[i];
    assert.ok(near.speed > far.speed && near.scale > far.scale && near.gain > far.gain, `layer ${i} is not nearer than ${i - 1}`);
  }
  assert.deepEqual(depthShade([0.5, 0.7, 0.4]), { layer: 2, light: 0.4 * LAYERS[2].gain }, 'the near form does not hide the far ones');
  assert.equal(depthShade([0.5, 0, 0]).layer, 0, 'a far form behind empty space is hidden');
  assert.equal(depthShade([0, 0, 0]).layer, -1);
  assert.ok(Math.max(...LAYERS.map((l) => l.gain)) <= 0.35, 'the background is as loud as a sonar pulse');
});

test('the scene leaves empty space between small forms', () => {
  let n = 0, form = 0;
  for (let y = 0; y < 900; y += 19) for (let x = 0; x < 1400; x += 7.4) { n++; if (terrain(x, y, 10) >= FORM_AT) form++; }
  const share = form / n;
  assert.ok(share > 0.35 && share < 0.8, `forms cover ${(share * 100).toFixed(0)}% of the screen`);
  assert.ok(FORM_PX <= 100 && LAYERS.every((L) => L.scale <= 150), `forms of ${LAYERS.map((L) => L.scale).join('/')}px are not small`);
  let crossings = 0;
  for (let x = 0, was = terrain(0, 300, 10) >= FORM_AT; x < 1400; x += 6) {
    const is = terrain(x, 300, 10) >= FORM_AT;
    if (is !== was) crossings++;
    was = is;
  }
  assert.ok(crossings >= 4, `only ${crossings} edges of forms across the screen — the forms are huge`);
});

test('the clouds of all layers together leave empty space between them', () => {
  let n = 0, any = 0;
  for (let y = 0; y < 900; y += 19) for (let x = 0; x < 1400; x += 7.4) {
    n++;
    if (LAYERS.some((L, l) => terrain(x, y, 10, l) >= L.at)) any++;
  }
  const share = any / n;
  assert.ok(share > 0.35 && share < 0.7, `the clouds cover ${(share * 100).toFixed(0)}% of the screen`);
});

test('a symbol rides with its cloud and flickers now and then', () => {
  assert.equal(glyphAt(120, 7, 2, 10), glyphAt(120, 7, 2, 10));
  let changed = 0;
  for (let jw = 0; jw < 200; jw++) if (glyphAt(jw, 3, 1, 10) !== glyphAt(jw, 3, 1, 12)) changed++;
  assert.ok(changed > 100, `only ${changed} of 200 symbols changed in 2 s — they do not flicker`);
  let same = 0;
  for (let jw = 0; jw < 200; jw++) if (glyphAt(jw, 3, 1, 10) === glyphAt(jw, 3, 1, 10.05)) same++;
  assert.ok(same > 180, `symbols change every frame (${200 - same} of 200 in 50 ms)`);
});

test('forms are lit like 3D surfaces — the side facing the light is brighter than the side away from it', () => {
  const h = FORM_AT + 0.15;
  assert.equal(shade(FORM_AT - 0.01, FORM_AT, FORM_AT), 0, 'empty space lights up');
  const dh = 3 / FORM_PX;
  const facing = shade(h, h + dh, h + dh), away = shade(h, h - dh, h - dh);
  assert.ok(facing > away + 0.15, `no 3D: lit side ${facing.toFixed(2)}, shadow side ${away.toFixed(2)}`);
  for (const [a, b, c] of [[0.6, 0.5, 0.7], [0.9, 0.95, 0.85], [0.5, 0.5, 0.5]]) {
    const v = shade(a, b, c);
    assert.ok(v >= 0 && v <= 1);
  }
});

test('a ping lights only where its front has passed — brightest at the front, fading behind it — and ends', () => {
  const p = makePing(0, 0, 0, mid);
  const t = 600, front = (t / 1000) * p.speed;
  assert.equal(reveal(p, front + 20, t), 0, 'the ping lights ahead of its front');
  const atFront = reveal(p, front - 5, t), behind = reveal(p, front - 200, t);
  assert.ok(atFront > 0.5, `the front is dim (${atFront})`);
  assert.ok(behind > 0 && behind < atFront * 0.75, `nothing fades behind the front (${behind} vs ${atFront})`);
  const late = p.life - 100, lateFront = Math.min(p.reach, (late / 1000) * p.speed);
  assert.ok(reveal(p, lateFront - 5, late) < atFront * 0.5, 'the ping does not fade with age');
  assert.equal(reveal(p, 50, p.life), 0, 'the ping never ends');
  assert.equal(reveal(p, 10, -1), 0);
});

test('pings end and are kept few', () => {
  const p = makePing(0, 0, 0, mid);
  assert.deepEqual(livePings([p], p.life + 1), []);
  let list = [];
  for (let i = 0; i < 30; i++) list = addPing(list, makePing(i, 0, i, mid));
  assert.equal(list.length, MAX_PINGS);
  assert.equal(list.at(-1).x, 29, 'the newest ping was dropped instead of the oldest');
});

test('frames follow the display rate on a wide screen — only a narrow one waits between frames (CK-794)', () => {
  assert.equal(frameWait(false), 0, 'a wide screen waits between frames');
  assert.ok(frameWait(true) >= 40, 'a narrow screen draws at the display rate');
  const src = readFileSync(new URL('../public/js/glyphs.js', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  const body = (name) => { const at = src.indexOf(`function ${name}(`); return src.slice(at, src.indexOf('\n}\n', at)); };
  assert.match(body('next'), /if \(!wait\) \{ frame = requestAnimationFrame\(draw\); return; \}/, 'a wide screen does not ask for every frame');
  assert.match(body('next'), /setTimeout\(/, 'a narrow screen keeps the display waking up for nothing');
  assert.doesNotMatch(body('draw'), /now\s*-\s*\w+\s*<|frameDue/, 'draw() skips frames');
});

test('CK-794: a minute without the person the background stands still, and their first move brings it back', () => {
  const ok = { design: 'v3', enabled: true, reducedMotion: false, hidden: false };
  assert.equal(glyphsOn({ ...ok, idle: true }), false, 'an idle page keeps the scene moving');
  assert.equal(IDLE_MS, 60000);
  const src = readFileSync(new URL('../public/js/glyphs.js', import.meta.url), 'utf8');
  const halt = src.slice(src.indexOf('function halt()'), src.indexOf('\n}\n', src.indexOf('function halt()')));
  assert.match(halt, /idle: false[\s\S]*freeze\(\)/, 'idle wipes the scene instead of freezing it');
  assert.match(src, /idle: performance\.now\(\) - activeAt >= IDLE_MS/);
  for (const ev of ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart']) assert.ok(src.includes(`'${ev}'`), `${ev} does not wake the background`);
  assert.match(src, /activeAt = performance\.now\(\); if \(!frame\) syncGlyphs\(\);/, 'a move does not wake a frozen background');
});

test('only a click on empty background sends a pulse — not on buttons, cards, fields or other interface', () => {
  const el = (cls) => ({ matches: (sel) => sel.split(',').map((x) => x.trim()).includes(cls) });
  for (const bg of ['.main', '.board', '.col-body', '.dashboard', '.chaos-view', '.now-view']) assert.equal(isBackground(el(bg)), true, `${bg} is background`);
  for (const ui of ['.card', '.btn-primary', '.btn-icon', '.proj', '.panel', '.col-head', '.search', '.chaos-card', '.kbsel-btn']) {
    assert.equal(isBackground(el(ui)), false, `a click on ${ui} sends a pulse`);
  }
  assert.equal(isBackground(null), false);
  for (const bad of ['button', 'input', 'textarea', 'select', '.card', '.panel', '.proj', '.btn', '.kbsel', '.chip']) {
    assert.ok(!BACKGROUND.split(',').map((x) => x.trim()).some((s) => s === bad || s.startsWith(bad + '-') || s.startsWith(bad + '.')), `${bad} is listed as background`);
  }
  const src = readFileSync(new URL('../public/js/glyphs.js', import.meta.url), 'utf8');
  assert.match(src, /if \(e\.button !== 0 \|\| !isBackground\(e\.target\)\) return;/, 'the click handler does not ask isBackground');
  assert.doesNotMatch(readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8'), /\bpulse\(/);
});

// loop that ran on the real time (the scene jumped on by the time it was hidden) both left the suite green
test('CK-679: the loop runs on the scene clock — paused on hide, resumed when the tab is back', () => {
  const src = readFileSync(new URL('../public/js/glyphs.js', import.meta.url), 'utf8');
  const body = (name) => { const at = src.indexOf(`function ${name}(`); return src.slice(at, src.indexOf('\n}\n', at)); };
  assert.match(body('freeze'), /clock\.pause\(now\)/, 'a hidden tab keeps the scene going');
  assert.match(body('wake'), /clock\.resume\(performance\.now\(\)\)[\s\S]*next\(\)/, 'back on the tab, the scene never moves again');
  assert.match(body('draw'), /const T = clock\.at\(now\);[\s\S]*repaint\(T\)[\s\S]*paintLayers\(t\)/, 'the scene runs on the real time and jumps by the time the tab was hidden');
});
