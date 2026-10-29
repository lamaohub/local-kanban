
import { WORKING, buildSelect, drawLinks } from './board.js';
import { syncGlyphs } from './glyphs.js';
import { $, ALL_STATUSES, HEALTH, LANG, api, apiBlob, esc, fmtNum, ic, seg, smoothReload, state, tr } from './core.js';
import { applyKeepDrawer, repaintWorkTabs } from './drawer.js';
import { checkVersion, hasUnsavedInput, pendingReload } from './init.js';
import { confirmDiscard, loadProjects, popLayer, pushLayer, renderSidebar, selectProject, setupPromptBlockHTML, styledAlert, styledConfirm, styledPrompt, wireSetupPrompt } from './sidebar.js';
import { SHORT_MONTHS, SOUND_LIB, STATUS_LABELS, audioCtx, lastMissedAt, lastSseAt, loadLaunchOptions, missedSounds, pageLoadedAt, playNamedSound, refresh, relTime, repaintUsage, titleOr, updateSoundBadge } from './sse.js';
import { changeLines, folderFrom, hooksButtons, hooksRefusal, setupView } from './claude-setup-rules.js';
import { loadLimits, renderLimits } from './limits.js';
import { EFFORT_LABELS, EFFORTS, effortOf, launchShown } from './launch-rules.js';
import { errorLine, refusalLine, refusalText } from './unsaved.js';
import { openOnboarding } from './onboarding.js';
import { repaintColumnViews } from './now-terms.js';
import { CONTACT_NAME, CONTACT_URL } from './onboarding-rules.js';
import { installView } from './app-install-rules.js';
import { renderShareSection } from './share.js';
import { localStore } from './store.js';
import { applyAutomations, automations } from './automations.js';
import { PHONE_DEFAULTS, onPhone } from './phone-rules.js';

function mdInline(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
export function mdLite(md) {
  const out = [];
  let list = false;
  const closeList = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const block of String(md || '').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean)) {
    const flat = block.split('\n').map((l) => l.trim()).join(' ');
    const head = flat.match(/^#{1,6}\s+(.*)$/);
    if (head) { closeList(); out.push(`<h4>${mdInline(head[1])}</h4>`); continue; }
    if (/^[-*]\s+/.test(block)) {
      if (!list) { out.push('<ul>'); list = true; }
      for (const item of block.split(/\n(?=[-*]\s)/)) {
        out.push(`<li>${mdInline(item.replace(/^[-*]\s+/, '').split('\n').map((l) => l.trim()).join(' '))}</li>`);
      }
      continue;
    }
    closeList();
    out.push(`<p>${mdInline(flat)}</p>`);
  }
  closeList();
  return out.join('');
}

const SETTINGS_DEFAULTS = { sound: true, soundReview: 'ding', soundDone: 'click', startScreen: 'dashboard', dashRange: 'week', theme: 'light', keepDrawer: false, notifyReview: false, compactCards: false, linkLines: true, keymap: {}, launch: 'board', glyphs: true, permission: 'auto', effort: '', effortCheck: '', showUsage: true, showLimits: true, chatView: 'terminal', showHealth: false };
export function getSetting(k) {
  const v = localStore.getItem('kb.set.' + k);
  const d = Object.hasOwn(PHONE_DEFAULTS, k) && onPhone() ? PHONE_DEFAULTS[k] : SETTINGS_DEFAULTS[k];
  if (v === null) return d;
  let got;
  try { got = JSON.parse(v); } catch { return d; }
  // a keymap that was a string broke ⌘F and the Hotkeys section, whose «Reset» would have mended it
  if (d !== undefined && (got === null || typeof got !== typeof d || Array.isArray(got) !== Array.isArray(d))) return d;
  return got;
}
export function setClaudeView(v) {
  setSetting('chatView', v === 'chat' ? 'chat' : 'terminal');
  repaintWorkTabs();
  repaintColumnViews();
}
export function pickedSetting(k) {
  const v = localStore.getItem('kb.set.' + k);
  if (v === null) return null;
  try { return JSON.parse(v); } catch { return null; }
}
export function setSetting(k, v) { localStore.setItem('kb.set.' + k, JSON.stringify(v)); }

export function syncLangToServer(lang = LANG) {
  return api('POST', '/api/lang', { lang }).catch(() => {});
}

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
const KEY_ACTIONS = [
  { id: 'newTask', label: tr('new task'), def: { code: 'KeyN' } },
  { id: 'search', label: tr("search projects and tasks (a second press — the browser's find)"), def: MAC ? { code: 'KeyF', meta: true } : { code: 'KeyF', ctrl: true } },
  { id: 'prevProject', label: tr('previous project (in the sidebar)'), def: { code: 'BracketLeft' } },
  { id: 'nextProject', label: tr('next project (in the sidebar)'), def: { code: 'BracketRight' } },
  { id: 'openCard', label: tr('open the selected card'), def: { code: 'Enter' } },
  { id: 'deleteCard', label: tr('delete the selection / the card under the cursor'), def: { code: 'Delete' } },
];
const KEY_FIXED = [
  ['← ↑ ↓ →', 'move the selection across cards'],
  ['Shift + ← ↑ ↓ →', 'move a card (between columns / by position)'],
  ['Esc', 'close the card · clear the selection'],
  ['⌘ + Enter', 'save edits in the open card'],
  ['⌘ + V', 'paste a screenshot into the open task or a comment'],
  ['Shift + Enter', 'line break in the comment field'],
  ['right-click on a card', 'action menu (status, priority, labels, duplicate…)'],
];
function keyBinding(id) {
  return customBinding(id) || KEY_ACTIONS.find((a) => a.id === id).def;
}
export function customBinding(id) {
  const km = getSetting('keymap');
  const b = Object.hasOwn(km, id) ? km[id] : null;
  return b && typeof b === 'object' && typeof b.code === 'string' ? b : null;
}
export function matchKey(e, id) {
  const b = keyBinding(id);
  return e.code === b.code && !!b.shift === e.shiftKey && !!b.alt === e.altKey && !!b.ctrl === e.ctrlKey && !!b.meta === e.metaKey;
}
const KEY_NAMES = { BracketLeft: '[', BracketRight: ']', Backspace: '⌫', Escape: 'Esc', Space: 'Space', Minus: '-', Equal: '=', Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", Backquote: '`' };
function comboLabel(b) {
  const name = KEY_NAMES[b.code] || b.code.replace(/^(Key|Digit)/, '');
  return `${b.ctrl ? '⌃ ' : ''}${b.alt ? '⌥ ' : ''}${b.shift ? '⇧ ' : ''}${b.meta ? '⌘ ' : ''}${name}`;
}

const THEMES = [
  { v: 'system', label: 'System', sw: ['#faf9f5', '#141414', '#d97757'] },
  { v: 'light', label: 'Light', sw: ['#faf9f5', '#ffffff', '#c96442'] },
  { v: 'dark', label: 'Dark', sw: ['#141414', '#1a1a1a', '#d97757'] },
];
export function applyDesign() {
  document.documentElement.dataset.design = 'v3';
}
export function applyTheme() {
  applyDesign();
  let t = getSetting('theme');
  if (t === 'coral') { setSetting('theme', 'light'); t = 'light'; }
  if (t === 'claude') { setSetting('theme', 'dark'); t = 'dark'; }
  let mode = t;
  if (t === 'system') mode = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode; // light | dark
  syncThemeColor();
  syncGlyphs();
}
globalThis.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (getSetting('theme') === 'system') applyTheme();
});

export function applyCompact() {
  $('board').classList.toggle('compact', !!getSetting('compactCards'));
}

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.setAttribute('content', bg);
}

