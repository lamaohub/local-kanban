
import { WORKING, buildSelect, drawLinks } from './board.js';
import { $, ALL_STATUSES, LANG, api, apiBlob, esc, ic, seg, state, tr } from './core.js';
import { applyKeepDrawer } from './drawer.js';
import { checkVersion, pendingReload } from './init.js';
import { loadProjects, popLayer, pushLayer, setupPromptBlockHTML, styledAlert, styledConfirm, styledPrompt, wireSetupPrompt } from './sidebar.js';
import { SHORT_MONTHS, SOUND_LIB, STATUS_LABELS, audioCtx, lastMissedAt, lastSseAt, missedSounds, pageLoadedAt, playNamedSound, refresh, relTime, titleOr, updateSoundBadge } from './sse.js';

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

const SETTINGS_DEFAULTS = { sound: true, soundReview: 'ding', soundDone: 'click', startScreen: 'dashboard', dashRange: 'week', theme: 'system', keepDrawer: false, notifyReview: false, compactCards: false, linkLines: true, keymap: {} };
export function getSetting(k) {
  const v = localStorage.getItem('kb.set.' + k);
  if (v === null) return SETTINGS_DEFAULTS[k];
  try { return JSON.parse(v); } catch { return SETTINGS_DEFAULTS[k]; }
}
export function setSetting(k, v) { localStorage.setItem('kb.set.' + k, JSON.stringify(v)); }

export function syncLangToServer(lang = LANG) {
  return api('POST', '/api/lang', { lang }).catch(() => {});
}

const KEY_ACTIONS = [
  { id: 'newTask', label: tr('new task'), def: { code: 'KeyN' } },
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
  const km = getSetting('keymap') || {};
  return km[id] || KEY_ACTIONS.find((a) => a.id === id).def;
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
  { v: 'system', label: 'System', sw: ['#fbfbfa', '#ffffff', '#e8704e'] },
  { v: 'light', label: 'Light', sw: ['#fbfbfa', '#ffffff', '#e8704e'] },
  { v: 'dark', label: 'Dark', sw: ['#1c1b19', '#262522', '#e8854a'] },
  { v: 'claude', label: 'Claude', sw: ['#1f1f1e', '#262626', '#d97757'] },
];
export function applyTheme() {
  let t = getSetting('theme');
  if (t === 'coral') { setSetting('theme', 'light'); t = 'light'; }
  let mode = t;
  if (t === 'system') mode = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.dataset.theme = mode; // light | dark | claude
  syncThemeColor();
}

export function applyCompact() {
  $('board').classList.toggle('compact', !!getSetting('compactCards'));
}

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) meta.setAttribute('content', bg);
}

