
import { patchCard, renderBoard } from './board.js';
import { $, ALL, ALL_STATUSES, CALENDAR, CHAOS, DASH, HORIZON, LANG, SETTINGS, api, esc, ic, retryUnsaved, setGhSyncOn, state, tr } from './core.js';
import { openDrawer, renderComments, renderIssueRow, syncOpenDrawerStatus } from './drawer.js';
import { getSetting } from './settings.js';
import { loadProjects, loadTasks, renderSidebar, renderTopbar, selectProject } from './sidebar.js';

export async function refreshSync() {
  try {
    const st = await api('GET', '/api/stats');
    const wk = st.week_seconds >= 3600
      ? `${Math.floor(st.week_seconds / 3600)}${tr('h')} ${Math.round((st.week_seconds % 3600) / 60)}${tr('m')}`
      : `${Math.max(1, Math.round(st.week_seconds / 60))}${tr('m')}`;
    $('week-stats').textContent = st.week_done ? `${tr('last 7 days:')} ${st.week_done} ✓ · ${wk}` : '';
    const s = await api('GET', '/api/sync');
    setGhSyncOn(s.configured !== false);
    const el = $('sync-badge');
    if (s.configured === false) { el.textContent = ''; el.className = 'sync-badge'; }
    else if (s.failed.length) { el.innerHTML = `${ic('warn', 12)} ${esc(tr('sync'))}: ${s.failed.length} ${esc(tr('errors'))}`; el.className = 'sync-badge error'; }
    else if (s.gh === false && s.pending) { el.textContent = `gh ✗ · ${tr('queued')} ${s.pending}`; el.className = 'sync-badge error'; }
    else if (s.pending) { el.textContent = `${tr('sync')}: ${s.pending} ${tr('queued')}`; el.className = 'sync-badge busy'; }
    else { el.textContent = tr('sync: ok'); el.className = 'sync-badge'; }
  } catch {  }
}

export async function refresh() {
  await loadProjects();
  await loadTasks();
  await syncOpenDrawerStatus();
}

const TASK_EVENTS = new Set(['task.created', 'task.updated', 'task.deleted']);
const SPECIAL_VIEWS = [DASH, HORIZON, CALENDAR, CHAOS, SETTINGS];

async function refreshProjectCounters() {
  try { state.projects = await api('GET', '/api/projects'); } catch { return; }
  renderSidebar();
  renderTopbar();
}

async function applySseEvent(ev) {
  if (!TASK_EVENTS.has(ev.type)) return false;
  if (SPECIAL_VIEWS.includes(state.slug)) return false;
  const d = ev.data;
  if (!d || d.id == null) return false;
  const onThisBoard = state.slug === ALL || d.project === state.slug;
  if (onThisBoard) {
    const i = state.tasks.findIndex((t) => t.id === d.id);
    if (ev.type === 'task.deleted') {
      if (i >= 0) state.tasks.splice(i, 1);
    } else if (i >= 0) {
      const before = state.tasks[i];
      const after = { ...before, ...d };
      state.tasks[i] = after;
      if (patchCard(before, after)) { await refreshProjectCounters(); await syncOpenDrawerStatus(); return true; }
    } else if (ev.type === 'task.created') {
      state.tasks.push(d);
    } else {
      return false;
    }
    renderBoard();
  }
  await refreshProjectCounters();
  await syncOpenDrawerStatus();
  return true;
}

/* ── SSE ── */
export let audioCtx = null;
export function ensureAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.onstatechange = updateSoundBadge;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { audioCtx = null; }
  updateSoundBadge();
  return audioCtx;
}
window.addEventListener('pointerdown', ensureAudio);
window.addEventListener('keydown', ensureAudio);
document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureAudio(); });

