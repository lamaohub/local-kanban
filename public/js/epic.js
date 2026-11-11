import { $, api, esc, ic, seg, state, tr } from './core.js';
import { openDoc, openDrawer, sayRefused } from './drawer.js';
import { chatText } from './chat-md.js';
import { fmtDate } from './sse.js';
import { refusalLine, refusalText } from './unsaved.js';
import { styledAlert, styledConfirm, styledPrompt } from './sidebar.js';
import { getSetting } from './settings.js';
import { startEffort } from './launch-rules.js';
import { automations } from './automations.js';
import { batchProgress, epicBadge, refusedWord, runWords } from './epic-rules.js';

let rowKey = null; // the card the row was drawn for
let shown = null; // what the row shows: {key, plan, epic, children}
let planWin = null; // the open window of a plan: {key, version, current, at, versions, body, el}
let epicAsk = 0;

/** The words of a plan's version: «v3 / 3 · 9 Nov 14:20», an earlier one marked. */
export const versionWords = (p) => `v${p.version} / ${p.current} · ${fmtDate(p.at)}${p.version !== p.current ? ` · ${tr('earlier version')}` : ''}`;
const planHref = (key, version, current) => `/api/tasks/${seg(key)}/plan.md${version && version !== current ? `?version=${version}` : ''}`;

const planLine = (t) => (t.plan ? `<div class="epic-plan">${ic('doc', 13)}<span class="epic-plan-l">${esc(tr('Plan'))}</span>`
  + `<span class="muted epic-plan-v">v${esc(t.plan.version)} · ${esc(fmtDate(t.plan.at))}</span>`
  + `<button type="button" class="link-chip link-add" id="d-plan-open">${esc(tr('Open plan'))}</button></div>` : '');

const taskRow = (t) => `<div class="eb-task" draggable="true" data-key="${esc(t.key)}" title="${esc(t.title)}"><span class="dot s-${esc(t.status)}"></span>`
  + `<span class="eb-key">${esc(t.key)}</span><span class="eb-t">${esc(t.title || tr('untitled'))}</span></div>`;

function batchHTML(b, e) {
  const run = e.run?.[b.id];
  const leading = run && ['starting', 'running', 'accepting'].includes(run.state);
  const said = run ? runWords(run, tr) : '';
  const prog = batchProgress(b.counts, tr);
  const canStart = !b.closed && !leading;
  return `<div class="eb${b.closed ? ' eb-closed' : ''}" data-batch="${b.id}">`
    + `<div class="eb-head" draggable="true" title="${esc(tr('Drag to change the order of the batches'))}">`
    + `<span class="eb-n">${esc(tr('Batch'))} ${b.n}</span>`
    + `<button type="button" class="eb-title" data-act="rename" title="${esc(tr('Rename the batch'))}">${esc(b.title || tr('untitled'))}</button>`
    + `<span class="eb-prog muted">${esc(prog)}</span>`
    + `<span class="eb-tools">${canStart ? `<button type="button" class="link-chip link-add" data-act="run">${ic('play', 12)}<span>${esc(tr(run?.state === 'failed' ? 'Start again' : 'Start the batch'))}</span></button>` : ''}`
    + `${leading ? `<button type="button" class="link-chip link-add" data-act="stop">${esc(tr('Stop'))}</button>` : ''}`
    + `<button type="button" class="btn-icon eb-del" data-act="delete" aria-label="${esc(tr('Delete the batch'))}" title="${esc(tr('Delete the batch'))}">×</button></span></div>`
    + `${said ? `<div class="eb-run${run.state === 'failed' ? ' eb-run-bad' : ''}">${esc(said)}</div>` : ''}`
    + `<div class="eb-tasks">${b.tasks.map(taskRow).join('') || `<div class="eb-empty muted">${esc(tr('Drag sub-tasks here'))}</div>`}</div></div>`;
}