const SM_SECTIONS = [['general', tr('General')], ['appearance', tr('Appearance')], ['cats', tr('Sections')], ['skills', tr('Skills')], ['archive', tr('Archive')], ['sync', tr('Sync')], ['errors', tr('Errors')], ['backups', tr('Backups')], ['keys', tr('Hotkeys')], ['about', tr('About')]];
function settingsModalKey(e) { if (e.key === 'Escape') closeSettingsModal(); }
function closeSettingsModal() {
  popLayer('settings-overlay');
  $('settings-overlay')?.remove();
  document.removeEventListener('keydown', settingsModalKey);
}
export function openSettingsModal() {
  closeSettingsModal();
  pushLayer('settings-overlay', closeSettingsModal);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'settings-overlay';
  overlay.innerHTML = `<div class="settings-modal">
    <div class="sm-nav">
      <div class="sm-nav-head">${tr('Settings')}</div>
      ${SM_SECTIONS.map(([id, lab], i) => `<div class="sm-nav-item${i === 0 ? ' active' : ''}" data-sec="${id}">${lab}</div>`).join('')}
    </div>
    <div class="sm-main">
      <button class="sm-close btn-icon" title="${tr('Close')}">✕</button>
      <div class="sm-body" id="sm-body"></div>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.sm-close').onclick = closeSettingsModal;
  overlay.onclick = (e) => { if (e.target === overlay) closeSettingsModal(); };
  overlay.querySelectorAll('.sm-nav-item').forEach((n) => {
    n.onclick = () => { overlay.querySelectorAll('.sm-nav-item').forEach((x) => x.classList.toggle('active', x === n)); renderSection(n.dataset.sec); };
  });
  document.addEventListener('keydown', settingsModalKey);
  renderSection('general');
}
async function renderSection(sec) {
  const body = $('sm-body');
  if (!body) return;
  if (sec === 'general') {
    const soundList = Object.entries(SOUND_LIB).map(([id, s]) => ({ value: id, label: tr(s.name) }));
    body.innerHTML = `<div class="sm-h">${tr('General')}</div>`
      + `<div class="set-row"><span class="set-lab">${tr('Interface language')}<small>${tr('applies after page reload')}</small></span><div class="kbsel set-sel" id="sel-lang"></div></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Sound notifications')}<small>${tr('sound on Review and Done')}</small></span><input type="checkbox" class="set-toggle" data-set="sound"></label>`
      + `<label class="set-row"><span class="set-lab">${tr('Review notifications')}<small>${tr('system notification when a task reaches Review')}</small></span><input type="checkbox" class="set-toggle" data-set="notifyReview"></label>`
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
    const diagTimer = setInterval(() => { if (!renderSndDiag()) clearInterval(diagTimer); }, 1000);
    body.querySelector('[data-set="sound"]').checked = !!getSetting('sound');
    body.querySelector('[data-set="sound"]').onchange = (e) => { setSetting('sound', e.target.checked); updateSoundBadge(); };
    const notifyEl = body.querySelector('[data-set="notifyReview"]');
    notifyEl.checked = !!getSetting('notifyReview');
    notifyEl.onchange = async (e) => {
      if (e.target.checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        if (perm !== 'granted') { e.target.checked = false; setSetting('notifyReview', false); return; }
      }
      setSetting('notifyReview', e.target.checked);
    };
    body.querySelector('[data-set="keepDrawer"]').checked = !!getSetting('keepDrawer');
    body.querySelector('[data-set="keepDrawer"]').onchange = (e) => { setSetting('keepDrawer', e.target.checked); applyKeepDrawer(); };
    buildSelect($('sel-soundReview'), { value: getSetting('soundReview'), options: soundList, onChange: (v) => { setSetting('soundReview', v); playNamedSound(v); } });
    buildSelect($('sel-soundDone'), { value: getSetting('soundDone'), options: soundList, onChange: (v) => { setSetting('soundDone', v); playNamedSound(v); } });
    buildSelect($('sel-startScreen'), { value: getSetting('startScreen'), options: [{ value: 'dashboard', label: tr('Dashboard') }, { value: 'chaos', label: tr('Chaos') }, { value: 'last', label: tr('Last opened') }], onChange: (v) => setSetting('startScreen', v) });
    buildSelect($('sel-dashRange'), { value: getSetting('dashRange'), options: RANGE_BTN.map(([v, lab]) => ({ value: v, label: tr(lab) })), onChange: (v) => { setSetting('dashRange', v); state.dashRange = v; } });
    buildSelect($('sel-lang'), { value: LANG, options: [{ value: 'ru', label: tr('Russian') }, { value: 'en', label: 'English' }], onChange: async (v) => { setSetting('lang', v); await syncLangToServer(v); location.reload(); } });
    body.querySelectorAll('.snd-test').forEach((b) => { b.onclick = () => playNamedSound(getSetting(b.dataset.test)); });
  } else if (sec === 'appearance') {
    const cur = getSetting('theme');
    body.innerHTML = `<div class="sm-h">${tr('Appearance')}</div>`
      + `<div class="set-col"><span class="set-lab">${tr('Theme')}<small>${tr('light, dark or in Claude colors')}</small></span>`
      + `<div class="theme-grid">${THEMES.map((t) => `<button class="theme-card${t.v === cur ? ' active' : ''}" data-theme="${t.v}">`
          + `<span class="theme-sw">${t.sw.map((c) => `<span style="background:${c}"></span>`).join('')}</span>`
          + `<span class="theme-card-lab">${tr(t.label)}</span></button>`).join('')}</div></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Compact cards')}<small>${tr('hide the description preview — more cards fit on screen')}</small></span><input type="checkbox" class="set-toggle" data-set="compactCards"></label>`
      + `<label class="set-row"><span class="set-lab">${tr('Link lines')}<small>${tr('draw lines between linked cards; when off, links show as a chain badge')}</small></span><input type="checkbox" class="set-toggle" data-set="linkLines"></label>`;
    body.querySelectorAll('.theme-card').forEach((b) => {
      b.onclick = () => { setSetting('theme', b.dataset.theme); applyTheme(); body.querySelectorAll('.theme-card').forEach((x) => x.classList.toggle('active', x === b)); };
    });
    body.querySelector('[data-set="compactCards"]').checked = !!getSetting('compactCards');
    body.querySelector('[data-set="compactCards"]').onchange = (e) => { setSetting('compactCards', e.target.checked); applyCompact(); };
    body.querySelector('[data-set="linkLines"]').checked = getSetting('linkLines') !== false;
    body.querySelector('[data-set="linkLines"]').onchange = (e) => { setSetting('linkLines', e.target.checked); drawLinks(); };
  } else if (sec === 'archive') {
    body.innerHTML = `<div class="sm-h">${tr('Archive')}</div>`
      + `<div class="kbh-note muted">${tr('Archived boards are hidden from the sidebar and left out of every dashboard number. Their tasks are kept.')}</div>`
      + '<div id="arch-list" class="bk-list">…</div>';
    const load = async () => {
      let list;
      try { list = await api('GET', '/api/projects/archived'); } catch { $('arch-list').textContent = '—'; return; }
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
    catch { $('cat-list').textContent = '—'; return; }
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
      try { await fn(); } catch (e) { $('cat-list').insertAdjacentHTML('afterbegin', `<div class="cat-err">${esc(e.message || tr('did not work'))}</div>`); return; }
      await refresh();
      renderSection('cats');
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
      + `<div class="sync-about">`
      + `<p>${tr('The board can mirror its tasks to GitHub: every task becomes an issue, and each project gets its own Projects v2 board. Handy when someone else needs to see the work, or when you want the history somewhere besides this machine.')}</p>`
      + `<p>${tr('One repository for the whole board, not one per project. Create it yourself first, and make it private: task titles, descriptions and comments are copied there in full. This is the only thing on this board that leaves your machine.')}</p>`
      + `<p>${tr('The mirror is one-way: the board writes to GitHub and never reads back. Turning it off is emptying these fields.')}</p>`
      + `<p class="muted">${tr('Needs the gh CLI, signed in with the project scope:')}</p>`
      + '<pre class="onb-code">gh auth login &amp;&amp; gh auth refresh -s project</pre>'
      + `<p class="muted">${tr('Without that scope an issue is still created, but the card never lands on the Projects board.')}</p>`
      + `<p class="muted"><a href="https://github.com/lamaohub/local-kanban#github-sync-optional" target="_blank" rel="noopener noreferrer">${tr('The same in the README, in more detail')}</a></p>`
      + `</div>`
      + `<div class="set-col"><span class="set-lab">${tr('Owner and issues repository')}<small id="sync-cfg-hint">${tr('empty — sync is off, the board runs locally')}</small></span>`
      + `<div class="sync-cfg-row"><input type="text" id="sync-owner" placeholder="${tr('owner (GitHub user)')}"><input type="text" id="sync-repo" placeholder="${tr('owner/repo for issues')}"><button class="btn-ghost" id="sync-cfg-save">${tr('Save')}</button></div></div>`
      + `<div class="set-row"><span class="set-lab" id="set-sync">…<small id="set-sync-last"></small></span><button class="btn-ghost" id="set-sync-retry">${tr('Retry failed')}</button></div>`
      + `<label class="set-row"><span class="set-lab">${tr('Pause sync')}<small>${tr('keep changes local and catch up with GitHub later')}</small></span><input type="checkbox" class="set-toggle" id="sync-pause"></label>`
      + `<div class="set-col hidden" id="sync-errors-wrap"><span class="set-lab">${tr('Recent errors')}</span><div id="sync-errors" class="bk-list"></div></div>`;
    const OP_LABEL = { create_issue: tr('create issue'), set_status: tr('status'), set_priority: tr('priority'), set_labels: tr('labels'), set_blocked: tr('blocked flag'), add_comment: tr('comment'), update_issue: tr('edit issue'), close_issue: tr('close issue'), reopen_issue: tr('reopen issue'), delete_issue: tr('delete issue') };
    try {
      const s = await api('GET', '/api/sync');
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
    $('sync-pause').onchange = async (e) => { try { await api('POST', '/api/sync/pause', { paused: e.target.checked }); } catch {  } renderSection('sync'); };
    $('set-sync-retry').onclick = async () => { try { await api('POST', '/api/sync/retry'); } catch {  } renderSection('sync'); };
    $('sync-cfg-save').onclick = async () => {
      try { await api('POST', '/api/sync/config', { owner: $('sync-owner').value, repo: $('sync-repo').value }); }
      catch (e) { $('sync-cfg-hint').textContent = e.message || tr('not saved'); return; }
      renderSection('sync');
    };
  } else if (sec === 'errors') {
    body.innerHTML = `<div class="sm-h">${tr('Errors')}<span class="muted err-count" id="err-count"></span><button class="btn-ghost" id="err-clear">${tr('Clear the log')}</button></div>`
      + `<div class="kbh-note muted">${tr('Everything lands here: a server failure, a failed sync op, an error in the browser. Empty means the board runs clean.')}</div>`
      + '<div id="err-list" class="bk-list">…</div>';
    const SRC = { server: tr('server'), sync: tr('sync'), client: tr('browser') };
    const load = async () => {
      try {
        const list = await api('GET', '/api/errors');
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
      + `<button class="btn-ghost" id="bk-up">${tr('Upload')}</button>`
      + `<button class="btn-ghost" id="bk-now">${tr('Back up now')}</button></div>`
      + `<div class="kbh-note muted">${tr('The uploaded file opens as a separate board on a neighbouring port — this board and its tasks stay untouched.')}</div>`
      + `<input type="file" id="bk-file" accept=".db,application/octet-stream" class="hidden">`
      + `<div id="bk-restore" class="bk-restore hidden"></div>`
      + `<div id="bk-list" class="bk-list">…</div>`;
    const load = async () => {
      try {
        const info = await api('GET', '/api/backups');
        const list = info.items;
        const stamp = (iso) => esc(String(iso).slice(0, 16).replace('T', ' '));
        const head = (info.last_error
          ? `<div class="kbh-note warn">${tr('The last automatic snapshot failed')} (${stamp(info.last_error_at)}): ${esc(info.last_error)}</div>`
          : '')
          + (info.last_ok ? `<div class="kbh-note muted">${tr('Last successful snapshot')}: ${stamp(info.last_ok)}</div>` : '')
          + `<div class="kbh-note muted">${info.attachments
            ? tr('Images and attachments are mirrored next to the snapshots, not inside the downloaded file.')
            : tr('The snapshot covers the database only.')}</div>`;
        $('bk-list').innerHTML = head + (list.length
          ? list.map((b) => `<div class="bk-row"><span>${esc(b.name)}</span><span class="muted">${(b.size / 1048576).toFixed(1)} ${tr('MB')} · ${esc(b.mtime.slice(0, 16).replace('T', ' '))}</span><a class="bk-dl" href="/api/backups/${encodeURIComponent(b.name)}" download="${esc(b.name)}" title="${tr('Download backup')}">${ic('download', 13)}</a></div>`).join('')
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
    $('bk-now').onclick = async () => { $('bk-now').disabled = true; try { await api('POST', '/api/backups'); } catch {  } $('bk-now').disabled = false; load(); };

    const box = () => $('bk-restore');
    const showRestore = (html) => { const b = box(); if (!b) return; b.classList.remove('hidden'); b.innerHTML = html; };
    const renderRunning = (r) => {
      const mins = Math.round((r.expires_in || 0) / 60000);
      showRestore(`<div class="bkr-head">${ic('download', 13)} ${tr('Check board is up')}</div>`
        + `<div class="bkr-sub muted">${tr('tasks')}: <b>${r.stats.tasks}</b> · ${tr('projects')}: <b>${r.stats.projects}</b>`
        + ` · ${tr('closes in')} ${mins} ${tr('min')}</div>`
        + `<div class="bkr-act"><a class="btn-primary" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${tr('Open')} ${esc(r.url)}</a>`
        + `<button class="btn-ghost" id="bkr-stop">${tr('Close the check board')}</button></div>`);
      $('bkr-stop').onclick = async () => { try { await api('DELETE', '/api/backups/restore'); } catch {  } box().classList.add('hidden'); };
    };
    api('GET', '/api/backups/restore', null, { quiet: true }).then((r) => { if (r && r.port) renderRunning(r); }).catch(() => {});

    $('bk-up').onclick = () => $('bk-file').click();
    $('bk-file').onchange = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const goOn = await styledConfirm(
        `${tr('File')}: ${file.name} (${(file.size / 1048576).toFixed(1)} ${tr('MB')}).\n`
        + tr('It will be checked and opened as a SEPARATE board on a neighbouring port. This board and its tasks will not change.'),
        { okLabel: tr('Check the backup') });
      if (!goOn) return;
      $('bk-up').disabled = true;
      showRestore(`<div class="bkr-head">${tr('Checking the file and starting the board…')}</div>`
        + `<div class="bkr-sub muted">${tr('this takes a few seconds')}</div>`);
      try {
        const r = await apiBlob('/api/backups/restore', new Blob([file], { type: 'application/octet-stream' }), { quiet: true });
        renderRunning(r);
      } catch (err) {
        showRestore(`<div class="bkr-head bkr-bad">${ic('warn', 13)} ${tr('Did not work out')}</div>`
          + `<div class="bkr-sub muted">${esc(err.message || String(err))}</div>`);
      }
      $('bk-up').disabled = false;
    };
    load();
  } else if (sec === 'skills') {
    await renderSkillsSection(body);
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
      + `<div class="set-col"><span class="set-lab">${tr("What's new")}<small id="about-news-sub">…</small></span><div class="about-news" id="about-news">…</div></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Check for updates')}<small id="about-recheck-sub">${tr('re-read branch state from GitHub')}</small></span><button class="btn-ghost" id="about-recheck">${tr('Check')}</button></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Reload the page')}<small>${tr('re-read the board code right now')}</small></span><button class="btn-ghost" id="about-reload">${tr('Reload now')}</button></div>`
      + `<div class="set-row"><span class="set-lab">${tr('Using the board at work')}<small>${tr('free for everyone, nothing switched off — if it earns you money, $12 a year per person keeps it maintained')}</small></span>`
      + `<a class="btn-ghost" href="https://github.com/lamaohub/local-kanban/blob/main/docs/COMMERCIAL.md" target="_blank" rel="noopener noreferrer">${tr('Read')}</a></div>`
      + `<div class="set-col"><span class="set-lab">${tr('Diagnostics')}</span><div class="bk-list" id="about-diag">…</div></div>`
      + `<div class="set-col"><span class="set-lab">${tr('Setup via Claude')}<small>${tr('copy and paste into Claude chat — it will run the setup and ask you questions')}</small></span>`
      + setupPromptBlockHTML() + '</div>';
    wireSetupPrompt(body);
    $('about-reload').onclick = () => location.reload();
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
        $('about-do-upd')?.classList.remove('hidden');
      }
      else if (u.dev?.ahead) { el.textContent = `${tr('in dev')} ${u.dev.ahead} ${commitsWord(u.dev.ahead)} ${tr('awaiting release')}`; el.classList.add('stale-ver'); sub.textContent = `${tr('commit')} ${u.local}${tag} · ${tr('matches GitHub')}`; }
      else { el.textContent = tr('up to date ✓'); sub.textContent = `${what} ${u.local}${tag} · ${same}`; }
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
    const loadNews = async (upd, forced) => {
      const box = $('about-news'); const sub = $('about-news-sub');
      if (!box || !sub) return;
      try {
        const remote = upd?.update_available === true ? `?remote=1${forced ? '&refresh=1' : ''}` : '';
        const n = await api('GET', `/api/whats-new${remote}`, null, { quiet: true });
        box.innerHTML = n?.notes ? mdLite(n.notes) : `<p class="muted">${esc(tr('no notes for this version'))}</p>`;
        const ver = n?.version ? `${tr('version')} ${n.version}${n.source === 'github' ? ` · ${tr('not installed yet')}` : ''}` : '';
        const link = /^https:\/\//.test(n?.url || '')
          ? ` · <a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer">${esc(tr('release page'))}</a>` : '';
        sub.innerHTML = esc(ver) + link;
      } catch { box.textContent = '—'; sub.textContent = ''; }
    };
    api('GET', '/api/about').catch(() => null).then((a) => { about = a; })
      .then(() => api('GET', '/api/update-check')).then((u) => { renderUpd(u); return loadNews(u); })
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
      if (about?.packaged) ask.push(`${tr('Afterwards refresh the skills Claude reads:')} local-kanban skills`);
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
        sub.textContent = `${tr('the update did not go through')}: ${err.message || err}`;
        showFailCmd(err.body?.cmd);
        btn.disabled = false; return;
      }
      if (!r?.ok) { stop(tr('Did not work out'), true); sub.textContent = `${tr('the update did not go through')}: ${(r?.output || '').split('\n').pop() || '—'}`; showFailCmd(r?.cmd); btn.disabled = false; return; }
      if (r.restart !== 'pm2') {
        stop('', false);
        sub.textContent = tr('updated — start the board again to pick it up')
          + (about?.packaged ? ` · ${tr('and refresh the skills:')} local-kanban skills` : '');
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
      try { const u = await api('GET', '/api/update-check?refresh=1'); renderUpd(u); await loadNews(u, true); }
      catch { $('about-upd-sub').textContent = '—'; }
      btn.disabled = false;
    };
    try {
      const a = await api('GET', '/api/about');
      about = a;
      $('about-ver').textContent = (a.packaged && a.version) ? `v${a.version}`
        : a.commit ? `${tr('commit')} ${a.commit}`
        : (a.app_mtime ? `app.js ${tr('from')} ${fmtDbTime(a.app_mtime.slice(0, 19).replace('T', ' '))}` : '—');
      const up = a.uptime;
      const upStr = up >= 86400 ? `${Math.floor(up / 86400)}${tr('d')} ${Math.floor((up % 86400) / 3600)}${tr('h')}` : up >= 3600 ? `${Math.floor(up / 3600)}${tr('h')} ${Math.floor((up % 3600) / 60)}${tr('m')}` : `${Math.floor(up / 60)}${tr('m')}`;
      $('about-diag').innerHTML = [
        [tr('Database'), `${(a.db_size / 1048576).toFixed(1)} ${tr('MB')}`],
        [tr('Database path'), a.db_path],
        [tr('Server uptime'), upStr],
        [tr('Tasks · projects'), `${a.tasks} · ${a.projects}`],
        ['Node', a.node],
      ].map(([k, v]) => `<div class="bk-row"><span>${esc(k)}</span><span class="muted">${esc(String(v))}</span></div>`).join('');
    } catch { $('about-diag').textContent = '—'; }
  }
}

let skillSel = null;
let skillsInfo = null;
let pendingSkill = null;
function skillDirty() {
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
  catch (e) { if (seq === skillLoadSeq) updateSkillState(e.message || tr('could not read the file')); return; }
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
  updateSkillState(r.exists ? '' : tr('the skill is not installed — the file will be created on save'));
}
async function renderSkillsSection(body) {
  body.innerHTML = `<div class="sm-h">${tr('Skills')}<button class="btn-ghost" id="sk-new">${tr('＋ New skill')}</button></div>`
    + `<div class="kbh-note muted">${tr('Skills are the instructions Claude reads. They live outside the board, in ~/.claude/skills, and the board only shows and updates them.')}</div>`
    + '<div id="sk-list" class="bk-list">…</div>'
    + `<div class="set-col sk-edit hidden" id="sk-edit">
        <span class="set-lab">${tr('Skill file')}<small class="sk-path" id="sk-path"></small></span>
        <div class="kbh-note warn hidden" id="sk-link-warn"></div>
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
  try { info = await api('GET', '/api/skills'); }
  catch { $('sk-list').textContent = '—'; return; }
  if (!$('sk-list')) return;
  skillsInfo = info;
  const items = [...info.items];
  if (!items.some((s) => s.name === info.board_skill)) items.unshift({ ...info.board, used_by: [], packaged: true });
  items.sort((a, b) => (a.name === info.board_skill ? -1 : b.name === info.board_skill ? 1 : a.name.localeCompare(b.name)));
  const usedByLabel = (list) => (list.length > 2
    ? `${tr('used by')} ${list.length} ${plural(list.length, 'project', 'projects')}`
    : `${tr('used by')} ${list.map((p) => p.name || p.slug).join(', ')}`);
  const tagsFor = (s) => {
    const tags = [];
    if (s.name === info.board_skill) tags.push(tr('board skill'));
    if (s.name === info.generic_deploy_skill) tags.push(tr('shared deploy skill'));
    if (s.used_by?.length) tags.push(usedByLabel(s.used_by));
    if (!s.exists) tags.push(tr('not installed'));
    return tags;
  };
  const row = (s) => `<div class="bk-row sk-row" data-name="${esc(s.name)}" title="${esc((s.used_by || []).map((p) => p.name || p.slug).join(', '))}">
      <span class="sk-name"><span class="sk-title">${esc(s.name)}</span>${tagsFor(s).map((t) => `<span class="ps-doc-tag">${esc(t)}</span>`).join('')}</span>
      <span class="muted sk-meta" title="${esc(s.real_path)}">${s.exists ? `${Math.max(1, Math.round((s.size || 0) / 1024))} ${tr('KB')} · ${esc(String(s.mtime || '').slice(0, 10))}` : '—'}</span>
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
    row.onclick = () => selectSkillRow(row.dataset.name);
  });
  $('sk-new').onclick = () => styledPrompt(tr('New skill'), {
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

  $('sk-del').onclick = async () => {
    if (!skillSel) return;
    const item = (skillsInfo?.items || []).find((s) => s.name === skillSel.name);
    const used = (item?.used_by || []).map((p) => p.name || p.slug);
    const msg = `${tr('Delete the skill')} «${skillSel.name}»?\n${skillSel.real_path}`
      + (skillSel.symlink ? `\n${tr('this is a link — only the link is removed, the file it points to stays')}` : '')
      + (used.length ? `\n${tr('used by')}: ${used.join(', ')}` : '');
    if (!await styledConfirm(msg, { okLabel: tr('Delete'), danger: true })) return;
    try { await api('DELETE', `/api/skills/${seg(skillSel.name)}`, { confirm_path: skillSel.real_path }); }
    catch (e) { updateSkillState(e.message || tr('not deleted')); return; }
    skillSel = null;
    renderSection('skills');
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
    } catch (e) { updateSkillState(e.message || tr('could not load')); }
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
      updateSkillState(e.message || tr('not saved'));
      if (e.status === 409) loadSkillText(skillSel.name);
    }
  };

  const want = pendingSkill && items.some((s) => s.name === pendingSkill) ? pendingSkill : items[0]?.name;
  pendingSkill = null;
  if (want) await selectSkillRow(want);
}

function listenRemap(row) {
  const kbd = row.querySelector('kbd');
  const prev = kbd.textContent;
  row.classList.add('listening');
  kbd.textContent = tr('press a key…');
  const done = (label) => {
    document.removeEventListener('keydown', onKey, true);
    row.classList.remove('listening');
    kbd.textContent = label;
  };
  const flash = (msg) => { kbd.textContent = msg; setTimeout(() => { if (row.classList.contains('listening')) kbd.textContent = tr('press a key…'); }, 900); };
  function onKey(e) {
    e.preventDefault();
    e.stopPropagation();
    if (['Shift', 'Meta', 'Alt', 'Control'].includes(e.key)) return;
    if (e.code === 'Escape') { done(prev); return; }
    if (e.code.startsWith('Arrow')) { flash(tr('the arrow keys are taken')); return; }
    const b = { code: e.code, shift: e.shiftKey, alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey };
    const clash = KEY_ACTIONS.find((a) => a.id !== row.dataset.act && comboLabel(keyBinding(a.id)) === comboLabel(b));
    if (clash) { flash(`${tr('taken')}: ${comboLabel(keyBinding(clash.id))}`); return; }
    const km = { ...(getSetting('keymap') || {}) };
    km[row.dataset.act] = b;
    setSetting('keymap', km);
    done(comboLabel(b));
  }
  document.addEventListener('keydown', onKey, true);
}

export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const RANGE_LABEL = { week: tr('this week'), month: tr('this month'), half: tr('in 6 months'), year: tr('this year') };
export const RANGE_BTN = [['week', 'Week'], ['month', 'Month'], ['half', 'Half a year'], ['year', 'Year']];
export function ymdLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
export function waitingHTML(w) {
  const secs = [];
  if (w.review.length) secs.push(`<div class="wait-sec-h">${tr('Check')} (${w.review.length})</div>${w.review.map((t) => wRow(t, 'review', '')).join('')}`);
  if (w.blocked.length) secs.push(`<div class="wait-sec-h">${tr('Blocked')} (${w.blocked.length})</div>${w.blocked.map((t) => wRow(t, 'cancelled', t.reason || '', true)).join('')}`);
  if (w.stale.length) secs.push(`<div class="wait-sec-h">${tr('Stalled')} (${w.stale.length})</div>${w.stale.map((t) => wRow(t, 'doing', `${t.hours}${tr('h without movement')}`)).join('')}`);
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
    html += `<div class="feed-day">${dayLabel(day)} <span class="feed-day-n">· ${evs.length} ${tr('events')}</span></div>`;
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