const SM_SECTIONS = [['general', tr('General')], ['appearance', tr('Appearance')], ['app', tr('As an app')], ['share', 'Wi-Fi'], ['cats', tr('Sections')], ['claude', 'Claude Code'], ['skills', tr('Skills')], ['health', tr('Health')], ['archive', tr('Archived')], ['sync', tr('Sync')], ['errors', tr('Errors')], ['backups', tr('Backups')], ['keys', tr('Hotkeys')], ['about', tr('About')]];
const leaveSkillEditor = async () => !skillDirty() || confirmDiscard();
let settingsAsking = false;
async function requestCloseSettings() {
  if (settingsAsking || !$('settings-overlay')) return;
  settingsAsking = true;
  let ok = false;
  try { ok = await leaveSkillEditor(); } finally { settingsAsking = false; }
  if (!ok) { if ($('settings-overlay')) pushLayer('settings-overlay', requestCloseSettings); return; }
  closeSettingsModal();
}
const SM_FOCUSABLE = 'button, [href], input, select, textarea, summary, [tabindex]:not([tabindex="-1"])';
function trapSettingsTab(e) {
  const overlay = $('settings-overlay');
  if (!overlay || document.querySelector('.modal-overlay:not(#settings-overlay)')) return;
  const all = [...overlay.querySelectorAll(SM_FOCUSABLE)].filter((el) => !el.disabled && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  if (!all.length) return;
  e.preventDefault();
  const at = all.indexOf(document.activeElement);
  const to = at < 0 ? (e.shiftKey ? all.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + all.length) % all.length;
  all[to].focus();
}
function keepSettingsFocus(e) {
  const overlay = $('settings-overlay');
  if (!overlay || overlay.contains(e.target) || document.querySelector('.modal-overlay:not(#settings-overlay)')) return;
  overlay.querySelector('.sm-nav-item.active')?.focus({ preventScroll: true });
}
function settingsModalKey(e) {
  if (e.key === 'Escape') requestCloseSettings();
  else if (e.key === 'Tab') trapSettingsTab(e);
}
let smReturnFocus = null;
function closeSettingsModal() {
  stopRemap?.();
  popLayer('settings-overlay');
  const was = $('settings-overlay');
  was?.remove();
  document.removeEventListener('keydown', settingsModalKey);
  document.removeEventListener('focusin', keepSettingsFocus);
  if (was && smReturnFocus?.isConnected) smReturnFocus.focus({ preventScroll: true });
  smReturnFocus = null;
}
export function openSettingsModal(section) {
  const open = typeof section === 'string' && SM_SECTIONS.some(([id]) => id === section) ? section : 'general';
  closeSettingsModal();
  smReturnFocus = document.activeElement !== document.body ? document.activeElement : null;
  pushLayer('settings-overlay', requestCloseSettings);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'settings-overlay';
  overlay.innerHTML = `<div class="settings-modal">
    <div class="sm-nav">
      <div class="sm-nav-head">${tr('Settings')}</div>
      ${SM_SECTIONS.map(([id, lab]) => `<div class="sm-nav-item${id === open ? ' active' : ''}" data-sec="${id}" tabindex="0" role="button">${lab}</div>`).join('')}
    </div>
    <div class="sm-main">
      <button class="sm-close btn-icon" title="${tr('Close')}">✕</button>
      <div class="sm-body" id="sm-body"></div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.sm-close').onclick = requestCloseSettings;
  overlay.onclick = (e) => { if (e.target === overlay) requestCloseSettings(); };
  overlay.querySelectorAll('.sm-nav-item').forEach((n) => {
    n.onclick = async () => {
      if (!await leaveSkillEditor()) return;
      overlay.querySelectorAll('.sm-nav-item').forEach((x) => x.classList.toggle('active', x === n));
      renderSection(n.dataset.sec);
    };
    n.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); n.click(); } };
  });
  document.addEventListener('keydown', settingsModalKey);
  document.addEventListener('focusin', keepSettingsFocus);
  renderSection(open);
  overlay.querySelector('.sm-nav-item.active')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  overlay.querySelector('.sm-nav-item.active')?.focus({ preventScroll: true });
}
export function moreHTML(inner) {
  return `<details class="sm-more"><summary>${tr('More')}</summary><div class="sm-more-body">${inner}</div></details>`;
}
export function notifyTestState(perm, on) {
  if (perm === 'unsupported') return tr('this browser cannot show system notifications');
  if (perm === 'denied') return tr('blocked by the browser — allow notifications for this page in its site settings (the icon left of the address), then check again');
  if (perm !== 'granted') return tr('the browser has not been asked yet — the check will ask it');
  return on ? tr('allowed by the browser and on') : tr('allowed by the browser, but off on the board — the switch above');
}
export const notifyPerm = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);
export async function sendTestNotification(el) {
  let perm = notifyPerm();
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') { el.textContent = notifyTestState(perm, !!getSetting('notifyReview')); return false; }
  const off = getSetting('notifyReview') ? '' : ` ${tr('Notifications about tasks are off on the board — the switch above.')}`;
  const at = new Date().toLocaleTimeString(LANG === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  let n;
  try {
    n = new Notification(tr('Test notification'), { body: tr('If you see this, notifications from the board reach you.'), icon: '/icon-192.png', tag: `kb-test-${Date.now()}` }); // its own tag: a repeat with the same one is replaced silently, no banner
  } catch {
    el.textContent = tr('the browser would not create a notification on this page');
    return false;
  }
  el.textContent = `${tr('sent at')} ${at} — ${tr('did it show up? If not, the system holds it back: on a Mac, System Settings → Notifications → your browser, and Do Not Disturb.')}${off}`;
  // `show` means the browser handed it over, not that it was on screen: macOS may still hold it back
  n.onshow = () => { el.textContent = `${tr('sent at')} ${at} — ${tr('the browser handed it to the system ✓. Did not see it? The system holds it back: on a Mac, System Settings → Notifications → your browser, Do Not Disturb, Notification Centre.')}${off}`; };
  n.onerror = () => { el.textContent = tr('the system would not show it — check the notifications of your browser in the system settings'); };
  n.onclick = () => { window.focus(); n.close(); };
  return true;
}
let installPrompt = null;
export function listenForInstall() {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; });
  window.addEventListener('appinstalled', () => { installPrompt = null; });
}
export const appStepsHTML = (g) => `<ol class="app-steps">${g.steps.map((s) => `<li>${tr(s)}</li>`).join('')}</ol>`;
export const appInstallView = (installed = false) => installView({
  ua: navigator.userAgent, touch: navigator.maxTouchPoints || 0,
  standalone: installed || !!(window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone),
  secure: window.isSecureContext !== false, canPrompt: !!installPrompt,
});
/** The browser's own offer to install, once; false when there was none (or it was taken back). */
export async function promptInstall() {
  const p = installPrompt;
  if (!p) return false;
  let accepted = false;
  try { await p.prompt(); accepted = (await p.userChoice)?.outcome === 'accepted'; } catch { /* the browser took the offer back */ }
  installPrompt = null; // an offer is good for one prompt
  return accepted;
}
export function renderAppSection(body) {
  const v = appInstallView();
  const side = v.installed ? `<span class="about-fresh">${tr('open as an app ✓')}</span>`
    : v.prompt ? `<button class="btn-primary" id="app-install">${tr('Install')}</button>` : '';
  body.innerHTML = `<div class="sm-h">${tr('As an app')}</div>`
    + `<div class="set-row"><span class="set-lab">${tr('A window of its own')}<small>${v.installed
      ? tr('the board is open as an app right now — its icon is in the Dock, the taskbar or on the home screen')
      : tr('the board opens in a window without tabs and an address bar, with its own icon in the Dock, the taskbar or on the home screen')}</small></span>${side}</div>`
    + (!v.installed && v.here ? `<div class="set-col"><span class="set-lab">${tr('In this browser')}<small>${tr(v.here.name)}</small></span>${appStepsHTML(v.here)}</div>` : '')
    + (v.insecure ? `<div class="kbh-note warn">${tr('Chrome and Edge make an app only of a page opened at 127.0.0.1 or localhost, or over https — this one is not, so the menu item stays grey. Open the board at 127.0.0.1 on the computer it runs on.')}</div>` : '')
    + `<div class="set-row"><span class="set-lab">${tr('The board stays the same')}<small>${tr('the app is only a window: the tasks live in the board on this computer, it has to be running as now, and closing the app stops nothing')}</small></span></div>`
    + `<details class="sm-more about-more"><summary><span class="set-lab">${tr('Other browsers')}<small>${tr('for a phone and the other browsers')}</small></span></summary>`
    + `<div class="app-other">${v.others.map((g) => `<div class="app-other-h">${tr(g.name)}</div>${appStepsHTML(g)}`).join('')}</div></details>`;
  const btn = body.querySelector('#app-install');
  if (btn) btn.onclick = async () => {
    btn.disabled = true;
    await promptInstall();
    renderAppSection(body);
  };
}
let sndDiagTimer = 0;
async function renderSection(sec) {
  const body = $('sm-body');
  if (!body) return;
  stopRemap?.();
  if (sec === 'general') {
    const soundList = Object.entries(SOUND_LIB).map(([id, s]) => ({ value: id, label: tr(s.name) }));
    body.innerHTML = `<div class="sm-h">${tr('General')}</div>`
      + `<div class="set-row"><span class="set-lab">${tr('Interface language')}<small>${tr('applies after page reload')}</small></span><div class="kbsel set-sel" id="sel-lang"></div></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Sound notifications')}<small>${tr('sound on Review and Done')}</small></span><input type="checkbox" class="set-toggle" data-set="sound"></label>`
      + `<label class="set-row"><span class="set-lab">${tr('System notifications')}<small>${tr('when a task reaches Review, Claude waits for you or asks a question')}</small></span><input type="checkbox" class="set-toggle" data-set="notifyReview"></label>`
      + `<div class="set-row"><span class="set-lab">${tr('Check notifications')}<small id="notif-state"></small></span><button class="btn-ghost" id="notif-test">${tr('Send a test')}</button></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Sound for Review')}</span><span class="sound-pick"><div class="kbsel set-sel" id="sel-soundReview"></div><button class="btn-ghost snd-test" data-test="soundReview" title="▶">▶</button></span></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Sound for Done')}</span><span class="sound-pick"><div class="kbsel set-sel" id="sel-soundDone"></div><button class="btn-ghost snd-test" data-test="soundDone" title="▶">▶</button></span></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Task sidebar always open')}<small>${tr('keep the right panel visible even with no task selected')}</small></span><input type="checkbox" class="set-toggle" data-set="keepDrawer"></label>`
      + `<div class="set-row"><span class="set-lab">${tr('Start screen')}<small>${tr('what to open on launch')}</small></span><div class="kbsel set-sel" id="sel-startScreen"></div></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Default dashboard range')}</span><div class="kbsel set-sel" id="sel-dashRange"></div></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Sound diagnostics')}<small id="snd-diag">…</small></span></div>`;
    const fmtT = (d) => d ? d.toLocaleTimeString(LANG === 'en' ? 'en-GB' : 'ru-RU', { hour: '2-digit', minute: '2-digit' }) : '—';
    const renderSndDiag = () => {
      const el = document.getElementById('snd-diag');
      if (!el) return false;
      const st = audioCtx ? ({ running: tr('running'), suspended: tr('blocked by autoplay'), closed: tr('closed') }[audioCtx.state] || audioCtx.state) : tr('not created');
      const sseAge = Math.round((Date.now() - lastSseAt) / 1000);
      el.textContent = `${tr('audio:')} ${st} · ${tr('sounds missed:')} ${missedSounds}${lastMissedAt ? ` (${tr('last at')} ${fmtT(lastMissedAt)})` : ''} · ${tr('server signal:')} ${sseAge}${tr('s ago')} · ${tr('page loaded at')} ${fmtT(pageLoadedAt)}`;
      return true;
    };
    renderSndDiag();
    clearInterval(sndDiagTimer);
    sndDiagTimer = setInterval(() => { if (!renderSndDiag()) { clearInterval(sndDiagTimer); sndDiagTimer = 0; } }, 1000);
    body.querySelector('[data-set="sound"]').checked = !!getSetting('sound');
    body.querySelector('[data-set="sound"]').onchange = (e) => { setSetting('sound', e.target.checked); updateSoundBadge(); };
    const notifyEl = body.querySelector('[data-set="notifyReview"]');
    notifyEl.checked = !!getSetting('notifyReview');
    notifyEl.onchange = async (e) => {
      if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { e.target.checked = false; setSetting('notifyReview', false); if ($('notif-state')) $('notif-state').textContent = notifyTestState(perm, false); return; }
      }
      setSetting('notifyReview', e.target.checked);
      if ($('notif-state')) $('notif-state').textContent = notifyTestState(notifyPerm(), e.target.checked); // the section may be gone after the prompt
    };
    $('notif-state').textContent = notifyTestState(notifyPerm(), !!getSetting('notifyReview'));
    $('notif-test').onclick = () => sendTestNotification($('notif-state'));
    body.querySelector('[data-set="keepDrawer"]').checked = !!getSetting('keepDrawer');
    body.querySelector('[data-set="keepDrawer"]').onchange = (e) => { setSetting('keepDrawer', e.target.checked); applyKeepDrawer(); };
    buildSelect($('sel-soundReview'), { value: getSetting('soundReview'), options: soundList, onChange: (v) => { setSetting('soundReview', v); playNamedSound(v); } });
    buildSelect($('sel-soundDone'), { value: getSetting('soundDone'), options: soundList, onChange: (v) => { setSetting('soundDone', v); playNamedSound(v); } });
    buildSelect($('sel-startScreen'), { value: getSetting('startScreen'), options: [{ value: 'dashboard', label: tr('Dashboard') }, { value: 'chaos', label: tr('New task') }, { value: 'last', label: tr('Last opened') }], onChange: (v) => setSetting('startScreen', v) });
    buildSelect($('sel-dashRange'), { value: getSetting('dashRange'), options: RANGE_BTN.map(([v, lab]) => ({ value: v, label: tr(lab) })), onChange: (v) => { setSetting('dashRange', v); state.dashRange = v; } });
    // message) — every other reload of the board waits for it, the language asks first
    const langSelect = () => buildSelect($('sel-lang'), { value: LANG, options: [{ value: 'ru', label: tr('Russian') }, { value: 'en', label: 'English' }], onChange: async (v) => {
      if (v === LANG) return;
      if (hasUnsavedInput() && !(await styledConfirm(tr('Changing the language reloads the page, and what is typed and not saved yet will be lost. Change the language?'), { okLabel: tr('Change the language'), danger: true }))) {
        if ($('sel-lang')) langSelect(); // the list shows the language the page still has
        return;
      }
      setSetting('lang', v); smoothReload(syncLangToServer(v));
    } });
    langSelect();
    body.querySelectorAll('.snd-test').forEach((b) => { b.onclick = () => playNamedSound(getSetting(b.dataset.test)); });
  } else if (sec === 'appearance') {
    const cur = getSetting('theme');
    body.innerHTML = `<div class="sm-h">${tr('Appearance')}</div>`
      + `<label class="set-row"><span class="set-lab">${tr('Symbols in the background')}<small>${tr('clouds and waves of symbols drift by from right to left; a click on empty space sends a sonar pulse through them')}</small></span><input type="checkbox" class="set-toggle" data-set="glyphs"></label>`
      + `<div class="set-col"><span class="set-lab">${tr('Theme')}<small>${tr('light, dark or as the system')}</small></span>`
      + `<div class="theme-grid">${THEMES.map((t) => `<button class="theme-card${t.v === cur ? ' active' : ''}" data-theme="${t.v}">`
          + `<span class="theme-sw">${t.sw.map((c) => `<span style="background:${c}"></span>`).join('')}</span>`
          + `<span class="theme-card-lab">${tr(t.label)}</span></button>`).join('')}</div></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Compact cards')}<small>${tr('hide the description preview — more cards fit on screen')}</small></span><input type="checkbox" class="set-toggle" data-set="compactCards"></label>`
      + `<label class="set-row"><span class="set-lab">${tr('Link lines')}<small>${tr('draw lines between linked cards; when off, links show as a chain badge')}</small></span><input type="checkbox" class="set-toggle" data-set="linkLines"></label>`;
    body.querySelectorAll('.theme-card').forEach((b) => {
      b.onclick = () => { setSetting('theme', b.dataset.theme); applyTheme(); body.querySelectorAll('.theme-card').forEach((x) => x.classList.toggle('active', x === b)); };
    });
    body.querySelector('[data-set="glyphs"]').checked = getSetting('glyphs') !== false;
    body.querySelector('[data-set="glyphs"]').onchange = (e) => { setSetting('glyphs', e.target.checked); syncGlyphs(); };
    body.querySelector('[data-set="compactCards"]').checked = !!getSetting('compactCards');
    body.querySelector('[data-set="compactCards"]').onchange = (e) => { setSetting('compactCards', e.target.checked); applyCompact(); };
    body.querySelector('[data-set="linkLines"]').checked = getSetting('linkLines') !== false;
    body.querySelector('[data-set="linkLines"]').onchange = (e) => { setSetting('linkLines', e.target.checked); drawLinks(); };
  } else if (sec === 'app') {
    renderAppSection(body);
  } else if (sec === 'health') {
    body.innerHTML = `<div class="sm-h">${tr('Health')}</div>`
      + `<label class="set-row"><span class="set-lab">${tr('Show Health in the sidebar')}<small>${tr('a section that measures the instructions Claude Code reads in each project — the CLAUDE.md of each against the norms')}</small></span><input type="checkbox" class="set-toggle" data-set="showHealth"></label>`
      + `<div class="set-row"><span class="set-lab">${tr('Open Health')}<small>${tr('the size of every CLAUDE.md, what loads at the start of a session, and the norms')}</small></span><button type="button" class="btn-ghost" id="health-open">${tr('Open')}</button></div>`;
    const box = body.querySelector('[data-set="showHealth"]');
    box.checked = getSetting('showHealth') === true;
    box.onchange = (e) => { setSetting('showHealth', e.target.checked); renderSidebar(); };
    $('health-open').onclick = () => { closeSettingsModal(); selectProject(HEALTH); };
  } else if (sec === 'share') {
    renderShareSection(body);
  } else if (sec === 'archive') {
    body.innerHTML = `<div class="sm-h">${tr('Archived')}</div>`
      + `<div class="kbh-note muted">${tr('Archived boards are hidden from the sidebar and left out of every dashboard number. Their tasks are kept.')}</div>`
      + '<div id="arch-list" class="bk-list">…</div>';
    const load = async () => {
      let list;
      try { list = await api('GET', '/api/projects/archived'); } catch { list = null; }
      if (!$('arch-list')) return;
      if (!list) { $('arch-list').textContent = '—'; return; }
      $('arch-list').innerHTML = list.length
        ? list.map((p) => `<div class="bk-row"><span>${esc(p.name)}</span>`
            + `<span class="muted">${p.tasks_n} ${plural(p.tasks_n, 'task', 'tasks')}</span>`
            + `<button class="btn-ghost arch-back" data-slug="${esc(p.slug)}">${tr('Bring back')}</button></div>`).join('')
        : `<div class="muted">${tr('nothing archived')}</div>`;
      $('arch-list').querySelectorAll('.arch-back').forEach((b) => {
        b.onclick = async () => {
          b.disabled = true;
          try { await api('PATCH', `/api/projects/${seg(b.dataset.slug)}`, { archived: 0 }); } catch { b.disabled = false; return; }
          await loadProjects();
          load();
        };
      });
    };
    load();
  } else if (sec === 'cats') {
    body.innerHTML = `<div class="sm-h">${tr('Sections')}<button class="btn-ghost" id="cat-add">${tr('＋ New section')}</button></div>`
      + `<div class="kbh-note muted">${tr('Sections group boards in the sidebar. A new name applies to every board in the section.')}</div>`
      + '<div id="cat-list" class="cat-list">…</div>';
    const byCat = new Map();
    for (const p of state.projects) {
      const c = p.category || 'Other';
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(p);
    }
    let cats;
    try { cats = await api('GET', '/api/categories'); }
    catch { cats = null; }
    if (!$('cat-list')) return;
    if (!cats) { $('cat-list').textContent = '—'; return; }
    const opts = cats.map((c) => ({ value: c.name, label: c.locked ? tr(c.name) : c.name }));
    $('cat-list').innerHTML = cats.map((c) => `<div class="cat-block" data-cat="${esc(c.name)}">
        <div class="cat-row">
          <input class="cat-name" type="text" value="${esc(c.locked ? tr(c.name) : c.name)}"${c.locked ? ` disabled title="${esc(tr('built-in section — the name cannot be changed'))}"` : ''}>
          <span class="muted cat-count">${c.count || tr('empty')}</span>
          <button class="btn-ghost cat-del"${c.locked ? ` disabled title="${esc(tr('built-in section — cannot be deleted'))}"` : ''}>${tr('Delete')}</button>
        </div>
        <div class="cat-projs">${(byCat.get(c.name) || []).map((p) => `<div class="cat-proj">
          <span class="cat-proj-name">${esc(p.name || p.slug)}</span>
          <div class="kbsel cat-sel" data-slug="${esc(p.slug)}"></div></div>`).join('')}</div>
      </div>`).join('');
    $('cat-list').querySelectorAll('.cat-sel').forEach((host) => {
      const slug = host.dataset.slug;
      const cur = state.projects.find((p) => p.slug === slug);
      buildSelect(host, {
        value: cur?.category || 'Other',
        options: opts,
        onChange: async (v) => {
          try { await api('PATCH', `/api/projects/${seg(slug)}`, { category: v === 'Other' ? null : v }); }
          catch {  }
          await refresh();
          renderSection('cats');
        },
      });
    });
    const catAct = async (fn) => {
      try { await fn(); } catch (e) { $('cat-list')?.insertAdjacentHTML('afterbegin', `<div class="cat-err">${esc(refusalLine('Did not work out', e, tr))}</div>`); return; }
      await refresh();
      if ($('cat-list')) renderSection('cats');
    };
    $('cat-list').querySelectorAll('.cat-name').forEach((inp) => {
      const from = inp.closest('.cat-block').dataset.cat;
      inp.onchange = () => {
        const to = inp.value.trim();
        if (!to || to === from) { inp.value = from; return; }
        catAct(() => api('PATCH', `/api/categories/${encodeURIComponent(from)}`, { name: to }));
      };
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); };
    });
    $('cat-list').querySelectorAll('.cat-del').forEach((btn) => {
      const name = btn.closest('.cat-block').dataset.cat;
      const n = (byCat.get(name) || []).length;
      btn.onclick = async () => {
        const msg = n ? `${tr('Delete section')} «${name}»? ${n} ${tr('board(s) will move to “Other”.')}` : `${tr('Delete section')} «${name}»?`;
        if (!await styledConfirm(msg, { okLabel: tr('Delete'), danger: true })) return;
        catAct(() => api('DELETE', `/api/categories/${encodeURIComponent(name)}`));
      };
    });
    $('cat-add').onclick = () => styledPrompt(tr('New section'), {
      placeholder: tr('section name'),
      okLabel: tr('Add'),
      onSubmit: async (name) => { await api('POST', '/api/categories', { name }); await refresh(); renderSection('cats'); },
    });
  } else if (sec === 'sync') {
    body.innerHTML = `<div class="sm-h">${tr('GitHub sync')}</div>`
      // and the two facts without which the sync fails on its first try — the repository is made by the person, and gh
      // needs the project scope, the most common and least clear refusal); the rest folds away
      + `<div class="sync-about"><p>${tr('Every task becomes an issue in one private GitHub repository you create yourself first — titles, descriptions and comments go there in full.')}</p>`
      + `<p class="muted">${tr('Needs gh signed in with the project scope: gh auth refresh -s project')}</p>`
      + moreHTML(`<p>${tr('The board can mirror its tasks to GitHub: every task becomes an issue, and each project gets its own Projects v2 board. Handy when someone else needs to see the work, or when you want the history somewhere besides this machine.')}</p>`
      + `<p>${tr('One repository for the whole board, not one per project. Create it yourself first, and make it private: task titles, descriptions and comments are copied there in full. This is the only thing on this board that leaves your machine.')}</p>`
      + `<p>${tr('The mirror is one-way: the board writes to GitHub and never reads back. Turning it off is emptying these fields.')}</p>`
      + `<p class="muted">${tr('Needs the gh CLI, signed in with the project scope:')}</p>`
      + '<pre class="onb-code">gh auth login &amp;&amp; gh auth refresh -s project</pre>'
      + `<p class="muted">${tr('Without that scope an issue is still created, but the card never lands on the Projects board.')}</p>`
      + `<p class="muted"><a href="https://github.com/lamaohub/local-kanban#github-sync-optional" target="_blank" rel="noopener noreferrer">${tr('The same in the README, in more detail')}</a></p>`)
      + `</div>`
      + `<div class="set-col"><span class="set-lab">${tr('Owner and issues repository')}<small id="sync-cfg-hint">${tr('empty — sync is off, the board runs locally')}</small></span>`
      + `<div class="sync-cfg-row"><input type="text" id="sync-owner" placeholder="${tr('owner (GitHub user)')}"><input type="text" id="sync-repo" placeholder="${tr('owner/repo for issues')}"><button class="btn-ghost" id="sync-cfg-save">${tr('Save')}</button></div></div>`
      + `<div class="set-row"><span class="set-lab" id="set-sync">…<small id="set-sync-last"></small></span><button class="btn-ghost" id="set-sync-retry">${tr('Retry failed')}</button></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Pause sync')}<small>${tr('keep changes local and catch up with GitHub later')}</small></span><input type="checkbox" class="set-toggle" id="sync-pause"></label>`
      + `<div class="set-col hidden" id="sync-errors-wrap"><span class="set-lab">${tr('Recent errors')}</span><div id="sync-errors" class="bk-list"></div></div>`;
    const OP_LABEL = { create_issue: tr('create issue'), set_status: tr('status'), set_priority: tr('priority'), set_labels: tr('labels'), set_blocked: tr('blocked flag'), add_comment: tr('comment'), update_issue: tr('edit issue'), close_issue: tr('close issue'), reopen_issue: tr('reopen issue'), delete_issue: tr('delete issue') };
    let s;
    try { s = await api('GET', '/api/sync'); } catch { s = null; }
    if (!$('set-sync')) return;
    try {
      if (!s) throw new Error('no answer');
      $('sync-owner').value = s.owner || '';
      $('sync-repo').value = s.repo || '';
      if (s.source === 'env') {
        $('sync-cfg-hint').textContent = tr('set via env KB_GH_OWNER/KB_GH_REPO — edit your launch config');
        $('sync-owner').disabled = $('sync-repo').disabled = $('sync-cfg-save').disabled = true;
      }
      $('set-sync').childNodes[0].textContent = s.configured === false ? tr('sync is off — the board runs locally')
        : s.paused ? tr('sync paused') + (s.pending ? ` · ${s.pending} ${tr('piling up')}` : '')
        : s.gh === false ? tr('GitHub is not set up (gh auth needed)')
        : s.failed.length ? `${s.failed.length} ${tr('failed in the queue')}`
        : s.pending ? `${s.pending} ${tr('queued')}` : tr('everything synced ✓');
      $('set-sync-last').textContent = s.last_ok ? `${tr('last successful sync:')} ${fmtDbTime(s.last_ok)}` : tr('no successful syncs yet');
      $('set-sync-retry').disabled = !s.failed.length;
      $('sync-pause').checked = !!s.paused;
      if (s.errors?.length) {
        $('sync-errors-wrap').classList.remove('hidden');
        $('sync-errors').innerHTML = s.errors.map((r) =>
          `<div class="bk-row"><span>${esc(OP_LABEL[r.op] || r.op)}${r.key ? ` · ${esc(r.key)}` : ''}</span><span class="muted" title="${esc(r.last_error || '')}">${esc((r.last_error || '').slice(0, 80))}${(r.last_error || '').length > 80 ? '…' : ''}</span></div>`).join('');
      }
    } catch { $('set-sync').childNodes[0].textContent = '—'; $('set-sync-retry').disabled = true; }
    $('sync-pause').onchange = async (e) => { try { await api('POST', '/api/sync/pause', { paused: e.target.checked }); } catch {  } if ($('set-sync')) renderSection('sync'); };
    $('set-sync-retry').onclick = async () => { try { await api('POST', '/api/sync/retry'); } catch {  } if ($('set-sync')) renderSection('sync'); };
    $('sync-cfg-save').onclick = async () => {
      try { await api('POST', '/api/sync/config', { owner: $('sync-owner').value, repo: $('sync-repo').value }); }
      catch (e) { const hint = $('sync-cfg-hint'); if (hint) hint.textContent = refusalLine('did not save', e, tr); return; }
      if ($('set-sync')) renderSection('sync');
    };
  } else if (sec === 'errors') {
    body.innerHTML = `<div class="sm-h" title="${esc(tr('Everything lands here: a server failure, a failed sync op, an error in the browser. Empty means the board runs clean.'))}">${tr('Errors')}<span class="muted err-count" id="err-count"></span><button class="btn-ghost" id="err-clear">${tr('Clear the log')}</button></div>`
      + '<div id="err-list" class="bk-list">…</div>';
    const SRC = { server: tr('server'), sync: tr('sync'), client: tr('browser') };
    const load = async () => {
      let list;
      try { list = await api('GET', '/api/errors'); } catch { list = null; }
      if (!$('err-list')) return;
      try {
        if (!list) throw new Error('no answer');
        const open = list.filter((r) => !r.resolved_at).length;
        const fixed = list.length - open;
        $('err-count').textContent = list.length
          ? (open ? `${open} ${tr('unresolved')}${fixed ? ` · ${fixed} ${tr('self-healed')}` : ''}` : `${tr('all self-healed')}`)
          : '';
        $('err-list').innerHTML = list.length
          ? list.map((r) => `<div class="bk-row err-row${r.resolved_at ? ' err-fixed' : ''}" title="${esc(r.detail || '')}">`
              + `<span class="err-when muted">${esc(fmtDbTime(r.at))}</span>`
              + `<span class="err-src">${esc(SRC[r.source] || r.source)}${r.scope ? ` · ${esc(r.scope)}` : ''}</span>`
              + `<span class="err-msg">${esc(r.message)}`
              + `${r.repeats ? ` <span class="muted">×${r.repeats + 1}</span>` : ''}`
              + `${r.resolved_at ? `<span class="err-fixed-tag">${tr('recovered on retry')}</span>` : ''}`
              + `</span></div>`).join('')
          : `<div class="muted">${tr('no errors ✓')}</div>`;
      } catch { $('err-list').textContent = '—'; }
    };
    $('err-clear').onclick = async () => {
      if (!await styledConfirm(tr('Clear the error log?'), { okLabel: tr('Clear'), danger: true })) return;
      try { await api('DELETE', '/api/errors'); } catch {  }
      load();
    };
    load();
  } else if (sec === 'backups') {
    body.innerHTML = `<div class="sm-h">${tr('Database backups')}`
      + `<button class="btn-ghost" id="bk-up" title="${esc(tr('The uploaded file opens as a separate board on a neighbouring port — this board and its tasks stay untouched.'))}">${tr('Upload')}</button>`
      + `<button class="btn-ghost" id="bk-now">${tr('Back up now')}</button></div>`
      + `<input type="file" id="bk-file" accept=".db,application/octet-stream" class="hidden">`
      + `<div id="bk-restore" class="bk-restore hidden"></div>`
      + `<div id="bk-list" class="bk-list">…</div>`
      + '<div id="bk-more"></div>';
    const load = async () => {
      let info;
      try { info = await api('GET', '/api/backups'); } catch { info = null; }
      if (!$('bk-list')) return;
      try {
        if (!info) throw new Error('no answer');
        const list = info.items;
        const stamp = (iso) => esc(fmtLocalStamp(iso));
        const head = (info.last_error
          ? `<div class="kbh-note warn">${tr('The last automatic snapshot failed')} (${stamp(info.last_error_at)}): ${esc(info.last_error)}</div>`
          : '')
          + (info.last_ok ? `<div class="kbh-note muted">${tr('Last successful snapshot')}: ${stamp(info.last_ok)}</div>` : '');
        const more = moreHTML(`<p>${info.attachments
          ? tr('Images and attachments are mirrored next to the snapshots, not inside the downloaded file.')
          : tr('The snapshot covers the database only.')}</p>`
          + `<p>${tr('The uploaded file opens as a separate board on a neighbouring port — this board and its tasks stay untouched.')}</p>`);
        // (the button «Upload» carries the same line as its hint: the list is long, and «More» is under it)
        if ($('bk-more') && !$('bk-more').innerHTML) $('bk-more').innerHTML = more;
        $('bk-list').innerHTML = head + (list.length
          ? list.map((b) => `<div class="bk-row"><span>${esc(b.name)}</span><span class="bk-meta"><span class="muted">${fmtNum(b.size / 1048576)} ${tr('MB')} · ${stamp(b.mtime)}</span><a class="bk-dl" href="/api/backups/${encodeURIComponent(b.name)}" download="${esc(b.name)}" title="${tr('Download backup')}">${ic('download', 13)}</a></span></div>`).join('')
          : `<div class="muted">${tr('no backups yet')}</div>`);
        $('bk-list').querySelectorAll('.bk-dl').forEach((a) => {
          a.onclick = async (e) => {
            e.preventDefault();
            const alive = await fetch(a.href, { method: 'HEAD' }).then((r) => r.ok).catch(() => false);
            if (!alive) { await styledAlert(tr('This snapshot has already been rotated out — refreshing the list.')); load(); return; }
            const tmp = document.createElement('a');
            tmp.href = a.href; tmp.download = a.getAttribute('download');
            document.body.appendChild(tmp); tmp.click(); tmp.remove();
          };
        });
      } catch { $('bk-list').textContent = '—'; }
    };
    $('bk-now').onclick = async (e) => { const btn = e.currentTarget; btn.disabled = true; try { await api('POST', '/api/backups'); } catch {  } btn.disabled = false; load(); };

    const box = () => $('bk-restore');
    const showRestore = (html) => { const b = box(); if (!b) return; b.classList.remove('hidden'); b.innerHTML = html; };
    const renderRunning = (r) => {
      const mins = Math.round((r.expires_in || 0) / 60000);
      showRestore(`<div class="bkr-head">${ic('download', 13)} ${tr('Check board is up')}</div>`
        + `<div class="bkr-sub muted">${tr('tasks')}: <b>${r.stats.tasks}</b> · ${tr('projects')}: <b>${r.stats.projects}</b>`
        + ` · ${tr('closes in')} ${mins} ${tr('min')}</div>`
        + `<div class="bkr-act"><a class="btn-primary" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${tr('Open')} ${esc(r.url)}</a>`
        + `<button class="btn-ghost" id="bkr-stop">${tr('Close the check board')}</button></div>`);
      $('bkr-stop').onclick = async () => { try { await api('DELETE', '/api/backups/restore'); } catch {  } box()?.classList.add('hidden'); };
    };
    api('GET', '/api/backups/restore', null, { quiet: true }).then((r) => { if (r && r.port) renderRunning(r); }).catch(() => {});

    $('bk-up').onclick = () => $('bk-file').click();
    $('bk-file').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const goOn = await styledConfirm(
        `${tr('File')}: ${file.name} (${fmtNum(file.size / 1048576)} ${tr('MB')}).\n`
        + tr('It will be checked and opened as a SEPARATE board on a neighbouring port. This board and its tasks will not change.'),
        { okLabel: tr('Check the backup') });
      if (!goOn) return;
      const up = $('bk-up');
      if (!up) return; // the window was closed while it asked
      up.disabled = true;
      showRestore(`<div class="bkr-head">${tr('Checking the file and starting the board…')}</div>`
        + `<div class="bkr-sub muted">${tr('this takes a few seconds')}</div>`);
      try {
        const r = await apiBlob('/api/backups/restore', new Blob([file], { type: 'application/octet-stream' }), { quiet: true });
        renderRunning(r);
      } catch (err) {
        showRestore(`<div class="bkr-head bkr-bad">${ic('warn', 13)} ${tr('Did not work out')}</div>`
          + `<div class="bkr-sub muted">${esc(tr(refusalText(err).reason))}</div>`);
      }
      up.disabled = false;
    };
    load();
  } else if (sec === 'skills') {
    await renderSkillsSection(body);
  } else if (sec === 'claude') {
    await renderClaudeSection(body);
  } else if (sec === 'keys') {
    body.innerHTML = `<div class="sm-h">${tr('Hotkeys')}<button class="btn-ghost" id="keys-reset">${tr('Reset to defaults')}</button></div>`
      + '<div class="kb-help">'
      + KEY_ACTIONS.map((a) => `<div class="kbh-row kbh-remap" data-act="${a.id}" title="${esc(tr('click to assign your own shortcut'))}"><kbd>${esc(comboLabel(keyBinding(a.id)))}</kbd><span>${esc(tr(a.label))}</span></div>`).join('')
      + KEY_FIXED.map(([k, d]) => `<div class="kbh-row"><kbd>${esc(tr(k))}</kbd><span>${esc(tr(d))}</span></div>`).join('')
      + '</div>'
      + `<div class="kbh-note muted">${tr('click the rows above to assign your own shortcut (Esc cancels); the ones below are fixed')}</div>`;
    $('keys-reset').onclick = () => { setSetting('keymap', {}); renderSection('keys'); };
    body.querySelectorAll('.kbh-remap').forEach((row) => { row.onclick = () => listenRemap(row); });
  } else {
    body.innerHTML = `<div class="sm-h">${tr('About')}</div>`
      + `<div class="set-row"><span class="set-lab">${tr('Code version')}<small id="about-ver">…</small></span><span class="about-fresh" id="about-fresh"></span></div>`
      + `<div class="set-row upd-row"><span class="set-lab"><span id="about-branch-lab">${tr('Board updates')}</span><small id="about-upd-sub">…</small></span>`
      + `<span class="about-upd-side"><span class="about-fresh" id="about-upd"></span>`
      + `<button class="btn-ghost hidden" id="about-do-upd">${tr('Install the update')}</button></span></div>`
      + `<div class="set-col hidden" id="about-upd-fail"><span class="set-lab">${tr('Run it yourself')}<small>${tr('the board is not allowed to do this — the command is the same one it just tried')}</small></span>`
      + '<pre class="onb-code" id="about-upd-cmd"></pre></div>'
      + `<div class="set-row hidden" id="about-dev-row"><span class="set-lab">${tr('dev branch')}<small id="about-dev-sub">…</small></span><span class="about-fresh" id="about-dev"></span></div>`
      + `<details class="sm-more about-more"><summary><span class="set-lab">${tr("What's new")}<small id="about-news-sub">…</small></span></summary><div class="about-news" id="about-news">…</div></details>`
      + `<div class="set-row"><span class="set-lab">${tr('Check for updates')}<small id="about-recheck-sub">${tr('re-read branch state from GitHub')}</small></span><button class="btn-ghost" id="about-recheck">${tr('Check')}</button></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Reload the page')}<small>${tr('re-read the board code right now')}</small></span><button class="btn-ghost" id="about-reload">${tr('Reload now')}</button></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Setup')}<small>${tr('the welcome wizard: language, how ▶ starts Claude, what the board shows, the sync')}</small></span><button class="btn-ghost" id="about-onboarding">${tr('Go through it again')}</button></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Questions')}<small>${tr('about anything — write to the author on Telegram')}</small></span><a class="btn-ghost" href="${CONTACT_URL}" target="_blank" rel="noopener noreferrer">${CONTACT_NAME}</a></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Using the board at work')}<small>${tr('free for everyone, nothing switched off — if it earns you money, $12 a year per person keeps it maintained')}</small></span>`
      + `<a class="btn-ghost" href="https://github.com/lamaohub/local-kanban/blob/main/docs/COMMERCIAL.md" target="_blank" rel="noopener noreferrer">${tr('Read')}</a></div>`
      + `<div class="set-col"><span class="set-lab">${tr('Diagnostics')}</span><div class="bk-list" id="about-diag">…</div></div>`
      + `<details class="sm-more about-more"><summary><span class="set-lab">${tr('Setup via Claude')}<small>${tr('copy and paste into Claude chat — it will run the setup and ask you questions')}</small></span></summary>`
      + setupPromptBlockHTML() + '</details>';
    wireSetupPrompt(body);
    $('about-reload').onclick = () => location.reload();
    $('about-onboarding').onclick = async () => { await requestCloseSettings(); if (!$('settings-overlay')) openOnboarding({ updated: false }); };
    checkVersion().then(() => {
      const el = $('about-fresh');
      if (el) { el.textContent = pendingReload ? tr('⟳ a new version is available') : tr('the board is fresh ✓'); el.classList.toggle('stale-ver', pendingReload); }
    });
    let about = null;
    const updateHint = () => (about?.packaged
      ? tr('update with: npm install -g local-kanban@latest')
      : tr('update with: npm run update'));
    const renderUpd = (u) => {
      const el = $('about-upd'); const sub = $('about-upd-sub'); const lab = $('about-branch-lab');
      if (!el || !sub) return;
      if (lab && u.branch) lab.textContent = `${tr('Branch')} ${u.branch}`;
      const rs = $('about-recheck-sub');
      if (rs && about?.packaged) rs.textContent = tr('ask the npm registry again');
      const what = about?.packaged ? tr('version') : tr('commit');
      const same = about?.packaged ? tr('matches the registry') : tr('matches GitHub');
      const tag = u.tag ? ` · ${tr('tag')} ${u.tag}` : '';
      el.className = 'about-fresh';
      $('about-do-upd')?.classList.toggle('hidden', u.update_available !== true);
      if (u.update_available === null) {
        el.textContent = '';
        sub.textContent = about?.packaged
          ? tr('cannot check — the npm registry did not answer')
          : tr('cannot check (no network, or the repo is private/not a git checkout)');
      }
      else if (u.update_available) {
        el.textContent = `⟳ ${tr('update available')} ${u.local} → ${u.remote}`;
        el.classList.add('stale-ver');
        sub.textContent = `${what} ${u.local}${tag}`;
      }
      else if (u.dev?.ahead) { el.textContent = `${tr('in dev')} ${u.dev.ahead} ${commitsWord(u.dev.ahead)} ${tr('awaiting release')}`; el.classList.add('stale-ver'); sub.textContent = `${tr('commit')} ${u.local}${tag} · ${tr('matches GitHub')}`; }
      else { el.textContent = tr('up to date ✓'); sub.textContent = `${what} ${u.local}${tag} · ${u.ahead ? tr('ahead of GitHub') : same}`; }
      const row = $('about-dev-row'); const dEl = $('about-dev'); const dSub = $('about-dev-sub');
      if (!row || !u.dev) return;
      row.classList.remove('hidden');
      dEl.className = 'about-fresh';
      if (u.dev.ahead) { dEl.textContent = `${u.dev.ahead} ${commitsWord(u.dev.ahead)} ${tr('awaiting release')}`; dEl.classList.add('stale-ver'); }
      else dEl.textContent = tr('matches main ✓');
      dSub.textContent = u.dev.sha
        ? `${u.dev.sha}${u.dev.date ? ` ${tr('at')} ${fmtDbTime(u.dev.date.slice(0, 19).replace('T', ' '))}` : ''}${u.dev.message ? ` · ${u.dev.message}` : ''}`
        : tr('dev has no commits beyond main');
    };
    let lastUpd = null;
    let newsRemote = false; // the notes of the version not installed yet were fetched for the open fold
    $('about-news')?.closest('details')?.addEventListener('toggle', (e) => {
      if (e.target.open && lastUpd?.update_available === true && !newsRemote) { newsRemote = true; loadNews(lastUpd); }
    });
    const loadNews = async (upd, forced) => {
      const box = $('about-news'); const sub = $('about-news-sub');
      if (!box || !sub) return;
      try {
        // opened; folded, the line says the installed version from the disk
        const open = Boolean(box.closest('details')?.open);
        const remote = open && upd?.update_available === true ? `?remote=1${forced ? '&refresh=1' : ''}` : '';
        const n = await api('GET', `/api/whats-new${remote}`, null, { quiet: true });
        box.innerHTML = n?.notes ? mdLite(n.notes) : `<p class="muted">${esc(tr('no notes for this version'))}</p>`;
        const ver = n?.version ? `${tr('version')} ${n.version}${n.source === 'github' ? ` · ${tr('not installed yet')}` : ''}` : '';
        const link = /^https:\/\//.test(n?.url || '')
          ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(tr('release page'))}</a>` : '';
        sub.innerHTML = esc(ver) + link;
      } catch { box.textContent = '—'; sub.textContent = ''; }
    };
    api('GET', '/api/about').catch(() => null).then((a) => { about = a; })
      .then(() => api('GET', '/api/update-check')).then((u) => { lastUpd = u; renderUpd(u); return loadNews(u); })
      .catch(() => { const s = $('about-upd-sub'); if (s) s.textContent = '—'; });
    const showFailCmd = (cmd) => {
      const wrap = $('about-upd-fail');
      if (!wrap) return;
      $('about-upd-cmd').textContent = cmd || '';
      wrap.classList.toggle('hidden', !cmd);
    };
    $('about-do-upd').onclick = async () => {
      const btn = $('about-do-upd'); const sub = $('about-upd-sub'); const el = $('about-upd');
      const ask = [tr('Update the board now? It will restart.'),
        tr('Your tasks are not touched: they live in the data directory, apart from the code.')];
      if (about?.packaged) ask.push(tr('The skills Claude reads come along with it, unless a copy already differs from the board\'s version — that one stays as it is.'));
      if (!(await styledConfirm(ask.join('\n')))) return;
      showFailCmd('');
      const label = btn.textContent;
      let phase = tr('installing…'); let sec = 0;
      const paint = () => { el.textContent = `${phase} ${sec}${tr('s')}`; };
      btn.disabled = true; btn.textContent = tr('Updating…');
      el.classList.add('stale-ver'); paint();
      const timer = setInterval(() => { sec += 1; paint(); }, 1000);
      const stop = (text, keepAccent) => {
        clearInterval(timer);
        el.textContent = text || '';
        el.classList.toggle('stale-ver', !!keepAccent);
        btn.textContent = label;
      };
      let r;
      try {
        r = await api('POST', '/api/update', null, { quiet: true });
      } catch (err) {
        stop(tr('Did not work out'), true);
        sub.textContent = refusalLine('the update did not go through', err, tr);
        showFailCmd(err.body?.cmd);
        btn.disabled = false; return;
      }
      if (!r?.ok) { stop(tr('Did not work out'), true); sub.textContent = `${tr('the update did not go through')}: ${(r?.output || '').split('\n').pop() || '—'}`; showFailCmd(r?.cmd); btn.disabled = false; return; }
      if (r.restart !== 'pm2') {
        stop('', false);
        sub.textContent = tr('updated — start the board again to pick it up')
          + (r.skills?.kept?.length ? ` · ${tr('left as it was — not the board\'s version:')} ${r.skills.kept.join(', ')}` : '');
        return;
      }
      phase = tr('restarting…'); sec = 0; paint();
      for (let i = 0; i < 60; i++) {
        await new Promise((ok) => setTimeout(ok, 1000));
        try { await api('GET', '/api/about', null, { quiet: true }); clearInterval(timer); location.reload(); return; } catch {  }
      }
      stop(tr('Did not work out'), true);
      sub.textContent = tr('updated, but the board did not come back — start it yourself');
    };

    $('about-recheck').onclick = async () => {
      const btn = $('about-recheck');
      btn.disabled = true; $('about-upd-sub').textContent = tr('checking…');
      try { const u = await api('GET', '/api/update-check?refresh=1'); lastUpd = u; newsRemote = false; renderUpd(u); await loadNews(u, true); }
      catch { const sub = $('about-upd-sub'); if (sub) sub.textContent = '—'; }
      btn.disabled = false;
    };
    let a;
    try { a = await api('GET', '/api/about'); } catch { a = null; }
    if (!$('about-diag')) return;
    try {
      if (!a) throw new Error('no answer');
      about = a;
      $('about-ver').textContent = (a.packaged && a.version) ? `v${a.version}`
        : a.commit ? `${tr('commit')} ${a.commit}`
        : (a.app_mtime ? `app.js ${tr('from')} ${fmtDbTime(a.app_mtime.slice(0, 19).replace('T', ' '))}` : '—');
      const up = a.uptime;
      const upStr = up >= 86400 ? `${Math.floor(up / 86400)}${tr('d')} ${Math.floor((up % 86400) / 3600)}${tr('h')}` : up >= 3600 ? `${Math.floor(up / 3600)}${tr('h')} ${Math.floor((up % 3600) / 60)}${tr('m')}` : `${Math.floor(up / 60)}${tr('m')}`;
      $('about-diag').innerHTML = [
        [tr('Database'), `${fmtNum(a.db_size / 1048576)} ${tr('MB')}`],
        [tr('Database path'), a.db_path],
        [tr('Server uptime'), upStr],
        [tr('Tasks · projects'), `${a.tasks} · ${a.projects}`],
        ['Node', a.node],
      ].map(([k, v]) => `<div class="bk-row"><span>${esc(k)}</span><span class="muted">${esc(String(v))}</span></div>`).join('');
    } catch { $('about-diag').textContent = '—'; }
  }
}

/* ── Settings → Claude Code ────────────────────────────────────────────────
   One place for the board's work with Claude Code: whether this computer has what the board needs (the programs ▶
   starts tasks with, the Claude folder and what the board reads in it, the two entries in settings.json), each piece
   with what does not work without it and how to fix it; connecting the board from here — the same change as
   `local-kanban hooks install|uninstall`, agreed to in a confirmation that shows exactly what will be written; and
   the two settings of how tasks start, moved here from General. What each row says is decided by
   claude-setup-rules.js; the server only looks (GET /api/claude) and writes on the person's word (PUT/DELETE
   /api/claude/hooks). */
let claudeSeq = 0;
// The words are the marks' hints and, under the section's heading, their legend.
const CC_MARK = { ok: ['✓', 'in place'], off: ['✕', 'needed and missing'], opt: ['–', 'not set up — needed only if you use it'], warn: ['!', 'needs a look'] };
const CC_WORD = { ok: 'in place', off: 'missing', opt: 'not set up', warn: 'needs a look' };
function ccValue(r) {
  if (r.count) return `${tr(r.count.label)}: ${r.count.n}`;
  if (r.time) return fmtLocalStamp(r.value);
  return r.value === undefined || r.value === null ? '' : String(r.value);
}
const ccLink = (f) => `<a class="cc-link" href="${esc(f.href)}"${/^https?:/.test(f.href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(tr(f.label))}</a>`;
function ccFix(f) {
  if (!f || f.connect) return '';
  if (f.cmd) return `<pre class="onb-code cc-cmd">${esc(f.cmd)}</pre>${f.href ? ccLink(f) : ''}`;
  if (f.href) return `${f.text ? `<div class="cc-fix muted">${esc(tr(f.text))}</div>` : ''}${ccLink(f)}`;
  if (f.section) return `<button type="button" class="btn-ghost cc-goto" data-sec="${esc(f.section)}">${esc(tr(f.label))}</button>`;
  return f.text ? `<div class="cc-fix muted">${esc(tr(f.text))}</div>` : '';
}
function ccRow(r) {
  const st = CC_MARK[r.state] ? r.state : 'warn';
  const [mark, word] = CC_MARK[st];
  const value = ccValue(r);
  const loud = st === 'off' || st === 'warn' || Boolean(r.say);
  return `<div class="set-row cc-row" data-id="${esc(r.id)}" data-state="${esc(r.state)}"${loud ? '' : ` title="${esc(tr(r.note))}"`}>`
    + `<span class="set-lab cc-main">${esc(tr(r.title))}${value ? `<small class="cc-value">${esc(value)}</small>` : ''}`
    + `${loud ? `<small class="cc-note">${esc(tr(r.note))}</small>` : ''}${st === 'ok' ? '' : ccFix(r.fix)}</span>`
    + `<span class="cc-state cc-${st}" title="${esc(tr(word))}"><span class="cc-mark cc-${st}" aria-hidden="true">${mark}</span>${esc(tr(CC_WORD[st]))}</span></div>`;
}
async function renderClaudeSection(body) {
  body.innerHTML = `<div class="sm-h" title="${esc(tr('What the board can use of Claude Code on this computer, and what it found. Nothing is started or sent anywhere to check it.'))}">Claude Code<button class="btn-ghost" id="cc-recheck">${tr('Check again')}</button></div>`
    // and the subscription limits (the sidebar footer, which says "no data" for good to someone working in the Claude app)
    + `<div class="sk-group-h">${tr('Show on the board')}</div>`
    + `<label class="set-row"><span class="set-lab">${tr('Claude usage')}<small>${tr('tokens and approximate money: the block on the dashboard and a line in the ⋯ menu of a card')}</small></span><input type="checkbox" class="set-toggle" data-set="showUsage"></label>`
    + `<label class="set-row"><span class="set-lab">${tr('Claude limits')}<small>${tr('the 5-hour and weekly limits of the subscription, at the bottom of the sidebar')}</small></span><input type="checkbox" class="set-toggle" data-set="showLimits"></label>`
    // of Claude now → Terminals is its chat or its terminal; a Claude the board did not start is always a chat
    + `<div class="set-row"><span class="set-lab">${tr('Show Claude as')}<small>${tr('in a card and in Claude now → Terminals; a Claude started outside the board is always a chat')}</small></span><div class="kbsel set-sel" id="sel-chatView"></div></div>`
    + `<div class="sk-group-h">${tr('Starting tasks')}</div>`
    + `<div class="set-row"><span class="set-lab">${tr('How ▶ starts Claude')}<small>${tr('what ▶ on To do and on a card does')}</small></span><div class="kbsel set-sel" id="sel-launch"></div></div>`
    + `<div class="set-row"><span class="set-lab">${tr('Claude inside the board may')}<small>${tr('what it does without asking you')}</small></span><div class="kbsel set-sel" id="sel-permission"></div></div>`
    + `<div class="set-row"><span class="set-lab">${tr('How hard Claude thinks')}<small>${tr('inside the board and in Terminal; the Claude app keeps its own')}</small></span><div class="kbsel set-sel" id="sel-effort"></div></div>`
    + `<div class="set-row"><span class="set-lab">${tr('How hard Claude thinks on a check')}<small>${tr('a check of the tasks in Review (Claude review)')}</small></span><div class="kbsel set-sel" id="sel-effort-check"></div></div>`
    + `<div class="sk-group-h">${tr('Automations')}</div>`
    + `<label class="set-row"><span class="set-lab">${tr('Turn on automations')}<small>${tr('a section in the sidebar: a check of Review starts by itself once Claude has finished the work of a project')}</small></span><input type="checkbox" class="set-toggle" id="set-automations"></label>`
    + '<div id="cc-list" class="cc-list">…</div>';
  const avail = await loadLaunchOptions();
  if (!$('sel-launch')) return; // the window was closed meanwhile
  buildSelect($('sel-launch'), { value: launchShown(pickedSetting('launch'), avail), options: [{ value: 'auto', label: tr('Automatically') }, { value: 'board', label: tr('Inside the board — at once, no windows') }, { value: 'desktop', label: tr('In the Claude app') }, { value: 'terminal', label: tr('In Terminal') }, { value: 'copy', label: tr('Only copy the prompt') }], onChange: (v) => setSetting('launch', v) });
  buildSelect($('sel-effort'), { value: effortOf(getSetting('effort')) || '', options: [{ value: '', label: tr('As in the settings of Claude Code') }, ...EFFORTS.map((v) => ({ value: v, label: tr(EFFORT_LABELS[v]) }))], onChange: (v) => setSetting('effort', v) });
  buildSelect($('sel-effort-check'), { value: effortOf(getSetting('effortCheck')) || '', options: [{ value: '', label: tr('As for every task') }, ...EFFORTS.map((v) => ({ value: v, label: tr(EFFORT_LABELS[v]) }))], onChange: (v) => setSetting('effortCheck', v) });
  buildSelect($('sel-permission'), { value: getSetting('permission'), options: [{ value: 'auto', label: tr('Auto — decides what is safe') }, { value: 'acceptEdits', label: tr('Edit files, ask about commands') }, { value: 'manual', label: tr('Ask about everything but the board commands') }, { value: 'plan', label: tr('Only make a plan') }], onChange: (v) => setSetting('permission', v) });
  // both apply at once: the dashboard behind the window, the open card and the sidebar follow the switch
  const usageBox = body.querySelector('[data-set="showUsage"]');
  usageBox.checked = getSetting('showUsage') !== false;
  usageBox.onchange = (e) => { setSetting('showUsage', e.target.checked); repaintUsage(); };
  const limitsBox = body.querySelector('[data-set="showLimits"]');
  limitsBox.checked = getSetting('showLimits') !== false;
  limitsBox.onchange = (e) => { setSetting('showLimits', e.target.checked); renderLimits(); };
  // applies at once: the open card and the columns follow the choice
  buildSelect($('sel-chatView'), { value: getSetting('chatView') === 'chat' ? 'chat' : 'terminal', options: [{ value: 'chat', label: tr('A chat') }, { value: 'terminal', label: tr('A terminal') }], onChange: (v) => setClaudeView(v) });
  const autoBox = $('set-automations');
  autoBox.checked = automations().on;
  autoBox.onchange = async (e) => {
    const on = e.target.checked;
    autoBox.disabled = true;
    try { applyAutomations(await api('PUT', '/api/automations/switch', { on }, { quiet: true })); } catch (err) {
      e.target.checked = !on;
      styledAlert(refusalLine('Could not switch the automations', err, tr));
    }
    autoBox.disabled = false;
  };
  $('cc-recheck').onclick = () => loadClaude();
  await loadClaude();
}
/** Read what the board has of Claude Code and draw it; `note` — the outcome of a connect / take off, kept on screen
    ({text, bad}: a refusal stands out, and either way it is scrolled into view — the buttons sit at the very bottom). */
async function loadClaude(note = null) {
  const seq = ++claudeSeq;
  let d;
  try { d = await api('GET', '/api/claude', undefined, { quiet: true }); } catch (e) {
    if (seq !== claudeSeq || !$('cc-list')) return;
    const text = tr(e.offline ? 'No connection to the board — try again' : 'Could not check — the board did not answer');
    // says what happened: the outcome of connecting when there was one (it already says nothing was written), else
    // that the check did not go through
    const done = $('cc-done');
    if (done) {
      // a connect or a take off that WENT THROUGH: the buttons on screen are of the file before it (and its fingerprint) —
      const wrote = Boolean(note && !note.bad);
      done.textContent = wrote ? `${note.text} ${text}` : note?.text || text;
      done.className = 'cc-done kbh-note warn';
      for (const [id, on] of Object.entries(loadClaude.buttons || {})) { const b = $(id); if (b) b.disabled = wrote || !on; }
      done.scrollIntoView({ block: 'nearest' });
      return;
    }
    $('cc-list').innerHTML = `<div class="kbh-note warn">${esc(text)}</div>`;
    return;
  }
  const list = $('cc-list');
  if (seq !== claudeSeq || !list) return; // overtaken, or the section was closed
  const groups = setupView(d);
  const btn = hooksButtons(d.settings);
  loadClaude.buttons = { 'cc-connect': btn.connect, 'cc-disconnect': btn.disconnect };
  // nothing was written by itself, so the buttons' reason would only repeat them
  const why = btn.why && !d.settings?.error && !note?.bad ? btn.why : null;
  list.innerHTML = groups.map((g) => {
    // the rows of «Starting tasks» go under its two settings, which the section draws above the list
    const head = g.id === 'programs' ? '' : `<div class="sk-group-h">${esc(tr(g.title))}</div>`;
    // the file the connection lives in (the folder's own row names the folder)
    const where = g.id === 'connection' ? `<div class="cc-where muted">${esc(d.settings?.path || '')}</div>` : '';
    const actions = g.id === 'connection'
      ? `<div class="cc-actions"><button type="button" class="btn-primary" id="cc-connect"${btn.connect ? '' : ' disabled'}>${tr('Connect')}</button>`
        + `<button type="button" class="btn-ghost" id="cc-disconnect"${btn.disconnect ? '' : ' disabled'}>${tr('Disconnect')}</button></div>`
        + (why ? `<div class="kbh-note warn cc-why">${esc(tr(why))}</div>` : '')
        + `<div class="cc-done ${note?.bad ? 'kbh-note warn' : 'muted'}${note ? '' : ' hidden'}" id="cc-done">${esc(note?.text || '')}</div>`
      : '';
    return head + where + g.rows.map(ccRow).join('') + actions;
  }).join('');
  list.querySelectorAll('.cc-goto').forEach((b) => {
    b.onclick = () => document.querySelector(`#settings-overlay .sm-nav-item[data-sec="${CSS.escape(b.dataset.sec)}"]`)?.click();
  });
  $('cc-connect').onclick = () => changeClaudeHooks('install', d.settings);
  $('cc-disconnect').onclick = () => changeClaudeHooks('uninstall', d.settings);
  if (note) $('cc-done')?.scrollIntoView({ block: 'nearest' });
}
/* Connect or take off: the confirmation shows exactly what goes into the file; the board writes only the file the
   page showed the change for (`seen`) — one that changed meanwhile is refused, and the section is read again. With
   no connection nothing is queued to be sent later: the consent was for the file as it was. */
