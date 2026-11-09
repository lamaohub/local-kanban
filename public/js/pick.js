import { $, esc, ic, state, tr } from './core.js';
import { localStore } from './store.js';
import { openDrawer, wordsToClaude } from './drawer.js';
import { MARK_KEY, PICK_PREFIX, bookmarklet, isMark, newMark, pickMessage, readPick } from './pick-rules.js';
import { previewUrl } from './editor-rules.js';
import { WORDS_SAID } from './branch-rules.js';
import { refusalLine } from './unsaved.js';

const FOR = 'kb.ui.pickFor';
let pending = null; // {key, pick, words} or {key, refused}: what came for the card `key`, until sent or put away
let sent = null; // {key, how}: the card says it was sent until it is closed or another card is opened
let helpFor = null; // the card that shows how to point
let card = null; // {key, project} of the card on screen
let seq = 0; // a number per arrival: the block is drawn again only when what it shows has changed

const bookmarkName = () => tr('Point for Claude');
/** The board's mark for its bookmark — made the first time a bookmark is given out. */
function markOf() {
  const m = localStore.getItem(MARK_KEY);
  if (isMark(m)) return m;
  const fresh = newMark();
  localStore.setItem(MARK_KEY, fresh);
  return fresh;
}

/** The element in the address, if one came: taken off the address and shown on the card it was asked for. */
export function takePick() {
  if (!location.hash.startsWith(PICK_PREFIX)) return;
  const got = readPick(location.hash, localStore.getItem(MARK_KEY));
  history.replaceState(null, '', location.pathname + location.search);
  if (!got) return;
  const key = localStore.getItem(FOR) || state.drawerKey;
  if (!key) return; // no card asked for it: it belongs to none
  pending = got.refused ? { key, refused: got.refused, n: ++seq } : { key, pick: got, words: '', n: ++seq };
  sent = null;
  if (card?.key === key && state.drawerKey === key) paintPick(card);
  else openDrawer(key);
}

function head(text) {
  return `<div class="pick-head">${ic('point', 13)}<span>${esc(text)}</span><button type="button" class="btn-icon pick-x" title="${esc(tr('Close'))}">✕</button></div>`;
}
const bookmarkHTML = () => `<a class="link-chip link-add pick-bookmark" draggable="true">${ic('point', 12)} ${esc(bookmarkName())}</a> <span class="pick-note muted" role="status"></span>`;
function wireBookmark(box) {
  const a = box.querySelector('.pick-bookmark');
  a.href = bookmarklet(location.origin, tr('Click an element for Claude · Esc — cancel'), markOf());
  a.onclick = (e) => { e.preventDefault(); box.querySelector('.pick-note').textContent = tr('Drag it to the bookmarks bar — it works on the page of your app.'); };
}
const REFUSED = {
  stale: () => tr('This bookmark is out of date: the board now puts its mark on the element. Drag the new one below to the bookmarks bar in place of the old one, and point again.'),
  foreign: () => tr('An element came without the mark of this board\'s bookmark: a page may have made it up, or your bookmark is from before. It is not shown, and nothing goes to Claude. Yours? Drag the new one below to the bookmarks bar and point again.'),
};

/** The card's part: the icon in its head, and the block — the element that came, a refused one, or how to point. */
export function paintPick(t) {
  card = t ? { key: t.key, project: t.project } : null;
  const btn = $('d-point');
  const box = $('d-pick');
  btn.classList.toggle('hidden', !t);
  if (!t) { box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; return; }
  if (sent && sent.key !== t.key) sent = null;
  btn.title = tr('Point at an element of the page for Claude');
  btn.onclick = (e) => {
    e.preventDefault();
    localStore.setItem(FOR, t.key);
    helpFor = t.key;
    if (pending?.refused) pending = null;
    sent = null;
    paintPick(t);
    const p = state.projects.find((x) => x.slug === t.project);
    const url = p && previewUrl(p.domain);
    if (url) window.open(url, '_blank', 'noopener');
  };
  const mine = pending?.key === t.key ? pending : null;
  const view = mine ? `${mine.refused ? 'refused' : 'pick'}:${mine.n}` : sent?.key === t.key ? `sent:${sent.how}` : helpFor === t.key ? 'help' : '';
  // the card is drawn again by every change of its task (a launch moves it at once): the words typed stay as they are
  const sig = `${t.key}|${view}`;
  if (view && box.dataset.sig === sig && !box.classList.contains('hidden')) return;
  box.dataset.sig = sig;
  const close = () => { if (pending?.key === t.key) pending = null; if (sent?.key === t.key) sent = null; helpFor = null; paintPick(t); };
  if (mine?.pick) {
    const { pick } = mine;
    let where = pick.url;
    try { const u = new URL(pick.url); where = `${u.host}${u.pathname === '/' ? '' : u.pathname}`; } catch { /* as it came */ }
    box.innerHTML = head(tr('Element from {page}').replace('{page}', where))
      + `<textarea class="pick-words" rows="2" placeholder="${esc(tr('What to do with it (optional)'))}"></textarea>`
      + `<div class="pick-label muted">${esc(tr('Claude gets exactly this — the page wrote its text and HTML:'))}</div>`
      + `<pre class="pick-msg"></pre>`
      + `<div class="pick-actions"><button type="button" class="btn btn-primary pick-send">${esc(tr('Send to Claude'))}</button></div>`;
    const words = box.querySelector('.pick-words');
    const msg = box.querySelector('.pick-msg');
    const message = () => pickMessage(t.key, pick, mine.words, tr);
    words.value = mine.words;
    msg.textContent = message();
    words.oninput = () => { mine.words = words.value; msg.textContent = message(); };
    const send = box.querySelector('.pick-send');
    send.onclick = async () => {
      send.disabled = true;
      const r = await wordsToClaude(t, message(), send);
      if (pending !== mine) return;
      if (r.how === 'refused') {
        send.disabled = false;
        box.querySelector('.pick-said')?.remove();
        send.insertAdjacentHTML('afterend', `<span class="pick-said muted" role="status">${esc(refusalLine(tr('Not sent'), r.error, tr))}</span>`);
        return;
      }
      pending = null; helpFor = null;
      sent = { key: t.key, how: r.how };
      if (card?.key === t.key) paintPick(card);
    };
  } else if (mine?.refused) {
    box.innerHTML = head(tr('The element is not shown'))
      + `<p class="pick-how">${esc(REFUSED[mine.refused]())}</p>`
      + `<p class="pick-how">${bookmarkHTML()}</p>`;
    wireBookmark(box);
  } else if (sent?.key === t.key) {
    box.innerHTML = head(tr(WORDS_SAID[sent.how] || WORDS_SAID.launch));
  } else if (helpFor === t.key) {
    box.innerHTML = head(tr('Point at an element for Claude'))
      + `<p class="pick-how">${esc(tr('On the page of your app press the bookmark «{name}» and click the element — it comes back to this card. Esc cancels.').replace('{name}', bookmarkName()))}</p>`
      + `<p class="pick-how">${esc(tr('No bookmark yet? Drag this one to the bookmarks bar:'))} ${bookmarkHTML()}</p>`;
    wireBookmark(box);
  } else {
    box.classList.add('hidden'); box.innerHTML = ''; box.dataset.sig = ''; return;
  }
  box.querySelector('.pick-x').onclick = close;
  box.classList.remove('hidden');
}

addEventListener('hashchange', takePick); // the board's window opened again by the bookmark: only its hash changes
