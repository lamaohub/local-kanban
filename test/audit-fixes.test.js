// here from the page's own source with stand-ins around it; where it is layout, the rule itself is held. Each guard was
// seen red with its fix taken back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const read = (rel) => readFileSync(fileURLToPath(new URL(`../public/${rel}`, import.meta.url)), 'utf8');
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const between = (src, from, to) => {
  const a = src.indexOf(from);
  const b = src.indexOf(to, a + 1);
  assert.ok(a >= 0 && b > a, `${from} … ${to} is not in the source`);
  return src.slice(a, b).replace(/^export /gm, '');
};
const fnBody = (src, head) => {
  const a = src.indexOf(head);
  assert.ok(a >= 0, `${head} is not in the source`);
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
};

test('CK-798: a checklist item typed and left at once goes to its own task — on close and on a switch of card', async () => {
  const drawer = code(read('js/drawer.js'));
  const src = between(drawer, 'function scheduleChecklistSave(', 'async function addChecklistItem(');
  const sent = [];
  const timers = [];
  const ctx = {
    state: { drawerKey: 'DEMO-1' }, drawerChecklist: [{ id: 7, text: '' }], clSaveTimers: {}, clSending: new Set(),
    api: async (method, url, body) => { sent.push([method, url, body.text]); },
    patchChecklistItem: (key, id, body) => ctx.api('PATCH', `/api/tasks/${key}/checklist/${id}`, body),
    seg: (s) => encodeURIComponent(String(s)), refusalText: () => ({}), sayRefused: () => {},
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
  };
  vm.runInNewContext(src, ctx);
  ctx.scheduleChecklistSave(7, 'buy milk');
  ctx.state.drawerKey = 'DEMO-2'; // another card opened before the debounce fired
  ctx.flushChecklistSaves();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, [['PATCH', '/api/tasks/DEMO-1/checklist/7', 'buy milk']], 'the edit went to the other task or was lost');
  assert.deepEqual(Object.keys(ctx.clSaveTimers), [], 'a sent edit stays waiting and goes again');
  // both ways out of a card send what waits
  assert.match(fnBody(drawer, 'export function closeDrawer('), /flushChecklistSaves\(\);[\s\S]*state\.drawerKey = null/, 'closing the card loses a waiting item');
  assert.match(fnBody(drawer, 'export function openDrawer('), /if \(state\.drawerKey !== key\) flushChecklistSaves\(\);/, 'a switch of card sends a waiting item to the new task');
});

test('CK-799: a hotkey being reassigned listens on one row, and only while it is on the screen', () => {
  const settings = code(read('js/settings.js'));
  const src = between(settings, 'let stopRemap = null;', 'const DOW = ');
  const listeners = new Map();
  const saved = [];
  const doc = {
    addEventListener: (type, fn) => listeners.set(`${type}`, [...(listeners.get(type) || []), fn]),
    removeEventListener: (type, fn) => listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)),
  };
  const fire = (type, e) => { for (const fn of [...(listeners.get(type) || [])]) fn({ preventDefault() {}, stopPropagation() {}, ...e }); };
  const row = (act) => {
    const kbd = { textContent: act.toUpperCase() };
    const cls = new Set();
    const r = { dataset: { act }, isConnected: true, querySelector: () => kbd, kbd,
      classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c), contains: (c) => cls.has(c) } };
    r.contains = (t) => t === r || t === kbd;
    return r;
  };
  const ctx = {
    document: doc, tr: (s) => s, setTimeout: () => 0, KEY_ACTIONS: [], comboLabel: (b) => b?.code || '', keyBinding: () => null,
    getSetting: () => ({}), setSetting: (k, v) => saved.push(v),
  };
  vm.runInNewContext(`${src}; this.listen = listenRemap;`, ctx);
  const n = row('newTask');
  const q = row('quickSearch');
  // a click on another row: the first stops listening, one key is one shortcut
  ctx.listen(n);
  ctx.listen(q);
  assert.equal(n.classList.contains('listening'), false, 'two rows listen at once');
  fire('keydown', { key: 'q', code: 'KeyQ' });
  assert.deepEqual(saved.map((km) => Object.keys(km)), [['quickSearch']]);
  assert.equal((listeners.get('keydown') || []).length, 0, 'a listener stays after the key was taken');
  // the row left the screen (another section, Settings closed): the next key is not taken
  ctx.listen(n);
  n.isConnected = false;
  fire('keydown', { key: 'a', code: 'KeyA' });
  assert.equal(saved.length, 1, 'a key typed elsewhere became the shortcut');
  assert.equal((listeners.get('keydown') || []).length, 0);
  n.isConnected = true;
  // a click outside the row
  ctx.listen(n);
  fire('pointerdown', { target: {} });
  assert.equal(n.classList.contains('listening'), false, 'a click outside leaves the row listening');
  assert.equal(n.kbd.textContent, 'NEWTASK', 'the old shortcut is not shown back');
  // leaving the section or closing Settings stops it too
  assert.match(fnBody(settings, 'function closeSettingsModal('), /stopRemap\?\.\(\);/, 'closing Settings leaves the row listening');
  assert.match(fnBody(settings, 'async function renderSection('), /if \(!body\) return;\s*stopRemap\?\.\(\);/, 'another section leaves the row listening');
});