async function changeClaudeHooks(action, s) {
  const install = action === 'install';
  const lines = changeLines(install ? s.install : s.uninstall);
  // confirmation and does not close the first one
  if (!lines.length || changeClaudeHooks.busy) return;
  changeClaudeHooks.busy = true;
  try {
    const ask = s.other_board
      ? `${tr('Another board is connected to Claude Code:')} ${s.other_board}. ${tr(install ? 'Take it over and connect this one?' : 'Take it off Claude Code?')}`
      : tr(install ? 'Connect the board to Claude Code?' : 'Take the board off Claude Code?');
    const ok = await styledConfirm(ask, {
      okLabel: tr(install ? 'Connect' : 'Disconnect'),
      detail: `${s.path}\n\n${lines.join('\n')}\n\n${s.exists
        ? `${tr('Everything else in the file stays as it is.')} ${tr('The previous file is kept in the board\'s backups.')}`
        : tr('There is no such file yet — it will be made.')}`,
    });
    if (!ok) return;
    for (const id of ['cc-connect', 'cc-disconnect']) { const b = $(id); if (b) b.disabled = true; }
    let note;
    try {
      const r = await api(install ? 'PUT' : 'DELETE', '/api/claude/hooks', { seen: s.seen }, { quiet: true });
      note = { text: !r.written ? tr('Nothing to change')
        : [tr(install ? 'Connected ✓' : 'Taken off ✓'), r.kept ? `${tr('the previous file is kept as')} ${r.kept}` : '', tr('New Claude Code sessions pick it up.')].filter(Boolean).join(' · ') };
    } catch (e) { note = { text: tr(hooksRefusal(e)), bad: true }; }
    loadLimits();
    await loadClaude(note);
  } finally { changeClaudeHooks.busy = false; }
}

