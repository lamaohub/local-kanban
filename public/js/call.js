
import { esc, tr, ic, LANG, api, seg } from './core.js';
import { typeset } from './typeset.js';
import { getSetting } from './settings.js';
import { overlayLayer, selectProject } from './sidebar.js';
import { pendingAsks } from './asks.js';
import { answerBody, askSummary, questionsOf, OTHER } from './ask-rules.js';
import { refusalLine } from './unsaved.js';
import { playNamedSound } from './sse.js';
import { openDrawer } from './drawer.js';
import { callMemory, callsOf, callWords, intentOf, lastReport, lastWords, lineUp, pickOption, replyOf, speakable, spokenOrdinal, yesNo } from './call-rules.js';

const RING_EVERY_MS = 2600; // one ring of the sound of Review
const RING_FOR_MS = 45000; // not taken — a missed call, the task stays in «waiting for you»
const LOOK_EVERY_MS = 2000; // how often the call asks the chat for Claude's answer
const STILL_AT_IT_MS = 45000; // Claude has not answered — said once: one can hang up, the board calls back
const WAIT_FOR_MS = 15 * 60000; // and then the call lets the task go: its turn's end rings anew
const DOWNLOAD_LOOK_MS = 3000; // a language pack downloading — how often the call asks whether it is here
const DOWNLOAD_LOOKS = 60; // and for how long (3 min)
const VOICES_WAIT_MS = 1000; // the list of the system's voices, not loaded yet
const HEAR_ASK_MS = 3000; // how long the browser may think over whether it hears on the Mac
const HEAR_TRIES = 2; // silences in a row before the call stops listening by itself

const Recognition = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
const langTag = () => (LANG === 'ru' ? 'ru-RU' : 'en-US');

/** Can this browser hear speech on this Mac: 'local' — yes; 'download' / 'downloading' — once its language pack is
    there; 'cloud' — it hears only through the internet (Safari: recognition without `available`), never used;
    'unavailable' — not this language on this Mac; 'silent' — it did not say; 'none' — no recognition at all. The
    owner's test call said one «cannot hear» for all of them, and what to do was not to be told. */
export async function hearingState() {
  const R = Recognition();
  if (!R) return 'none';
  if (typeof R.available !== 'function') return 'cloud';
  try {
    // a browser that never answers (the Chromium of the browser checks) — as one that cannot hear
    const a = await Promise.race([R.available({ langs: [langTag()], processLocally: true }), new Promise((r) => { setTimeout(() => r('silent'), HEAR_ASK_MS); })]);
    return { available: 'local', downloadable: 'download', downloading: 'downloading', unavailable: 'unavailable', silent: 'silent' }[a] || 'none';
  } catch { return 'none'; }
}

/** What the call says when it cannot listen, by `hearingState` — the reason and what to do. */
const NOT_HEARING = {
  download: 'Speech recognition is not on this Mac yet — download it, or type the answer',
  downloading: 'Speech recognition is downloading — I will listen once it is here; or type the answer',
  cloud: 'This browser hears speech only through the internet — to talk by voice, open the board in Chrome; here, type the answer',
  unavailable: 'Chrome cannot hear the language of the board on this Mac — type the answer',
  silent: 'The browser did not say whether it can hear — type the answer',
  none: 'This browser cannot hear speech — to talk by voice, open the board in Chrome; here, type the answer',
};

/** Download the language pack of local recognition (once; the click that asks for it is the person's). */
export async function installHearing() {
  const R = Recognition();
  try { return Boolean(await R?.install?.({ langs: [langTag()], processLocally: true })); } catch { return false; }
}

/** A voice of the system on this Mac for the board's language — never a voice of the network. */
function voice() {
  const all = globalThis.speechSynthesis?.getVoices?.() || [];
  const mine = all.filter((v) => v.localService && v.lang.toLowerCase().startsWith(LANG === 'ru' ? 'ru' : 'en'));
  return mine.find((v) => /enhanced|premium/i.test(v.name)) || mine[0] || null;
}

