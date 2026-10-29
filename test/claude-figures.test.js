// block and the line in a card) and the subscription limits (the sidebar footer, which says "no data" for good to
// someone who works in the Claude app). The real functions are taken out of public/js/*.js and run on a fake DOM, as
// in drawer-offline.test.js: the modules pull in DOM neighbours, so node cannot import them.
// Run: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { limitsNone, limitsShown, limitsView } from '../public/js/limits-rules.js';
import { EFFORT_LABELS, EFFORTS, effortOf, launchShown } from '../public/js/launch-rules.js';

const read = (rel) => readFileSync(new URL(`../public/js/${rel}`, import.meta.url), 'utf8');
const files = { settings: read('settings.js'), limits: read('limits.js'), dash: read('dash.js'), sse: read('sse.js'), core: read('core.js') };

/** A top-level function of a module, found by its head, `export` taken off. */
function take(file, head) {
  const src = files[file];
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}.js`);
  return src.slice(at, src.indexOf('\n}\n', at) + 2).replace(/^export /, '');
}
/** A top-level arrow function kept in a const: from its head to the `};` that closes it. */
function takeArrow(file, head) {
  const src = files[file];
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}.js`);
  return src.slice(at, src.indexOf('\n};\n', at) + 3);
}
/** One line of a module, found by its start, `export` taken off. */
function line(file, head) {
  const src = files[file];
  const at = src.indexOf(head);
  assert.ok(at >= 0, `${head} is gone from ${file}.js`);
  return src.slice(at, src.indexOf('\n', at) + 1).replace(/^export /, '');
}

/** The real getSetting/setSetting over a fake localStorage holding `saved` (key → the stored text). */
function settingsStore(saved = {}) {
  const items = new Map(Object.entries(saved).map(([k, v]) => [`kb.set.${k}`, v]));
  const box = { localStore: { getItem: (k) => (items.has(k) ? items.get(k) : null), setItem: (k, v) => items.set(k, String(v)) }, PHONE_DEFAULTS: {}, onPhone: () => false };
  vm.runInNewContext([line('settings', 'const SETTINGS_DEFAULTS = '), take('settings', 'export function getSetting('),
    line('settings', 'export function setSetting(')].join('\n'), box);
  return box;
}

test('both switches are on until switched off, and a stored value that does not read counts as on', () => {
  const fresh = settingsStore();
  assert.equal(fresh.getSetting('showUsage'), true, 'the usage is hidden on a board nobody set up');
  assert.equal(fresh.getSetting('showLimits'), true, 'the limits are hidden on a board nobody set up');
  const off = settingsStore({ showUsage: 'false', showLimits: 'false' });
  assert.equal(off.getSetting('showUsage'), false);
  assert.equal(off.getSetting('showLimits'), false);
  assert.equal(settingsStore({ showUsage: 'not json' }).getSetting('showUsage'), true);
  const round = settingsStore();
  round.setSetting('showLimits', false);
  assert.equal(round.getSetting('showLimits'), false, 'a switch set off does not read back as off');
});