function epicHTML(t) {
  const e = t.epic;
  const kids = (t.links || []).filter((l) => l.rel === 'child');
  if (!e) {
    if (!kids.length) return '';
    return `<div class="epic-head"><span class="epic-plan-l">${esc(tr('Sub-tasks'))}: ${kids.length}</span>`
      + `<button type="button" class="link-chip link-add" data-act="split">${esc(tr('Lay out in batches'))}</button></div>`;
  }
  const autoOff = (e.auto_next || e.through) && !automations().on;
  return `<div class="epic-head"><span class="epic-plan-l">${esc(tr('Batches'))}</span><span class="muted">${esc(epicBadge(e, tr))}</span>`
    + `<span class="epic-set"><span class="muted">${esc(tr('Portion'))}</span>`
    + `<button type="button" class="btn-icon" data-act="portion-" aria-label="${esc(tr('Fewer tasks a start'))}">−</button><span class="epic-portion">${e.portion}</span>`
    + `<button type="button" class="btn-icon" data-act="portion+" aria-label="${esc(tr('More tasks a start'))}">+</button>`
    + `<label class="epic-auto"><input type="checkbox" data-act="auto"${e.auto_next ? ' checked' : ''}> ${esc(tr('next batch by itself after acceptance'))}</label>`
    + `<label class="epic-auto" title="${esc(tr('The next batch starts once this one is in Ready to ship or Review, without your acceptance; the tasks of the epic commit one after another into one branch, and the epic ships once, when you say so'))}"><input type="checkbox" data-act="through"${e.through ? ' checked' : ''}> ${esc(tr('straight through, without acceptance between batches'))}</label></span></div>`
    + (autoOff ? `<div class="eb-run muted">${esc(tr('Automations are off in the settings — the next batch waits for you'))}</div>` : '')
    + `<div class="epic-batches">${e.batches.map((b) => batchHTML(b, e)).join('')}</div>`
    + `<div class="epic-foot"><button type="button" class="link-chip link-add" data-act="add">${esc(tr('+ batch'))}</button>`
    + (e.loose?.length ? `<span class="muted">${esc(tr('In no batch'))}:</span><div class="eb-loose" data-batch="none">${e.loose.map(taskRow).join('')}</div>` : '<div class="eb-loose eb-loose-empty" data-batch="none"></div>')
    + '</div>';
}

/** The epic's row of an open card: the plan's line and the batches. `t` — the full card, or null. */
export function renderEpic(t) {
  const row = $('d-epic');
  if (!row) return;
  rowKey = t?.key || null;
  shown = t ? { key: t.key, plan: t.plan || null, epic: t.epic || null, links: t.links || [] } : null;
  const html = t ? planLine(t) + epicHTML(t) : '';
  if (!html) { row.classList.add('hidden'); row.innerHTML = ''; return; }
  row.innerHTML = html;
  row.classList.remove('hidden');
  const open = row.querySelector('#d-plan-open');
  if (open) open.onclick = () => openPlan(t.key);
  wireEpic(row, t.key);
}

/** The epic's view again (an event, a change made here) — drawn only if its card is still the open one. */
async function reloadEpic(key, v = null) {
  const my = ++epicAsk;
  let view = v;
  if (!view) { try { view = await api('GET', `/api/tasks/${seg(key)}/epic`, undefined, { quiet: true }); } catch { return; } }
  if (my !== epicAsk || key !== state.drawerKey || key !== rowKey || !shown) return;
  const epic = view.batches?.length ? { ...(shown.epic || {}), ...view, ...summaryOf(view) } : null;
  renderEpic({ ...shown, epic });
}
const summaryOf = (v) => {
  const all = v.batches.flatMap((b) => b.tasks.map((t) => t.status));
  const open = v.batches.findIndex((b) => !b.closed && b.tasks.length);
  return { batches_n: v.batches.length, tasks_n: all.length, closed_n: all.filter((s) => s === 'done' || s === 'cancelled').length, current: open < 0 ? null : open + 1 };
};

async function act(key, method, path, body, head) {
  try { const v = await api(method, `/api/tasks/${seg(key)}${path}`, body, { quiet: true }); await reloadEpic(key, v); return v; }
  catch (e) { if (refusalText(e).gone) sayRefused(e, key); else styledAlert(refusalLine(head, e, tr)); return null; }
}

function runWordsForPage() {
  return {
    run: tr('Run the kanban skill'),
    epic: tr('This is batch {n}{title} of the epic {key}: kb show {key} prints its batches, kb plan {key} its plan.'),
    doTask: tr('Do the tasks:'),
    through: tr('The epic {key} runs straight through: its next batch starts once this one is handed in, before anything is shipped, and builds on its commits — leave them where they are and do not ship to main; the epic ships once, when the owner says so.'),
  };
}
async function startBatch(key, b, force = false) {
  const body = { words: runWordsForPage(), launch: { permission: getSetting('permission'), effort: startEffort(false, getSetting('effort'), getSetting('effortCheck')) || undefined }, ...(force ? { force: true } : {}) };
  try {
    const v = await api('POST', `/api/tasks/${seg(key)}/batches/${b.id}/run`, body, { quiet: true });
    await reloadEpic(key, v);
  } catch (e) {
    if (e?.status === 409 && e.body?.reason === 'batch-running' && !force) {
      const ok = await styledConfirm(tr('Batch {m} of this epic is still running. Start batch {n} next to it?').replace('{m}', e.body.batch).replace('{n}', b.n), { okLabel: tr('Start next to it') });
      if (ok) await startBatch(key, b, true);
      return;
    }
    const why = refusedWord(e?.body);
    styledAlert(why ? `${tr('The batch did not start')}: ${tr(why)}` : refusalLine('The batch did not start', e, tr));
    reloadEpic(key);
  }
}

