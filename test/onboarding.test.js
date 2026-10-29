// goes through it once more; nothing of its data is touched. Plus what the wizard offers (public/js/onboarding-rules.js
// runs here in node) and how the page reaches it (the source of onboarding.js — a module of the page, not importable).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTACT_NAME, CONTACT_URL, FEATURES, STEP_HEADS, VIEW_CHOICES, launchChoices, onboardingSteps, scanLines, scanReady } from '../public/js/onboarding-rules.js';
import { setupView } from '../public/js/claude-setup-rules.js';

let tmp, app, db;
before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'kb-onb-'));
  process.env.KB_DATA_DIR = tmp;
  db = await import('../src/db.js');
  const { default: Fastify } = await import('fastify');
  const systemRoutes = (await import('../src/routes/system.js')).default;
  app = Fastify();
  await app.register(systemRoutes);
  await app.ready();
});
after(async () => { await app?.close(); rmSync(tmp, { recursive: true, force: true }); });

const get = async () => (await app.inject({ method: 'GET', url: '/api/onboarding' })).json();
const post = async (done) => (await app.inject({ method: 'POST', url: '/api/onboarding', payload: { done } })).json();

test('a board that went through the old wizard, or was marked done without one, sees the new one once', async () => {
  const { ONBOARDING_VERSION } = await import('../src/routes/system.js');
  assert.ok(ONBOARDING_VERSION >= 3, 'CK-698: a board that saw the small wizard is not shown the whole-screen one');
  assert.ok(ONBOARDING_VERSION >= 4, 'CK-709: a board that saw the wizard without step Permissions is not shown it');
  // a fresh board
  assert.deepEqual(await get(), { done: false, seen: 0, version: ONBOARDING_VERSION });
  db.kvSet('onboarding.done', '1');
  assert.deepEqual(await get(), { done: false, seen: 1, version: ONBOARDING_VERSION }, 'an updated board skipped the wizard');
  // went through it
  assert.equal((await post(true)).done, true);
  assert.equal(db.kvGet('onboarding.version'), String(ONBOARDING_VERSION));
  assert.equal(db.kvGet('onboarding.done'), '1', 'the old flag is kept for an older page');
  assert.equal((await get()).done, true);
  // a later wizard brings it back
  db.kvSet('onboarding.version', String(ONBOARDING_VERSION - 1));
  assert.equal((await get()).done, false);
  // taking it back
  await post(true);
  assert.equal((await post(false)).done, false);
  assert.equal((await get()).seen, 0);
});

test('the flag is all the wizard\'s route touches: projects, tasks, the sync and the language stay', async () => {
  const { default: Fastify } = await import('fastify');
  const projectRoutes = (await import('../src/routes/projects.js')).default;
  const papp = Fastify();
  await papp.register(projectRoutes);
  await papp.ready();
  const made = await papp.inject({ method: 'POST', url: '/api/projects', payload: { slug: 'keep', name: 'Keep' } });
  assert.equal(made.statusCode, 201, made.body);
  db.kvSet('gh.owner', 'octocat');
  db.kvSet('gh.repo', 'octocat/hello-world');
  db.kvSet('ui.lang', 'ru');
  db.kvSet('sync.paused', '1');
  db.db.prepare("INSERT INTO tasks (project_id, task_no, title, status) SELECT id, 1, 'Keep me', 'todo' FROM projects WHERE slug = 'keep'").run();
  const before = db.db.prepare('SELECT slug, name, prefix FROM projects ORDER BY id').all();
  const tasks = db.db.prepare('SELECT id, title, status FROM tasks ORDER BY id').all();
  assert.equal(tasks.length, 1);
  await post(false);
  await get();
  await post(true);
  assert.deepEqual(db.db.prepare('SELECT slug, name, prefix FROM projects ORDER BY id').all(), before);
  assert.deepEqual(db.db.prepare('SELECT id, title, status FROM tasks ORDER BY id').all(), tasks, 'the wizard touched the tasks');
  assert.equal(db.kvGet('sync.paused'), '1', 'the wizard touched the pause of the sync');
  assert.equal(db.kvGet('gh.owner'), 'octocat');
  assert.equal(db.kvGet('gh.repo'), 'octocat/hello-world');
  assert.equal(db.kvGet('ui.lang'), 'ru');
  await papp.close();
});

