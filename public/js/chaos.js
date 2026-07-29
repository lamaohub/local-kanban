
import { buildSelect, selVal } from './board.js';
import { $, LABEL_COLORS, LABEL_SELECTABLE, PRI_ICON, PRI_LEVELS, api, esc, ic, state, tr } from './core.js';
import { openDrawer, openLightbox, uploadAttachment } from './drawer.js';
import { loadProjects } from './sidebar.js';
import { autoGrow, refresh, titleOr } from './sse.js';

const CHAOS_IC = {
  attach: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M11 5.2 6.3 9.9a1.7 1.7 0 0 0 2.4 2.4l4.7-4.7a3.2 3.2 0 0 0-4.6-4.5L4 7.9a4.8 4.8 0 0 0 6.8 6.8l3-3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  noclaude: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle cx="8" cy="5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3.6 13a4.4 4.4 0 0 1 8.8 0" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  go: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 8h9M9.2 4.4 12.8 8l-3.6 3.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tag: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2.2H3.2a1 1 0 0 0-1 1V8l5.6 5.6a1.2 1.2 0 0 0 1.7 0l3.9-3.9a1.2 1.2 0 0 0 0-1.7L8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/><circle cx="5.4" cy="5.4" r="1" fill="currentColor"/></svg>',
  flag: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M4 14V2.6M4 3.2h7.5l-1.6 2.4 1.6 2.4H4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  stBacklog: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  stTodo: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><circle cx="8" cy="8" r="5" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="2.3" fill="currentColor"/></svg>',
  pin: '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M9.6 2.2 13.8 6.4M11 4 7.6 7.4l-3 .6 4.4 4.4.6-3L13 6M5.2 10.8 2.6 13.4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  lockClosed: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
  lockOpen: '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.4" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.0-.8" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  spark: '<svg viewBox="0 0 32 32" width="28" height="28" aria-hidden="true"><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 16 29 16M16 16 27.3 22.5M16 16 22.5 27.3M16 16 16 29M16 16 9.5 27.3M16 16 4.7 22.5M16 16 3 16M16 16 4.7 9.5M16 16 9.5 4.7M16 16 16 3M16 16 22.5 4.7M16 16 27.3 9.5"/></g></svg>',
  send: '<svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true"><path d="M9 14.5V4M4.5 8 9 3.5 13.5 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
const CHAOS_TITLES = [
  'What are we working on?',
  'Where do we start?',
  'What goes into the queue?',
  'What’s on for today?',
  'Let’s jot down some tasks?',
  'What’s on your mind?',
  'What shall we turn into a task?',
  'What do we take on?',
  'What do we note before it slips?',
  'Which chaos do we sort out?',
];
let chaosTitleIdx = -1;
function setChaosHeading() {
  const el = $('chaos-title');
  if (!el) return;
  let i = Math.floor(Math.random() * CHAOS_TITLES.length);
  if (i === chaosTitleIdx) i = (i + 1) % CHAOS_TITLES.length;
  chaosTitleIdx = i;
  el.textContent = tr(CHAOS_TITLES[i]);
}
let chaosBuilt = false;
let chaosStatus = 'backlog';
let chaosPriority = 0;
let chaosLabel = '';
let chaosNoclaude = false;
export let chaosPending = [];
let chaosHintTimer = null;
let chaosLock = localStorage.getItem('kb.chaos.lock') === '1';

function buildChaosProjectSelect() {
  const host = $('chaos-project');
  if (!host) return;
  const keep = host.dataset.value || localStorage.getItem('kb.chaos.project') || localStorage.getItem('kb.ui.lastProject');
  const projOpts = [...state.projects]
    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    .map((p) => ({ value: p.slug, label: p.name || p.slug, rightHTML: p.pinned ? `<span class="kbsel-pin" title="${tr('pinned')}">${CHAOS_IC.pin}</span>` : '' }));
  const defProj = state.projects.find((p) => p.slug === keep)?.slug || projOpts[0]?.value || '';
  buildSelect(host, { value: defProj, placeholder: tr('project'), options: projOpts, search: true });
}

export async function renderChaos(opening) {
  if (!state.projects.length) { try { await loadProjects(); } catch {  } }
  if (chaosBuilt && $('chaos-input')) {
    if (opening) setChaosHeading();
    buildChaosProjectSelect(); renderChaosNoclaudeList(opening); return;
  }
  $('chaos').innerHTML = `
    <div class="chaos-wrap">
      <div class="chaos-head">
        <span class="chaos-spark">${CHAOS_IC.spark}</span>
        <h1 class="chaos-title" id="chaos-title"></h1>
      </div>
      <div class="chaos-sub">${tr('Jot a task down quickly — it lands in the project you pick.')}</div>
      <div class="chaos-card">
        <div id="chaos-pending" class="chaos-pending hidden"></div>
        <textarea id="chaos-input" class="chaos-input" rows="2" placeholder="${tr('What needs doing?')}"></textarea>
        <div class="chaos-card-foot">
          <button class="chaos-ic chaos-attach" id="chaos-attach-ic" title="${tr('Attach a screenshot')}">${CHAOS_IC.attach}</button>
          <span class="chaos-foot-gap"></span>
          <button class="chaos-ic chaos-go" id="chaos-create" title="${tr('Create (⌘/Ctrl+Enter)')}">${CHAOS_IC.send}</button>
        </div>
        <input id="chaos-file" type="file" accept="image/*" multiple hidden>
      </div>
      <div class="chaos-bar">
        <div class="kbsel chaos-proj" id="chaos-project"></div>
        <button class="chaos-ic" id="chaos-status-ic" title="${tr('Status')}"></button>
        <button class="chaos-ic" id="chaos-pri-ic" title="${tr('Priority')}"></button>
        <button class="chaos-ic" id="chaos-label-ic" title="${tr('Label')}"></button>
        <button class="chaos-ic" id="chaos-noclaude-ic" title="${tr('noclaude label — done by hand')}">${CHAOS_IC.noclaude}</button>
        <button class="chaos-ic" id="chaos-lock-ic" title="${tr('Lock the selection')}"></button>
      </div>
      <div id="chaos-hint" class="chaos-hint"></div>
      <div class="chaos-list">
        <div id="chaos-nc-list" class="chaos-nc-list"></div>
      </div>
    </div>`;
  setChaosHeading();
  buildChaosProjectSelect();

  refreshChaosStatusIc(); refreshChaosPriIc(); refreshChaosLabelIc(); refreshChaosNoclaudeIc(); refreshChaosLockIc();
  $('chaos-status-ic').onclick = (e) => chaosPopover(e.currentTarget,
    [['backlog', tr('Backlog')], ['todo', tr('To do')]].map(([v, l]) => ({ v, html: `<span class="dot s-${v}"></span>${l}`, active: v === chaosStatus })),
    (v) => { chaosStatus = v; refreshChaosStatusIc(); });
  $('chaos-pri-ic').onclick = (e) => chaosPopover(e.currentTarget,
    PRI_LEVELS.map(([v, l]) => ({ v, html: l, active: v === chaosPriority })),
    (v) => { chaosPriority = Number(v); refreshChaosPriIc(); });
  $('chaos-label-ic').onclick = (e) => chaosPopover(e.currentTarget,
    [{ v: '', html: tr('no label'), active: chaosLabel === '' }].concat(LABEL_SELECTABLE.map((n) =>
      ({ v: n, html: `<span class="lbl-dot" style="background:${LABEL_COLORS[n]}"></span>${esc(n)}`, active: chaosLabel === n }))),
    (v) => { chaosLabel = v; refreshChaosLabelIc(); });
  $('chaos-noclaude-ic').onclick = () => { chaosNoclaude = !chaosNoclaude; refreshChaosNoclaudeIc(); };
  $('chaos-lock-ic').onclick = () => { chaosLock = !chaosLock; localStorage.setItem('kb.chaos.lock', chaosLock ? '1' : '0'); refreshChaosLockIc(); };

  $('chaos-attach-ic').onclick = () => $('chaos-file').click();
  $('chaos-file').onchange = (e) => { chaosAddImages([...e.target.files]); e.target.value = ''; };
  $('chaos').onpaste = onChaosPaste;
  $('chaos-create').onclick = chaosCreate;

  const input = $('chaos-input');
  input.oninput = () => autoGrow(input);
  input.onkeydown = (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); chaosCreate(); } };
  chaosBuilt = true;
  renderChaosPending();
  renderChaosNoclaudeList(true);
  input.focus();
}
function refreshChaosStatusIc() {
  const ic = $('chaos-status-ic');
  ic.innerHTML = chaosStatus === 'todo' ? CHAOS_IC.stTodo : CHAOS_IC.stBacklog;
  ic.classList.toggle('set', chaosStatus === 'todo');
  ic.title = `${tr('Status:')} ${chaosStatus === 'todo' ? tr('To do') : tr('Backlog')}`;
}
function refreshChaosPriIc() {
  const p = chaosPriority;
  $('chaos-pri-ic').innerHTML = p ? `<span class="pri ${PRI_ICON[p][1]}">${PRI_ICON[p][0]}</span>` : CHAOS_IC.flag;
  $('chaos-pri-ic').classList.toggle('set', !!p);
  $('chaos-pri-ic').title = p ? `${tr('Priority:')} ${PRI_ICON[p][2]}` : tr('Priority: none');
}
function refreshChaosLabelIc() {
  $('chaos-label-ic').innerHTML = CHAOS_IC.tag + (chaosLabel ? `<span class="lbl-dot" style="background:${LABEL_COLORS[chaosLabel]}"></span>` : '');
  $('chaos-label-ic').classList.toggle('set', !!chaosLabel);
  $('chaos-label-ic').title = chaosLabel ? `${tr('Label')}: ${chaosLabel}` : tr('Label');
}
function refreshChaosNoclaudeIc() { $('chaos-noclaude-ic').classList.toggle('on', chaosNoclaude); }
function refreshChaosLockIc() {
  const ic = $('chaos-lock-ic');
  if (!ic) return;
  ic.innerHTML = chaosLock ? CHAOS_IC.lockClosed : CHAOS_IC.lockOpen;
  ic.classList.toggle('on', chaosLock);
  ic.title = chaosLock ? tr('Lock on: status/priority/labels are kept after creating') : tr('Lock off: the choice resets after creating');
}