export function updateSoundBadge() {
  const b = $('sound-badge');
  if (!b) return;
  b.classList.toggle('hidden', !(getSetting('sound') && audioCtx && audioCtx.state !== 'running'));
}
$('sound-badge').onclick = async () => {
  const ctx = ensureAudio();
  try { await ctx?.resume(); } catch {  }
  updateSoundBadge();
  if (ctx?.state === 'running') playNamedSound(getSetting('soundReview'));
};

function tones(ctx, notes, { type = 'sine', step = 0.1, dur = 0.32, vol = 0.12 } = {}) {
  const now = ctx.currentTime;
  notes.forEach((f, i) => {
    const osc = ctx.createOscillator(); const gain = ctx.createGain();
    osc.type = type; osc.frequency.value = f;
    const t = now + i * step;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(t); osc.stop(t + dur + 0.05);
  });
}
function chord(ctx, freqs, { vol = 0.08, dur = 0.5 } = {}) {
  const now = ctx.currentTime;
  freqs.forEach((f) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(vol, now + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(now); o.stop(now + dur + 0.05);
  });
}
function sweep(ctx, from, to, { dur = 0.2, vol = 0.15, type = 'sine' } = {}) {
  const now = ctx.currentTime;
  const o = ctx.createOscillator(); const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(from, now);
  o.frequency.exponentialRampToValueAtTime(to, now + dur);
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(vol, now + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, now + dur + 0.02);
  o.connect(g); g.connect(ctx.destination);
  o.start(now); o.stop(now + dur + 0.06);
}
function noiseClick(ctx) {
  const len = Math.ceil(ctx.sampleRate * 0.05);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
  const src = ctx.createBufferSource(); src.buffer = buf;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 2400;
  const g = ctx.createGain(); g.gain.value = 0.16;
  src.connect(lp); lp.connect(g); g.connect(ctx.destination);
  src.start(ctx.currentTime); src.stop(ctx.currentTime + 0.06);
}
export const SOUND_LIB = {
  none:  { name: 'No sound', play: () => {} },
  ding:  { name: 'Ding', play: (c) => tones(c, [1319, 1760]) },
  bell:  { name: 'Bell', play: (c) => tones(c, [1568, 2093], { type: 'triangle', step: 0.09, dur: 0.42 }) },
  chime: { name: 'Chime', play: (c) => tones(c, [1047, 1319, 1760], { step: 0.08, dur: 0.3 }) },
  drop:  { name: 'Drop', play: (c) => sweep(c, 1600, 680, { dur: 0.18, vol: 0.14 }) },
  chord: { name: 'Chord', play: (c) => chord(c, [523.25, 659.25, 783.99]) },
  click: { name: 'Click', play: noiseClick },
  pop:   { name: 'Pop', play: (c) => sweep(c, 880, 200, { dur: 0.12, vol: 0.18 }) },
};

export let missedSounds = 0;
export let lastMissedAt = null;
export const pageLoadedAt = new Date();
export async function playNamedSound(id) {
  const ctx = ensureAudio();
  if (!ctx) return;
  if (ctx.state !== 'running') { try { await ctx.resume(); } catch {  } }
  if (ctx.state !== 'running') { missedSounds++; lastMissedAt = new Date(); updateSoundBadge(); return; }
  (SOUND_LIB[id] || SOUND_LIB.ding).play(ctx);
}
function playReviewSound() {
  if (!getSetting('sound')) return;
  playNamedSound(getSetting('soundReview'));
}
function playDoneSound() {
  if (!getSetting('sound')) return;
  playNamedSound(getSetting('soundDone'));
}

function realTransition(ev, to) {
  if (ev.type !== 'task.updated' || ev.data?.status !== to) return false;
  const prev = ev.data.prev_status ?? state.tasks.find((t) => t.id === ev.data.id)?.status;
  return !!prev && prev !== to;
}
function maybeReviewSound(ev) {
  if (realTransition(ev, 'review')) playReviewSound();
}