function wireEpic(row, key) {
  const e = shown?.epic;
  const batchOf = (el) => e?.batches.find((b) => String(b.id) === el.closest('[data-batch]')?.dataset.batch);
  row.querySelectorAll('[data-act]').forEach((el) => {
    const a = el.dataset.act;
    if (a === 'auto') { el.onchange = () => act(key, 'PATCH', '/epic', { auto_next: el.checked }, 'Not saved'); return; }
    if (a === 'through') { el.onchange = () => act(key, 'PATCH', '/epic', { through: el.checked }, 'Not saved'); return; }
    el.onclick = async (ev) => {
      ev.stopPropagation();
      const b = batchOf(el);
      if (a === 'split') {
        const v = await act(key, 'POST', '/batches', { title: '' }, 'Not saved');
        const first = v?.batches?.[0];
        if (!first) return;
        let last = v;
        for (const t of v.loose || []) last = await act(key, 'POST', '/epic/place', { key: t.key, batch: first.id }, 'Not saved') || last;
        return;
      }
      if (a === 'add') return act(key, 'POST', '/batches', { title: '' }, 'Not saved');
      if (a === 'portion-' || a === 'portion+') {
        const n = Math.min(10, Math.max(1, (e?.portion || 3) + (a === 'portion+' ? 1 : -1)));
        if (n !== e?.portion) act(key, 'PATCH', '/epic', { portion: n }, 'Not saved');
        return;
      }
      if (!b) return;
      if (a === 'rename') {
        styledPrompt(tr('The name of batch {n}').replace('{n}', b.n), { placeholder: b.title || tr('Stage 1'), okLabel: tr('Save'),
          onSubmit: async (title) => { const v = await api('PATCH', `/api/tasks/${seg(key)}/batches/${b.id}`, { title }, { quiet: true }); await reloadEpic(key, v); } });
        return;
      }
      if (a === 'delete') {
        const ok = await styledConfirm(tr('Delete batch {n}? Its tasks stay sub-tasks of the epic, in no batch.').replace('{n}', b.n), { okLabel: tr('Delete'), danger: true });
        if (ok) act(key, 'DELETE', `/batches/${b.id}`, undefined, 'Could not delete the batch');
        return;
      }
      if (a === 'run') return startBatch(key, b);
      if (a === 'stop') return act(key, 'POST', `/batches/${b.id}/stop`, {}, 'Not saved');
    };
  });
  row.querySelectorAll('.eb-task').forEach((el) => { el.onclick = () => openDrawer(el.dataset.key); });
  wireDrag(row, key);
}

/* Dragging: a task between batches and within one (dropped on a row — before it, or after it past its middle; on the
   empty part — at the end; on «In no batch» — out of the batches), a batch by its head among the batches. */