function chaosPopover(anchor, items, onPick) {
  document.querySelector('.chaos-pop')?.remove();
  const pop = document.createElement('div');
  pop.className = 'chaos-pop';
  pop.innerHTML = items.map((o) => `<div class="chaos-pop-opt${o.active ? ' active' : ''}" data-v="${esc(String(o.v))}">${o.html}</div>`).join('');
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const margin = 10;
  const below = innerHeight - r.bottom - margin;
  const above = r.top - margin;
  const openUp = below < 200 && above > below;
  pop.style.maxHeight = `${Math.max(120, (openUp ? above : below) - 5)}px`;
  let left = r.left;
  if (left + pop.offsetWidth > innerWidth - 8) left = innerWidth - pop.offsetWidth - 8;
  const top = openUp ? (r.top - pop.offsetHeight - 5) : (r.bottom + 5);
  pop.style.left = `${Math.max(8, left)}px`; pop.style.top = `${Math.max(8, top)}px`;
  const close = () => { pop.remove(); document.removeEventListener('mousedown', out); };
  function out(e) { if (!pop.contains(e.target) && e.target !== anchor) close(); }
  pop.querySelectorAll('.chaos-pop-opt').forEach((el) => { el.onclick = () => { onPick(el.dataset.v); close(); }; });
  setTimeout(() => document.addEventListener('mousedown', out), 0);
}