test('the steps: the demo only for an empty board, everything else for everyone', () => {
  assert.deepEqual(onboardingSteps(false), ['lang', 'access', 'claude', 'view', 'sync', 'demo', 'done']);
  assert.deepEqual(onboardingSteps(true), ['lang', 'access', 'claude', 'view', 'sync', 'done']);
});

test('the ways ▶ starts Claude: all four, each the value of the launch setting, the missing ones say why', () => {
  const all = launchChoices({ board: true, desktop: true, terminal: true, cli: true });
  assert.deepEqual(all.map((c) => c.value), ['board', 'terminal', 'desktop', 'copy']);
  assert.ok(all.every((c) => !c.off && c.title && c.note));
  // before GET /api/launch answers nothing is said to be missing
  assert.ok(launchChoices().every((c) => !c.off));
  const bare = launchChoices({ board: false, desktop: false, terminal: true, cli: false });
  assert.deepEqual(bare.filter((c) => c.off).map((c) => c.value), ['board', 'terminal', 'desktop']);
  assert.equal(bare.find((c) => c.value === 'copy').off, '', 'copying is there on any computer');
});

const src = (f) => readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8');

test('the switches of the wizard are the settings of Settings → Claude Code and Appearance', () => {
  const settings = src('settings.js');
  for (const c of VIEW_CHOICES) {
    assert.match(settings, new RegExp(`data-set="${c.key}"`), `${c.key} is not a setting of Settings`);
    assert.ok(settings.includes(`tr('${c.title.replace(/'/g, "\\'")}')`) || settings.includes(`tr("${c.title}")`), `${c.title} reads otherwise in Settings`);
  }
});

test('the welcome links the author on Telegram, in a new tab without the opener', () => {
  assert.equal(CONTACT_URL, 'https://t.me/danielmarkoff');
  assert.equal(CONTACT_NAME, '@danielmarkoff');
  const onb = src('onboarding.js');
  const welcome = onb.slice(onb.indexOf('const stepLang'), onb.indexOf('const stepClaude'));
  assert.match(welcome, /<a href="\$\{CONTACT_URL\}" target="_blank" rel="noopener noreferrer">\$\{CONTACT_NAME\}<\/a>/);
  assert.match(src('settings.js'), /href="\$\{CONTACT_URL\}" target="_blank" rel="noopener noreferrer">\$\{CONTACT_NAME\}/, 'About lost the contact');
});

