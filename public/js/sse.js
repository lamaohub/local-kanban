
import { applyLive, patchCard, renderBoard } from './board.js';
import { $, ALL, ALL_STATUSES, AUTO, HEALTH, CALENDAR, CHAOS, DASH, DONE, HORIZON, LANG, NOW, REVIEW, SETTINGS, api, esc, fmtNum, ic, retryUnsaved, seg, setGhSyncOn, state, tr } from './core.js';
import { applyChecklist, closeDrawer, commentArrived, openDrawer, openTerminalOf, peekTerminal, refreshWork, renderComments, renderIssueRow, syncOpenDrawerStatus } from './drawer.js';
import { getSetting, pickedSetting, plural } from './settings.js';
import { loadProjects, loadTasks, markNowEntry, overlayLayer, renderSidebar, renderTopbar, resumeSwitch, selectProject, styledAlert, styledConfirm } from './sidebar.js';
import { applyEvents, eventQueue, oneFlight, SEARCH_DELAY_MS, silentTooLong } from './live-rules.js';
import { CHANNEL, createLink } from './live-link.js';
import { applyLimits, loadLimits } from './limits.js';
import { applyAutomations, loadAutomations } from './automations.js';
import { applyAskEvent, loadAsks } from './asks.js';
import { usageLine } from './usage-rules.js';
import { KB_DEFAULT_PORT, boardOnly, checksOnly, launchPick, manualRefusal, startEffort, withBoardAddress } from './launch-rules.js';
import { refusalLine, refusalText } from './unsaved.js';
import { repaintReview } from './review.js';
import { setTerminalQuestions } from './attention.js';
import { typeset } from './typeset.js';
import { chatEvent } from './chat.js';
import { applyShare, loadShare } from './share.js';

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

let boardLoadStarted = false;
let boardLoaded = false;
let streamOpen = null;
export const streamOpened = new Promise((resolve) => { streamOpen = resolve; });
// the list's notice by the title says so and its rule reads the board again (listFailure). A fault of the page goes on
const serverFailure = (e) => Boolean(e?.offline || e?.status);
export async function refresh() {
  boardLoadStarted = true;
  // list, which says the failure and reads again by its rule. Thrown, it left the list and the open card unread and
  // «Failed to fetch» uncaught — on an event applied by a refresh, a reconnect, a move. The first load still throws:
  try { await loadProjects(); } catch (e) { if (!boardLoaded || !serverFailure(e)) throw e; }
  await loadTasks();
  await syncOpenDrawerStatus();
  await loadLive();
  loadLaunchOptions();
  loadLimits();
  loadShare();
  loadAutomations();
  loadAsks();
  if (!boardLoaded) { boardLoaded = true; setTimeout(flushSseQueue, 0); }
}

let liveLoaded = false;
let liveEvents = 0; // task.live, applied so far: a picture asked for before a newer event is older than the page's
async function loadLive() {
  try {
    const seen = liveEvents;
    const live = await api('GET', '/api/live', undefined, { quiet: true });
    if (seen !== liveEvents) { markNowEntry(); repaintReview(); return; }
    const changes = applyLive(live.tasks);
    state.liveProjects = live.projects || [];
    const fresh = applyTerminalQuestions(live.questions);
    if (liveLoaded) maybeQuestionAlert(fresh, maybeWaitingAlert(changes));
    liveLoaded = true;
    markNowEntry(); repaintReview();
  } catch {  }
}

const SPECIAL_VIEWS = [DASH, NOW, REVIEW, DONE, AUTO, HEALTH, HORIZON, CALENDAR, CHAOS, SETTINGS];

async function refreshProjectCounters() {
  try { state.projects = await api('GET', '/api/projects'); } catch { return; }
  renderSidebar();
  renderTopbar();
}

let searchReload = null;
function reloadSearchSoon() {
  clearTimeout(searchReload);
  searchReload = setTimeout(() => { if (state.search) loadTasks().catch(() => {}); }, SEARCH_DELAY_MS);
}

