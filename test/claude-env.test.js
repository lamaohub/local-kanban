// bare mode (CLAUDE_CODE_SIMPLE — the owner kept it in .zshrc) reads no sign-in, no hooks, no skills: the card offered
// «Sign in», and /login answered "Bare mode doesn't use the sign-in from /login". An API key in the environment stands
// above the subscription (code.claude.com/docs/en/authentication). Now the board takes the bare mode off its Claude —
// inside the board and in the Terminal it opens — Settings → Claude Code names both, and the card explains the bare mode
// instead of offering a sign-in that cannot work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cleanEnv, NOT_FOR_BOARD } from '../src/phantom.js';
import { envState } from '../src/claude-setup.js';
import { setupView } from '../public/js/claude-setup-rules.js';

test('the board takes the bare mode off its Claude, and keeps the rest of the person\'s settings', () => {
  assert.deepEqual(NOT_FOR_BOARD, ['CLAUDE_CODE_SIMPLE']);
  const out = cleanEnv({ PATH: '/b', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'k', CLAUDE_CODE_USE_BEDROCK: '1' });
  assert.equal('CLAUDE_CODE_SIMPLE' in out, false);
  assert.equal(out.ANTHROPIC_API_KEY, 'k');
  assert.equal(out.CLAUDE_CODE_USE_BEDROCK, '1');
});

test('what of the environment reaches the board\'s Claude: names only, never a value', () => {
  const e = envState({ PATH: '/b', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: '' }, { env: { ANTHROPIC_AUTH_TOKEN: 't' } });
  assert.deepEqual(e, { taken_off: ['CLAUDE_CODE_SIMPLE'], keys: ['ANTHROPIC_API_KEY'], settings: ['ANTHROPIC_AUTH_TOKEN'] });
  assert.ok(!JSON.stringify(e).includes('sk-secret'), 'a value went into the answer');
  // a switch set off is off; a board started from a Claude session passes none of the person's settings
  for (const v of ['0', 'false', 'off', '']) assert.deepEqual(envState({ CLAUDE_CODE_SIMPLE: v }, {}).taken_off, [], v);
  assert.deepEqual(envState({ CLAUDECODE: '1', CLAUDE_CODE_SIMPLE: '1', ANTHROPIC_API_KEY: 'k' }, {}), { taken_off: [], keys: [], settings: [] });
  // settings.json's env is Claude Code's own — the board cannot take it off, so it is named
  assert.deepEqual(envState({}, { env: { CLAUDE_CODE_SIMPLE: 1 } }).settings, ['CLAUDE_CODE_SIMPLE']);
  assert.deepEqual(envState({}, { env: 'x' }).settings, []);
  assert.deepEqual(envState({}, undefined).settings, []);
});

const rowsOf = (env) => Object.fromEntries(setupView({ env }).flatMap((g) => g.rows).map((r) => [r.id, r]));

test('Settings → Claude Code: rows only when there is something, each saying what breaks and how to fix it', () => {
  const none = rowsOf({ taken_off: [], keys: [], settings: [] });
  assert.equal(none.bare, undefined);
  assert.equal(none.key, undefined);
  assert.equal(rowsOf({ taken_off: ['CLAUDE_CODE_SIMPLE'] }).bare.state, 'ok', 'the bare mode the board takes off is not a fault');
  const inSettings = rowsOf({ settings: ['CLAUDE_CODE_SIMPLE'] }).bare;
  assert.equal(inSettings.state, 'warn');
  assert.match(inSettings.fix.text, /settings\.json/);
  const key = rowsOf({ keys: ['ANTHROPIC_API_KEY'] }).key;
  assert.equal(key.state, 'warn');
  assert.equal(key.value, 'ANTHROPIC_API_KEY');
  assert.match(key.note, /asks once/);
  assert.match(key.fix.text, /\/status/);
  assert.match(rowsOf({ keys: ['ANTHROPIC_AUTH_TOKEN'] }).key.note, /without asking/);
  assert.match(rowsOf({ settings: ['ANTHROPIC_API_KEY'] }).key.fix.text, /settings\.json/);
  const both = rowsOf({ keys: ['ANTHROPIC_API_KEY'], settings: ['ANTHROPIC_AUTH_TOKEN'] }).key;
  assert.match(both.fix.text, /settings\.json/);
  assert.match(both.fix.text, /start the board from a terminal without/, 'the advice leaves the key in the board\'s own environment');
  assert.match(both.fix.text, /Use custom API key/, 'the advice for both places drops the remembered answer about the key');
  assert.match(both.note, /without asking/, 'a token used without asking is said to be asked about');
  assert.doesNotMatch(rowsOf({ keys: ['ANTHROPIC_API_KEY'] }).key.fix.text, /settings\.json/);
});

test('the card explains the bare mode instead of offering a sign-in that cannot work', () => {
  const src = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const line = src.match(/^const BARE_MODE = .*$/m)[0];
  const BARE_MODE = new Function(`${line}; return BARE_MODE;`)();
  // the line the owner's Claude Code 2.1.293 printed on /login, 08.10.2026
  assert.ok(BARE_MODE.test("Bare mode doesn't use the sign-in from /login. It reads ANTHROPIC_API_KEY or an apiKeyHelper from --settings"));
  assert.ok(!BARE_MODE.test('Not logged in · Please run /login'));
  // the bare note wins over the sign-in one, and its button opens the row that names the cause
  assert.match(src, /const login = live && !bare && needsLogin/);
  assert.match(src, /openSettingsModal\('claude'\)/);
});
