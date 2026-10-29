import { $, LANG, api, esc, ic, liftCurtain, smoothReload, state, tr } from './core.js';
import { setupView } from './claude-setup-rules.js';
import { launchPick } from './launch-rules.js';
import { renderLimits } from './limits.js';
import { CONTACT_NAME, CONTACT_URL, FEATURES, STEP_HEADS, VIEW_CHOICES, accessLines, launchChoices, onboardingSteps, scanLines } from './onboarding-rules.js';
import { sceneAccept, sceneAccess, sceneDemo, sceneNow, sceneScan, sceneSync, sceneTake, sceneView, sceneWatch, sceneWay } from './onboarding-scenes.js';
import { appInstallView, appStepsHTML, applyCompact, getSetting, notifyPerm, notifyTestState, pickedSetting, promptInstall, sendTestNotification, setClaudeView, setSetting, syncLangToServer } from './settings.js';
import { manualSetupHTML, selectProject, setupPromptBlockHTML, wireSetupPrompt } from './sidebar.js';
import { loadLaunchOptions, refresh, repaintUsage, todoPromptText } from './sse.js';
import { typeset } from './typeset.js';
import { refusalLine } from './unsaved.js';
import { sessionStore } from './store.js';

// each language by its own name — the only non-English word of the module, kept in one place
const LANG_NAMES = { ru: 'Русский', en: 'English' };

// the step to open on after the reload a change of language needs (LANG is a const of the page)
const RESUME_KEY = 'kb.session.onbStep';
// the welcome shows its three points in turn until the person points at one
const FEATURE_EVERY_MS = 6000;
const FEATURE_SCENE = { take: sceneTake, watch: () => sceneWatch({ view: 'chat' }), now: sceneNow, accept: sceneAccept };
// the prompt ▶ hands over in the pictures of step Claude — the words of 📋 on To do, for the example project
const examplePrompt = () => todoPromptText([{ key: 'MA-3' }], 'my-app');
const calm = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// the timer of the wizard on screen: opening it again stops the old one before its overlay goes
let stopShown = null;

export async function maybeOnboarding() {
  try {
    const st = await api('GET', '/api/onboarding');
    // language, comes back too — and takes its step mark with it: left behind, it opened the next wizard on step two
    if (st.done && !wizardResumes()) { liftCurtain(); return; }
    openOnboarding({ updated: st.seen > 0 || state.projects.length > 0 });
  } catch {
    // an older server or no connection — no wizard, unless it is coming back from its own reload
    if (wizardResumes()) openOnboarding(); else liftCurtain();
  }
}