async function applyBatch(batch) {
  const plan = applyEvents(state.tasks, batch, {
    slug: state.slug, all: state.slug === ALL, special: SPECIAL_VIEWS.includes(state.slug), searching: Boolean(state.search),
  });
  const moved = batch.some((ev) => ev?.type === 'task.updated' && ev.data?.key === state.drawerKey && ev.data.prev_status != null && ev.data.prev_status !== ev.data.status);
  if (plan.refresh) { await refresh(); if (moved) await syncOpenDrawerStatus({ moved }); return; }
  state.tasks = plan.tasks;
  if (state.searchHits) for (const id of plan.unhit) state.searchHits.delete(id);
  if (plan.render) renderBoard();
  else {
    for (const [id, before] of plan.changed) {
      const after = state.tasks.find((t) => t.id === id);
      if (after && !patchCard(before, after) && plan.loud.has(id)) { renderBoard(); break; }
    }
  }
  if (plan.counters) await refreshProjectCounters();
  if (plan.drawer) await syncOpenDrawerStatus({ moved });
  if (plan.searchStale) reloadSearchSoon();
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
  marimba: { name: 'Marimba', play: (c) => tones(c, [784, 1047], { type: 'triangle', step: 0.11, dur: 0.18, vol: 0.16 }) },
  harp:    { name: 'Harp', play: (c) => tones(c, [523.25, 659.25, 783.99, 1046.5, 1318.5], { type: 'triangle', step: 0.05, dur: 0.5, vol: 0.08 }) },
  fanfare: { name: 'Fanfare', play: (c) => tones(c, [523.25, 659.25, 783.99, 1046.5], { type: 'triangle', step: 0.1, dur: 0.28, vol: 0.1 }) },
  coin:    { name: 'Coin', play: (c) => tones(c, [988, 1319], { type: 'square', step: 0.08, dur: 0.26, vol: 0.06 }) },
  glass:   { name: 'Glass', play: (c) => tones(c, [2637, 3136], { step: 0.06, dur: 0.7, vol: 0.06 }) },
  soft:    { name: 'Soft', play: (c) => chord(c, [392, 493.88, 587.33], { vol: 0.06, dur: 0.9 }) },
  sonar:   { name: 'Sonar', play: (c) => tones(c, [1175], { dur: 1.1, vol: 0.1 }) },
  bubble:  { name: 'Bubble', play: (c) => sweep(c, 320, 960, { dur: 0.11, vol: 0.14 }) },
  knock:   { name: 'Knock', play: (c) => { sweep(c, 240, 90, { dur: 0.06, vol: 0.25 }); setTimeout(() => sweep(c, 240, 90, { dur: 0.06, vol: 0.25 }), 130); } },
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

function maybeWaitingAlert(changes) {
  // it tells its Claude to go on (`retrying`): that rang for a blink of the network the person need not see
  const waiting = (changes || []).filter((c) => (c.claude === 'idle' && c.broke === 'stuck' && c.fromBroke !== 'stuck')
    || (!c.broke && (c.from === 'busy' || c.from === 'background') && (c.claude === 'waiting' || c.claude === 'idle'))
    || (c.claude === 'limit' && c.from !== 'limit'));
  if (!waiting.length) return new Set();
  playReviewSound();
  const rang = new Set(waiting.map((c) => c.id));
  const stops = waiting.filter((c) => c.claude === 'limit');
  const notes = waiting.filter((c) => c.claude !== 'limit');
  if (stops.length) notes.push({ ...stops[0], open: stops[0].key, key: stops.map((c) => c.key).join(', '), title: stops.length > 1 ? '' : stops[0].title });
  if (!getSetting('notifyReview')) return rang;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return rang;
  for (const c of notes) {
    try {
      const limit = c.claude === 'limit';
      const title = limit ? `${tr('Claude hit the usage limit')}${c.resets ? ` · ${tr('until')} ${c.resets}` : ''}`
        : c.broke ? tr("Claude's answer broke off") : tr('Claude is waiting for you');
      // with no banner and no sound: every wait of a task after its first went by unnoticed
      const notif = new Notification(title, { body: c.title ? `${c.key} · ${c.title}` : c.key, icon: '/icon-192.png', tag: limit ? 'kb-limit' : `kb-live-${c.id}`, renotify: true });
      notif.onclick = () => { window.focus(); openTaskFromNotification(c.open || c.key, c.project); notif.close(); };
    } catch {  }
  }
  return rang;
}

let terminalAsking = new Set();
function applyTerminalQuestions(list) {
  const fresh = (list || []).filter((q) => !terminalAsking.has(q.id));
  terminalAsking = new Set((list || []).map((q) => q.id));
  setTerminalQuestions(list);
  return fresh;
}
function maybeQuestionAlert(fresh, rang) {
  const asking = fresh.filter((q) => !rang.has(q.id));
  if (!asking.length) return;
  playReviewSound();
  if (!getSetting('notifyReview')) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  for (const q of asking) {
    try {
      const notif = new Notification(tr('Claude is asking you a question'), { body: `${q.key} · ${q.title || ''}`, icon: '/icon-192.png', tag: `kb-question-${q.id}`, renotify: true });
      notif.onclick = () => { window.focus(); openTaskFromNotification(q.key, q.project); notif.close(); };
    } catch {  }
  }
}

function maybeDoneSound(ev) {
  if (realTransition(ev, 'done')) playDoneSound();
}

export let lastSseAt = Date.now();

const sseQueue = eventQueue();
let sseFlushing = false;
async function flushSseQueue() {
  if (sseFlushing || !boardLoaded) return;
  sseFlushing = true;
  try {
    while (sseQueue.size) {
      const batch = sseQueue.take();
      await applyBatch(batch);
      if (state.drawerKey && batch.some((ev) => ev.type === 'task.updated'
        && ev.data.key === state.drawerKey && ev.data.gh_issue_number)) {
        const t = state.tasks.find((x) => x.key === state.drawerKey);
        if (t) renderIssueRow(t);
      }
      if (state.drawerKey && batch.some((ev) => ev.data && ev.data.key === state.drawerKey)) peekTerminal();
    }
  } finally { sseFlushing = false; }
}

// the stream (re)opened — here or in the tab that holds the link
function linkOpened() {
  lastSseAt = Date.now();
  streamOpen();
  if (boardLoadStarted) resumeSwitch();
  if (boardLoadStarted) refresh().catch((e) => { if (!serverFailure(e)) throw e; });
  if (boardLoadStarted && state.drawerKey) renderComments(state.drawerKey);
  retryUnsaved();
}
let flushTimer = null;
function streamMessage(data) {
  const stale = silentTooLong(lastSseAt, Date.now());
  lastSseAt = Date.now();
  let ev;
  try { ev = JSON.parse(data); } catch { return; }
  const ownComment = ev.type === 'task.comment' && ev.data?.key === state.drawerKey;
  if (stale) { refresh().catch(() => {}); if (state.drawerKey && !ownComment) renderComments(state.drawerKey); }
  if (ev.type === 'ping') return;
  if (ev.type === 'sync.status') { refreshSync(); return; }
  if (ev.type === 'session.chat') { chatEvent(ev.data?.session); return; }
  if (ev.type === 'task.work') { const open = state.drawerKey && (ev.data?.keys || []).includes(state.drawerKey); if (open) refreshUsage(state.drawerKey); if (open) refreshWork(state.drawerKey); return; }
  if (ev.type === 'task.live') { liveEvents++; state.liveProjects = ev.data?.projects || []; maybeQuestionAlert(applyTerminalQuestions(ev.data?.questions), maybeWaitingAlert(applyLive(ev.data?.tasks))); markNowEntry(); peekTerminal(); if (state.slug === DASH || state.slug === NOW || state.slug === REVIEW) loadTasks().catch(() => {}); return; }
  if (ev.type === 'task.checklist') { applyChecklist(ev.data?.key, ev.data?.checklist); if (state.slug === NOW && !ev.data?.text_only) loadTasks().catch(() => {}); return; }
  if (ev.type === 'limits.updated') { applyLimits(ev.data); return; }
  if (ev.type === 'share.updated') { applyShare(ev.data); return; }
  if (ev.type === 'automation.updated') { applyAutomations(ev.data); return; }
  if (ev.type === 'ask.created' || ev.type === 'ask.removed') { applyAskEvent(ev); return; }
  if (ev.type === 'task.comment') commentArrived(ev.data.key, ev.data.comment, ev.data.comments_n);
  maybeReviewSound(ev);
  maybeReviewNotify(ev);
  maybeDoneSound(ev);
  sseQueue.push(ev);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flushSseQueue, 150);
}