test('CK-802: Esc over the open Section list closes the list first, not the project\'s settings', () => {
  const init = code(read('js/init.js'));
  const project = code(read('js/project.js'));
  assert.match(init, /const POPUP_SELECTOR = '[^']*\.pp-select\.open[^']*';/, 'the open Section list is not a popup for the board\'s keys');
  assert.match(fnBody(project, 'function closeCatList('), /popLayer\('ps-category'\);/);
  assert.match(fnBody(project, 'function buildCatSelect('), /box\.classList\.add\('open'\);\s*pushLayer\('ps-category', closeCatList\);/, 'the list is not a layer of the stack');
});

test('CK-803: the selection frame ends at the visible board — cards past its edge are not taken, the frame is not drawn over the card', () => {
  const board = code(read('js/board.js'));
  const src = fnBody(board, 'function marqueeApply(');
  const rect = (left, top, w, h) => ({ left, top, right: left + w, bottom: top + h, width: w, height: h });
  const card = (id, r) => {
    const cls = new Set();
    return { dataset: { id: String(id) }, getBoundingClientRect: () => r, classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)) }, cls };
  };
  const seen = card(1, rect(650, 250, 200, 80)); // inside the board, under the frame
  const past = card(2, rect(1150, 250, 200, 80)); // stands past the board's right edge (under the open card)
  const ctx = {
    marqueeStart: { x: 600, y: 200 }, marqueeLast: { x: 1300, y: 400 }, marqueeEl: { style: {} }, selectedIds: new Set(),
    $: () => ({ getBoundingClientRect: () => rect(200, 100, 700, 600) }), Math,
    document: { querySelectorAll: () => [seen, past] },
  };
  vm.runInNewContext(`${src}; this.apply = marqueeApply;`, ctx);
  ctx.apply();
  assert.deepEqual([...ctx.selectedIds], [1], 'the frame took a card nobody saw');
  assert.equal(ctx.marqueeEl.style.width, '300px', 'the frame is drawn past the board, over the card');
  assert.equal(ctx.marqueeEl.style.left, '600px');
  // the anchor went over the board's top with the scroll: what is past it is still taken, the frame is drawn from the top
  ctx.marqueeStart = { x: 600, y: 20 };
  ctx.apply();
  assert.equal(ctx.marqueeEl.style.top, '100px', 'the frame is drawn over the board\'s top');
  assert.equal(ctx.marqueeEl.style.height, '300px');
});

test('CK-804: Claude now draws only the answer to its latest request', async () => {
  const now = code(read('js/now.js'));
  const src = between(now, 'let seq = 0;', '\nsetInterval(');
  const answers = [];
  const painted = [];
  const ctx = {
    NOW: 'now', state: { slug: 'now' }, last: null, tr: (s) => s, $: () => ({}),
    api: () => new Promise((resolve) => answers.push(resolve)), paint: (d) => painted.push(d.runs.length),
  };
  vm.runInNewContext(`${src}; this.render = renderNow;`, ctx);
  const first = ctx.render();
  const second = ctx.render();
  answers[1]({ runs: [] }); // the newer answer comes first
  await second;
  answers[0]({ runs: [1, 2, 3] }); // the older one comes late
  await first;
  assert.deepEqual(painted, [0], 'a late answer painted the old picture over the newer one');
  assert.deepEqual(ctx.last.runs, []);
});