export const CALL_VOICES = [
  { value: '', label: 'Voice of the system' },
  { value: 'aidar', label: 'Aidar (male)' },
  { value: 'eugene', label: 'Eugene (male)' },
  { value: 'baya', label: 'Baya (female)' },
  { value: 'kseniya', label: 'Kseniya (female)' },
  { value: 'xenia', label: 'Xenia (female)' },
];
/** The neural voice the call speaks with, or null: chosen in Settings, a Russian board, installed on the board. */
export async function neuralVoice() {
  const speaker = getSetting('callVoice');
  if (LANG !== 'ru' || !speaker) return null;
  try {
    const v = await api('GET', '/api/voice', undefined, { quiet: true });
    return v?.installed && v.speakers?.includes(speaker) ? speaker : null;
  } catch { return null; }
}
let playing = null; // {audio, done} — the phrase of the neural voice being said
function stopNeural() {
  if (!playing) return;
  const p = playing;
  playing = null;
  try { p.audio.pause(); } catch { /* gone */ }
  p.done();
}
/** Say a text with the neural voice; true once said (or skipped), false when it could not — then the system's. */
export async function sayNeural(text, speaker) {
  let blob;
  try {
    const r = await fetch('/api/voice', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, speaker }) });
    if (!r.ok) return false;
    blob = await r.blob();
  } catch { return false; }
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  stopNeural();
  return new Promise((resolve) => {
    let over = false;
    const done = (ok = true) => { if (over) return; over = true; URL.revokeObjectURL(url); if (playing?.audio === audio) playing = null; resolve(ok); };
    playing = { audio, done };
    audio.onended = () => done(true);
    audio.onerror = () => done(false);
    audio.play().catch(() => done(false)); // no activation of the page — the system's voice tries
  });
}
/** Settings: hear a voice. */
export async function previewVoice(speaker) {
  const text = tr('Hi! This is how a call sounds with this voice.');
  if (speaker && LANG === 'ru' && await sayNeural(text, speaker)) return;
  await voicesReady();
  const v = voice();
  const synth = globalThis.speechSynthesis;
  if (!v || !synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = v; u.lang = v.lang; u.rate = 1.05;
  synth.speak(u);
}

let line = []; // calls waiting: [{id, key, project, title, why}]
let call = null; // the call on the screen

/** Something to call about happened (sse.js). Off in Settings — nothing. A call of the task being talked over now is
    the conversation's own (its turn ended), not a new one. */
export function callSignal(item) {
  if (!getSetting('voiceCall') || !item?.key) return;
  if (call && call.with === String(item.id)) return;
  line = lineUp(line, item);
  if (!call) ring();
}

const memory = callMemory();
/** Every event of the board's stream (sse.js) — the call finds in it what to call about (callsOf). */
export function callHears(ev) {
  for (const item of callsOf(ev, memory)) callSignal(item);
}

/** Settings → «Test call»: rings, says a phrase, repeats what it heard. */
export function testCall() {
  if (call) return; // a call is on: its line is not the test's to drop
  line = [{ id: 'test', key: '', title: tr('Test call'), why: 'test' }];
  ring();
}

function ring() {
  const first = line[0];
  if (!first) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay call-overlay';
  overlay.id = 'call';
  overlay.innerHTML = `<div class="modal call-box" role="dialog" aria-label="${esc(tr('Claude is calling'))}">
      <div class="call-who"><span class="call-ring">${ic('phone', 22)}</span>
        <span class="call-names"><span class="call-name">Claude</span><span class="call-sub"></span></span></div>
      <div class="call-state" aria-live="polite"></div>
      <div class="call-said"></div>
      <div class="call-heard"></div>
      <form class="call-type hidden"><input class="call-input" autocomplete="off" placeholder="${esc(tr('or type the answer'))}"></form>
      <div class="call-actions"></div>
    </div>`;
  document.body.appendChild(overlay);
  call = { overlay, ended: false, with: null, taken: false, rec: null, typed: null, speaking: null, neural: null };
  // the neural voice loads its model while the call rings (2 s), so the first phrase is not waited for
  const ringing = call;
  neuralVoice().then((sp) => {
    ringing.neural = sp;
    if (sp) api('POST', '/api/voice/warm', undefined, { quiet: true }).catch(() => { ringing.neural = null; });
  });
  call.close = overlayLayer(overlay, { backdrop: false, onClose: () => endCall() });
  const box = overlay.querySelector('.call-box');
  call.el = (cls) => box.querySelector(cls);
  setWho(first);
  setState(tr('Calling…'));
  actions([
    { cls: 'btn-primary call-take', label: tr('Take'), icon: 'phone', on: () => take() },
    { cls: 'btn-ghost call-drop', label: tr('Decline the call'), on: () => hangUp() },
  ]);
  overlay.querySelector('.call-take')?.focus();
  overlay.querySelector('.call-type').onsubmit = (e) => {
    e.preventDefault();
    const input = overlay.querySelector('.call-input');
    const text = input.value.trim();
    if (!text || !call?.typed) return;
    input.value = '';
    call.typed(text);
  };
  const sound = () => { if (call && !call.taken && !call.ended) playNamedSound(getSetting('soundReview')); };
  sound();
  call.ringer = setInterval(sound, RING_EVERY_MS);
  call.missed = setTimeout(() => { if (call && !call.taken) hangUp(); }, RING_FOR_MS);
  if (document.hidden && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    try {
      const n = new Notification(tr('Claude is calling'), { body: first.key ? `${first.key} · ${first.title || ''}` : first.title, icon: '/icon-192.png', tag: 'kb-call', renotify: true, requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
      call.note = n;
    } catch { /* the system may refuse — the call is on the page */ }
  }
}

function setWho(item) {
  const sub = call?.el('.call-sub');
  if (sub) sub.textContent = item.key ? `${item.key} · ${item.title || ''}` : (item.title || '');
  if (call) call.item = item;
}
function setState(text, { live = false } = {}) {
  const el = call?.el('.call-state');
  if (!el) return;
  el.textContent = typeset(text);
  el.classList.toggle('live', live);
}
function showSaid(text) { const el = call?.el('.call-said'); if (el) el.textContent = typeset(text || '').replace(/(\p{L})-(\p{L})/gu, '$1\u2011$2'); }
function showHeard(text) { const el = call?.el('.call-heard'); if (el) el.textContent = text || ''; }

/** The buttons of the call, drawn anew. */
function actions(list) {
  const box = call?.el('.call-actions');
  if (!box) return;
  box.innerHTML = list.map((b, i) => `<button type="button" class="${b.cls}" data-i="${i}">${b.icon ? ic(b.icon, 14) : ''}<span>${esc(b.label)}</span></button>`).join('');
  box.querySelectorAll('button').forEach((el) => { el.onclick = () => list[Number(el.dataset.i)].on(); });
}
function talkActions(extra = []) {
  const item = call?.item;
  actions([
    ...extra,
    { cls: 'btn-ghost call-skip', label: tr('Skip speech'), on: () => { globalThis.speechSynthesis?.cancel(); stopNeural(); } },
    ...(item?.key ? [{ cls: 'btn-ghost call-open', label: tr('Open the task'), on: () => { if (item.project) selectProject(item.project); openDrawer(item.key); } }] : []),
    { cls: 'btn-primary call-end', label: tr('Hang up'), icon: 'phone', on: () => hangUp() },
  ]);
}

function stopRinging() {
  clearInterval(call?.ringer);
  clearTimeout(call?.missed);
  try { call?.note?.close(); } catch { /* gone already */ }
}

function hangUp() {
  if (!call || call.ended) return;
  call.ended = true;
  line = [];
  globalThis.speechSynthesis?.cancel();
  stopNeural();
  try { call.rec?.abort(); } catch { /* not listening */ }
  call.typed?.(null);
  call.close?.();
}
function endCall() {
  if (!call) return;
  line = []; // Esc is a hang-up too
  stopRinging();
  call.ended = true;
  globalThis.speechSynthesis?.cancel();
  stopNeural();
  try { call.rec?.abort(); } catch { /* not listening */ }
  call.typed?.(null);
  call = null;
}

async function take() {
  if (!call || call.taken) return;
  call.taken = true;
  call.overlay.classList.add('taken');
  stopRinging();
  call.hearing = await hearingState();
  call.el('.call-type').classList.remove('hidden');
  talkActions();
  while (call && !call.ended && line.length) {
    const item = line.shift();
    setWho(item);
    call.with = String(item.id);
    try { await talk(item); } catch (e) { console.error(e); await say(tr('Something went wrong on the board.')); }
    if (call) call.with = null;
    if (call && !call.ended && line.length) await say(tr('There is more.'));
  }
  if (call && !call.ended) { await say(tr('That is all. Bye.')); call.close?.(); }
}

/** The voices of the system: Chrome lists them a moment after the page loads — a call that early waits for them. */
function voicesReady() {
  const synth = globalThis.speechSynthesis;
  if (!synth || synth.getVoices().length) return Promise.resolve();
  return new Promise((r) => {
    const t = setTimeout(r, VOICES_WAIT_MS);
    synth.addEventListener?.('voiceschanged', () => { clearTimeout(t); r(); }, { once: true });
  });
}

/** Say a text aloud and show it; resolves when said, skipped or the call ended. */
async function say(text) {
  showSaid(text);
  showHeard('');
  setState(tr('Claude is speaking'), { live: true });
  if (text && call && !call.ended && call.neural) {
    if (await sayNeural(text, call.neural)) return;
    if (call) call.neural = null; // failed once — the system's voice for the rest of this call
  }
  await voicesReady();
  const synth = globalThis.speechSynthesis;
  const v = voice();
  if (!text || !synth || !v || !call || call.ended) return Promise.resolve();
  return new Promise((done) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = v;
    u.lang = v.lang;
    u.rate = 1.05;
    call.speaking = u; // Chrome lets an utterance with no reference go before its end
    const fin = () => { if (call) call.speaking = null; done(); };
    u.onend = fin;
    u.onerror = fin;
    synth.speak(u);
  });
}

/** What the person answered: their words, or null (silence, hang-up). By voice when the Mac can hear, and by typing
    in the call's field always — whichever comes first. */
function hear() {
  if (!call || call.ended) return Promise.resolve(null);
  setState(tr('Listening — speak'), { live: true });
  return new Promise((done) => {
    let over = false;
    const finish = (text) => {
      if (over) return;
      over = true;
      if (call) { call.typed = null; try { call.rec?.abort(); } catch { /* ended */ } call.rec = null; }
      if (text) showHeard(text);
      done(text || null);
    };
    call.typed = finish;
    call.el('.call-input')?.focus();
    let tries = 0;
    const listen = () => {
      if (over || !call || call.ended) return;
      const R = Recognition();
      const r = new R();
      r.lang = langTag();
      r.processLocally = true; // never the cloud
      r.interimResults = true;
      r.continuous = false;
      let heard = '';
      let failed = '';
      r.onresult = (e) => {
        heard = [...e.results].map((x) => x[0].transcript).join(' ').trim();
        showHeard(heard);
      };
      r.onerror = (e) => { failed = e.error || 'error'; };
      r.onend = () => {
        if (over) return;
        if (heard) { finish(heard); return; }
        if (failed && failed !== 'no-speech' && failed !== 'aborted') { setState(`${tr('Cannot hear')}: ${failed} — ${tr('type the answer')}`); return; }
        tries += 1;
        if (tries < HEAR_TRIES) { listen(); return; }
        setState(tr('Did not hear you — speak again or type'));
        actions([
          { cls: 'btn-primary call-speak', label: tr('Speak'), icon: 'phone', on: () => { tries = 0; talkActions(); setState(tr('Listening — speak'), { live: true }); listen(); } },
          { cls: 'btn-ghost call-end', label: tr('Hang up'), on: () => hangUp() },
        ]);
      };
      call.rec = r;
      try { r.start(); } catch (e) { setState(`${tr('Cannot hear')}: ${e.message}`); }
    };
    if (call.hearing === 'local') listen();
    else notHearing(listen, () => over);
  });
}

/** The call cannot listen: say why; a language pack not downloaded — a button for it right in the call, one
    downloading — wait for it; once it is here, listen. Typing stays open all the while. */
function notHearing(listen, isOver) {
  setState(tr(NOT_HEARING[call.hearing] || NOT_HEARING.none));
  if (call.hearing === 'downloading') { hearsSoon(listen, isOver); return; }
  if (call.hearing !== 'download') return;
  talkActions([{
    cls: 'btn-ghost call-get', label: tr('Download speech recognition'), on: async () => {
      setState(tr(NOT_HEARING.downloading));
      await installHearing();
      hearsSoon(listen, isOver);
    },
  }]);
}
async function hearsSoon(listen, isOver) {
  for (let i = 0; i < DOWNLOAD_LOOKS && call && !call.ended && !isOver(); i += 1) {
    call.hearing = await hearingState();
    if (!call || call.ended || isOver()) return;
    if (call.hearing === 'local') { talkActions(); setState(tr('Listening — speak'), { live: true }); listen(); return; }
    if (call.hearing !== 'download' && call.hearing !== 'downloading') break;
    await new Promise((r) => { setTimeout(r, DOWNLOAD_LOOK_MS); });
  }
  if (call && !call.ended && !isOver()) { talkActions(); setState(tr(NOT_HEARING[call.hearing] || NOT_HEARING.none)); }
}

const chatOf = (key) => api('GET', `/api/tasks/${seg(key)}/chat`, undefined, { quiet: true }).catch(() => null);
const askOf = (item) => pendingAsks().find((a) => String(a.task_id) === String(item.id)) || null;

/** One call's subject, talked over to its end: what the board says first, then the conversation. */
async function talk(item) {
  if (item.why === 'test') {
    await say(tr('This is a test call. Say something — I will repeat it.'));
    const heard = await hear();
    if (heard) await say(`${tr('You said')}: ${heard}. ${tr('Everything works.')}`);
    return;
  }
  const name = speakable(item.title, { sentences: 1, chars: 90 }).replace(/[.!?…]+$/, '');
  if (item.why === 'review' || item.why === 'ready') {
    const comments = await api('GET', `/api/tasks/${seg(item.key)}/comments`, undefined, { quiet: true }).catch(() => []);
    const report = speakable(lastReport(comments));
    const head = item.why === 'ready' ? tr('waits for your word to ship.') : tr('is done.');
    const ask = item.why === 'ready' ? tr('Ship it? Say it — I will pass it to Claude.') : tr('Accept? Or say what to fix.');
    return dialog(item, { mode: 'talk', text: `${tr('Task')} «${name}» ${head} ${report} ${ask}` });
  }
  const a = item.why === 'ask' ? askOf(item) : null;
  if (a) return dialog(item, { mode: 'ask', ask: a, text: `${tr('Task')} «${name}». ` });
  const chat = await chatOf(item.key);
  if (chat?.state === 'question' && chat.choice?.options?.length) return dialog(item, { mode: 'choice', choice: chat.choice, text: `${tr('Task')} «${name}». ` });
  const words = speakable(lastWords(chat));
  return dialog(item, { mode: 'talk', text: `${tr('Task')} «${name}». ${words || tr('Claude is waiting for you.')}` });
}

/* ── the conversation: say, hear, act, wait for Claude, again ─────────────────────────── */

async function dialog(item, step) {
  let why = item.why;
  let cur = step;
  while (cur && call && !call.ended) {
    if (cur.mode === 'ask') cur = await onAsk(item, cur);
    else if (cur.mode === 'choice') cur = await onChoice(item, cur);
    else {
      await say(cur.text);
      const heard = await hear();
      if (heard === null) return;
      const it = intentOf(heard, why);
      if (it.act === 'hangup') { hangUp(); return; }
      if (it.act === 'later') { await say(tr('Okay, later.')); return; }
      if (it.act === 'accept') {
        try { await api('PATCH', `/api/tasks/${seg(item.key)}`, { status: 'done' }, { quiet: true }); await say(tr('Accepted.')); } catch (e) { await say(refusalLine('Not accepted', e, tr)); }
        return;
      }
      cur = await tellClaude(item, it.words);
    }
    why = 'waiting'; // after Claude answered, «accept» is words to him: the task left Review with them
  }
}

/** Words to Claude, then its answer as the next step (or null — nothing more to talk over). */
async function tellClaude(item, words) {
  const at = Date.now();
  try {
    await api('POST', `/api/tasks/${seg(item.key)}/chat`, { text: callWords(words, LANG) }, { quiet: true });
  } catch (e) {
    await say(refusalLine('Not sent', e, tr));
    return null;
  }
  return answerAfter(item, at);
}

/** Wait for Claude's answer to what was said or chosen at `at`. */
async function answerAfter(item, at) {
  setState(tr('Claude is thinking…'), { live: true });
  showHeard('');
  let toldWait = false;
  while (call && !call.ended) {
    await new Promise((r) => { setTimeout(r, LOOK_EVERY_MS); });
    if (!call || call.ended) return null;
    const a = askOf(item);
    if (a && Date.parse(a.created_at) >= at - 5000) return { mode: 'ask', ask: a, text: '' };
    const r = replyOf(await chatOf(item.key), at);
    if (r.kind === 'question') return { mode: 'choice', choice: r.choice, text: '' };
    if (r.kind === 'text') return { mode: 'talk', text: speakable(r.text) || tr('Done.') };
    if (r.kind === 'none') return { mode: 'talk', text: tr('Done. Claude said nothing.') };
    if (Date.now() - at > WAIT_FOR_MS) { await say(tr('Claude is still at work. I will call when it is done.')); return null; }
    if (!toldWait && Date.now() - at > STILL_AT_IT_MS) {
      toldWait = true;
      await say(tr('Claude is still at work. You can hang up — I will call back.'));
      setState(tr('Claude is thinking…'), { live: true });
    }
  }
  return null;
}

/** A question on Claude's screen: read it with its options, press the one said (or the own answer). */
async function onChoice(item, cur) {
  const ch = cur.choice;
  const opts = ch.options.filter((o) => !o.other).slice(0, 6);
  const other = ch.options.find((o) => o.other);
  const list = opts.map((o, i) => `${spokenOrdinal(i, LANG)}: ${speakable(o.label, { sentences: 1, chars: 80 }).replace(/[.!?…]+$/, '')}.`).join(' ');
  const q = speakable(ch.text, { sentences: 2, chars: 200 });
  await say(`${cur.text || ''}${tr('Claude asks')}: ${q} ${list}${other ? ` ${tr('Or say it in your own words.')}` : ''}`);
  for (let tries = 0; tries < 2 && call && !call.ended; tries += 1) {
    const heard = await hear();
    if (heard === null) return null;
    const it = intentOf(heard, 'question');
    if (it.act === 'hangup') { hangUp(); return null; }
    if (it.act === 'later') { await say(tr('Okay, later.')); return null; }
    const i = pickOption(heard, opts.map((o) => o.label));
    const at = Date.now();
    const press = (body) => api('POST', `/api/tasks/${seg(item.key)}/terminal`, body, { quiet: true });
    try {
      if (i >= 0) await press({ text: String(opts[i].n) });
      else if (other) {
        await press({ text: String(other.n) });
        await new Promise((r) => { setTimeout(r, 400); });
        await press({ text: heard, key: 'Enter' });
      } else { await say(tr('Did not catch it. Say the number of the option.')); continue; }
    } catch (e) { await say(refusalLine('Not sent', e, tr)); return null; }
    await say(i >= 0 ? `${tr('Chose')}: ${speakable(opts[i].label, { sentences: 1, chars: 80 })}` : tr('Passed it on.'));
    return answerAfter(item, at);
  }
  return null;
}

/** What a permission asks, in a few words. */
function permissionWords(a) {
  const i = a.input && typeof a.input === 'object' ? a.input : {};
  if (a.tool === 'Bash' && i.description) return speakable(i.description, { sentences: 1, chars: 120 }).replace(/[.!?…]+$/, '');
  const what = askSummary(a);
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(a.tool)) return `${tr('change the file')} ${what.split('/').pop()}`;
  if (a.tool === 'Bash') return tr('run a command — it is on the screen');
  return `${a.tool || tr('a tool')}`;
}

/** A request to the board: a permission, a plan or a question — answered by voice. */
async function onAsk(item, cur) {
  const a = cur.ask;
  const at = Date.now();
  const decide = async (allow, form) => {
    try {
      await api('POST', `/api/asks/${encodeURIComponent(a.id)}/decision`, answerBody(a, allow, form), { quiet: true });
      return true;
    } catch (e) { await say(refusalLine('Not sent', e, tr)); return false; }
  };
  if (a.kind === 'question') {
    const picks = [];
    for (const q of questionsOf(a)) {
      const labels = q.options.map((o) => o.label);
      const list = labels.slice(0, 6).map((l, i) => `${spokenOrdinal(i, LANG)}: ${speakable(l, { sentences: 1, chars: 80 }).replace(/[.!?…]+$/, '')}.`).join(' ');
      await say(`${cur.text || ''}${tr('Claude asks')}: ${speakable(q.question, { sentences: 2, chars: 200 })} ${list} ${tr('Or say it in your own words.')}`);
      cur = { ...cur, text: '' };
      const heard = await hear();
      if (heard === null) return null;
      const it = intentOf(heard, 'ask');
      if (it.act === 'hangup') { hangUp(); return null; }
      if (it.act === 'later') { await say(tr('Okay, later.')); return null; }
      const i = pickOption(heard, labels);
      picks.push(i >= 0 ? { checked: [labels[i]] } : { checked: [OTHER], other: heard });
    }
    if (!(await decide(true, { picks }))) return null;
    await say(tr('Passed it on.'));
    return answerAfter(item, at);
  }
  const what = a.kind === 'plan'
    ? `${tr('Claude offers a plan')}: ${speakable(a.input?.plan, { sentences: 2, chars: 220 })} ${tr('Approve it?')}`
    : `${tr('Claude asks for permission')}: ${permissionWords(a)}. ${tr('Allow?')}`;
  await say(`${cur.text || ''}${what}`);
  for (let tries = 0; tries < 2 && call && !call.ended; tries += 1) {
    const heard = await hear();
    if (heard === null) return null;
    const it = intentOf(heard, 'ask');
    if (it.act === 'hangup') { hangUp(); return null; }
    if (it.act === 'later') { await say(tr('Okay, later.')); return null; }
    const yes = yesNo(heard);
    if (yes === null) { await say(tr('Yes or no?')); continue; }
    if (!(await decide(yes, yes ? {} : { reason: '' }))) return null;
    await say(yes ? tr('Allowed.') : tr('Refused.'));
    return answerAfter(item, at);
  }
  return null;
}
