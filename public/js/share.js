import { $, api, esc, ic, tr } from './core.js';
import { copyText } from './sse.js';
import { refusalLine } from './unsaved.js';
import { moreHTML } from './settings.js';

let shareOn = false;
const buttonTitle = () => tr(shareOn ? 'The board is open to Wi-Fi' : 'Open the board to Wi-Fi');
export function shareButtonHTML() {
  return `<button type="button" class="btn-icon proj-share${shareOn ? ' on' : ''}" title="${esc(buttonTitle())}" aria-label="${esc(buttonTitle())}">${ic('wifi', 14)}</button>`;
}

export function applyShare(data) {
  shareOn = !!data?.on;
  document.querySelectorAll('.proj-share').forEach((b) => {
    b.classList.toggle('on', shareOn);
    b.title = buttonTitle();
    b.setAttribute('aria-label', buttonTitle());
  });
}
export async function loadShare() {
  try { applyShare(await api('GET', '/api/share', undefined, { quiet: true })); } catch { /* keep the last one */ }
}

const REFUSED_WHY = {
  network: 'not from the local network of this computer',
  host: 'opened another address: %s — not the one of the QR code',
  site: 'a request from another site, not from the page of the board',
  address: 'a broken address',
};
const clock = (iso) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
function refusedHTML(list) {
  const items = (list || []).map((r) => `<div class="share-refused-row"><span class="share-refused-at">${esc(clock(r.at))}</span>`
    + `<code>${esc(r.ip)}</code><span>${esc(tr(REFUSED_WHY[r.why] || 'refused').replace('%s', r.host || ''))}${r.n > 1 ? ` · ×${r.n}` : ''}</span></div>`).join('');
  return row(tr('Turned away'), tr('the last devices the board did not let in, and why. A device that never reached this computer — a guest network of the router, a VPN, mobile data — is not here: then the phone is simply on another network'))
    + `<div class="share-refused">${items || `<span class="muted">${esc(tr('nobody so far'))}</span>`}</div>`;
}
const POLL_MS = 3000; // «connected now» while the section is open
let poll = null; // one at a time: leaving the section and coming back within POLL_MS would start a second
const row = (lab, hint, side = '') => `<div class="set-row"><span class="set-lab">${lab}<small>${hint}</small></span>${side}</div>`;

export async function renderShareSection(body) {
  body.innerHTML = `<div class="sm-h">Wi-Fi</div><div id="share-box" class="share-box">…</div>`;
  let st;
  try { st = await api('GET', '/api/share'); } catch { if ($('share-box')) $('share-box').textContent = '—'; return; }
  drawShare(st);
  clearInterval(poll);
  const timer = setInterval(async () => {
    const box = $('share-box');
    if (!box) { clearInterval(timer); return; }
    let now;
    try { now = await api('GET', '/api/share', undefined, { quiet: true }); } catch { return; }
    if (!$('share-box')) return;
    // the QR is redrawn only when something it shows changed — a redraw every few seconds would flicker
    if (now.on !== st.on || now.qr !== st.qr || now.error !== st.error) { st = now; drawShare(st); return; }
    if ($('share-n')) $('share-n').textContent = String(now.guests_n);
    if (JSON.stringify(now.refused) !== JSON.stringify(st.refused) && $('share-refused')) { st = now; $('share-refused').innerHTML = refusedHTML(now.refused); }
  }, POLL_MS);
  poll = timer;
}

function drawShare(st) {
  const box = $('share-box');
  if (!box) return;
  applyShare(st);
  if (st.guest) {
    box.innerHTML = row(tr('You are a guest here'), tr('this board runs on another computer; its owner opens and closes it to the network'));
    return;
  }
  const first = st.urls?.[0];
  let h = `<label class="set-row"><span class="set-lab">${tr('Open the board to Wi-Fi')}<small>${tr('people on the same network open it from a phone or a laptop by the QR code or the link')}</small></span>`
    + `<input type="checkbox" class="set-toggle" id="share-on"${st.on ? ' checked' : ''}></label>`;
  if (!st.on && st.wanted && st.error) {
    h += `<div class="kbh-note warn">${st.error === 'port-busy'
      ? esc(tr('Port %s is taken by another program — the board did not open to the network. Free it or set another one in KB_SHARE_PORT.').replace('%s', st.port))
      : tr('Could not open the board to the network — the details are in Settings → Errors.')}</div>`;
  }
  if (st.on && !first) h += `<div class="kbh-note warn">${tr('This computer is not on a network now — there is no address to give. Join a Wi-Fi network and open the section again.')}</div>`;
  if (st.on && first) {
    h += `<div class="share-card"><div class="share-qr">${st.qr || ''}</div><div class="share-side">`
      + `<span class="set-lab">${tr('Scan with the phone camera')}<small>${tr('or send the link — it opens the board on any device of this network')}</small></span>`
      + `<code class="share-url">${esc(first.url)}</code>`
      + `<span><button type="button" class="btn-ghost" id="share-copy">${ic('copy', 13)} ${tr('Copy link')}</button></span></div></div>`
      + row(tr('Connected now'), tr('devices that opened the board in the last minute'), `<span class="about-fresh" id="share-n">${st.guests_n}</span>`);
  }
  if (st.on || st.refused?.length) h += `<div id="share-refused">${refusedHTML(st.refused)}</div>`;
  h += `<div class="kbh-note warn">${tr('Whoever on this network opens the address can do on the board all you can: move tasks, write to Claude in the chat and the terminal — that is, run commands on this computer. The address has no password: keep the board open only on a network of people you trust, and switch it off in a café or a hotel.')} ${tr('Settings of the computer itself stay yours: connecting Claude Code, skills, project files, updating the board.')}</div>`;
  const others = (st.urls || []).slice(1);
  h += moreHTML(`<p>${tr('The board stays on this computer: it has to be running, and switching off closes it to the network at once. After a restart of the board it is open again, at the same address.')}</p>`
    + `<p>${tr('On a Mac the system may ask whether node may accept incoming connections — allow it, or nobody gets in.')}</p>`
    + (others.length && st.on ? `<p>${tr('Other addresses of this computer')}:</p>${others.map((u) => `<code class="share-url">${esc(u.url)}</code>`).join('')}` : ''));
  box.innerHTML = h;

  const toggle = $('share-on');
  toggle.onchange = async () => {
    toggle.disabled = true;
    try { drawShare(await api('PUT', '/api/share', { on: toggle.checked })); } catch (e) {
      toggle.checked = !toggle.checked;
      toggle.disabled = false;
      box.insertAdjacentHTML('beforeend', `<div class="kbh-note warn">${esc(refusalLine('Did not work out', e, tr))}</div>`);
    }
  };
  const copy = $('share-copy');
  if (copy) copy.onclick = async () => {
    if (await copyText(first.url)) { copy.innerHTML = `${ic('copy', 13)} ${tr('Copied')}`; setTimeout(() => { if (copy.isConnected) copy.innerHTML = `${ic('copy', 13)} ${tr('Copy link')}`; }, 1500); }
  };
}