test('Settings → Claude Code has the switches above Starting tasks, each showing its setting and applying at once', async () => {
  const boxes = { showUsage: { checked: null, onchange: null }, showLimits: { checked: null, onchange: null } };
  const body = { innerHTML: '', querySelector: (sel) => boxes[(/^\[data-set="(\w+)"\]$/.exec(sel) || [])[1]] || null };
  const saved = new Map([['showUsage', false]]);
  const seen = { usage: [], limits: [], feed: [], claude: 0 };
  const els = {};
  const box = {
    tr: (s) => s, esc: (s) => String(s), $: (id) => (els[id] ||= { onclick: null }), buildSelect: () => {},
    loadLaunchOptions: async () => ({}), pickedSetting: () => null, launchShown, EFFORT_LABELS, EFFORTS, effortOf,
    getSetting: (k) => (saved.has(k) ? saved.get(k) : undefined),
    setSetting: (k, v) => saved.set(k, v),
    // what the setting says at the moment of the repaint: it has to be written first
    repaintUsage: () => seen.usage.push(saved.get('showUsage')),
    renderLimits: () => seen.limits.push(saved.get('showLimits')),
    repaintWorkTabs: () => {}, repaintColumnViews: () => {},
    loadClaude: async () => { seen.claude++; },
    automations: () => ({ on: false, rules: [] }), applyAutomations: () => {},
  };
  vm.runInNewContext(`${line('settings', 'const CC_MARK = ')}${take('settings', 'async function renderClaudeSection(')}\nthis.run = renderClaudeSection;`, box);
  await box.run(body);
  const html = body.innerHTML;
  for (const set of ['showUsage', 'showLimits']) assert.match(html, new RegExp(`<input type="checkbox" class="set-toggle" data-set="${set}">`), `no switch for ${set}`);
  const group = html.indexOf('Show on the board');
  assert.ok(group > 0 && group < html.indexOf('data-set="showUsage"') && html.indexOf('data-set="showLimits"') < html.indexOf('Starting tasks'),
    'the switches are not in their own group above Starting tasks');
  assert.equal(boxes.showUsage.checked, false, 'a switched-off usage shows as on');
  assert.equal(boxes.showLimits.checked, true, 'limits nobody switched off show as off');
  boxes.showUsage.onchange({ target: { checked: true } });
  assert.deepEqual(seen.usage, [true], 'switching the usage on is not applied, or applied before it is written');
  assert.deepEqual(seen.limits, [], 'the usage switch repaints the limits');
  boxes.showLimits.onchange({ target: { checked: false } });
  assert.deepEqual(seen.limits, [false], 'switching the limits off is not applied, or applied before it is written');
  assert.deepEqual(seen.usage, [true], 'the limits switch repaints the usage');
  assert.equal(seen.claude, 1, 'the section no longer checks Claude Code');
  assert.match(html, /id="sel-chatView"/, 'no choice of how Claude is shown');
  assert.doesNotMatch(html, /data-set="showChat"/);
});

/** The real renderLimits on a fake footer: `el.clicks` — the handlers its "no data" button got, `opened` — the
    sections the click opened in Settings. */
