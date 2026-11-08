import { $, esc, ic, state, tr } from './core.js';
import { localStore } from './store.js';
import { openDrawer, wordsToClaude } from './drawer.js';
import { PICK_PREFIX, bookmarklet, pickMessage, readPick } from './pick-rules.js';
import { previewUrl } from './editor-rules.js';

const FOR = 'kb.ui.pickFor';
let pending = null; // the element that came, until sent or put away
let helpFor = null; // the card that shows how to point
let card = null; // {key, project} of the card on screen

const bookmarkName = () => tr('Point for Claude');

/** The element in the address, if one came: taken off the address and shown on the card it was asked for. */
export function takePick() {
  if (!location.hash.startsWith(PICK_PREFIX)) return;
  const pick = readPick(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!pick) return;
  pending = pick;
  const key = localStore.getItem(FOR) || state.drawerKey;
  if (!key) return; // shown on the next card opened
  if (card?.key === key && state.drawerKey === key) paintPick(card);
  else openDrawer(key);
}

function head(text) {
  return `<div class="pick-head">${ic('point', 13)}<span>${esc(text)}</span><button type="button" class="btn-icon pick-x" title="${esc(tr('Close'))}">✕</button></div>`;
}

/** The card's part: the icon in its head, and the block — the element that came, or how to point. */
export function paintPick(t) {
  card = t ? { key: t.key, project: t.project } : null;
  const btn = $('d-point');
  const box = $('d-pick');
  btn.classList.toggle('hidden', !t);
  if (!t) { box.classList.add('hidden'); box.innerHTML = ''; return; }
  btn.title = tr('Point at an element of the page for Claude');
  btn.onclick = (e) => {
    e.preventDefault();
    localStore.setItem(FOR, t.key);
    helpFor = t.key;
    paintPick(t);
    const p = state.projects.find((x) => x.slug === t.project);
    const url = p && previewUrl(p.domain);
    if (url) window.open(url, '_blank', 'noopener');
  };
  const close = () => { pending = null; helpFor = null; paintPick(t); };
  if (pending) {
    const pick = pending;
    let where = pick.url;
    try { const u = new URL(pick.url); where = `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { /* as it came */ }
    const facts = [[tr('selector'), pick.selector, true], [tr('components'), pick.components.join(' ← '), false], [tr('source'), pick.source || '', true], [tr('text'), pick.text, false]]
      .filter(([, v]) => v).map(([k, v, mono]) => `<div class="pick-fact"><span class="muted">${esc(k)}</span><span class="${mono ? 'pick-mono' : ''}">${esc(v)}</span></div>`).join('');
    box.innerHTML = head(tr('Element from {page}').replace('{page}', where))
      + `<div class="pick-facts">${facts}</div>`
      + `<textarea class="pick-words" rows="2" placeholder="${esc(tr('What to do with it (optional)'))}"></textarea>`
      + `<div class="pick-actions"><button type="button" class="btn btn-primary pick-send">${esc(tr('Send to Claude'))}</button></div>`;
    const send = box.querySelector('.pick-send');
    send.onclick = async () => {
      send.disabled = true;
      const how = await wordsToClaude(t, pickMessage(t.key, pick, box.querySelector('.pick-words').value, tr), send);
      if (pending !== pick) return;
      pending = null; helpFor = null;
      box.innerHTML = head(how === 'chat' ? tr('Sent to Claude of the task.') : tr('Claude is started with these words.'));
      box.querySelector('.pick-x').onclick = close;
    };
  } else if (helpFor === t.key) {
    box.innerHTML = head(tr('Point at an element for Claude'))
      + `<p class="pick-how">${esc(tr('On the page of your app press the bookmark «{name}» and click the element — it comes back to this card. Esc cancels.').replace('{name}', bookmarkName()))}</p>`
      + `<p class="pick-how">${esc(tr('No bookmark yet? Drag this one to the bookmarks bar:'))} <a class="link-chip link-add pick-bookmark" draggable="true">${ic('point', 12)} ${esc(bookmarkName())}</a> <span class="pick-note muted" role="status"></span></p>`;
    const a = box.querySelector('.pick-bookmark');
    a.href = bookmarklet(location.origin, tr('Click an element for Claude · Esc — cancel'));
    a.onclick = (e) => { e.preventDefault(); box.querySelector('.pick-note').textContent = tr('Drag it to the bookmarks bar — it works on the page of your app.'); };
  } else {
    box.classList.add('hidden'); box.innerHTML = ''; return;
  }
  box.querySelector('.pick-x').onclick = close;
  box.classList.remove('hidden');
}

addEventListener('hashchange', takePick); // the board's window opened again by the bookmark: only its hash changes
