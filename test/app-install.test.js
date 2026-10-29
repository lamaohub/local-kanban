// other browsers folded below, an Install button where the browser offers it. The rules are a leaf module, run here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INSTALL_BROWSERS, INSTALL_STEPS, browserOf, installView } from '../public/js/app-install-rules.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

const UA = {
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Safari/537.36 Edg/141.0.3537.71',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.54 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
};

test('the browser is told from its user agent, an iPad asking for the desktop site included', () => {
  assert.equal(browserOf(UA.chrome), 'chrome');
  assert.equal(browserOf(UA.edge), 'edge', 'Edge reads as Chrome');
  assert.equal(browserOf(UA.safari), 'safari', 'Safari reads as something else');
  assert.equal(browserOf(UA.safari, 5), 'ios', 'an iPad that calls itself a Mac gets the steps of a Mac');
  assert.equal(browserOf(UA.iphone), 'ios');
  assert.equal(browserOf(UA.android), 'android', 'Chrome on Android gets the steps of a computer');
  assert.equal(browserOf(UA.firefox), 'firefox');
  assert.equal(browserOf('curl/8'), null);
});

test('the section shows the steps of this browser, the others below, and nothing to do once installed', () => {
  const v = installView({ ua: UA.safari });
  assert.equal(v.here, INSTALL_STEPS.safari);
  assert.equal(v.others.length, INSTALL_BROWSERS.length - 1);
  assert.ok(!v.others.includes(INSTALL_STEPS.safari), 'the steps of this browser are repeated under the others');
  assert.equal(installView({ ua: 'curl/8' }).others.length, INSTALL_BROWSERS.length, 'an unknown browser loses some steps');
  assert.equal(installView({ ua: UA.chrome, canPrompt: true }).prompt, true, 'the offer of the browser gives no button');
  const done = installView({ ua: UA.chrome, standalone: true, canPrompt: true, secure: false });
  assert.equal(done.installed, true);
  assert.equal(done.prompt, false, 'an installed board offers to install itself again');
  assert.equal(done.insecure, false);
});

test('a Chromium browser on a page that is not a secure context is told why the menu item is grey', () => {
  for (const ua of [UA.chrome, UA.edge, UA.android]) assert.equal(installView({ ua, secure: false }).insecure, true, ua);
  assert.equal(installView({ ua: UA.safari, secure: false }).insecure, false, 'Safari makes an app of any page');
  assert.equal(installView({ ua: UA.chrome, secure: true }).insecure, false);
});

test('every step is in the Russian dictionary, and the section is wired into Settings', () => {
  const core = read('../public/js/core.js');
  const strings = Object.values(INSTALL_STEPS).flatMap((g) => [g.name, ...g.steps]);
  for (const s of strings) assert.ok(core.includes(`  '${s}': '`), `no Russian for «${s}»`);
  const settings = read('../public/js/settings.js');
  assert.match(settings, /\['app', tr\('As an app'\)\]/, 'Settings lost the section');
  assert.match(settings, /sec === 'app'\) \{\n\s*renderAppSection\(body\);/, 'the section is not drawn');
  assert.match(settings, /beforeinstallprompt[\s\S]{0,80}preventDefault\(\); installPrompt = e;/, 'the offer of the browser is not kept');
  assert.match(read('../public/js/init.js'), /\nlistenForInstall\(\);/, 'the offer is not listened for at start');
});

test('the manifest opens in the colours of the light theme, the default one', () => {
  const m = JSON.parse(read('../public/manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.background_color, '#faf9f5', 'the splash of the app is dark while the board opens light');
});