let skillSel = null;
let skillsInfo = null;
let pendingSkill = null;
export function skillDirty() {
  const ta = $('sk-text');
  return Boolean(skillSel && ta && ta.value !== skillSel.saved);
}
function updateSkillState(note) {
  const dirty = skillDirty();
  const save = $('sk-save');
  if (save) save.disabled = !dirty;
  const el = $('sk-note');
  if (!el) return;
  if (note !== undefined) { el.textContent = note; return; }
  el.textContent = dirty ? tr('changed — not written to the file yet') : '';
}
async function selectSkillRow(name) {
  const list = $('sk-list');
  const row = list?.querySelector(`.sk-row[data-name="${CSS.escape(name)}"]`);
  if (!row) return;
  list.querySelectorAll('.sk-row').forEach((x) => x.classList.toggle('active', x === row));
  $('sk-edit').classList.remove('hidden');
  await loadSkillText(name);
}

let skillLoadSeq = 0;
function setSkillButtons(enabled) {
  for (const id of ['sk-fetch', 'sk-save', 'sk-del']) { const b = $(id); if (b) b.disabled = !enabled; }
}
async function loadSkillText(name) {
  const ta = $('sk-text');
  if (!ta) return;
  const seq = ++skillLoadSeq;
  skillSel = null;
  setSkillButtons(false);
  ta.value = '';
  let r;
  try { r = await api('GET', `/api/skills/${seg(name)}`); }
  catch (e) { if (seq === skillLoadSeq) updateSkillState(errorLine('could not read the file', e, tr)); return; }
  if (seq !== skillLoadSeq) return;
  if (!$('sk-text')) return;
  setSkillButtons(true);
  skillSel = { name, real_path: r.real_path, symlink: r.symlink, exists: r.exists, saved: r.text || '' };
  ta.value = skillSel.saved;
  $('sk-path').textContent = r.real_path;
  const shared = (skillsInfo?.packaged_skills || []).includes(name);
  $('sk-fetch').disabled = !shared;
  $('sk-del').disabled = false;
  $('sk-fetch').title = shared ? '' : tr('the board has no shared version of this skill — it is your own');
  $('sk-del').classList.toggle('hidden', !r.exists);
  $('sk-link-warn').classList.toggle('hidden', !r.symlink);
  $('sk-link-warn').textContent = r.symlink
    ? `${tr('this is a symlink — saving rewrites the file it points to:')} ${r.real_path}`
    : '';
  $('sk-stale').classList.toggle('hidden', !(name === skillsInfo?.board_skill && skillsInfo?.board?.package_state === 'differs'));
  updateSkillState(r.exists ? '' : tr('the skill is not installed — the file will be created on save'));
}
async function renderSkillsSection(body) {
  body.innerHTML = `<div class="sm-h">${tr('Skills')}<button class="btn-ghost" id="sk-new">${tr('＋ New skill')}</button></div>`
    + `<div class="set-row hidden" id="sk-where" title="${esc(tr('Skills are the instructions Claude reads. They live outside the board, in the skills folder of the Claude folder, and the board only shows and updates them.'))}"></div>`
    + '<div id="sk-list" class="bk-list">…</div>'
    + `<div class="set-col sk-edit hidden" id="sk-edit">
        <span class="set-lab">${tr('Skill file')}<small class="sk-path" id="sk-path"></small></span>
        <div class="kbh-note warn hidden" id="sk-link-warn"></div>
        <div class="kbh-note warn sk-stale hidden" id="sk-stale"><span>${tr('This copy is not the version this board ships: Claude may follow rules the board no longer has.')}</span>
          <button class="btn-ghost" id="sk-take">${tr('Take the board\'s version')}</button></div>
        <textarea id="sk-text" class="sk-text" spellcheck="false"></textarea>
        <div class="sk-actions">
          <button class="btn-ghost" id="sk-fetch">${tr('Load the shared version')}</button>
          <button class="btn-ghost" id="sk-revert">${tr('Revert')}</button>
          <button class="btn-primary" id="sk-save" disabled>${tr('Save to the file')}</button>
          <button class="btn-ghost sk-del hidden" id="sk-del">${tr('Delete')}</button>
          <span class="muted sk-note" id="sk-note"></span>
        </div>
      </div>`;
  let info;
  const list = $('sk-list');
  try { info = await api('GET', '/api/skills'); }
  catch { if (list.isConnected) list.textContent = '—'; return; }
  if (!list.isConnected) return;
  skillsInfo = info;
  if (info.folder?.path) {
    const extra = (info.roots || []).slice(1);
    const from = info.folder.from && info.folder.from !== 'default' ? `<small>${esc(tr(folderFrom(info.folder.from)))}</small>` : '';
    $('sk-where').innerHTML = `<span class="set-lab">${tr('Skills folder')}<small class="sk-path">${esc(info.folder.path)}</small>${from}`
      + (extra.length ? `<small>${esc(tr('Also read from KB_SKILLS_EXTRA:'))} <span class="sk-path">${esc(extra.join(', '))}</span></small>` : '') + '</span>';
    $('sk-where').classList.remove('hidden');
  }
  const items = [...info.items];
  if (!items.some((s) => s.name === info.board_skill)) items.unshift({ ...info.board, used_by: [], packaged: true });
  items.sort((a, b) => (a.name === info.board_skill ? -1 : b.name === info.board_skill ? 1 : a.name.localeCompare(b.name)));
  const usedByLabel = (list) => (list.length > 2
    ? `${tr('used by')} ${list.length} ${plural(list.length, 'project', 'projects')}`
    : `${tr('used by')} ${list.map((p) => p.name || p.slug).join(', ')}`);
  const tagsFor = (s) => {
    const tags = [];
    if (s.name === info.board_skill) tags.push(tr('board skill'));
    if (s.name === info.board_skill && info.board?.package_state === 'differs') tags.push(tr('not the board\'s version'));
    if (s.name === info.generic_deploy_skill) tags.push(tr('shared deploy skill'));
    if (s.used_by?.length) tags.push(usedByLabel(s.used_by));
    if (!s.exists) tags.push(tr('not installed'));
    return tags;
  };
  const stale = tr('not the board\'s version');
  const row = (s) => `<div class="bk-row sk-row" data-name="${esc(s.name)}" title="${esc((s.used_by || []).map((p) => p.name || p.slug).join(', '))}">
      <span class="sk-name"><span class="sk-title">${esc(s.name)}</span>${tagsFor(s).map((t) => `<span class="ps-doc-tag${t === stale ? ' warn' : ''}">${esc(t)}</span>`).join('')}</span>
      <span class="muted sk-meta" title="${esc(s.real_path)}">${s.exists ? `${Math.max(1, Math.round((s.size || 0) / 1024))} ${tr('KB')} · ${esc(s.mtime ? fmtLocalStamp(s.mtime).slice(0, 10) : '')}` : '—'}</span>
    </div>`;
  const own = new Set(info.own_skills || []);
  const isDeploy = (s) => s.name === info.generic_deploy_skill || s.used_by?.length || own.has(s.name);
  const groups = [
    [tr('The board'), items.filter((s) => s.name === info.board_skill)],
    [tr('Deploy skills'), items.filter((s) => s.name !== info.board_skill && isDeploy(s))],
  ];
  $('sk-list').innerHTML = groups.filter(([, list]) => list.length)
    .map(([title, list]) => `<div class="sk-group-h">${esc(title)}</div>${list.map(row).join('')}`).join('');
  $('sk-list').querySelectorAll('.sk-row').forEach((row) => {
    row.onclick = async () => { if (await leaveSkillEditor()) selectSkillRow(row.dataset.name); };
  });
  $('sk-new').onclick = async () => {
    if (!await leaveSkillEditor()) return;
    styledPrompt(tr('New skill'), {
      placeholder: tr('name: latin letters, digits, hyphen'),
      okLabel: tr('Create'),
      onSubmit: async (raw) => {
        const name = raw.trim();
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) throw new Error(tr('name: latin letters, digits, hyphen, underscore only'));
        const cur = await api('GET', `/api/skills/${seg(name)}`);
        if (cur.exists) {
          await api('POST', `/api/skills/${seg(name)}/adopt`);
          pendingSkill = name;
          await renderSection('skills');
          updateSkillState(tr('this skill was already on disk — added it to the list'));
          return;
        }
        let text = `---\nname: ${name}\ndescription: \n---\n\n`;
        if ((info.packaged_skills || []).includes(name)) {
          try { text = (await api('GET', `/api/skills/${seg(name)}/upstream?lang=${LANG}`, null, { quiet: true })).text; }
          catch {  }
        }
        await api('PUT', `/api/skills/${seg(name)}`, { text, confirm_path: cur.real_path });
        pendingSkill = name;
        await renderSection('skills');
        updateSkillState(tr('created ✓'));
      },
    });
  };

  $('sk-del').onclick = async () => {
    if (!skillSel) return;
    const item = (skillsInfo?.items || []).find((s) => s.name === skillSel.name);
    const used = (item?.used_by || []).map((p) => p.name || p.slug);
    const msg = `${tr('Delete the skill')} «${skillSel.name}»?\n${skillSel.real_path}`
      + (skillSel.symlink ? `\n${tr('this is a link — only the link is removed, the file it points to stays')}` : '')
      + (used.length ? `\n${tr('used by')}: ${used.join(', ')}` : '');
    if (!await styledConfirm(msg, { okLabel: tr('Delete'), danger: true })) return;
    try { await api('DELETE', `/api/skills/${seg(skillSel.name)}`, { confirm_path: skillSel.real_path }); }
    catch (e) {
      // the file is not the one shown, or the skill is gone: the section is drawn again first, the reason goes after it
      const why = errorLine('not deleted', e, tr);
      if (e.status === 404 || e.status === 409) { pendingSkill = skillSel.name; await renderSection('skills'); }
      updateSkillState(why);
      return;
    }
    skillSel = null;
    renderSection('skills');
  };

  $('sk-take').onclick = async () => {
    if (!skillSel) return;
    if (!await leaveSkillEditor()) return; // the editor's own unsaved text would be read over
    const ok = await styledConfirm(`${tr('Replace this skill with the version this board ships?')} ${tr('The current file is kept among the board\'s backups.')}`,
      { okLabel: tr('Replace'), detail: skillSel.real_path });
    if (!ok) return;
    const name = skillSel.name;
    $('sk-take').disabled = true;
    let r;
    try { r = await api('POST', `/api/skills/${seg(name)}/refresh`, { confirm_path: skillSel.real_path }, { quiet: true }); } catch (e) {
      $('sk-take').disabled = false;
      // the file is not what the page showed — draws the section again first (its state, the tag and the box come
      // with it), and the reason goes on the line after that, or the drawing would clear it
      const why = e.body?.reason === 'link' ? tr('this is a link to a file elsewhere — the board does not write through it')
        : e.body?.reason === 'no-folder' ? tr('No such folder — check KB_CLAUDE_DIR. Nothing was written.')
        : e.body?.reason === 'changed' ? tr('the file on disk changed — look at it again')
          : e.offline ? tr('No connection to the board — try again')
            : e.status >= 500 ? tr('the board answered with an error — the details are in Settings → Errors') : tr('did not save');
      if (e.status === 409) { pendingSkill = name; await renderSection('skills'); }
      updateSkillState(why);
      return;
    }
    pendingSkill = name;
    await renderSection('skills');
    updateSkillState(r.kept?.length ? `${tr('the board\'s version is in place ✓ · the previous one is kept as')} ${r.kept.join(', ')}` : tr('the board\'s version is in place ✓'));
  };

  $('sk-text').oninput = () => updateSkillState();
  $('sk-revert').onclick = () => { if (skillSel) loadSkillText(skillSel.name); };
  $('sk-fetch').onclick = async () => {
    if (!skillSel) return;
    const btn = $('sk-fetch');
    btn.disabled = true;
    updateSkillState(tr('fetching…'));
    try {
      const r = await api('GET', `/api/skills/${seg(skillSel.name)}/upstream?lang=${LANG}`);
      $('sk-text').value = r.text;
      updateSkillState(`${r.source === 'github' ? tr('loaded from GitHub') : tr('loaded from the installed package')}`
        + ` · ${r.lang.toUpperCase()} · ${tr('nothing is written to disk until you save')}`);
    } catch (e) { updateSkillState(errorLine('could not load', e, tr)); }
    btn.disabled = false;
  };
  $('sk-save').onclick = async () => {
    if (!skillSel || !skillDirty()) return;
    const ok = await styledConfirm(`${tr('Overwrite this file?')}\n${skillSel.real_path}`, { okLabel: tr('Overwrite'), danger: true });
    if (!ok) return;
    $('sk-save').disabled = true;
    try {
      const r = await api('PUT', `/api/skills/${seg(skillSel.name)}`, { text: $('sk-text').value, confirm_path: skillSel.real_path });
      skillSel.saved = $('sk-text').value;
      updateSkillState(r.backup_name ? `${tr('saved ✓ · the previous version is kept as')} ${r.backup_name}` : tr('saved ✓'));
    } catch (e) {
      updateSkillState(errorLine('did not save', e, tr));
      // a Claude folder KB_CLAUDE_DIR names that is not there (409 no-folder): the skill is not installed, and reading it
      if (e.status === 409 && e.body?.reason !== 'no-folder') loadSkillText(skillSel.name);
    }
  };

  const want = pendingSkill && items.some((s) => s.name === pendingSkill) ? pendingSkill : items[0]?.name;
  pendingSkill = null;
  if (want) await selectSkillRow(want);
}