function maybeReviewNotify(ev) {
  if (!getSetting('notifyReview')) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  if (!realTransition(ev, 'review')) return;
  try {
    const notif = new Notification(tr('A task is ready for review'), {
      body: `${ev.data.key} · ${ev.data.title || ''}`,
      icon: '/icon-192.png',
      tag: `kb-review-${ev.data.id}`,
    });
    notif.onclick = () => { window.focus(); openTaskFromNotification(ev.data.key, ev.data.project); notif.close(); };
  } catch {  }
}

function openTaskFromNotification(key, project) {
  if (project && state.slug !== project) selectProject(project);
  openDrawer(key);
}

function maybeDoneSound(ev) {
  if (realTransition(ev, 'done')) playDoneSound();
}

export const SSE_STALE_MS = 75000;
let sse = null;
export let lastSseAt = Date.now();

let sseQueue = [];
let sseFlushing = false;
async function flushSseQueue() {
  if (sseFlushing) return;
  sseFlushing = true;
  try {
    while (sseQueue.length) {
      const batch = sseQueue;
      sseQueue = [];
      let applied = true;
      for (const ev of batch) { if (!await applySseEvent(ev)) { applied = false; break; } }
      if (!applied) await refresh();
      if (state.drawerKey && batch.some((ev) => ev.type === 'task.updated'
        && ev.data.key === state.drawerKey && ev.data.gh_issue_number)) {
        const t = state.tasks.find((x) => x.key === state.drawerKey);
        if (t) renderIssueRow(t);
      }
    }
  } finally { sseFlushing = false; }
}

export function connectSSE() {
  if (sse) { try { sse.close(); } catch {  } }
  const es = new EventSource('/api/events');
  sse = es;
  let timer = null;
  es.onopen = () => {
    lastSseAt = Date.now();
    refresh();
    retryUnsaved();
  };
  es.onmessage = (e) => {
    const gap = Date.now() - lastSseAt;
    lastSseAt = Date.now();
    if (gap > SSE_STALE_MS) refresh().catch(() => {});
    const ev = JSON.parse(e.data);
    if (ev.type === 'ping') return;
    if (ev.type === 'sync.status') { refreshSync(); return; }
    if (ev.type === 'task.comment' && state.drawerKey === ev.data.key) renderComments(ev.data.key);
    maybeReviewSound(ev);
    maybeReviewNotify(ev);
    maybeDoneSound(ev);
    sseQueue.push(ev);
    clearTimeout(timer);
    timer = setTimeout(flushSseQueue, 150);
  };
  es.onerror = () => { es.close(); if (sse === es) setTimeout(connectSSE, 3000); };
}
export function ensureSSE() {
  if (document.hidden) return;
  if (!sse || sse.readyState === 2 || Date.now() - lastSseAt > SSE_STALE_MS) connectSSE();
}
document.addEventListener('visibilitychange', ensureSSE);
window.addEventListener('focus', ensureSSE);

export function relTime(iso) {
  const d = (Date.now() - new Date(iso + 'Z').getTime()) / 1000;
  if (d < 60) return tr('just now');
  if (d < 3600) return `${Math.floor(d / 60)}${tr('m ago')}`;
  if (d < 86400) return `${Math.floor(d / 3600)}${tr('h ago')}`;
  return `${Math.floor(d / 86400)}${tr('d ago')}`;
}