const LINK_SAY_MS = 5000;
let linkSayTimer = null;
function sayLink(st) {
  clearTimeout(linkSayTimer);
  const el = $('live-badge');
  if (!el) return;
  if (st.up) { el.classList.add('hidden'); return; }
  const paint = () => {
    el.textContent = tr(st.refused ? 'no live updates' : 'no connection');
    el.title = tr(st.refused === 'guests'
      ? 'The board gives guests a few live connections, and they are taken by other tabs of guests. Changes from other devices do not come — close a tab of the board or click to try again'
      : st.refused
        ? 'The board has too many live connections open. Changes from other devices do not come — close a tab of the board or click to try again'
        : 'The board does not answer — changes from other devices do not come. It reconnects by itself; click to try now');
    el.classList.remove('hidden');
  };
  const left = LINK_SAY_MS - (Date.now() - st.since);
  if (left <= 0) paint(); else linkSayTimer = setTimeout(paint, left);
}
// after a failed stream
const roomFull = () => api('GET', '/api/events/room', undefined, { quiet: true }).then((r) => (r?.full ? r.reason || 'full' : false));

const link = createLink({
  EventSourceImpl: window.EventSource,
  channel: typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null,
  locks: navigator.locks || null,
  onOpen: linkOpened,
  onMessage: streamMessage,
  onState: sayLink,
  probe: roomFull,
});
$('live-badge')?.addEventListener('click', () => link.retry());

