// chats». A phone starts dark, with Claude as a chat and Claude now on the chats of its runs, until the person picks
// otherwise; a computer — and a narrowed window of one — keeps its own defaults. The language follows the system on
// any device (navigator.language, core.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onPhone, PHONE_DEFAULTS, PHONE_NOW_VIEW } from '../public/js/phone-rules.js';

const device = ({ touch, w, h }) => ({
  matchMedia: (q) => ({ matches: q === '(hover: none) and (pointer: coarse)' ? touch : false }),
  screen: { width: w, height: h },
});

test('a phone is a touch screen with no hover and a short side under 600 points — not a narrow window', () => {
  assert.equal(onPhone(device({ touch: true, w: 390, h: 844 })), true, 'an iPhone');
  assert.equal(onPhone(device({ touch: true, w: 844, h: 390 })), true, 'an iPhone on its side');
  assert.equal(onPhone(device({ touch: false, w: 1440, h: 900 })), false, 'a computer, whatever its window');
  assert.equal(onPhone(device({ touch: true, w: 820, h: 1180 })), false, 'a tablet keeps the computer\'s defaults');
  assert.equal(onPhone({}), false, 'no matchMedia (an old browser, a test) — not a phone');
  assert.equal(onPhone({ matchMedia: () => { throw new Error('x'); } }), false);
});

test('a phone starts dark, with Claude as a chat and Claude now on the chats of its runs', () => {
  assert.deepEqual(PHONE_DEFAULTS, { theme: 'dark', chatView: 'chat' });
  assert.equal(PHONE_NOW_VIEW, 'terms');
  // the defaults reach the places that read them: getSetting and the view of Claude now
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /const d = Object\.hasOwn\(PHONE_DEFAULTS, k\) && onPhone\(\) \? PHONE_DEFAULTS\[k\] : SETTINGS_DEFAULTS\[k\]/);
  const now = readFileSync(new URL('../public/js/now.js', import.meta.url), 'utf8');
  assert.match(now, /let view = onPhone\(\) \? PHONE_NOW_VIEW : 'list'/);
  // what the person picked wins: getSetting returns the stored value before any default
  assert.match(settings, /if \(v === null\) return d;/);
});

// the dark of a phone (and of a dark board) is there before the first paint: boot-fallback.js sets the theme the module
test('the theme stands before the first paint, as applyTheme would set it', async () => {
  const vm = await import('node:vm');
  const code = readFileSync(new URL('../public/boot-fallback.js', import.meta.url), 'utf8');
  const themeOf = ({ saved, touch = false, w = 1440, h = 900, dark = false }) => {
    let theme = null;
    vm.runInNewContext(code, {
      setTimeout() {}, location: { search: '', origin: 'http://x' }, URLSearchParams,
      window: { addEventListener() {} }, sessionStorage: { getItem: () => null, removeItem() {} },
      localStorage: { getItem: (k) => (k === 'kb.set.theme' && saved !== undefined ? JSON.stringify(saved) : null) },
      matchMedia: (q) => ({ matches: q.includes('pointer: coarse') ? touch : q.includes('prefers-color-scheme: dark') ? dark : false }),
      screen: { width: w, height: h },
      document: { documentElement: { classList: { add() {}, remove() {}, contains: () => false }, setAttribute: (k, v) => { if (k === 'data-theme') theme = v; } } },
    });
    return theme;
  };
  assert.equal(themeOf({ touch: true, w: 390, h: 844 }), 'dark', 'a phone nobody set up');
  assert.equal(themeOf({}), 'light', 'a computer nobody set up');
  assert.equal(themeOf({ saved: 'light', touch: true, w: 390, h: 844 }), 'light', 'a phone set to light');
  assert.equal(themeOf({ saved: 'dark' }), 'dark');
  assert.equal(themeOf({ saved: 'system', dark: true }), 'dark');
  assert.equal(themeOf({ saved: 'claude' }), 'dark', 'the old theme «Claude» is the dark one (CK-641)');
});