/** `updated` — the board was in use before: the welcome says its data stays, and the demo is not offered. */
export function openOnboarding({ updated = state.projects.length > 0 } = {}) {
  stopShown?.();
  document.getElementById('onboarding')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'onboarding';
  overlay.innerHTML = `<div class="onb" role="dialog" aria-modal="true" aria-labelledby="onb-title">
    <section class="onb-side">
      <div class="onb-brand"><img src="/favicon.svg" alt="" width="22" height="22"><span>local-kanban</span></div>
      <div class="onb-main">
        <div class="onb-eyebrow"></div>
        <h1 class="onb-title" id="onb-title"></h1>
        <div class="onb-lead"></div>
        <div class="onb-body"></div>
        <div class="modal-err hidden"></div>
      </div>
      <div class="onb-actions"></div>
    </section>
    <section class="onb-stage" aria-hidden="true"><div class="onb-scene"></div></section>
    <div class="onb-top"><div class="onb-steps"></div><div class="onb-count"></div></div>
  </div>`;
  document.body.appendChild(overlay);
  const box = overlay.querySelector('.onb');
  const eyebrow = overlay.querySelector('.onb-eyebrow');
  const title = overlay.querySelector('.onb-title');
  const lead = overlay.querySelector('.onb-lead');
  const body = overlay.querySelector('.onb-body');
  const main = overlay.querySelector('.onb-main');
  const actions = overlay.querySelector('.onb-actions');
  const stage = overlay.querySelector('.onb-scene');
  const stepsEl = overlay.querySelector('.onb-steps');
  const countEl = overlay.querySelector('.onb-count');
  const errEl = overlay.querySelector('.modal-err');
  const err = (msg) => { errEl.textContent = msg || ''; errEl.classList.toggle('hidden', !msg); };
  const STEPS = onboardingSteps(state.projects.length > 0);
  let demoCreated = false;
  let timer = null; // the welcome's turn of its points; any step change stops it
  const stopTimer = () => { clearInterval(timer); timer = null; };
  stopShown = stopTimer;
  // each visit of a step has its number: an answer that comes after the person left — even to come back — draws nothing
  let visit = 0;
  const finish = () => {
    stopTimer();
    api('POST', '/api/onboarding', { done: true }).catch(() => {});
    overlay.remove();
    refresh().then(() => { if (demoCreated) selectProject('demo'); });
  };
  const STEP = { lang: () => stepLang(), access: () => stepAccess(), claude: () => stepClaude(), view: () => stepView(), sync: () => stepSync(), demo: () => stepDemo(), done: () => stepDone() };
  const go = (to) => (STEP[to] || STEP.done)();
  const next = (from) => go(STEPS[STEPS.indexOf(from) + 1]);
  const pad = (n) => String(n).padStart(2, '0');
  // the bottom row: a step back on the left (not on the first step), the way on — and what else the step offers — on the right
  const nav = (id, nextLabel = 'Next', extra = '') => {
    const i = STEPS.indexOf(id);
    actions.innerHTML = (i > 0 ? `<button class="btn-ghost onb-back" id="onb-back">← ${tr('Back')}</button>` : '<span></span>')
      + `<div class="onb-go">${extra}<button class="btn-primary onb-next" id="onb-next">${tr(nextLabel)} <span class="onb-arrow">→</span></button></div>`;
    if (i > 0) $('onb-back').onclick = () => go(STEPS[i - 1]);
    return $('onb-next');
  };
  const begin = (id, { wide = false } = {}) => {
    stopTimer();
    visit += 1;
    const head = STEP_HEADS[id];
    const i = STEPS.indexOf(id);
    stepsEl.innerHTML = STEPS.map((x) => `<span class="onb-dot${x === id ? ' on' : ''}"></span>`).join('');
    countEl.innerHTML = `<b>${pad(i + 1)}</b> / ${pad(STEPS.length)}`;
    box.classList.toggle('onb-wide', wide);
    box.dataset.step = id;
    err('');
    eyebrow.textContent = tr(head.eyebrow);
    title.innerHTML = esc(typeset(tr(head.title))) + (head.title2 ? `<span class="onb-title-2">${esc(typeset(tr(head.title2)))}</span>` : '');
    lead.textContent = head.lead ? typeset(tr(head.lead)) : '';
    lead.classList.toggle('hidden', !head.lead);
    body.innerHTML = '';
    stage.innerHTML = '';
    main.scrollTop = 0;
  };

  const stepLang = () => {
    begin('lang');
    if (updated) lead.textContent += ` ${typeset(tr('The board was updated: choose again how to work with it — your projects, tasks and settings stay.'))}`;
    body.innerHTML = `<div class="onb-lang"><span class="muted">${tr('Language')}</span><div class="onb-seg">
        <button type="button" class="${LANG === 'ru' ? 'on' : ''}" data-lang="ru">${LANG_NAMES.ru}</button>
        <button type="button" class="${LANG === 'en' ? 'on' : ''}" data-lang="en">${LANG_NAMES.en}</button>
      </div></div>`
      + `<div class="onb-list" id="onb-feats">${FEATURES.map((f, i) => `<button type="button" class="onb-item" data-i="${i}">`
      + `<span class="onb-ic">${ic(f.icon, 15)}</span><span class="onb-item-t"><b>${esc(tr(f.title))}</b><small>${esc(typeset(tr(f.note)))}</small></span>`
      + `<span class="onb-chev">${ic('chevron', 12)}</span></button>`).join('')}</div>`
      + `<div class="muted onb-contact">${tr('Questions about anything — write to me on Telegram:')} <a href="${CONTACT_URL}" target="_blank" rel="noopener noreferrer">${CONTACT_NAME}</a></div>`;
    const items = [...body.querySelectorAll('.onb-item')];
    let shown = -1;
    const show = (i) => {
      if (i === shown) return;
      shown = i;
      items.forEach((b, k) => b.classList.toggle('on', k === i));
      stage.innerHTML = FEATURE_SCENE[FEATURES[i].id]();
    };
    // while the mouse went to Next. A click keeps it: the turn stops for good on this visit of the step
    items.forEach((b, i) => { b.onclick = () => { stopTimer(); show(i); }; b.onfocus = b.onclick; });
    show(0);
    if (!calm()) timer = setInterval(() => show((shown + 1) % items.length), FEATURE_EVERY_MS);
    const pickLang = async (lang) => {
      setSetting('lang', lang);
      const sent = syncLangToServer(lang);
      // page fades out while the language goes to the server, and fades in with the wizard already open
      if (lang !== LANG) {
        try { sessionStore.setItem(RESUME_KEY, STEPS[1]); } catch { /* no storage — it starts from the welcome again */ }
        smoothReload(sent);
        return;
      }
      await sent;
      next('lang');
    };
    body.querySelectorAll('[data-lang]').forEach((b) => { b.onclick = () => pickLang(b.dataset.lang); });
    nav('lang').onclick = () => pickLang(LANG);
  };

  const stepAccess = () => {
    begin('access');
    const v = visit;
    let macos = null; // GET /api/claude `macos`, and its row of Settings → Claude Code
    let macRow = null;
    let unchecked = false; // GET /api/claude failed: what was known stays, and nothing known is said so
    let installed = false; // installed from this tab: the tab itself stays a tab
    let drawn = false;
    let howOpen = false;
    body.innerHTML = '<div class="onb-list onb-perms" id="onb-perms"></div>'
      + `<div class="muted onb-later">${esc(typeset(tr('All of it is in Settings too: General, As an app and Claude Code.')))}</div>`;
    nav('access').onclick = () => next('access');
    const btn = (id, label, main = false) => `<button type="button" class="${main ? 'btn-primary' : 'btn-ghost'}" data-do="${id}">${esc(tr(label))}</button>`;
    const mark = { ok: ic('check', 11), no: '–', warn: '!' };
    const row = (l, icon, title, note, tools = '', more = '') => `<div class="onb-perm" data-id="${l.id}">`
      + `<span class="onb-ic">${ic(icon, 15)}</span><span class="onb-item-t"><b>${esc(tr(title))}</b><small id="onb-perm-${l.id}">${note}</small>`
      + `${more}${tools ? `<span class="onb-perm-do">${tools}</span>` : ''}</span>`
      + `<span class="onb-mark onb-mark-${l.mark}" title="${esc(tr(l.text))}">${mark[l.mark]}</span></div>`;
    const paint = () => {
      if (v !== visit || !$('onb-perms')) return;
      const perm = notifyPerm();
      const on = Boolean(getSetting('notifyReview'));
      const app = appInstallView(installed);
      const lines = accessLines({ perm, on, macos, app, unchecked });
      const line = (id) => lines.find((l) => l.id === id);
      // the words of Settings, but "the switch above" is a button here
      const notifyNote = perm === 'granted' && !on ? tr('allowed by the browser, but off on the board') : notifyTestState(perm, on);
      let html = row(line('notify'), 'bell', 'System notifications', esc(notifyNote),
        (perm === 'default' ? btn('allow', 'Allow notifications', true) : '')
        + (perm === 'denied' ? btn('notify-check', 'Check again') : '') // allowed in the site settings, then here
        + (perm === 'granted' && !on ? btn('on', 'Turn on', true) : '')
        + (perm === 'granted' && on ? btn('test', 'Send a test') : ''));
      if (line('macos') && !macos) {
        html += row(line('macos'), 'lock', 'This computer', esc(tr('the board did not answer — check again')), btn('mac-check', 'Check again')); // a Mac or not is unknown
      } else if (line('macos')) {
        const fix = macRow?.fix;
        html += row(line('macos'), 'lock', 'macOS access', esc(typeset(tr(macRow?.note || ''))),
          (fix?.href ? `<a class="btn-ghost" href="${esc(fix.href)}">${esc(tr(fix.label))}</a>` : '') + (macos.full_disk ? '' : btn('mac-check', 'Check again')),
          (macRow?.value ? `<code class="onb-path">${esc(macRow.value)}</code>` : '') + (fix?.text ? `<small>${esc(typeset(tr(fix.text)))}</small>` : '')
          + (unchecked ? `<small class="onb-warn">${esc(typeset(tr('The board did not answer the check — this is what the one before showed.')))}</small>` : ''));
      }
      html += row(line('app'), 'download', 'As an app', esc(typeset(tr(app.installed
        ? 'the board is open as an app right now — its icon is in the Dock, the taskbar or on the home screen'
        : 'the board opens in a window without tabs and an address bar, with its own icon in the Dock, the taskbar or on the home screen'))),
        app.installed ? '' : (app.prompt ? btn('install', 'Install', true) : '')
          + (app.here && !app.prompt ? `<button type="button" class="btn-ghost" data-do="how" aria-expanded="${howOpen}" aria-controls="onb-how">${esc(tr(howOpen ? 'Hide the steps' : 'How to install'))}</button>` : '')
          + btn('app-check', 'Check again'),
        app.installed ? '' : (app.insecure ? `<small class="onb-warn">${esc(typeset(tr('Chrome and Edge make an app only of a page opened at 127.0.0.1 or localhost, or over https — this one is not, so the menu item stays grey. Open the board at 127.0.0.1 on the computer it runs on.')))}</small>` : '')
          + (app.here && !app.prompt ? `<div id="onb-how"${howOpen ? '' : ' class="hidden"'}><small>${esc(tr('In this browser'))} — ${esc(tr(app.here.name))}</small>${appStepsHTML(app.here)}</div>` : ''));
      $('onb-perms').innerHTML = html;
      stage.innerHTML = sceneAccess(lines, { still: drawn });
      drawn = true;
      const act = {
        allow: async () => { if ((await Notification.requestPermission()) === 'granted') setSetting('notifyReview', true); paint(); },
        on: () => { setSetting('notifyReview', true); paint(); },
        'notify-check': () => paint(),
        test: () => sendTestNotification($('onb-perm-notify')),
        'mac-check': () => look(),
        install: async () => { installed = await promptInstall(); paint(); },
        'app-check': () => paint(),
        how: (b) => {
          howOpen = !howOpen;
          $('onb-how')?.classList.toggle('hidden', !howOpen);
          b.textContent = tr(howOpen ? 'Hide the steps' : 'How to install');
          b.setAttribute('aria-expanded', String(howOpen));
          if (howOpen) b.scrollIntoView({ block: 'nearest' }); // the steps open above it: the button pressed stays in sight
        },
      };
      $('onb-perms').querySelectorAll('[data-do]').forEach((b) => { b.onclick = () => act[b.dataset.do]?.(b); });
    };
    // GET /api/claude reads settings.json and looks for programs: the browser's lines do not wait for it
    const look = () => api('GET', '/api/claude', undefined, { quiet: true }).catch(() => null).then((setup) => {
      if (v !== visit) return;
      unchecked = !setup;
      if (!setup) { paint(); return; } // a failed check again keeps the row it had
      macos = setup.macos || null;
      macRow = setup ? setupView(setup).flatMap((s) => s.rows).find((r) => r.id === 'macos') || null : null;
      paint();
    });
    const onInstalled = () => { installed = true; paint(); };
    window.addEventListener('appinstalled', onInstalled, { once: true });
    paint();
    look();
  };

  const stepClaude = async () => {
    begin('claude');
    const v = visit;
    const viewNow = () => (getSetting('chatView') === 'chat' ? 'chat' : 'terminal');
    const seg = (v, label) => `<button type="button" class="${viewNow() === v ? 'on' : ''}" data-view="${v}">${esc(tr(label))}</button>`;
    body.innerHTML = '<div class="onb-list" id="onb-launch"></div>'
      + `<div class="onb-lang onb-view-pick"><span class="onb-view-l"><span>${esc(tr('Show Claude as'))}</span>`
      + `<small>${esc(typeset(tr('in a card and in Claude now → Terminals; a Claude started outside the board is always a chat')))}</small></span>`
      + `<div class="onb-seg" id="onb-view">${seg('chat', 'Chat')}${seg('terminal', 'Terminal')}</div></div>`
      + `<div class="muted onb-later">${esc(typeset(tr('Permissions and how hard Claude thinks — in Settings → Claude Code.')))}</div>`;
    nav('claude').onclick = () => next('claude');
    // passes over). Its tabs are for the mouse (the half is hidden from screen readers): a way focused from the keyboard
    // shows its picture by itself
    let tab = 'scan';
    let lines = null;
    let avail = {};
    let pointed = null;
    const paint = () => {
      if (v !== visit) return;
      const way = launchChoices(avail).find((c) => c.value === (pointed || launchPick(pickedSetting('launch'), avail)));
      stage.innerHTML = `<div class="onb-tabs onb-stage-tabs"><button type="button" tabindex="-1" data-tab="scan" class="${tab === 'scan' ? 'on' : ''}">${ic('search', 12)} ${esc(tr('This computer'))}</button>`
        + (way ? `<button type="button" tabindex="-1" data-tab="way" class="${tab === 'way' ? 'on' : ''}">${ic('play', 11)} ${esc(tr(way.title))}</button>` : '') + '</div>'
        + (tab === 'way' && way ? sceneWay(way.value, examplePrompt(), tr(way.off || way.note), viewNow()) : sceneScan(lines));
      stage.querySelectorAll('[data-tab]').forEach((b) => { b.onclick = () => { tab = b.dataset.tab; paint(); }; });
    };
    paint();
    // the choice is written at once, as in Settings, and the picture shows the board's Claude the way picked
    body.querySelectorAll('[data-view]').forEach((b) => {
      b.onclick = () => {
        setClaudeView(b.dataset.view);
        body.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
        pointed = 'board';
        tab = 'way';
        paint();
      };
    });
    // the check of this computer is slower (it reads settings.json, looks for programs): the ways do not wait for it
    api('GET', '/api/claude', undefined, { quiet: true }).catch(() => null).then((setup) => {
      if (v !== visit) return;
      lines = setup ? scanLines(setupView(setup).flatMap((s) => s.rows), tr) : [];
      if (tab === 'scan') paint();
    });
    avail = (await loadLaunchOptions()) || {};
    const list = $('onb-launch');
    if (!list || v !== visit) return; // the step was left while the answer came
    const draw = () => {
      const now = launchPick(pickedSetting('launch'), avail);
      list.innerHTML = launchChoices(avail).map((c) => `<button type="button" class="onb-item onb-way${c.value === now ? ' on' : ''}" data-launch="${c.value}"${c.off ? ' disabled' : ''}>`
        + `<span class="onb-radio"></span><span class="onb-item-t"><b>${esc(tr(c.title))}</b><small>${esc(typeset(tr(c.off || c.note)))}</small></span></button>`).join('');
      list.querySelectorAll('[data-launch]').forEach((b) => {
        const look = () => { pointed = b.dataset.launch; tab = 'way'; paint(); };
        b.onclick = () => {
          setSetting('launch', b.dataset.launch);
          const now = launchPick(pickedSetting('launch'), avail);
          list.querySelectorAll('[data-launch]').forEach((x) => x.classList.toggle('on', x.dataset.launch === now));
          look();
        };
        b.onfocus = look;
      });
    };
    draw();
    paint();
  };

  const stepView = () => {
    begin('view');
    body.innerHTML = `<div class="onb-list">${VIEW_CHOICES.map((c) => `<label class="onb-item onb-switch"><span class="onb-item-t"><b>${esc(tr(c.title))}</b><small>${esc(typeset(tr(c.note)))}</small></span>`
      + `<input type="checkbox" class="set-toggle" data-set="${c.key}"${getSetting(c.key) ? ' checked' : ''}></label>`).join('')}</div>`;
    const values = () => Object.fromEntries(VIEW_CHOICES.map((c) => [c.key, Boolean(getSetting(c.key))]));
    stage.innerHTML = sceneView(values());
    // each applies at once, as in Settings: what is behind the wizard follows the switch, and so does the picture
    const after = { showUsage: repaintUsage, showLimits: renderLimits, compactCards: applyCompact };
    body.querySelectorAll('[data-set]').forEach((sw) => {
      sw.onchange = () => { setSetting(sw.dataset.set, sw.checked); after[sw.dataset.set]?.(); stage.innerHTML = sceneView(values(), sw.dataset.set); };
    });
    nav('view').onclick = () => next('view');
  };

  const stepSync = async () => {
    begin('sync');
    const v = visit;
    body.innerHTML = `<div class="onb-fields"><input type="text" id="onb-owner" placeholder="${tr('owner (GitHub user)')}"><input type="text" id="onb-repo" placeholder="${tr('owner/repo for issues')}"></div>
      <div class="muted onb-later" id="onb-gh-state"></div>`;
    stage.innerHTML = sceneSync(null);
    const i = STEPS.indexOf('sync');
    actions.innerHTML = `<button class="btn-ghost onb-back" id="onb-back">← ${tr('Back')}</button>`
      + `<div class="onb-go"><button class="btn-ghost" id="onb-sync-skip">${tr('Skip — work locally')}</button>`
      + `<button class="btn-primary onb-next" id="onb-sync-on">${tr('Enable sync')}</button></div>`;
    $('onb-back').onclick = () => go(STEPS[i - 1]);
    $('onb-sync-skip').onclick = () => next('sync');
    let was = null; // the sync set before: kept as it is unless the person changes it
    $('onb-sync-on').onclick = async () => {
      const owner = $('onb-owner').value.trim();
      const repo = $('onb-repo').value.trim();
      if (was?.configured && (was.source === 'env' || (owner === (was.owner || '') && repo === (was.repo || '')))) { next('sync'); return; }
      try {
        await api('POST', '/api/sync/config', { owner, repo });
        next('sync');
      } catch (e) { err(refusalLine('Sync is not on', e, tr)); }
    };
    try { was = await api('GET', '/api/sync', undefined, { quiet: true }); } catch { return; }
    const el = $('onb-gh-state');
    if (!el || v !== visit) return; // the step was left meanwhile
    el.textContent = was.gh === false ? tr('gh CLI missing or not authenticated — you can enable sync later') : was.gh ? tr('gh CLI found and authenticated ✓') : '';
    if (!was.configured) return;
    $('onb-owner').value = was.owner || '';
    $('onb-repo').value = was.repo || '';
    if (was.source === 'env') { $('onb-owner').disabled = true; $('onb-repo').disabled = true; }
    el.textContent = `${tr('Sync is already on')}: ${was.repo || ''} ✓`;
    stage.innerHTML = sceneSync(was.repo);
    $('onb-sync-on').textContent = tr('Keep it');
    $('onb-sync-skip').remove();
  };

  const stepDemo = () => {
    begin('demo');
    stage.innerHTML = sceneDemo();
    const btn = nav('demo', 'Create demo', `<button class="btn-ghost" id="onb-demo-no">${tr('Skip')}</button>`);
    $('onb-demo-no').onclick = () => next('demo');
    btn.onclick = async () => {
      try { await api('POST', '/api/projects/demo', { lang: LANG }, { quiet: true }); } catch { /* it is there already */ }
      demoCreated = true;
      next('demo');
    };
  };

  // more work instead of "done"; they are folded beside it for whoever wants Claude to set up the projects
  const stepDone = async () => {
    begin('done', { wide: true });
    const v = visit;
    nav('done', 'Start working').onclick = finish;
    let packaged = false;
    let sync = null;
    const [about, sy, avail] = await Promise.all([
      api('GET', '/api/about', null, { quiet: true }).catch(() => null),
      api('GET', '/api/sync', undefined, { quiet: true }).catch(() => null),
      loadLaunchOptions(),
    ]);
    packaged = Boolean(about?.packaged);
    sync = sy;
    if (!$('onboarding') || v !== visit) return; // closed or left while the answers came
    const way = launchChoices(avail).find((c) => c.value === launchPick(pickedSetting('launch'), avail));
    const shown = VIEW_CHOICES.filter((c) => c.key !== 'compactCards' && getSetting(c.key)).map((c) => tr(c.title));
    const rows = [
      [tr('Language'), LANG_NAMES[LANG] || LANG_NAMES.en],
      [tr('▶ starts Claude'), way ? tr(way.title) : '—'],
      [tr('Show Claude as'), tr(getSetting('chatView') === 'chat' ? 'Chat' : 'Terminal')],
      [tr('On the board'), shown.length ? shown.join(', ') : tr('nothing extra')],
      [tr('GitHub sync'), sync?.configured ? (sync.repo || tr('switched on')) : tr('off — the board works locally')],
      ...(demoCreated ? [[tr('Demo project'), tr('created — it opens now')]] : []),
    ];
    body.innerHTML = '<div class="onb-panels">'
      + `<div class="onb-panel"><div class="onb-panel-h">${tr('Your board')}</div>`
      + `<div class="onb-sum">${rows.map(([k, v]) => `<div class="onb-sum-row"><span class="muted">${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}</div></div>`
      + `<div class="onb-panel"><div class="onb-panel-h">${tr('Projects')}</div>`
      + `<details class="sm-more onb-more"><summary>${tr('Set up projects with Claude')}</summary>`
      + `<div class="muted">${esc(typeset(tr('Claude can finish the setup for you — copy this and paste it into its chat:')))}</div>`
      + setupPromptBlockHTML() + manualSetupHTML(packaged) + '</details>'
      + `<div class="muted onb-contact">${tr('Questions about anything — write to me on Telegram:')} <a href="${CONTACT_URL}" target="_blank" rel="noopener noreferrer">${CONTACT_NAME}</a></div></div>`
      + '</div>';
    wireSetupPrompt(body);
  };

  let resume = null;
  try { resume = sessionStore.getItem(RESUME_KEY); sessionStore.removeItem(RESUME_KEY); } catch { /* no storage */ }
  go(STEPS.includes(resume) ? resume : 'lang');
  liftCurtain();
}

export function wizardResumes() {
  try { return Boolean(sessionStore.getItem(RESUME_KEY)); } catch { return false; }
}
