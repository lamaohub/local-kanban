// The first-run wizard stands on one grid, and the numbers of that grid live in different places: the split of the two
// halves (.onb) and the place of the dots and the count over the right half (.onb-top), the stage's padding and its
// line, the height of the logo in the markup (onboarding.js) and the padding over the words. A change of one of them
// alone moved the dots off the picture, or the picture off the line of the small heading, with every rule still matching
// its own text — this guard ties each number to the ones it is made of.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const onb = readFileSync(new URL('../public/js/onboarding.js', import.meta.url), 'utf8');
// the first rule with exactly this selector, outside any @media
const rule = (sel) => {
  const flat = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
  return [...flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, s]) => s.split(',').map((x) => x.trim()).includes(sel)).map(([, , b]) => b).join(';');
};
const px = (s) => Number(String(s).replace('px', ''));
const padding = (body) => {
  const m = body.match(/(?:^|;)\s*padding:\s*([^;]+)/);
  assert.ok(m, 'no padding');
  const p = m[1].trim().split(/\s+/).map(px);
  const [t, r = t, b = t, l = r] = p;
  return { t, r, b, l };
};

test('the dots and the count stand on the edges of the picture, whatever the split of the two halves', () => {
  const cols = rule('.onb').match(/grid-template-columns:\s*minmax\(0,\s*(\d+(?:\.\d+)?)fr\)\s*minmax\(0,\s*(\d+(?:\.\d+)?)fr\)/);
  assert.ok(cols, 'the wizard is not two halves of fr');
  const share = (Number(cols[1]) / (Number(cols[1]) + Number(cols[2]))) * 100;
  const top = rule('.onb-top').match(/left:\s*calc\((\d+(?:\.\d+)?)% \+ (\d+)px\);\s*right:\s*(\d+)px/);
  assert.ok(top, 'the place of the dots is not a share of the wizard plus the stage\'s edge');
  const stage = rule('.onb-stage');
  const pad = padding(stage);
  const line = stage.match(/border-left:\s*(\d+)px/);
  assert.ok(line, 'the stage has no line on its left');
  assert.equal(Number(top[1]), share, 'the dots stand over a split of the halves the wizard no longer has');
  assert.equal(Number(top[2]), pad.l + Number(line[1]), 'the dots are off the left edge of the picture');
  assert.equal(Number(top[3]), pad.r, 'the count is off the right edge of the picture');
});

test('the picture starts on the line of the small heading on the left', () => {
  const side = padding(rule('.onb-side'));
  const main = padding(rule('.onb-main'));
  const stage = padding(rule('.onb-stage'));
  const logo = onb.match(/<div class="onb-brand"><img [^>]*height="(\d+)"/);
  assert.ok(logo, 'the logo of the wizard has no height in its markup');
  assert.doesNotMatch(rule('.onb-brand'), /(?:^|;)\s*(?:height|min-height|padding|line-height):/, 'the logo row is not as tall as the logo');
  assert.equal(stage.t, side.t + Number(logo[1]) + main.t, 'the picture is off the line of the small heading');
});