function wireDrag(row, key) {
  let dragged = null; // {kind: 'task'|'batch', id}
  const clear = () => row.querySelectorAll('.eb-over, .eb-before, .eb-after').forEach((x) => x.classList.remove('eb-over', 'eb-before', 'eb-after'));
  row.querySelectorAll('.eb-task').forEach((el) => {
    el.addEventListener('dragstart', (ev) => { dragged = { kind: 'task', id: el.dataset.key }; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', el.dataset.key); el.classList.add('eb-dragging'); });
    el.addEventListener('dragend', () => { el.classList.remove('eb-dragging'); dragged = null; clear(); });
  });
  row.querySelectorAll('.eb-head').forEach((el) => {
    el.addEventListener('dragstart', (ev) => { dragged = { kind: 'batch', id: el.closest('.eb').dataset.batch }; ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', dragged.id); });
    el.addEventListener('dragend', () => { dragged = null; clear(); });
  });
  const spot = (zone, ev) => {
    const rows = [...zone.querySelectorAll('.eb-task')].filter((r) => r.dataset.key !== dragged?.id);
    for (const r of rows) { const box = r.getBoundingClientRect(); if (ev.clientY < box.top + box.height / 2) return r; }
    return null;
  };
  row.querySelectorAll('.eb, .eb-loose').forEach((zone) => {
    zone.addEventListener('dragover', (ev) => {
      if (!dragged) return;
      if (dragged.kind === 'batch' && !zone.classList.contains('eb')) return;
      ev.preventDefault();
      clear();
      if (dragged.kind === 'task') { zone.classList.add('eb-over'); spot(zone, ev)?.classList.add('eb-before'); }
      else if (zone.dataset.batch !== dragged.id) zone.classList.add(ev.clientY < zone.getBoundingClientRect().top + zone.getBoundingClientRect().height / 2 ? 'eb-before' : 'eb-after');
    });
    zone.addEventListener('dragleave', (ev) => { if (!zone.contains(ev.relatedTarget)) zone.classList.remove('eb-over', 'eb-before', 'eb-after'); });
    zone.addEventListener('drop', (ev) => {
      if (!dragged) return;
      ev.preventDefault();
      const d = dragged;
      const after = zone.classList.contains('eb-after');
      const before = d.kind === 'task' ? spot(zone, ev)?.dataset.key || null : null;
      clear();
      if (d.kind === 'task') {
        const batch = zone.dataset.batch === 'none' ? null : Number(zone.dataset.batch);
        act(key, 'POST', '/epic/place', { key: d.id, batch, before }, 'Not moved');
        return;
      }
      const ids = (shown?.epic?.batches || []).map((b) => b.id).filter((id) => String(id) !== d.id);
      let at = ids.findIndex((id) => String(id) === zone.dataset.batch);
      if (at < 0) return;
      if (after) at += 1;
      ids.splice(at, 0, Number(d.id));
      act(key, 'PUT', '/batches/order', { batches: ids }, 'Not moved');
    });
  });
}

/** `task.epic`: a batch of the open epic changed (a sub-task moved, a portion started) — its view is read again. */
export function applyEpicEvent(data) {
  if (data?.key && data.key === rowKey && data.key === state.drawerKey) reloadEpic(data.key);
}

/** The plan of a task in its window. `version` — an earlier one; none — the current. */
export function openPlan(key, version = null) {
  const tools = `<button type="button" class="btn-icon doc-prev" aria-label="${esc(tr('Earlier version'))}" title="${esc(tr('Earlier version'))}">‹</button>`
    + '<span class="doc-ver muted"></span>'
    + `<button type="button" class="btn-icon doc-next" aria-label="${esc(tr('Later version'))}" title="${esc(tr('Later version'))}">›</button>`
    + `<a class="link-chip link-add doc-dl" download>${ic('download', 13)}<span>${esc(tr('Download .md'))}</span></a>`;
  const win = { key, version, current: null, versions: [] };
  planWin = win;
  const paint = (p) => {
    Object.assign(win, { version: p.version, current: p.current, versions: p.versions || [], at: p.at });
    const head = win.el.overlay;
    head.querySelector('.doc-ver').textContent = versionWords(p);
    const list = win.versions.map((v) => v.version); // newest first
    const at = list.indexOf(p.version);
    head.querySelector('.doc-prev').disabled = at < 0 || at >= list.length - 1;
    head.querySelector('.doc-next').disabled = at <= 0;
    head.querySelector('.doc-dl').href = planHref(key, p.version, p.current);
    return chatText(p.body, null, { soft: true });
  };
  const read = async (v) => paint(await api('GET', `/api/tasks/${seg(key)}/plan${v ? `?version=${v}` : ''}`, undefined, { quiet: true }));
  const refused = (e) => refusalLine('The plan could not be opened', e, tr);
  const step = async (dir) => {
    const list = win.versions.map((v) => v.version);
    const next = list[list.indexOf(win.version) + dir];
    if (next == null) return;
    try { win.el.body.innerHTML = await read(next); win.el.body.scrollTop = 0; } catch (e) { win.el.body.textContent = refused(e); }
  };
  win.el = openDoc(`${tr('Plan')} · ${key}`, () => read(version), refused, {
    tools,
    wire: (overlay) => {
      overlay.querySelector('.doc-prev').onclick = () => step(1);
      overlay.querySelector('.doc-next').onclick = () => step(-1);
      overlay.querySelector('.doc-dl').href = planHref(key, version, null);
    },
  });
  win.reload = async () => { try { win.el.body.innerHTML = await read(null); } catch { /* the shown version stays */ } };
}

/** `task.plan`: Claude wrote a new version — the card's line follows, and an open window on the current version too. */
export async function applyPlanEvent(data) {
  if (!data?.key) return;
  if (data.key === rowKey && data.key === state.drawerKey && shown) renderEpic({ ...shown, plan: data.plan });
  const w = planWin;
  if (w?.key === data.key && w.el?.overlay.isConnected && w.version === w.current) await w.reload();
}