function footer() {
  const clicks = [];
  const el = { innerHTML: 'left as it was', hidden: false, querySelector: (sel) => (sel === '.lim-none' && /class="lim-none/.test(el.innerHTML) ? { addEventListener: (ev, fn) => ev === 'click' && clicks.push(fn) } : null) };
  const opened = [];
  const box = {
    $: (id) => (id === 'limits' ? el : null), tr: (s) => s, esc: (s) => String(s),
    SHORT_MONTHS: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    limitsView, limitsNone, limitsShown, show: false, getSetting: (k) => (k === 'showLimits' ? box.show : undefined),
    openSettingsModal: (sec) => opened.push(sec),
  };
  vm.runInNewContext([line('limits', 'let snap = '), line('limits', 'let link = '), line('limits', 'let seq = '), line('limits', 'const NAMES = '), take('limits', 'function clock('),
    take('limits', 'export function renderLimits('), take('limits', 'export function applyLimits('),
    'this.setSnap = (s) => { snap = s; }; this.setLink = (l) => { link = l; };'].join('\n'), box);
  return { el, box, clicks, opened };
}

test('the limits footer is not drawn while switched off, and comes back with the reading it holds', () => {
  const { el, box } = footer();
  const show = (v) => { box.show = v; };
  show(false);
  const inAnHour = Math.floor(Date.now() / 1000) + 3600;
  box.setSnap({ windows: { five_hour: { used: 42, resets_at: inAnHour } }, at: new Date().toISOString() });
  box.renderLimits();
  assert.equal(el.hidden, true, 'the footer stays on screen while switched off');
  assert.equal(el.innerHTML, 'left as it was', 'a switched-off footer is drawn all the same');
  show(true);
  box.renderLimits();
  assert.equal(el.hidden, false, 'switched on again, the footer stays hidden');
  assert.match(el.innerHTML, /Claude limits[\s\S]*5 hours[\s\S]*42%/, 'switched on again, the footer does not show the reading it holds');
  box.setSnap({ windows: {}, at: null });
  box.setLink('connected');
  box.renderLimits();
  assert.match(el.innerHTML, /title="[^"]*The footer can be switched off in Settings → Claude Code\.">no data</, '"no data" does not say where the footer is switched off');
  show(false);
  box.renderLimits();
  assert.equal(el.hidden, true);
});

// owner did not want "not connected · connect" at all — with the status line not through this board and nothing current
// there is no footer; connected and still nothing, "no data" opens Settings → Claude Code.
test('with nothing current the footer is there only for a board the status line goes through', () => {
  const { el, box, clicks, opened } = footer();
  box.show = true;
  box.setSnap({ windows: {}, at: null });
  for (const link of ['off', 'manual', 'other', null]) {
    box.setLink(link);
    el.hidden = false;
    box.renderLimits();
    assert.equal(el.hidden, true, `link ${link}: a footer of limits that do not come is drawn`);
  }
  box.setLink('connected');
  box.renderLimits();
  assert.equal(el.hidden, false);
  assert.match(el.innerHTML, /<button type="button" class="lim-none" title="[^"]*">no data<\/button>/);
  assert.equal(clicks.length, 1, 'the footer is not clickable');
  clicks[0]();
  assert.equal(opened.at(-1), 'claude', 'the click does not open Settings → Claude Code');
  // a reading still shows under any link: it is the figure of now
  const inAnHour = Math.floor(Date.now() / 1000) + 3600;
  box.setLink('off');
  box.setSnap({ windows: { five_hour: { used: 7, resets_at: inAnHour } }, at: new Date().toISOString() });
  box.renderLimits();
  assert.equal(el.hidden, false, 'a current reading is hidden');
  assert.match(el.innerHTML, /7%/);
  assert.deepEqual([limitsShown([], 'connected'), limitsShown([], 'off'), limitsShown([{}], 'off'), limitsShown([], null)], [true, false, true, false]);
  // the event of connecting carries `link` (any tab); the event of a reading does not, and the last one stays
  box.applyLimits({ windows: {}, at: null, link: 'off' });
  assert.equal(el.hidden, true);
  box.applyLimits({ windows: {}, at: null, link: 'connected' });
  assert.equal(el.hidden, false, 'connecting in another tab is not seen');
  box.applyLimits({ windows: {}, at: null });
  assert.match(el.innerHTML, />no data</, 'an event without `link` forgot the one held');
});

test('the dashboard draws the usage block only while the usage is switched on', async () => {
  const dash = { innerHTML: '', querySelectorAll: () => [] };
  let show = true;
  const d = {
    summary: { done_period: 1, active: 1, cycle_hours_period: null, work_seconds_period: 0 }, done_per_day: [], range: 'week',
    queue: { todo_ready: 3, backlog: 1 }, fun: { peak_hour: null, done_total: 1 }, waiting: [], usage: { total: 5 },
    heat_days: [], range_since: '2026-10-01', heat_time: [], top_projects: [], recent: [],
  };
  const none = () => '';
  const box = {
    $: (id) => (id === 'dashboard' ? dash : { onclick: null }), state: { projects: [{ slug: 'p' }], dashRange: 'week' },
    api: async () => d, tr: (s) => s, esc: (s) => String(s), ic: none, fmtNum: String, LANG: 'en', ALL: '#all',
    RANGE_LABEL: { week: 'this week' }, RANGE_BTN: [['week', 'Week']], HEAT_LEGEND: '', plural: (n, one) => one,
    statCard: none, streaks: () => [0, 0], fmtWork: none, calendarHTML: none, timeHeatHTML: none, topProjHTML: none,
    doneBarsHTML: none, feedHTML: none, waitingHTML: none, setWaitFolded: none,
    dashPanel: (title, body) => `<section data-title="${title}">${body}</section>`,
    usagePanel: () => 'USAGE-BLOCK', usageFmt: {}, getSetting: (k) => (k === 'showUsage' ? show : undefined),
    openDrawer: none, openStatusPicker: none, selectProject: none, refresh: async () => {},
    ymdLocal: () => '2026-10-26',
  };
  vm.runInNewContext(`let seq = 0;\nlet drawnDay = '';\n${take('dash', 'export async function renderDashboard(')}\nthis.run = renderDashboard;`, box);
  await box.run();
  assert.match(dash.innerHTML, /data-title="Claude usage">USAGE-BLOCK/, 'the dashboard lost the usage block');
  show = false;
  await box.run();
  assert.doesNotMatch(dash.innerHTML, /Claude usage|USAGE-BLOCK/, 'a switched-off usage is still on the dashboard');
  assert.match(dash.innerHTML, /data-title="Waiting for you"/, 'the rest of the dashboard went with the block');
});

test('a card shows no usage line and asks for none while switched off; switched on, the line comes back at once', () => {
  let show = false;
  const flights = [];
  const loads = [];
  const removed = [];
  const box = {
    getSetting: (k) => (k === 'showUsage' ? show : undefined),
    usageLine: (u) => (u ? { text: 'Usage · 3k tokens', title: 'notes' } : null), usageFmt: {}, esc: (s) => String(s),
    state: { slug: '#dash', drawerKey: 'CK-1' }, DASH: '#dash',
    repaintClaudeInfo: () => removed.push('menu'),
    menuOpen: () => true, // …and is fetched only while that menu is open
    loadTasks: async () => { loads.push(1); },
    usageFlight: (key) => { flights.push(key); },
    usageAt: 0, usageTimer: null, USAGE_EVERY_MS: 10_000,
  };
  vm.runInNewContext([takeArrow('sse', 'const usageHTML = '), take('sse', 'export function refreshUsage('), take('sse', 'export function repaintUsage('),
    'this.usageHTML = usageHTML;'].join('\n'), box);
  assert.equal(box.usageHTML({ total: 3000 }), '', 'a switched-off usage line is drawn in the card');
  box.refreshUsage('CK-1');
  assert.deepEqual(flights, [], 'a switched-off usage line is still fetched while Claude works');
  assert.equal(box.usageTimer, null, 'a switched-off usage line is still fetched a little later');
  box.repaintUsage();
  assert.equal(removed.length, 1, 'switched off, the open card keeps its usage line');
  assert.equal(loads.length, 1, 'switched off, the dashboard behind the settings keeps the block');
  assert.deepEqual(flights, [], 'switched off, the line is fetched all the same');
  show = true;
  assert.match(box.usageHTML({ total: 3000 }), /^<div class="dm-info dm-usage" title="notes">Usage · 3k tokens<\/div>$/, 'the card lost its usage line');
  box.repaintUsage();
  assert.deepEqual(flights, ['CK-1'], 'switched on, the open card does not get its line back');
  assert.equal(loads.length, 2, 'switched on, the dashboard behind the settings does not get the block back');
  assert.equal(removed.length, 1);
  box.state.slug = 'proj';
  box.state.drawerKey = null;
  box.repaintUsage();
  assert.equal(loads.length, 2, 'a board that is not the dashboard is loaded again');
  assert.deepEqual(flights, ['CK-1'], 'a line is fetched with no card open');
  box.refreshUsage('CK-2');
  assert.deepEqual(flights, ['CK-1', 'CK-2'], 'switched on, the line is no longer refreshed while Claude works');
});

test('every word of the footer and of the two switches has its Russian', () => {
  const core = files.core;
  const dict = core.slice(core.indexOf('const I18N_RU = {'), core.indexOf('export function tr('));
  assert.ok(dict.length > 1000, 'the dictionary was not found in core.js');
  const words = (src) => [...src.matchAll(/\btr\('((?:[^'\\]|\\.)*)'\)/g)].map((m) => m[1].replace(/\\'/g, "'"));
  const section = take('settings', 'async function renderClaudeSection(');
  const switches = words(section.slice(section.indexOf("tr('Show on the board')"), section.indexOf("tr('Starting tasks')")));
  assert.ok(switches.length >= 5, `the words of the switches were not found: ${switches.length}`);
  const footer = words(files.limits);
  assert.ok(footer.includes('The footer can be switched off in Settings → Claude Code.'), 'the footer does not say where it is switched off');
  const has = (s) => dict.includes(`'${s}': `) || dict.includes(`'${s}':\n`) || new RegExp(`\\n\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: '`).test(dict);
  const none = Object.values(limitsNone());
  assert.deepEqual([...new Set([...switches, ...footer, ...none])].filter((s) => !has(s)), [], 'stays English on the Russian board');
});