export const SHORT_MONTHS = LANG === 'ru'
  ? ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'Z');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${hh}:${mm}`;
}

export const STATUS_LABELS = Object.fromEntries(ALL_STATUSES);

const TL_KEEP = 3;
const TL_MAX = 6;

export function renderTimeline(t) {
  const box = $('d-timeline');
  const items = [{
    when: t.created_at,
    dot: '<span class="tl-dot" style="background:var(--tl-created)"></span>',
    text: tr('Created'),
  }];
  for (const ev of (t.events || [])) {
    items.push({
      when: ev.created_at,
      dot: `<span class="tl-dot dot s-${ev.status}"></span>`,
      text: esc(STATUS_LABELS[ev.status] || ev.status),
    });
  }

  const hiddenCount = items.length > TL_MAX ? items.length - TL_KEEP : 0;
  const rows = items.map((it, i) => `<div class="tl-item${i < hiddenCount ? ' tl-old' : ''}">`
    + `<span class="tl-when">${fmtDate(it.when)}</span>`
    + `<span class="tl-what">${it.dot}${it.text}</span></div>`);

  const toggle = hiddenCount
    ? `<button type="button" class="tl-toggle" id="tl-toggle">`
      + `<span class="tl-toggle-label">${tr('Show the rest')} (${hiddenCount})</span>${ic('chevron', 13)}</button>`
    : '';

  const backToWork = (t.events || []).filter((e) => e.status === 'doing').length;
  const cycle = backToWork > 1 ? `<div class="tl-cycle">↻ ${tr('went back to work')} ${backToWork}×</div>` : '';
  box.innerHTML = toggle + rows.join('') + cycle;
  box.classList.toggle('tl-collapsed', hiddenCount > 0);
  box.classList.remove('hidden');

  if (hiddenCount) {
    $('tl-toggle').onclick = () => {
      const collapsed = box.classList.toggle('tl-collapsed');
      $('tl-toggle').querySelector('.tl-toggle-label').textContent = collapsed
        ? `${tr('Show the rest')} (${hiddenCount})`
        : tr('Collapse');
    };
  }
}

export function autoGrow(el) {
  if (!el.isConnected || !el.offsetParent) return;
  el.style.height = 'auto';
  const frame = el.offsetHeight - el.clientHeight;
  el.style.height = el.scrollHeight + frame + 'px';
}

export function titleOr(t) {
  return (t && t.title && t.title.trim()) ? esc(t.title) : `<span class="row-untitled">${tr('untitled')}</span>`;
}

export async function copyTodoPrompt(tasks, btn) {
  const slug = state.slug === ALL ? null : state.slug;
  const head = slug ? `${tr('Do the tasks from')} ${slug} ${tr('with the to-do status:')}` : tr('Do the tasks with the to-do status:');
  const text = [tr('Run the kanban skill'), head, ...tasks.map((t) => t.key)].join('\n');
  const ok = await copyText(text);
  btn.textContent = ok ? '✓' : '✕';
  btn.classList.toggle('copied', ok);
  setTimeout(() => { btn.innerHTML = ic('copy', 13); btn.classList.remove('copied'); }, 1400);
}

export async function copyBacklogPrompt(tasks, btn) {
  const slug = state.slug === ALL ? null : state.slug;
  const head = slug ? `${tr('Groom the backlog of')} ${slug} ${tr('(grooming mode):')}` : tr('Groom the backlog (grooming mode):');
  const text = [tr('Run the kanban skill'), head, ...tasks.map((t) => t.key)].join('\n');
  const ok = await copyText(text);
  btn.textContent = ok ? '✓' : '✕';
  btn.classList.toggle('copied', ok);
  setTimeout(() => { btn.innerHTML = ic('copy', 13); btn.classList.remove('copied'); }, 1400);
}

export async function copyText(text) {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch {  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.focus(); ta.select();
    const ok = document.execCommand('copy'); ta.remove(); return ok;
  } catch { return false; }
}

let lastView = null;
export function showView(view) {
  $('toolbar').classList.toggle('hidden', view !== 'board');
  $('board').classList.toggle('hidden', view !== 'board');
  $('link-lines').classList.toggle('hidden', view !== 'board');
  $('dashboard').classList.toggle('hidden', view !== 'dashboard');
  $('settings').classList.toggle('hidden', view !== 'settings');
  $('horizon').classList.toggle('hidden', view !== 'horizon');
  $('calendar').classList.toggle('hidden', view !== 'calendar');
  $('chaos').classList.toggle('hidden', view !== 'chaos');
  const changed = lastView !== view;
  lastView = view;
  return changed;
}
