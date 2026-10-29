import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const css = read('../public/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
const settings = read('../public/js/settings.js');
const core = read('../public/js/core.js');
const sidebar = read('../public/js/sidebar.js');

function blocks(src) {
  const out = [];
  let depth = 0, start = 0, open = -1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '{') { if (depth === 0) open = i; depth++; }
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { out.push({ prelude: src.slice(start, open).trim(), body: src.slice(open + 1, i) }); start = i + 1; }
    }
  }
  return out;
}
const rules = [];
for (const b of blocks(css)) {
  if (b.prelude.startsWith('@media') || b.prelude.startsWith('@supports')) rules.push(...blocks(b.body));
  else if (!b.prelude.startsWith('@')) rules.push(b);
}
const selectors = (r) => r.prelude.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean);
const tokens = (body) => new Set([...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));

test('every rule of design v3 is scoped to html[data-design="v3"], and there are rules at all', () => {
  const v3 = rules.filter((r) => r.prelude.includes('data-design'));
  assert.ok(v3.length > 40, `only ${v3.length} rules of design v3 found`);
  for (const r of v3) {
    for (const s of selectors(r)) {
      assert.ok(s.startsWith('html[data-design="v3"]'), `"${s}" is not scoped to html[data-design="v3"]`);
    }
  }
});

test('the sidebar icons of v3 are hidden in v2', () => {
  const hide = rules.find((r) => selectors(r).includes('.nav-ic'));
  assert.ok(hide && /display\s*:\s*none/.test(hide.body), '.nav-ic is not hidden outside design v3');
  const show = rules.find((r) => selectors(r).includes('html[data-design="v3"] .nav-ic'));
  assert.ok(show && /display\s*:\s*inline-flex/.test(show.body), 'design v3 does not show .nav-ic');
});

test('design v3 has a palette for light and dark, and the dark one covers every colour of the light one', () => {
  const light = rules.find((r) => selectors(r).includes('html[data-design="v3"][data-theme="light"]'));
  const dark = rules.find((r) => selectors(r).includes('html[data-design="v3"][data-theme="dark"]'));
  assert.ok(light, 'no light palette of design v3');
  assert.ok(dark, 'no dark palette of design v3');
  const l = tokens(light.body), d = tokens(dark.body);
  for (const t of ['--bg', '--panel', '--side', '--text', '--muted', '--border', '--active', '--primary-bg', '--primary-text']) {
    assert.ok(l.has(t), `light palette lacks ${t}`);
  }
  for (const t of l) assert.ok(d.has(t), `dark palette of v3 lacks ${t} — the light colour would show through`);
  assert.match(dark.body, /color-scheme\s*:\s*dark/);
});

test('design 3 is the only design — whatever was saved, and already in the page before the code runs', () => {
  const src = /export function applyDesign\(\) \{[\s\S]*?\n\}/.exec(settings);
  assert.ok(src, 'applyDesign not found');
  for (const saved of ['v2', 'v3', 'v9', null]) {
    const html = { dataset: {} };
    new Function('getSetting', 'document', src[0].replace(/export /g, '') + '\napplyDesign();')(() => saved, { documentElement: html });
    assert.equal(html.dataset.design, 'v3', `a saved design "${saved}" switches the board off design 3`);
  }
  assert.match(settings, /export function applyTheme\(\) \{\n  applyDesign\(\);/, 'applyTheme does not apply the design');
  assert.doesNotMatch(settings, /DESIGNS|design-card|setSetting\('design'/, 'the settings still offer a choice of design');
  assert.doesNotMatch(settings, /SETTINGS_DEFAULTS = \{.*\bdesign:/, 'a design setting is still kept');
  assert.match(read('../public/index.html'), /<html[^>]*\sdata-design="v3"/);
});

test('the background switch speaks Russian on a Russian board', () => {
  for (const k of ['Symbols in the background', 'New task']) assert.ok(core.includes(`  '${k}': '`), `no Russian for "${k}"`);
  assert.ok(!core.includes(`  'Version 2': '`), 'the dictionary still keeps the words of the removed design choice');
});

test('v2 has neither the background of symbols nor the sidebar row New task; v3 hides the toolbar button for it', () => {
  for (const sel of ['#glyph-bg', '.proj-new']) {
    const r = rules.find((x) => selectors(x).includes(sel));
    assert.ok(r && /display\s*:\s*none/.test(r.body), `${sel} is not hidden outside design v3`);
  }
  const btn = rules.find((x) => selectors(x).includes('html[data-design="v3"] #new-task'));
  assert.ok(btn && /display\s*:\s*none/.test(btn.body));
  const bg = rules.find((x) => selectors(x).includes('html[data-design="v3"] #glyph-bg'));
  assert.ok(bg && /z-index\s*:\s*-1/.test(bg.body) && /pointer-events\s*:\s*none/.test(bg.body), 'the background must lie under the page and let clicks through');
});

test('reduced motion stops every animation of design v3', () => {
  const animated = rules.filter((r) => r.prelude.includes('data-design') && /(?:^|;)\s*animation\s*:\s*v3-/.test(r.body)).flatMap(selectors);
  assert.ok(animated.length >= 8, `only ${animated.length} animated selectors`);
  const media = blocks(css).filter((b) => /prefers-reduced-motion:\s*reduce/.test(b.prelude)).flatMap((b) => blocks(b.body));
  const off = new Set(media.filter((r) => /animation\s*:\s*none/.test(r.body)).flatMap(selectors));
  for (const s of animated) assert.ok(off.has(s), `"${s}" keeps its animation under reduced motion`);
});

test('the board appears by opacity only — the link lines measure the cards while it renders', () => {
  const r = rules.find((x) => selectors(x).includes('html[data-design="v3"] .board') && /animation/.test(x.body));
  const name = /animation\s*:\s*([\w-]+)/.exec(r.body)[1];
  const kf = blocks(css).find((b) => b.prelude === `@keyframes ${name}`);
  assert.ok(kf && !/transform/.test(kf.body), `the board animation ${name} moves it`);
});

test('the row New task is not a .proj — the first visible .proj of the sidebar is what browser checks wait for', () => {
  const m = /newEl\.className = '([^']*)'/.exec(sidebar);
  assert.ok(m, 'the row New task is gone');
  assert.ok(!m[1].split(/\s+/).includes('proj'), `the row New task has class "${m[1]}"`);
});

test('there are two themes, light and dark — the theme Claude is gone and a saved one reads as dark', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const list = settings.slice(settings.indexOf('const THEMES = ['), settings.indexOf('];', settings.indexOf('const THEMES = [')));
  assert.deepEqual([...list.matchAll(/v: '(\w+)'/g)].map((m) => m[1]), ['system', 'light', 'dark'], 'the choice of themes is not system, light and dark');
  assert.match(settings, /if \(t === 'claude'\) \{ setSetting\('theme', 'dark'\); t = 'dark'; \}/, 'a saved theme Claude does not become dark');
  assert.ok(!rules.some((r) => selectors(r).some((x) => x.includes('data-theme="claude"'))), 'the styles still have a theme Claude');
});

// dark board before anyone chose anything. The default is light; System stays a choice.
test('the theme of a board nobody set up is light, not the system one', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const defaults = /const SETTINGS_DEFAULTS = \{([^}]*)\}/.exec(settings);
  assert.ok(defaults, 'the defaults of the settings are gone');
  assert.match(defaults[1], /theme: 'light'/, 'a board nobody set up does not open light');
});