test('CK-809: the link lines are clipped below the column heads', () => {
  const board = code(read('js/board.js'));
  const draw = fnBody(board, 'export function drawLinks(');
  assert.match(draw, /const body = board\.querySelector\('\.col-body'\);/);
  assert.match(draw, /<clipPath id="link-clip"><rect x="0" y="\$\{top\}"/, 'the lines run over the column heads again');
  assert.match(draw, /<g clip-path="url\(#link-clip\)">\$\{html\}<\/g>/, 'the lines are not inside the clip');
});

test('CK-811: a start off the board shows no board skeleton and no task search', () => {
  const init = code(read('js/init.js'));
  const css = read('style.css');
  assert.match(init, /document\.documentElement\.classList\.toggle\('boot-view', \[DASH, NOW, REVIEW, DONE, AUTO, HEALTH, CHAOS, SETTINGS, HORIZON, CALENDAR\]\.includes\(state\.slug\)\);/);
  assert.match(css, /html\.booting\.boot-view #boot > \*, html\.booting\.boot-view #toolbar \{ visibility: hidden; \}/, 'the board skeleton flashes before the dashboard again');  // init.js is a module and runs after the first paint: the page's first script makes the same choice before it
  const fallback = readFileSync(fileURLToPath(new URL('../public/boot-fallback.js', import.meta.url)), 'utf8');
  const start = ({ session = null, local = {}, search = '' } = {}) => {
    const cls = new Set();
    const ctx = {
      setTimeout: () => 0, window: { addEventListener() {} }, URLSearchParams, JSON,
      location: { search, origin: 'http://127.0.0.1:3100' },
      sessionStorage: { getItem: (k) => (k === 'kb.session.slug' ? session : null), removeItem() {}, setItem() {} },
      localStorage: { getItem: (k) => (k in local ? local[k] : null) },
      document: { documentElement: { classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) }, style: { setProperty() {} } } },
    };
    vm.runInNewContext(fallback, ctx);
    return cls.has('boot-view') ? 'view' : 'board';
  };
  assert.equal(start(), 'view', 'the default start (the dashboard) shows the board skeleton before the first paint');
  assert.equal(start({ local: { 'kb.set.startScreen': '"chaos"' } }), 'view');
  assert.equal(start({ local: { 'kb.set.startScreen': '"last"', 'kb.ui.project': 'demo' } }), 'board');
  assert.equal(start({ local: { 'kb.set.startScreen': '"last"', 'kb.ui.project': '#settings' } }), 'view');
  assert.equal(start({ session: 'demo' }), 'board', 'a reload of a board loses its skeleton');
  assert.equal(start({ session: '#now' }), 'view');
  assert.equal(start({ session: 'demo', search: '?view=dash' }), 'view');
  assert.equal(start({ search: '?action=new' }), 'board');
  // the sections the choice above tells by their «#»
  const core = code(read('js/core.js'));
  for (const name of ['DASH', 'NOW', 'REVIEW', 'DONE', 'CHAOS', 'SETTINGS', 'HORIZON', 'CALENDAR']) {
    assert.match(core, new RegExp(`export const ${name} = '#`), `${name} is not a «#» slug — the first script takes it for a board`);
  }
});

