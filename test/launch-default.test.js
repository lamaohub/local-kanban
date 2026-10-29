// default nobody picked still steps aside where the board cannot start Claude itself (README: "Without tmux on the
// machine the board opens Claude in the project's folder instead"); "inside the board" picked by hand refuses there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardOnly, launchPick, launchShown } from '../public/js/launch-rules.js';

const ALL = { board: true, desktop: true, terminal: true, cli: true };
const NO_TMUX = { board: false, desktop: true, terminal: true, cli: true };

test('nobody picked: inside the board where it can, the next way where it cannot', () => {
  assert.equal(launchPick(null, ALL), 'board');
  assert.equal(launchPick(null, NO_TMUX), 'desktop');
  assert.equal(launchPick(null, { board: false, terminal: true, cli: true }), 'terminal');
  assert.equal(launchPick(null, {}), 'copy');
  // the board refused (a prompt too long for tmux): the next way, not the board again
  assert.equal(launchPick(null, ALL, true), 'desktop');
  assert.equal(boardOnly(null), false);
});

test('picked by hand: that way, and "inside the board" refuses rather than opens a window', () => {
  for (const m of ['board', 'desktop', 'terminal', 'copy']) assert.equal(launchPick(m, NO_TMUX), m);
  assert.equal(boardOnly('board'), true);
  assert.equal(boardOnly('auto'), false);
  assert.equal(launchPick('auto', ALL), 'board');
  assert.equal(launchPick('auto', NO_TMUX), 'desktop');
});

test('Settings show "inside the board" by default, "automatically" where the board cannot start Claude', () => {
  assert.equal(launchShown(null, ALL), 'board');
  assert.equal(launchShown(null, {}), 'board'); // the board did not answer: the default as it is
  assert.equal(launchShown(null, NO_TMUX), 'auto');
  assert.equal(launchShown('auto', ALL), 'auto');
  assert.equal(launchShown('terminal', ALL), 'terminal');
});

test('the defaults of the page: inside the board, Auto permissions', () => {
  const src = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const defaults = src.match(/const SETTINGS_DEFAULTS = \{([^\n]*)\};/)[1];
  assert.match(defaults, /launch: 'board'/);
  assert.match(defaults, /permission: 'auto'/);
});

// built from a null choice hid one picked by hand, and ▶ with getSetting read the default 'board' as picked by hand, so
// a refusal with a fallback (no tmux, a prompt too long for tmux) showed an error instead of the next way.
test('Settings and ▶ hand the rules what the person picked, not the default', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  const sse = readFileSync(new URL('../public/js/sse.js', import.meta.url), 'utf8');
  assert.match(settings, /launchShown\(pickedSetting\('launch'\),/);
  assert.match(sse, /launchPick\(pickedSetting\('launch'\),/);
  assert.match(sse, /boardOnly\(pickedSetting\('launch'\)\)/);
  assert.doesNotMatch(sse + settings, /(launchShown|launchPick|boardOnly)\((getSetting\(|null)/);
});