function chaosAddImages(files) {
  for (const f of files) { if (f && f.type.startsWith('image/')) chaosPending.push({ blob: f, url: URL.createObjectURL(f) }); }
  renderChaosPending();
}
function onChaosPaste(e) {
  const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.type.startsWith('image/'));
  if (!imgs.length) return;
  e.preventDefault();
  chaosAddImages(imgs.map((it) => it.getAsFile()).filter(Boolean));
}
function renderChaosPending() {
  const box = $('chaos-pending');
  if (!box) return;
  if (!chaosPending.length) { box.innerHTML = ''; box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.innerHTML = chaosPending.map((p, i) =>
    `<div class="attach"><img src="${p.url}" alt="${tr('screenshot')}"><span class="attach-x" data-i="${i}" title="${tr('remove')}">×</span></div>`).join('');
  box.querySelectorAll('.attach img').forEach((img) => { img.onclick = () => openLightbox(img.getAttribute('src')); });
  box.querySelectorAll('.attach-x').forEach((x) => { x.onclick = () => { URL.revokeObjectURL(chaosPending[Number(x.dataset.i)].url); chaosPending.splice(Number(x.dataset.i), 1); renderChaosPending(); }; });
}

let ncListAt = 0;
async function renderChaosNoclaudeList(force = false) {
  const box = $('chaos-nc-list');
  if (!box) return;
  if (!force && Date.now() - ncListAt < 2000) return;
  ncListAt = Date.now();
  let tasks = [];
  try { tasks = await api('GET', '/api/tasks?all=1'); } catch { box.innerHTML = '<div class="muted">—</div>'; return; }
  const rows = tasks
    .filter((t) => (t.labels || []).includes('noclaude') && ['backlog', 'todo'].includes(t.status))
    .sort((a, b) => b.priority - a.priority || a.status.localeCompare(b.status));
  const projName = (slug) => state.projects.find((p) => p.slug === slug)?.name || slug;
  box.innerHTML = rows.length
    ? rows.map((t) => `<div class="chaos-nc-row" data-key="${t.key}"><span class="dot s-${t.status}"></span>`
        + `<span class="cnc-key">${t.key}</span><span class="cnc-title">${titleOr(t)}</span>`
        + `<span class="cnc-proj">${esc(projName(t.project))}</span></div>`).join('')
    : `<div class="muted">${tr('no manual tasks in backlog/to do yet')}</div>`;
  box.querySelectorAll('.chaos-nc-row').forEach((el) => { el.onclick = () => openDrawer(el.dataset.key); });
}

async function chaosCreate() {
  const input = $('chaos-input');
  const text = input.value.trim();
  const project = selVal($('chaos-project'));
  const hint = $('chaos-hint');
  if (!project) { hint.textContent = tr('pick a project first'); hint.className = 'chaos-hint err'; return; }
  if (!text && !chaosPending.length) { input.focus(); return; }
  const labels = [...new Set([...(chaosLabel ? [chaosLabel] : []), ...(chaosNoclaude ? ['noclaude'] : [])])];
  const body = { project, title: text, status: chaosStatus, priority: chaosPriority, labels };
  $('chaos-create').disabled = true;
  try {
    const t = await api('POST', '/api/tasks', body);
    for (const p of chaosPending) { try { await uploadAttachment(p.blob, t.key); } catch {  } URL.revokeObjectURL(p.url); }
    chaosPending = []; renderChaosPending();
    localStorage.setItem('kb.chaos.project', project);
    input.value = ''; autoGrow(input);
    if (!chaosLock) {
      chaosStatus = 'backlog'; chaosPriority = 0; chaosLabel = ''; chaosNoclaude = false;
      refreshChaosStatusIc(); refreshChaosPriIc(); refreshChaosLabelIc(); refreshChaosNoclaudeIc();
    }
    hint.textContent = `${tr('created')}: ${t.key}`; hint.className = 'chaos-hint ok';
    clearTimeout(chaosHintTimer);
    chaosHintTimer = setTimeout(() => { hint.textContent = ''; hint.className = 'chaos-hint'; }, 3000);
    loadProjects();
    renderChaosNoclaudeList(true);
    input.focus();
  } catch (e) {
    hint.textContent = e && e.message ? String(e.message) : tr('could not create it'); hint.className = 'chaos-hint err';
  } finally { $('chaos-create').disabled = false; }
}