test('CK-812: a card opened while the one before is leaving comes in over the narrowed gap, not with a jump', () => {
  const drawer = code(read('js/drawer.js'));
  const end = fnBody(drawer, 'function endLeave(');
  assert.match(end, /const gap = l\.kept && l\.place && d && !d\.classList\.contains\('hidden'\) \? l\.width - l\.place\.getBoundingClientRect\(\)\.width : 0;/);
  assert.match(end, /if \(gap > 1 && d\.animate\) d\.animate\(\[\{ marginLeft: `\$\{-gap\}px` \}, \{ marginLeft: '0px' \}\]/, 'the board jumps back by the narrowed width in one frame');
  assert.match(fnBody(drawer, 'function leaveSmoothly('), /const mine = \{ ghost, place, width: r\.width \};/, 'the width the place started from is not kept');
});

test('CK-814: the List/Terminals switch stands at the same place in both views', () => {
  const css = read('style.css');
  assert.match(css, /\.now-view\.now-terms \{ padding: 16px 20px 14px;/, 'the switch moves up when the view changes');
  assert.match(css, /\.now-terms \.now-bar-slot \{ width: 100%; max-width: 860px; margin: 0 auto; \}/, 'the switch runs to the window\'s edge in Terminals');
});

test('CK-815: the walking card of the welcome is tall enough for a title of three lines and its status', () => {
  const css = read('style.css');
  const h = /\.onb-mboard \{ --onb-mh: (\d+)px;/.exec(css);
  assert.ok(h && Number(h[1]) >= 106, 'the walking card is shorter than its Russian title and status');
  assert.match(css, /\.onb-mslot \{ flex: none; height: var\(--onb-mh\); \}/, 'the place in To do and the card differ in height');
  assert.match(css, /\.onb-mover \.onb-mcard \{ height: var\(--onb-mh\); overflow: hidden; \}/);
});

test('CK-789: on a phone the rows of Waiting for you and Recent events give the title a line of its own', () => {
  const css = read('style.css');
  const block = /@media \(max-width: 640px\) \{\s*\.wait-row, \.feed-row \{ flex-wrap: wrap;[\s\S]*?\n\}/.exec(css)?.[0];
  assert.ok(block, 'the rows stay one line on a phone — the title gets 3 letters or none');
  assert.match(block, /\.wait-row::after, \.feed-row::after \{ content: ''; order: 2; flex-basis: 100%;/, 'nothing breaks the row after the title');
  assert.match(block, /\.wr-title, \.fr-title \{[^}]*white-space: normal;[^}]*-webkit-line-clamp: 2;/, 'the title is cut to one line again');
  assert.match(block, /\.wr-proj, \.wr-meta, \.fr-proj, \.fr-arrow, \.fr-time \{ order: 3;/, 'the project and the time stand beside the title again');
});

test('CK-792: on a phone the back gesture closes what stands over the card, then the card — not the page', () => {
  const drawer = code(read('js/drawer.js'));
  const src = between(drawer, 'const CARD_STEP', 'function closeDrawer(');
  const pushed = [];
  let pop = null;
  let layers = 1; // a picture opened over the card
  let closed = 0;
  let narrow = true;
  const history = {
    state: null,
    pushState(st) { pushed.push(st); this.state = st; }, replaceState(st) { this.state = st; }, back() {},
  };
  const ctx = {
    history, NARROW: '(max-width: 760px)', drawerShown: () => true, watchLayers: () => {}, layersOpen: () => false,
    closeTopLayer: () => (layers ? (layers -= 1, true) : false), closeDrawer: () => { closed += 1; },
    window: { addEventListener: (t, fn) => { if (t === 'popstate') pop = fn; } },
    document: { querySelector: (q) => (q === '.kbsel.open' && listOpen ? {} : null) }, closeOpenSelect: () => { listOpen = false; },
  };
  let listOpen = false;
  ctx.globalThis = { matchMedia: () => ({ matches: narrow, addEventListener() {} }) };
  vm.runInNewContext(`${src}; this.wire = wireCardBack; this.hold = holdBack;`, ctx);
  ctx.wire();
  assert.equal(typeof pop, 'function', 'back is not listened to');
  ctx.hold(); // the card opened
  assert.equal(pushed.length, 1, 'an open card leaves no step in the history — back leaves the page');
  history.state = null; pop(); // back: the picture over the card goes first, the step comes back
  assert.deepEqual([closed, pushed.length], [0, 2]);
  listOpen = true; history.state = null; pop();
  assert.deepEqual([listOpen, closed, pushed.length], [false, 0, 3], 'back with the list open closed the whole card');
  history.state = null; pop(); // back again: the card
  assert.equal(closed, 1, 'back does not close the card');
  narrow = false; history.state = null;
  ctx.hold();
  assert.equal(pushed.length, 3, 'a wide window gets steps in its history for a card');
  assert.match(code(read('js/init.js')), /\nwireCardBack\(\);/, 'the back gesture is not wired at the start');
  assert.match(fnBody(drawer, 'export function openDrawer('), /holdBack\(\);/, 'opening a card leaves no step in the history');
});

test('CK-796: the clip takes pictures only, for the task it was pressed on', () => {
  const drawer = code(read('js/drawer.js'));
  const src = between(drawer, 'const IMAGE_ACCEPT', 'async function termImage(');
  const alerts = [];
  const taken = [];
  const btn = { setAttribute() {} };
  const file = { files: [], value: 'x', click() {} };
  const form = { querySelector: (q) => (q === '.form-attach' ? btn : q === 'input[type=file]' ? file : null) };
  let open = 'DEMO-1';
  const ctx = { ic: () => '', tr: (s) => s, styledAlert: (m) => alerts.push(m), refusalLine: () => 'refused' };
  vm.runInNewContext(`${src}; this.wire = wirePicturePick;`, ctx);
  ctx.wire(form, (f, key) => taken.push([f.name, key]), { at: () => open });
  btn.onclick();
  open = 'DEMO-2'; // another card opened while the device's picker was up
  file.files = [{ name: 'a.png', type: 'image/png' }, { name: 'notes.txt', type: 'text/plain' }, { name: 'b.heic', type: 'image/heic' }];
  file.onchange();
  assert.deepEqual(taken, [['a.png', 'DEMO-1']], 'a file that is not a picture went on, or the picture went to the other card');
  assert.equal(alerts.length, 1, 'a refused file is refused silently');
  assert.equal(file.value, '', 'the same picture picked again is not a change');
});

test('CK-806: a late refusal of the skills list does not write into a section that is gone', () => {
  const load = code(fnBody(read('js/settings.js'), 'async function renderSkillsSection('));
  const wait = load.slice(load.indexOf("await api('GET', '/api/skills')") - 200, load.indexOf('skillsInfo = info'));
  assert.match(wait, /const list = \$\('sk-list'\);/, 'the section looks its list up again after the wait');
  assert.match(wait, /catch \{ if \(list\.isConnected\) list\.textContent = '—'; return; \}/, 'a refusal writes into a list that may be gone');
  assert.match(wait, /if \(!list\.isConnected\) return;/, 'an answer is drawn into a section the person left');
});

test('CK-807: the board of All projects has no «⋯» of a project', () => {
  const top = code(fnBody(read('js/sidebar.js'), 'export function renderTopbar('));
  const hide = top.match(/\$\('project-menu'\)\.classList\.toggle\('hidden', \[([^\]]+)\]\.includes\(state\.slug\)\)/);
  assert.ok(hide, 'renderTopbar no longer hides «⋯» by the slug');
  assert.ok(hide[1].split(',').map((s) => s.trim()).includes('ALL'), '«⋯» stands on All projects again and does nothing');
});

// suite green. The page's own selectProject runs up to its first step with the guard of project.js behind it.
test('CK-816: leaving the project settings with unsaved changes asks, and only Save that saved or Don\'t save go', async () => {
  const sidebar = code(read('js/sidebar.js'));
  const head = fnBody(sidebar, 'export function selectProject(').replace(/^export /, '');
  const prelude = head.slice(0, head.indexOf('  state.slug = slug;')) + '  state.slug = slug; state.projSettings = settings ? slug : null;\n}';
  const project = code(read('js/project.js'));
  const guard = between(project, 'let leaveAsking = false;', 'state.leaveGuard = ') + 'state.leaveGuard = () => !projectSettingsDirty() || askLeaveSettings();';
  let answer; let saves; let asked; let dirty;
  const ctx = {
    state: {}, openSide: () => {}, tr: (s) => s,
    projectSettingsDirty: () => dirty,
    styledConfirm: async (msg, opts) => { asked.push(opts.alt); return answer; },
    saveProjectSettings: async () => saves.shift(),
  };
  vm.runInNewContext(`${prelude}\n${guard}\nthis.selectProject = selectProject;`, ctx);
  const leave = async (to, opts) => { ctx.state.slug = 'demo'; ctx.state.projSettings = 'demo'; await ctx.selectProject(to, opts); return ctx.state.slug; };
  const run = async (d, a, s = []) => { dirty = d; answer = a; saves = s; asked = []; return leave('other'); };
  assert.equal(await run(false), 'other', 'nothing typed — and the page still asks');
  assert.equal(await run(true, false), 'demo', 'Cancel (or Esc on the question) leaves the page and the typing');
  assert.deepEqual(asked, ["Don't save"], 'the question has no «Don\'t save»');
  assert.equal(await run(true, 'alt'), 'other', '«Don\'t save» keeps the person on the page');
  assert.equal(await run(true, true, [true]), 'other', 'a saved «Save» keeps the person on the page');
  assert.equal(await run(true, true, [false]), 'demo', 'a refused save goes on and the typing is lost');
  dirty = true; asked = [];
  ctx.state.slug = 'demo'; ctx.state.projSettings = 'demo';
  await ctx.selectProject('demo', { settings: true });
  assert.deepEqual(asked, [], 'the settings of the same project, opened again, ask to leave them');
  assert.match(fnBody(project, 'async function saveProjectSettings('), /catch \(e\) \{ flashSaved\([^}]*\); return false; \}/, 'a refused save tells the guard it saved');
});