/** Start the live link (init.js): the tab holding it opens the stream, the others hear it. */
export function connectSSE() { link.start(); }
// The rule (`streamDead(stream, lastAt, now)`) is in live-link.js, with its test
export function ensureSSE(e) {
  link.ensure({ urgent: Boolean(e?.type) && !document.hidden, hidden: document.hidden });
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
const fmtDay = (ymd) => {
  const [y, m, d] = String(ymd || '').split('-').map(Number);
  return y && m && d ? `${d} ${SHORT_MONTHS[m - 1]} ${y}` : String(ymd ?? '');
};
export const usageFmt = { num: fmtNum, tr, plural, esc, date: fmtDay, gap: LANG === 'ru' ? ' ' : '' };

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

const usageHTML = (u) => {
  if (getSetting('showUsage') === false) return '';
  const line = usageLine(u, usageFmt);
  return line ? `<div class="dm-info dm-usage" title="${esc(line.title)}">${esc(line.text)}</div>` : '';
};
let cardClaude = { key: null, sessions: [], usage: null };
/** The lines of the ⋯ menu about Claude of the open card: sessions, then usage; '' when there is nothing to say. */
export function claudeInfoHTML() {
  if (!cardClaude.key || cardClaude.key !== state.drawerKey) return '';
  const ss = cardClaude.sessions;
  const latest = ss.reduce((m, x) => (String(x.last_seen) > m ? String(x.last_seen) : m), '');
  const sessions = ss.length
    ? `<div class="dm-info" title="${esc(ss.map((x) => x.session_id).join('\n'))}">`
      + `Claude · ${ss.length} ${plural(ss.length, 'session', 'sessions')} · ${tr('latest')} ${fmtDate(latest)}</div>`
    : '';
  return sessions + usageHTML(cardClaude.usage);
}
// the ⋯ menu lives in drawer.js, which imports this module: it hands its repaint in rather than this module reaching out
let claudeInfoListener = null;
/** `fn` — drawn again when the open card's Claude lines change (drawer.js fills its open ⋯ menu). */
export function onClaudeInfo(fn) { claudeInfoListener = fn; }
function repaintClaudeInfo() { if (claudeInfoListener) claudeInfoListener(); }
const menuOpen = () => Boolean($('drawer-menu-pop'));
export function askUsageNow() { if (state.drawerKey) refreshUsage(state.drawerKey); }
const USAGE_EVERY_MS = 10_000;
let usageAt = 0;
let usageTimer = null;
const usageFlight = oneFlight(async (key) => {
  usageAt = Date.now();
  let r;
  try { r = await api('GET', `/api/tasks/${seg(key)}/usage`, undefined, { quiet: true }); } catch { return; }
  if (state.drawerKey !== key) return;
  if (cardClaude.key === key) cardClaude.usage = r.usage;
  repaintClaudeInfo();
});
export function refreshUsage(key) {
  if (getSetting('showUsage') === false) return;
  if (!menuOpen()) return;
  const wait = usageAt + USAGE_EVERY_MS - Date.now();
  if (wait <= 0) { usageFlight(key); return; }
  if (usageTimer) return;
  usageTimer = setTimeout(() => { usageTimer = null; if (state.drawerKey && menuOpen()) usageFlight(state.drawerKey); }, wait);
}
export function repaintUsage() {
  if (state.slug === DASH) loadTasks().catch(() => {});
  if (getSetting('showUsage') === false || !menuOpen()) repaintClaudeInfo();
  else if (state.drawerKey) usageFlight(state.drawerKey);
}

export function renderTimeline(t) {
  const box = $('d-timeline');
  const TYPED_VIA = {
    typed: 'typed in the terminal',
    'typed-undone': 'typed in the terminal',
    settled: 'back by itself: the words were not about it',
  };
  const items = [{
    when: t.created_at,
    dot: '<span class="tl-dot" style="background:var(--tl-created)"></span>',
    text: tr('Created'),
  }];
  for (const ev of (t.events || [])) {
    const via = TYPED_VIA[ev.typed];
    items.push({
      when: ev.created_at,
      dot: `<span class="tl-dot dot s-${ev.status}"></span>`,
      // one span: a long note wraps on under the status, not as a column of its own
      text: via ? `<span>${esc(STATUS_LABELS[ev.status] || ev.status)} <span class="tl-via">· ${esc(tr(via))}</span></span>` : esc(STATUS_LABELS[ev.status] || ev.status),
    });
  }
  for (const mv of (t.moves || [])) {
    items.push({ when: mv.moved_at, dot: '<span class="tl-dot" style="background:var(--tl-created)"></span>', text: `${esc(tr('Moved from'))} ${esc(mv.key)}` });
  }
  items.sort((a, b) => (a.when < b.when ? -1 : a.when > b.when ? 1 : 0));

  const hiddenCount = items.length > TL_MAX ? items.length - TL_KEEP : 0;
  const rows = items.map((it, i) => `<div class="tl-item${i < hiddenCount ? ' tl-old' : ''}">`
    + `<span class="tl-when">${fmtDate(it.when)}</span>`
    + `<span class="tl-what">${it.dot}${it.text}</span></div>`);

  const toggle = hiddenCount
    ? `<button type="button" class="tl-toggle" id="tl-toggle">`
      + `<span class="tl-toggle-label">${tr('Show the rest')} (${hiddenCount})</span>${ic('chevron', 13)}</button>`
    : '';

  const backToWork = (t.events || []).filter((e) => e.status === 'doing' && e.typed !== 'typed-undone').length;
  const cycle = backToWork > 1 ? `<div class="tl-cycle">↻ ${tr('went back to work')} ${backToWork}×</div>` : '';
  if ('sessions' in t || cardClaude.key !== t.key) cardClaude = { key: t.key, sessions: t.sessions || [], usage: t.usage || null };
  repaintClaudeInfo();
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

const grown = new WeakMap();
const inserted = (was, now) => {
  if (now.length <= was.length) return false;
  let p = 0;
  while (p < was.length && was[p] === now[p]) p++;
  return now.endsWith(was.slice(p));
};
export function autoGrow(el) {
  if (!el.isConnected || !el.offsetParent) return;
  const last = grown.get(el);
  const width = el.offsetWidth;
  grown.set(el, { value: el.value, width });
  if (last && last.width === width && inserted(last.value, el.value)) {
    if (el.scrollHeight <= el.clientHeight) return;
    const want = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    if (el.style.height !== want) el.style.height = want;
    return;
  }
  el.style.height = 'auto';
  const frame = el.offsetHeight - el.clientHeight;
  el.style.height = el.scrollHeight + frame + 'px';
}

export function titleOr(t) {
  return (t && t.title && t.title.trim()) ? esc(t.title) : `<span class="row-untitled">${tr('untitled')}</span>`;
}

export function todoPromptText(tasks, slug = state.slug === ALL ? null : state.slug) {
  const head = slug ? `${tr('Do the tasks from')} ${slug} ${tr('with the to-do status:')}` : tr('Do the tasks with the to-do status:');
  return [tr('Run the kanban skill'), head, ...tasks.map((t) => t.key)].join('\n');
}
export const taskPromptText = (key) => [tr('Run the kanban skill'), `${tr('Do the task')} ${key}`].join('\n');

// is the reverse proxy's behind one: another port, or none on https. Until the answer is in, the page's own port.
function boardPort() {
  // no answer yet (or the ask failed): ask again for the next time — not awaited, a copy must stay in the click's gesture
  if (!launchAvail) loadLaunchOptions();
  return String((launchAvail && launchAvail.port) || location.port || '');
}
const promptHere = (text) => withBoardAddress(text, boardPort(), tr);

export async function copyTodoPrompt(tasks, btn) {
  const text = promptHere(todoPromptText(tasks));
  const ok = await copyText(text);
  btn.textContent = ok ? '✓' : '✕';
  btn.classList.toggle('copied', ok);
  setTimeout(() => { btn.innerHTML = ic('copy', 13); btn.classList.remove('copied'); }, 1400);
}

let launchAvail = null;
export async function loadLaunchOptions() {
  if (launchAvail) return launchAvail;
  try { launchAvail = await api('GET', '/api/launch', undefined, { quiet: true }); } catch { return {}; }
  return launchAvail;
}
async function launchMode(notBoard = false) {
  return launchPick(pickedSetting('launch'), await loadLaunchOptions(), notBoard);
}
function flashButton(btn, ok, title) {
  if (!btn) return;
  const icon = btn.innerHTML;
  const was = btn.title;
  btn.textContent = ok ? '✓' : '✕';
  btn.classList.toggle('copied', ok);
  if (title) btn.title = title;
  setTimeout(() => { btn.innerHTML = icon; btn.title = was; btn.classList.remove('copied'); }, 1400);
}
function refusedManual(e, keys, btn) {
  if (e.body?.reason !== 'manual') return false;
  flashButton(btn, false);
  const w = manualRefusal(e.body.manual, keys || []);
  styledAlert([tr(w.head), `${w.keys}.`, w.tail && tr(w.tail)].filter(Boolean).join(' '));
  refresh();
  return true;
}
function refusedCheck(e, btn) {
  if (e.body?.reason !== 'check-open' || !e.body.key) return false;
  flashButton(btn, false);
  const key = String(e.body.key);
  styledConfirm(`${tr('Another check of this project is open:')} ${key}. ${tr('It goes first — start this one once it is finished or cancelled.')}`,
    { okLabel: `${tr('Open')} ${key}` }).then((ok) => { if (ok) openDrawer(key); });
  refresh();
  return true;
}
function startRefused(e, keys) {
  if (!refusalText(e).gone) return;
  // the server does not name the deleted task: only a start of the open card's task alone is known to be about it —
  // ▶ of a column sends every key of it, and the open card may be a live one
  if (state.drawerKey && keys?.length === 1 && keys[0] === state.drawerKey) closeDrawer();
  refresh();
}
async function postLaunch(body, btn, again = false) {
  try {
    await api('POST', '/api/launch', body, { quiet: true });
    flashButton(btn, true);
  } catch (e) {
    if (refusedManual(e, body.keys, btn) || refusedCheck(e, btn)) return;
    if (e.body?.reason === 'no-folder' && body.text && !again) {
      if (await askProjectFolder(e.body)) await postLaunch(body, btn, true);
      return;
    }
    flashButton(btn, false);
    styledAlert(refusalLine('Could not start Claude', e, tr));
    startRefused(e, body.keys);
  }
}
const BOARD_WHY = {
  'no-project': "Claude inside the board starts in the folder of one project — open that project's board and press ▶ there.",
  'no-tmux': 'tmux is not installed on this computer — install it (brew install tmux) or pick another way to start tasks in Settings.',
  'no-claude': 'Claude Code (the claude command) is not found on this computer — install it, or pick another way to start tasks in Settings.',
  'too-long': "The prompt is too long for the board's terminal — start it in the Terminal or the Claude app (Settings), or shorten it.",
  'tmux-slow': 'tmux did not answer in time, so the board cannot tell whether a Claude already works on these tasks — press ▶ again in a few seconds.',
};
/** Continue the board's session `session` of the task `key` in its terminal; true — started. */
export async function resumeOnBoard({ key, session, btn, again = false }) {
  if (!key || !session) return false;
  const keys = [key];
  const body = { mode: 'board', project: key.replace(/-\d+$/, ''), keys, resume: session, permission: getSetting('permission'),
    effort: startEffort(checksOnly(keys, state.tasks), getSetting('effort'), getSetting('effortCheck')) };
  const label = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = tr('Starting…'); }
  try {
    await api('POST', '/api/launch', body, { quiet: true });
    return true;
  } catch (e) {
    // their flash of the button would put «Starting…» back on it after the label below — the window says it all
    if (refusedManual(e, keys, null) || refusedCheck(e, null)) return false;
    if (e.body?.running?.length) return true; // up already — the terminal shows it at its next look
    if (e.body?.reason === 'no-folder' && !again) return (await askProjectFolder(e.body)) && resumeOnBoard({ key, session, btn, again: true });
    styledAlert(BOARD_WHY[e.body?.reason] && e.body.reason !== 'tmux-slow' ? tr(BOARD_WHY[e.body.reason]) : refusalLine('Could not continue Claude', e, tr));
    startRefused(e, keys);
    return false;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }
}
export async function launchInClaude({ text, project, keys, btn, again = false, check }) {
  let mode = await launchMode();
  const effort = startEffort(check ?? checksOnly(keys, state.tasks), getSetting('effort'), getSetting('effortCheck'));
  if (mode === 'board') {
    try {
      const r = await api('POST', '/api/launch', { mode, text, project: project || undefined, keys: keys?.length ? keys : undefined, permission: getSetting('permission'), effort }, { quiet: true });
      flashButton(btn, true);
      openTerminalOf(r.keys?.[0], r);
      return;
    } catch (e) {
      const why = e.body?.reason;
      if (refusedManual(e, keys, btn) || refusedCheck(e, btn)) return;
      if (e.body?.running?.length) { flashButton(btn, true); openTerminalOf(e.body.running[0]); return; }
      if (why === 'no-folder' && !again) {
        if (await askProjectFolder(e.body)) await launchInClaude({ text, project, keys, btn, again: true, check });
        return;
      }
      if (boardOnly(pickedSetting('launch')) || !e.body?.fallback) {
        flashButton(btn, false);
        const which = why === 'tmux-slow' && e.body?.keys?.length ? ` ${tr('Tasks:')} ${e.body.keys.join(', ')}.` : '';
        styledAlert(BOARD_WHY[why] ? tr(BOARD_WHY[why]) + which : refusalLine('Could not start Claude', e, tr));
        startRefused(e, keys);
        return;
      }
      mode = await launchMode(true);
    }
  }
  if (mode === 'copy') { flashButton(btn, await copyText(promptHere(text)), tr('copied — paste it into Claude')); return; }
  // the Claude app, where the person still has to send the prompt — that Claude moves them itself)
  await postLaunch({ mode, text: mode === 'desktop' ? promptHere(text) : text, project: project || undefined, keys: keys?.length ? keys : undefined, effort: mode === 'terminal' ? effort : undefined }, btn);
}
function askProjectFolder({ project, name, missing, suggest }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal launch-folder">
      <div class="modal-title">${esc(typeset(missing ? tr('The folder of this project is not on this computer') : tr('This project has no folder')))}</div>
      <div class="lf-text">${esc(typeset(tr('Claude works in the folder of the project.')))} ${esc(missing ? `${tr('It was:')} ${missing}.` : `${tr('Project:')} ${name || project}.`)}</div>
      ${suggest ? `<div class="lf-text">${esc(typeset(tr('Create a new empty folder, or choose the folder with the project\'s code — the board remembers it and starts Claude at once.')))}</div><div class="lf-path">${esc(suggest)}</div>` : ''}
      <div class="modal-err hidden"></div>
      <div class="modal-actions">
        ${suggest ? `<button type="button" class="btn-primary lf-create">${esc(tr('Create the folder'))}</button>` : ''}
        <button type="button" class="${suggest ? 'btn-ghost' : 'btn-primary'} lf-pick">${esc(tr('Choose a folder…'))}</button>
        <button type="button" class="btn-ghost lf-cancel">${esc(tr('Cancel'))}</button>
      </div>
    </div>`;
    document.body.appendChild(overlay);
    let done = false;
    const close = overlayLayer(overlay, { onClose: () => { if (!done) resolve(false); } });
    const finish = () => { done = true; close(); resolve(true); };
    const err = (m) => { const el = overlay.querySelector('.modal-err'); el.textContent = m || ''; el.classList.toggle('hidden', !m); };
    const busy = (on) => overlay.querySelectorAll('button').forEach((b) => { b.disabled = on; });
    overlay.querySelector('.lf-cancel').onclick = close;
    const create = overlay.querySelector('.lf-create');
    if (create) {
      create.onclick = async () => {
        busy(true); err('');
        try { await api('POST', `/api/projects/${encodeURIComponent(project)}/folder`, null, { quiet: true }); finish(); } catch (e) { err(refusalLine('Could not create the folder', e, tr)); busy(false); }
      };
    }
    overlay.querySelector('.lf-pick').onclick = async () => {
      busy(true); err('');
      try {
        const r = await api('POST', '/api/fs/pick', null, { quiet: true });
        if (r?.path) { await api('PATCH', `/api/projects/${encodeURIComponent(project)}`, { path: r.path.replace(/\/+$/, '') || r.path }, { quiet: true }); finish(); return; }
      } catch (e) {
        err(e.status === 501 ? tr('There is no folder dialog on this computer — set the folder in the project settings.') : refusalLine('Could not set the folder', e, tr));
      }
      busy(false);
    };
  });
}

/** Open the Claude session that worked on a task: in the app by its own id, or resumed in a terminal. */
export async function openSessionInClaude({ session, host, project, btn }) {
  const mode = await launchMode(true);
  const a = await loadLaunchOptions();
  if (mode === 'desktop' && host) return postLaunch({ mode: 'desktop', host }, btn);
  if (mode === 'terminal' || (mode === 'desktop' && a.terminal && a.cli)) return postLaunch({ mode: 'terminal', resume: session, project: project || undefined }, btn);
  const port = boardPort();
  const env = /^\d+$/.test(port) && port !== KB_DEFAULT_PORT ? `KB_URL=http://127.0.0.1:${port} ` : '';
  flashButton(btn, await copyText(`${env}claude --resume ${session}`), tr('copied — paste it into Claude'));
}

export async function copyBacklogPrompt(tasks, btn) {
  const slug = state.slug === ALL ? null : state.slug;
  const head = slug ? `${tr('Groom the backlog of')} ${slug} ${tr('(grooming mode):')}` : tr('Groom the backlog (grooming mode):');
  const text = promptHere([tr('Run the kanban skill'), head, ...tasks.map((t) => t.key)].join('\n'));
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
  $('now').classList.toggle('hidden', view !== 'now');
  $('review').classList.toggle('hidden', view !== 'review');
  $('done').classList.toggle('hidden', view !== 'done');
  $('automations').classList.toggle('hidden', view !== 'automations');
  $('health').classList.toggle('hidden', view !== 'health');
  $('settings').classList.toggle('hidden', view !== 'settings');
  $('horizon').classList.toggle('hidden', view !== 'horizon');
  $('calendar').classList.toggle('hidden', view !== 'calendar');
  $('chaos').classList.toggle('hidden', view !== 'chaos');
  $('projset').classList.toggle('hidden', view !== 'projset');
  const changed = lastView !== view;
  lastView = view;
  return changed;
}