let stopRemap = null;
function listenRemap(row) {
  if (row.classList.contains('listening')) return;
  stopRemap?.();
  const kbd = row.querySelector('kbd');
  const prev = kbd.textContent;
  row.classList.add('listening');
  kbd.textContent = tr('press a key…');
  const done = (label) => {
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('pointerdown', onPointer, true);
    if (stopRemap === cancel) stopRemap = null;
    row.classList.remove('listening');
    kbd.textContent = label;
  };
  const cancel = () => done(prev);
  stopRemap = cancel;
  const flash = (msg) => { kbd.textContent = msg; setTimeout(() => { if (row.classList.contains('listening')) kbd.textContent = tr('press a key…'); }, 900); };
  function onPointer(e) { if (!row.contains(e.target)) cancel(); }
  function onKey(e) {
    if (!row.isConnected) { cancel(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (['Shift', 'Meta', 'Alt', 'Control'].includes(e.key)) return;
    if (e.code === 'Escape') { done(prev); return; }
    if (e.code.startsWith('Arrow')) { flash(tr('the arrow keys are taken')); return; }
    const b = { code: e.code, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
    const clash = KEY_ACTIONS.find((a) => a.id !== row.dataset.act && comboLabel(keyBinding(a.id)) === comboLabel(b));
    if (clash) { flash(`${tr('taken')}: ${comboLabel(keyBinding(clash.id))}`); return; }
    const km = { ...getSetting('keymap') };
    km[row.dataset.act] = b;
    setSetting('keymap', km);
    done(comboLabel(b));
  }
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('pointerdown', onPointer, true);
}

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const RANGE_LABEL = { week: tr('this week'), month: tr('this month'), half: tr('in 6 months'), year: tr('this year') };
export const RANGE_BTN = [['week', 'Week'], ['month', 'Month'], ['half', 'Half a year'], ['year', 'Year']];
export function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function fmtLocalStamp(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  return `${ymdLocal(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function fmtDbTime(s) {
  const d = new Date(s.replace(' ', 'T') + 'Z');
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// commit counter: one call, both languages
function commitsWord(n) {
  return plural(n, 'commit', 'commits');
}

// Plurals. English is the source language and needs two forms, so that is the call signature:
// plural(n, 'task', 'tasks'). Russian needs three and picks them by a rule of its own, so the
// forms live here keyed by the English singular. A word with no entry falls back to the English
// pair — a missing translation shows an English word, it does not break the sentence.
const PLURAL_RU = {
  task: ['задача', 'задачи', 'задач'],
  'task to delete': ['задачу', 'задачи', 'задач'],
  commit: ['коммит', 'коммита', 'коммитов'],
  project: ['проект', 'проекта', 'проектов'],
  session: ['сессия', 'сессии', 'сессий'],
  step: ['шаг', 'шага', 'шагов'],
  line: ['строка', 'строки', 'строк'],
  character: ['знак', 'знака', 'знаков'],
  subfolder: ['подпапка', 'подпапки', 'подпапок'],
  token: ['токен', 'токена', 'токенов'],
  file: ['файл', 'файла', 'файлов'],
  event: ['событие', 'события', 'событий'],
  command: ['команду', 'команды', 'команд'],
  time: ['раз', 'раза', 'раз'],
  helper: ['помощника', 'помощников', 'помощников'],
  skill: ['скилл', 'скилла', 'скиллов'],
  question: ['вопрос', 'вопроса', 'вопросов'],
  tool: ['инструмент', 'инструмента', 'инструментов'],
  'background task': ['фоновую работу', 'фоновые работы', 'фоновых работ'],
};
export function plural(n, one, many) {
  const forms = LANG === 'ru' && PLURAL_RU[one];
  if (!forms) return n === 1 ? one : many;
  const m10 = n % 10; const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return forms[0];
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return forms[1];
  return forms[2];
}
const tipTasks = (n) => `${n} ${plural(n, 'task', 'tasks')}`;
function heatBg(n, max) {
  if (!n) return 'background:var(--border-soft)';
  const lvl = Math.min(4, Math.ceil((n / max) * 4));
  return `background:rgba(232, 112, 78,${[0, 0.28, 0.5, 0.74, 1][lvl]})`;
}

export function calendarHTML(days, since) {
  const map = Object.fromEntries(days.map((x) => [x.d, x.n]));
  const max = Math.max(1, ...days.map((x) => x.n));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = since ? new Date(`${since}T00:00:00`) : new Date(today);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const cells = [];
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = ymdLocal(d);
    if (since && key < since) { cells.push('<div class="hcell hcell-off"></div>'); continue; }
    const n = map[key] || 0;
    cells.push(`<div class="hcell" data-tip="${tipTasks(n)}" data-tip-sub="${dayLabel(key)}" style="${heatBg(n, max)}"></div>`);
  }
  return `<div class="hscroll"><div class="cal">${cells.join('')}</div></div>`;
}

export function timeHeatHTML(rows) {
  const grid = Array.from({ length: 7 }, () => Array(24).fill(0));
  let max = 1;
  for (const r of rows) { const row = (r.w + 6) % 7; grid[row][r.h] = r.n; if (r.n > max) max = r.n; }
  let html = '<div class="thm">';
  for (let row = 0; row < 7; row++) {
    html += `<div class="thm-day">${tr(DOW[row])}</div>`;
    for (let h = 0; h < 24; h++) {
      html += `<div class="hcell" data-tip="${tipTasks(grid[row][h])}" data-tip-sub="${tr(DOW[row])} ${h}:00" style="${heatBg(grid[row][h], max)}"></div>`;
    }
  }
  return `${html}</div><div class="thm-axis"><span>0</span><span>6</span><span>12</span><span>18</span><span>23</span></div>`;
}

export function doneBarsHTML(days, since) {
  const map = Object.fromEntries(days.map((x) => [x.d, x.n]));
  const max = Math.max(1, ...days.map((x) => x.n));
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const start = since ? new Date(`${since}T00:00:00`) : new Date(today);
  const bars = [];
  for (let d = new Date(start); d <= today; d.setDate(d.getDate() + 1)) {
    const key = ymdLocal(d); const n = map[key] || 0;
    bars.push(`<div class="bar-col" data-tip="${n} ${plural(n, 'task', 'tasks')}" data-tip-sub="${dayLabel(key)}"><div class="bar" style="height:${Math.round((n / max) * 100)}%"></div><div class="bar-x">${d.getDate()}</div></div>`);
  }
  return `<div class="hscroll"><div class="bars">${bars.join('')}</div></div>`;
}

export function topProjHTML(list) {
  if (!list.length) return `<div class="muted">${tr('nothing finished yet')}</div>`;
  const max = Math.max(...list.map((x) => x.n));
  return list.map((p) => `<div class="tp-row"><span class="tp-name" title="${esc(p.name)}">${esc(p.name)}</span>`
    + `<span class="tp-bar-wrap"><span class="tp-bar" style="width:${Math.round((p.n / max) * 100)}%"></span></span>`
    + `<span class="tp-n">${p.n}</span></div>`).join('');
}

function wRow(t, dot, meta, wrapMeta) {
  const metaHTML = meta
    ? `<span class="${wrapMeta ? 'wr-reason' : 'wr-meta'}">${esc(meta)}</span>`
    : '';
  return `<div class="wait-row${wrapMeta && meta ? ' wait-row-wrap' : ''}" data-key="${t.key}">`
    + `<span class="dot s-${dot} wr-dot" data-pick="${t.key}" data-cur="${dot}" title="${esc(tr('change status'))}"></span>`
    + `<span class="wr-key">${t.key}</span><span class="wr-title">${titleOr(t)}</span>`
    + `<span class="wr-proj">${esc(t.project)}</span>${metaHTML}</div>`;
}

function closeStatusPicker() {
  popLayer('status-picker');
  $('status-picker')?.remove();
  document.removeEventListener('click', spOutside);
}
function spOutside(e) {
  const m = $('status-picker');
  if (m && !m.contains(e.target) && !e.target.classList.contains('wr-dot')) closeStatusPicker();
}
export function openStatusPicker(anchor, key, current) {
  closeStatusPicker();
  pushLayer('status-picker', closeStatusPicker);
  const menu = document.createElement('div');
  menu.className = 'status-picker';
  menu.id = 'status-picker';
  menu.innerHTML = ALL_STATUSES.map(([v, lab]) => {
    const disabled = WORKING.has(v) && v !== current;
    return `<div class="sp-opt${v === current ? ' active' : ''}${disabled ? ' disabled' : ''}" data-v="${v}">`
      + `<span class="dot s-${v}"></span>${lab}</div>`;
  }).join('');
  document.body.appendChild(menu);
  const r = anchor.getBoundingClientRect();
  let left = r.left; let top = r.bottom + 5;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = r.top - menu.offsetHeight - 5;
  if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - menu.offsetWidth - 8;
  menu.style.left = `${Math.max(8, left)}px`;
  menu.style.top = `${Math.max(8, top)}px`;
  menu.querySelectorAll('.sp-opt:not(.disabled)').forEach((o) => {
    o.onclick = async (e) => {
      e.stopPropagation();
      closeStatusPicker();
      if (o.dataset.v === current) return;
      try { await api('PATCH', `/api/tasks/${seg(key)}`, { status: o.dataset.v }, { quiet: true }); }
      catch {  }
      await refresh();
    };
  });
  setTimeout(() => document.addEventListener('click', spOutside), 0);
}
function claudeMeta(t) {
  if (t.claude === 'gone') return tr(t.interrupted ? 'session interrupted' : 'session closed');
  if (t.claude === 'limit') return `${tr('limit reached')}${t.resets ? ` · ${tr('until')} ${t.resets}` : ''}`;
  const what = tr(t.broke ? 'answer broke off' : 'waiting for you');
  if (!t.since) return what;
  const mins = Math.max(1, Math.round((Date.now() - t.since) / 60000));
  return `${what} · ${mins < 60 ? `${mins} ${tr('min')}` : `${Math.floor(mins / 60)} ${tr('h')}`}`;
}
const WAIT_FOLD_KEY = 'kb.ui.waitFold';
export function waitFolded() {
  try { const v = JSON.parse(localStore.getItem(WAIT_FOLD_KEY) || '[]'); return new Set(Array.isArray(v) ? v : []); } catch { return new Set(); }
}
/** Remember whether a list of "Waiting for you" is folded. */
export function setWaitFolded(id, folded) {
  const set = waitFolded();
  if (folded) set.add(id); else set.delete(id);
  try { localStore.setItem(WAIT_FOLD_KEY, JSON.stringify([...set])); } catch { /* private mode: until reload */ }
}
export function waitingHTML(w, folded = waitFolded()) {
  const sec = (id, title, list, row) => `<details class="wait-sec" data-sec="${id}"${folded.has(id) ? '' : ' open'}>`
    + `<summary class="wait-sec-h" title="${esc(tr('fold or unfold the list'))}">${esc(title)} (${list.length})</summary>${list.map(row).join('')}</details>`;
  const secs = [];
  if (w.claude?.length) secs.push(sec('claude', 'Claude', w.claude, (t) => wRow(t, t.status || 'doing', claudeMeta(t))));
  if (w.review.length) secs.push(sec('review', tr('Check'), w.review, (t) => wRow(t, 'review', '')));
  if (w.blocked.length) secs.push(sec('blocked', tr('Blocked'), w.blocked, (t) => wRow(t, 'cancelled', t.reason || '', true)));
  if (w.stale.length) secs.push(sec('stale', tr('Stalled'), w.stale, (t) => wRow(t, 'doing', `${t.hours}${tr('h without movement')}`)));
  if (!secs.length) return `<div class="wait-empty">✓ ${tr('All clear — nothing needs your decision')}</div>`;
  return secs.join('');
}

function dayLabel(key) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  if (key === ymdLocal(today)) return tr('Today');
  if (key === ymdLocal(yest)) return tr('Yesterday');
  const [, m, d] = key.split('-');
  return `${Number(d)} ${SHORT_MONTHS[Number(m) - 1]}`;
}
export function feedHTML(items) {
  if (!items.length) return `<div class="muted">${tr('no activity yet')}</div>`;
  const byDay = new Map();
  for (const e of items) {
    const key = ymdLocal(new Date(`${e.created_at}Z`));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }
  let html = '';
  for (const [day, evs] of byDay) {
    html += `<div class="feed-day">${dayLabel(day)} <span class="feed-day-n">· ${evs.length} ${plural(evs.length, 'event', 'events')}</span></div>`;
    for (const e of evs) {
      html += `<div class="feed-row" data-key="${e.key}"><span class="dot s-${e.status}"></span>`
        + `<span class="fr-key fr-proj" title="${esc(e.project || '')}">${esc(e.project || e.key)}</span><span class="fr-title">${titleOr(e)}</span>`
        + `<span class="fr-arrow">→ ${STATUS_LABELS[e.status] || e.status}</span>`
        + `<span class="fr-time">${relTime(e.created_at)}</span></div>`;
    }
  }
  return html;
}

export function streaks(days) {
  const set = new Set(days.filter((x) => x.n > 0).map((x) => x.d));
  if (!set.size) return [0, 0];
  const sorted = [...set].sort();
  let max = 1; let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const diff = Math.round((new Date(`${sorted[i]}T00:00:00`) - new Date(`${sorted[i - 1]}T00:00:00`)) / 86400000);
    run = diff === 1 ? run + 1 : 1;
    if (run > max) max = run;
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(today);
  if (!set.has(ymdLocal(d))) d.setDate(d.getDate() - 1);
  let cur = 0;
  while (set.has(ymdLocal(d))) { cur++; d.setDate(d.getDate() - 1); }
  return [cur, max];
}

export function statCard(label, value, sub) {
  return `<div class="dcard"><div class="dc-label">${label}</div><div class="dc-value">${value}</div>`
    + `${sub ? `<div class="dc-sub">${sub}</div>` : ''}</div>`;
}

export function isoWeek(d) {
  const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((dt - firstThu) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
}
export function dashPanel(title, body, extra) {
  return `<div class="panel"><div class="panel-h">${title}${extra || ''}</div>${body}</div>`;
}
export const HEAT_LEGEND = `<span class="heat-legend">${tr('less')}`
  + '<span class="hcell hcell-off"></span>'
  + '<span class="hcell" style="background:rgba(232, 112, 78,.28)"></span>'
  + '<span class="hcell" style="background:rgba(232, 112, 78,.5)"></span>'
  + '<span class="hcell" style="background:rgba(232, 112, 78,.74)"></span>'
  + `<span class="hcell" style="background:rgba(232, 112, 78,1)"></span>${tr('more')}</span>`;