test('the page opens the wizard for a board with projects instead of marking it done', () => {
  const onb = src('onboarding.js');
  const maybe = onb.slice(onb.indexOf('export async function maybeOnboarding'), onb.indexOf('export function openOnboarding'));
  assert.doesNotMatch(maybe, /POST/, 'maybeOnboarding marks the wizard done without showing it');
  assert.match(maybe, /openOnboarding\(/);
  // an older wizard (`seen`) broke "an update brings it back", and the suite stayed green
  assert.match(maybe, /if \(st\.done && !wizardResumes\(\)\) \{ liftCurtain\(\); return; \}\s*openOnboarding\(/);
  // Settings -> About), and when the board did not answer — else its step mark stayed and opened the next one on step two
  assert.match(maybe, /catch \{[\s\S]*?if \(wizardResumes\(\)\) openOnboarding\(\); else liftCurtain\(\);/);
  assert.doesNotMatch(maybe, /if \([^)]*st\.seen[^)]*\) return/);
  // the demo is offered by what the board holds, and the way ▶ starts Claude is written only by a click
  assert.match(onb, /const STEPS = onboardingSteps\(state\.projects\.length > 0\);/);
  assert.equal(onb.split("setSetting('launch'").length, 2, 'the launch setting is written outside the click');
  assert.match(onb, /b\.onclick = \(\) => \{\s*setSetting\('launch', b\.dataset\.launch\);/);
  const click = onb.slice(onb.indexOf("b.onclick = () => {\n          setSetting('launch'"), onb.indexOf('b.onfocus = look;'));
  assert.ok(click.length > 0 && !/\bdraw\(\)/.test(click), 'a click on a way draws the list anew');
  // a sync that stays on gets no "Skip — work locally", and gh not checked yet is not said to be found
  const sync = onb.slice(onb.indexOf('const stepSync'), onb.indexOf('const stepDemo'));
  assert.match(sync, /\$\('onb-sync-on'\)\.textContent = tr\('Keep it'\);\s*\$\('onb-sync-skip'\)\.remove\(\);/);
  assert.match(sync, /was\.gh \? tr\('gh CLI found and authenticated ✓'\) : ''/);
  // the step after a change of language comes from the session, not from "a language was ever saved" — an updated
  // board has one saved, and skipped the welcome
  assert.doesNotMatch(onb, /kb\.set\.lang/);
  assert.match(onb, /sessionStore\.setItem\(RESUME_KEY/);
  assert.match(src('init.js'), /import \{ maybeOnboarding(, wizardResumes)? \} from '\.\/onboarding\.js';/);
});

test('the wizard\'s backdrop is opaque, and the last screen is a summary with the prompt folded', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const rule = css.match(/#onboarding\.modal-overlay\s*\{([^}]*)\}/);
  assert.ok(rule, 'the wizard has no backdrop of its own');
  assert.match(rule[1], /background:\s*color-mix\(in srgb, var\(--bg\) \d+%, #000\)/);
  assert.doesNotMatch(rule[1], /rgba|transparent/);
  const onb = src('onboarding.js');
  const done = onb.slice(onb.indexOf('const stepDone'), onb.indexOf('let resume'));
  assert.match(done, /class="onb-sum"/);
  const folded = done.slice(done.indexOf('<details'), done.indexOf("'</details>'"));
  assert.ok(folded.includes('setupPromptBlockHTML()') && folded.includes('manualSetupHTML('), 'the prompt is not folded');
  assert.equal(done.split('setupPromptBlockHTML()').length, 2, 'the prompt is drawn outside the fold too');
});

test('every step has its head, and the welcome its four points with their pictures', () => {
  for (const id of onboardingSteps(false)) {
    assert.ok(STEP_HEADS[id]?.eyebrow && STEP_HEADS[id]?.title, `step ${id} has no head`);
  }
  assert.deepEqual(FEATURES.map((f) => f.id), ['take', 'watch', 'now', 'accept']);
  const onb = src('onboarding.js');
  for (const f of FEATURES) assert.match(onb, new RegExp(`\\b${f.id}: `), `the point ${f.id} has no picture`);
});

test('the check of this computer says what Settings → Claude Code says, row for row', () => {
  const found = setupView({ platform: 'darwin', claude: { path: '/x/claude', from: 'PATH' }, tmux: { path: '/x/tmux' }, app: { supported: true, path: null },
    terminal: { ok: true }, folder: { path: '/h/.claude', exists: true }, skill: { exists: true, state: 'same' } }).flatMap((s) => s.rows);
  const lines = scanLines(found);
  const by = Object.fromEntries(lines.map((l) => [l.text.split(': ').pop(), l.mark]));
  assert.equal(by['Claude Code (claude)'], 'ok');
  assert.equal(by.tmux, 'ok');
  assert.equal(by['Claude app'], 'no', 'a missing app is said to be found');
  assert.ok(lines.find((l) => l.text.startsWith('Not found: Claude app')));
  // nothing the page cannot tell yet is invented: no rows — no lines
  assert.deepEqual(scanLines([]), []);
  // the words go through the page's translation
  assert.ok(scanLines(found, (s) => `ru:${s}`).every((l) => l.text.startsWith('ru:')));
  assert.equal(scanReady(lines), true);
  const none = setupView({ platform: 'darwin', claude: { path: null }, app: { supported: true, path: null }, terminal: { ok: true } }).flatMap((s) => s.rows);
  assert.equal(scanReady(scanLines(none)), false, 'a computer without Claude is said to be ready');
  assert.equal(scanReady([]), false, 'a check that failed is said to be ready');
  const other = scanLines([{ id: 'hook', state: 'warn', title: "Claude's questions" }]);
  assert.deepEqual(other.map((l) => l.mark), ['warn'], 'a hook of another board reads as not connected');
  // a warning row the wizard would hide otherwise: bare mode breaks Claude of the board
  const bare = scanLines([{ id: 'claude', state: 'ok', title: 'Claude Code (claude)' }, { id: 'bare', state: 'warn', title: 'Bare mode' }]);
  assert.deepEqual(bare.map((l) => l.id), ['claude', 'bare']);
  assert.equal(scanReady(bare), false);
  assert.deepEqual(scanLines([{ id: 'bare', state: 'ok', title: 'Bare mode' }]), [], 'a row that is fine and only warns is shown');
});

test('the pictures come in once and stand still under "reduce motion"; a narrow screen gets the words alone', () => {
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  const reduce = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join('\n');
  assert.match(reduce, /\.onb-a[^{]*\{ animation: none; \}/, 'the parts of a picture still come in under reduce motion');
  assert.match(reduce, /\.onb-mover \{ animation: none;/);
  assert.doesNotMatch(css.match(/\.onb-a \{[^}]*\}/)[0], /infinite/, 'a picture loops');
  const onbRules = [...css.matchAll(/(\.onb[^{]*)\{([^}]*)\}/g)].filter((m) => /animation:/.test(m[2]));
  assert.ok(onbRules.length >= 5);
  assert.deepEqual(onbRules.filter((m) => /infinite/.test(m[2])).map((m) => m[1].trim()), [], 'a part of the wizard loops');
  const narrow = css.match(/@media \(max-width: 900px\) \{([\s\S]*?)\n\}/)[1];
  assert.match(narrow, /\.onb-stage \{ display: none; \}/, 'the picture squeezes the words on a narrow screen');
});

test('every word of the wizard and its pictures has its Russian', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const at = core.indexOf('const I18N_RU = ');
  const dict = new Function(`return ${core.slice(at + 'const I18N_RU = '.length, core.indexOf('\n};', at) + 2)}`)();
  const words = new Set();
  for (const f of ['onboarding.js', 'onboarding-scenes.js']) {
    for (const m of src(f).matchAll(/tr\('((?:\\'|[^'])*)'\)/g)) words.add(m[1].replace(/\\'/g, "'"));
  }
  for (const h of Object.values(STEP_HEADS)) for (const k of ['eyebrow', 'title', 'title2', 'lead']) if (h[k]) words.add(h[k]);
  for (const f of FEATURES) { words.add(f.title); words.add(f.note); }
  const NAMES = new Set(['Claude Code']); // a name reads the same in both languages
  const missing = [...words].filter((w) => !(w in dict) && !NAMES.has(w));
  assert.deepEqual(missing, [], 'these stay English on a Russian board');
});

test('the wizard changes its picture on a click, never on the mouse passing over', () => {
  const onb = src('onboarding.js');
  assert.doesNotMatch(onb, /onpointerenter|onpointerover|onmouseenter|onmouseover|onpointerleave/, 'a picture follows the mouse again');
  const lang = onb.slice(onb.indexOf('const stepLang'), onb.indexOf('const stepClaude'));
  assert.match(lang, /b\.onclick = \(\) => \{ stopTimer\(\); show\(i\); \};/);
  const claude = onb.slice(onb.indexOf('const stepClaude'), onb.indexOf('const stepView'));
  assert.match(claude, /b\.onclick = \(\) => \{\s*setSetting\('launch', b\.dataset\.launch\);[\s\S]*?look\(\);\s*\};/, 'a way clicked does not show its picture');
});

// and the board as an app with its steps, each checked right there
test('step Permissions comes right after the welcome and says each thing with its mark', async () => {
  const { accessLines } = await import('../public/js/onboarding-rules.js');
  assert.equal(onboardingSteps(true)[1], 'access');
  const ids = (o) => accessLines(o).map((l) => `${l.id}:${l.mark}`);
  assert.deepEqual(ids({ perm: 'default' }), ['notify:no'], 'off a Mac and with no app view only notifications');
  assert.deepEqual(ids({ perm: 'granted', on: true, macos: { full_disk: true }, app: { installed: true } }), ['notify:ok', 'macos:ok', 'app:ok']);
  assert.deepEqual(ids({ perm: 'granted', on: false, macos: { full_disk: false }, app: { installed: false } }), ['notify:warn', 'macos:warn', 'app:no']);
  assert.deepEqual(ids({ perm: 'denied', macos: { full_disk: null }, app: { installed: false, insecure: true } }), ['notify:no', 'app:no'], 'an unknown Full Disk Access is said to be missing');
  assert.equal(accessLines({ perm: 'unsupported' })[0].mark, 'warn');
  // a failed check of the computer is said, not taken for a computer that is not a Mac; what was known stays
  assert.deepEqual(ids({ perm: 'default', unchecked: true }), ['notify:no', 'macos:warn'], 'a failed check of the computer looks like no Mac');
  assert.deepEqual(ids({ perm: 'default', unchecked: true, macos: { full_disk: true } }), ['notify:no', 'macos:ok'], 'a failed check again throws away what was known');
  // every word of the step reaches the Russian board: the lines, the titles and the buttons
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const at = core.indexOf('const I18N_RU = ');
  const dict = new Function(`return ${core.slice(at + 'const I18N_RU = '.length, core.indexOf('\n};', at) + 2)}`)();
  const words = new Set();
  for (const o of [{ perm: 'default' }, { perm: 'denied' }, { perm: 'unsupported' }, { perm: 'granted', on: true }, { perm: 'granted' }]) {
    for (const m of [{ full_disk: true }, { full_disk: false }, null]) for (const app of [{ installed: true }, {}, { insecure: true }]) accessLines({ ...o, macos: m, app, unchecked: !m }).forEach((l) => words.add(l.text));
  }
  const onb = src('onboarding.js');
  const step = onb.slice(onb.indexOf('const stepAccess'), onb.indexOf('const stepClaude'));
  for (const m of step.matchAll(/btn\('[\w-]+', '([^']+)'/g)) words.add(m[1]);
  for (const m of step.matchAll(/row\(line\('\w+'\), '\w+', '([^']+)'/g)) words.add(m[1]);
  assert.ok(words.size > 15);
  assert.deepEqual([...words].filter((w) => !(w in dict)), [], 'these stay English on a Russian board');
  // nothing is asked of the browser before a click, and the app part is the one of Settings → As an app
  assert.equal(step.split('Notification.requestPermission').length, 2);
  assert.match(step, /allow: async \(\) => \{ if \(\(await Notification\.requestPermission\(\)\) === 'granted'\)/);
  assert.match(step, /const app = appInstallView\(installed\);/);
  assert.match(src('settings.js'), /export function renderAppSection\(body\) \{\n  const v = appInstallView\(\);/);
});

// behind (it opened the next wizard on step two), and a check again of macOS access the board did not answer
test('the wizard takes its step mark away when it comes back, and a check again the board did not answer is said', () => {
  const onb = readFileSync(new URL('../public/js/onboarding.js', import.meta.url), 'utf8');
  assert.match(onb, /resume = sessionStore\.getItem\(RESUME_KEY\); sessionStore\.removeItem\(RESUME_KEY\);/, 'the step mark stays behind');
  const look = onb.slice(onb.indexOf("const look = () => api('GET', '/api/claude'"), onb.indexOf('const onInstalled'));
  assert.match(look, /unchecked = !setup;/, 'a failed check again is not marked');
  assert.match(onb, /\+ \(unchecked \? `<small class="onb-warn">\$\{esc\(typeset\(tr\('The board did not answer the check/, 'a failed check again says nothing');
});

// terminal asked on step Claude; the questions of Claude not a fault; everyone goes through it once more
test('the wizard says what the board is now and asks chat or terminal', () => {
  const onb = src('onboarding.js');
  const claude = onb.slice(onb.indexOf('const stepClaude'), onb.indexOf('const stepView'));
  assert.match(claude, /setClaudeView\(b\.dataset\.view\);/, 'the choice is not the setting of Settings → Claude Code');
  assert.match(claude, /sceneWay\(way\.value, examplePrompt\(\), tr\(way\.off \|\| way\.note\), viewNow\(\)\)/, 'the picture of ▶ inside the board does not follow the choice');
  assert.match(onb, /\[tr\('Show Claude as'\), tr\(getSetting\('chatView'\) === 'chat' \? 'Chat' : 'Terminal'\)\]/, 'the summary does not say the choice');
  const scenes = src('onboarding-scenes.js');
  assert.match(scenes, /if \(view === 'chat'\) \{/, 'the card\'s Claude is a terminal only');
  assert.match(scenes, /class="onb-q-opt on"/, 'a question of Claude is drawn as keys, not as the form');
  assert.match(onb, /now: sceneNow/, 'Claude now has no picture');
  // the board gives its own Claude the hook: «Not connected» read as a fault
  assert.deepEqual(scanLines([{ id: 'hook', state: 'no', title: "Claude's questions" }]).map((l) => [l.mark, l.text]),
    [['ok', "Claude's questions: come to the board from its own Claude"]]);
  assert.match(readFileSync(new URL('../src/routes/system.js', import.meta.url), 'utf8'), /export const ONBOARDING_VERSION = 5;/, 'the updated wizard is not shown to everyone');
});

// language above the four points (a laptop's window keeps it in sight)
test('the wizard reads «Show Claude as» as the card does, marks the picked one, and puts the language first', () => {
  const onb = src('onboarding.js');
  const claude = onb.slice(onb.indexOf('const stepClaude'), onb.indexOf('const stepView'));
  const rule = (s) => s.match(/getSetting\('chatView'\) === '(\w+)' \? '(\w+)' : '(\w+)'/)?.slice(1).join(' ');
  const drawer = readFileSync(new URL('../public/js/drawer.js', import.meta.url), 'utf8');
  const card = rule(drawer.slice(drawer.indexOf('export const claudeView')));
  assert.equal(card, 'chat chat terminal', 'the card\'s rule moved; teach this test where it is');
  assert.equal(rule(claude.slice(claude.indexOf('const viewNow'))), card, 'the wizard reads chatView not as the card does');
  assert.match(claude, /class="\$\{viewNow\(\) === v \? 'on' : ''\}" data-view=/, 'the wizard marks the choice that is not set');
  assert.match(claude, /forEach\(\(x\) => x\.classList\.toggle\('on', x === b\)\)/, 'a click does not move the mark to the picked one');
  const lang = onb.slice(onb.indexOf('const stepLang'), onb.indexOf('const items', onb.indexOf('const stepLang')));
  assert.ok(lang.indexOf('class="onb-lang"') >= 0 && lang.indexOf('class="onb-lang"') < lang.indexOf('id="onb-feats"'), 'the language went under the four points');
});
