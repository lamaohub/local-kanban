
import { api, esc, ic, seg, tr } from './core.js';
import { SHORT_MONTHS, copyText, resumeOnBoard } from './sse.js';
import { matchKey, plural, setClaudeView } from './settings.js';
import { refusalLine } from './unsaved.js';
import { drawerIsFull, openDrawerFull, openLightbox, setDrawerFull, uploadAttachment } from './drawer.js';
import { NARROW, popLayer, pushLayer, styledConfirm } from './sidebar.js';
import { MODELS, modelLabel, sameModel } from './chat-models.js';
import { buildSelect } from './board.js';
import { SHELL_LANGS, chatText } from './chat-md.js';
import { askBlock, isSending, plainLabel, questionAsk, renderAsks } from './asks.js';
import { intoField, leftoverWords } from './ask-rules.js';

const TURNS_STEP = 15;
const STEP_KIND = {
  Bash: 'Runs', Read: 'Reads', Edit: 'Edits', MultiEdit: 'Edits', NotebookEdit: 'Edits', Write: 'Writes',
  Grep: 'Searches', Glob: 'Searches', Agent: 'Helper', Task: 'Helper', WebFetch: 'Web', WebSearch: 'Web',
  Skill: 'Skill', AskUserQuestion: 'Asks',
};
const drafts = new Map(); // task key → a message typed and not sent yet
const draftImages = new Map();
const sentWords = new Map();
const sentAnswers = new Map();
const refusedFor = new Map();
// task key → the refused words last put back into its field and when they were sent: a second refusal of words sent
// LATER goes after them, not before — two refused messages came back in the reverse order
const backAt = new Map();
const SENT_HOLD_MS = 60000;
const ASKED_SLACK_MS = 60000;
const MODEL_WAIT_MS = 120000;
const THUMB_IN_MS = 360; // .chat-thumb.in in style.css
const IMAGES_MAX = 10; // CHAT_IMAGES_MAX of src/routes/chat.js
const NOW_KEY = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? '⌘' : 'Ctrl+';
const mounted = new Set();
let thumbSeq = 0;
const THUMB_PX = 156; // the thumbnail's side (52px) at three dots a pixel

async function thumbOf(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, THUMB_PX / Math.min(bmp.width, bmp.height));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(bmp.width * k));
    cv.height = Math.max(1, Math.round(bmp.height * k));
    const g = cv.getContext('2d');
    g.imageSmoothingQuality = 'high';
    g.drawImage(bmp, 0, 0, cv.width, cv.height);
    bmp.close?.();
    return cv.toDataURL('image/png');
  } catch {
    return URL.createObjectURL(file);
  }
}

export const chatDirty = () => [...mounted].some((c) => (drafts.get(c.key) || '').trim() || draftImages.get(c.key)?.length);

export const chatTakesAsk = (id) => [...mounted].some((c) => c.shown && c.askId === id);
export function chatAsksChanged() {
  for (const c of mounted) if (c.data) c.paintAsk(c.data);
}

/** The stream said a session's chat changed: the chats on screen that show it read it again. */
export function chatEvent(session) {
  for (const c of mounted) if (c.session === session) c.refresh();
}

export function dur(ms) {
  if (!(ms >= 1000)) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} ${tr('s')}`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} ${tr('min')}` : `${Math.floor(m / 60)} ${tr('h')} ${m % 60} ${tr('min')}`;
}

const HELPER_TOOLS = new Set(['Agent', 'Task']);
const isHelper = (it) => HELPER_TOOLS.has(it.tool) || (it.tool === 'Skill' && it.running);
/** "06:04" of a moment the server sends (ISO), local time; '' for anything else. */
function clockOf(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function stepRow(it, working = false) {
  const tail = it.running ? '' : [dur(it.ms), it.error ? '' : (it.ms !== undefined ? '✓' : '')].filter(Boolean).join(' ');
  const steps = it.helper ? `<span class="chat-step-n">${it.helper.steps} ${esc(plural(it.helper.steps, 'step', 'steps'))}</span>` : '';
  const since = it.running ? clockOf(it.at) : '';
  const bg = it.running ? `<span class="chat-bg">${working ? '<span class="chat-pulse"></span>' : ''}${esc(since ? `${tr('in the background since')} ${since}` : tr('in the background'))}</span>` : '';
  const what = it.pic ? `<button type="button" class="chat-step-t chat-pic" data-pic="${esc(it.pic)}" title="${esc(tr('Open the picture'))}">${ic('image', 12)}<span class="chat-pic-t">${esc(it.text)}</span></button>`
    : `<span class="chat-step-t">${esc(it.text)}</span>`;
  return `<div class="chat-step${it.error ? ' err' : ''}${it.running ? ' running' : ''}" title="${esc(it.text)}"><span class="chat-step-k">${esc(tr(STEP_KIND[it.tool] || 'Tool'))}</span>`
    + what
    + `<span class="chat-step-d">${steps}${bg}${it.error ? `<span class="chat-x" title="${esc(tr('failed'))}">✗</span>` : ''}${esc(tail)}</span></div>`
    + (it.helper?.now ? `<div class="chat-answer chat-now">↳ ${esc(tr(STEP_KIND[it.helper.now.tool] || 'Tool'))} · ${esc(it.helper.now.text)}</div>` : '')
    + (it.answer ? `<div class="chat-answer">↳ ${esc(it.answer)}</div>` : '');
}

/** What runs in the background in these turns: helpers and commands still going. */
export function running(turns) {
  const all = (turns || []).flatMap((t) => t.items.filter((it) => it.kind === 'tool' && it.running));
  return { helpers: all.filter(isHelper).length, commands: all.filter((it) => !isHelper(it)).length };
}

export const answered = (it) => it.kind === 'tool' && it.tool === 'AskUserQuestion' && Array.isArray(it.answers) && it.answers.length > 0;
export function answersHTML(pairs, cls = '') {
  return `<div class="chat-user chat-answers${cls}"><div class="chat-bubble">${pairs.map((p) => {
    const q = p.h && !String(p.q).startsWith(p.h) ? `${p.h} · ${p.q}` : p.q;
    // the mark of the option Claude recommended went back to Claude as it came; the person's words are without it
    const a = String(p.a).split(', ').map(plainLabel).join(', ');
    return `<div class="chat-qa"><div class="chat-qa-q" title="${esc(p.q)}">${esc(q)}</div><div class="chat-qa-a">${esc(a)}</div></div>`;
  }).join('')}</div></div>`;
}

// a run of steps between Claude's texts, or one of its texts, a stop, words the person sent mid-turn, answers
function runsOf(items) {
  const runs = [];
  for (const it of items) {
    if (it.kind === 'tool' && !answered(it)) { if (runs.at(-1)?.steps) runs.at(-1).steps.push(it); else runs.push({ steps: [it] }); } else runs.push({ it });
  }
  return runs;
}
const codeBtn = (what, icon, label) => `<button type="button" class="chat-code-btn" data-code="${what}" title="${esc(tr(label))}" aria-label="${esc(tr(label))}">${ic(icon, 13)}</button>`;
// a block left open (cut off, or its fence missing) is not a command to run: its end is not known; nor is one longer than
const RUN_MAX = 8000;
const codeTools = (lang, closed, code = '') => `<span class="chat-code-tools">${codeBtn('copy', 'copy', 'Copy')}${closed && SHELL_LANGS.includes(lang) && code.length <= RUN_MAX ? codeBtn('run', 'terminal', 'Run in a Terminal window') : ''}</span>`;
function itemHTML(it) {
  if (answered(it)) return answersHTML(it.answers);
  return it.kind === 'stop' ? `<div class="chat-sep">${esc(tr('Stopped'))}</div>`
    : it.kind === 'said' ? `<div class="chat-user chat-mid"><div class="chat-bubble">${esc(it.text)}</div></div>`
      : `<div class="chat-claude">${chatText(it.text, codeTools)}</div>`;
}
const CODE_DONE_MS = 1400; // the ✓ a button shows after it did its work
/** Copy a block of code, or run it in a Terminal window — the session's, so the board can tell Claude wrote it. */
async function codeAction(c, b) {
  const code = b.closest('.chat-code-box')?.querySelector('.chat-code')?.textContent ?? '';
  const done = () => { b.classList.add('done'); b.innerHTML = ic('check', 13); setTimeout(() => { if (b.isConnected) { b.classList.remove('done'); b.innerHTML = ic(b.dataset.code === 'run' ? 'terminal' : 'copy', 13); } }, CODE_DONE_MS); };
  if (b.dataset.code === 'copy') { if (await copyText(code)) done(); return; }
  if (!(await styledConfirm(tr('Run this command in a new Terminal window, in the project folder?'), { okLabel: tr('Run'), detail: code }))) return;
  try {
    await api('POST', `/api/tasks/${seg(c.key)}/chat/run`, { session: c.session, code }, { quiet: true });
    done();
  } catch (e) {
    styledConfirm(refusalLine(tr('The command did not run'), e, tr), { okLabel: tr('Got it'), noCancel: true });
  }
}
const DID = {
  Runs: ['Ran a command', 'Ran %s', 'command', 'commands'], Reads: ['Read a file', 'Read %s', 'file', 'files'],
  Edits: ['Edited a file', 'Edited %s', 'file', 'files'], Writes: ['Wrote a file', 'Wrote %s', 'file', 'files'],
  Searches: ['Searched the code', 'Searched the code %s', 'time', 'times'], Helper: ['Started a helper', 'Started %s', 'helper', 'helpers'],
  Web: ['Looked on the web', 'Looked on the web %s', 'time', 'times'], Skill: ['Used a skill', 'Used %s', 'skill', 'skills'],
  Asks: ['Asked a question', 'Asked %s', 'question', 'questions'], Tool: ['Used a tool', 'Used %s', 'tool', 'tools'],
  // work handed to the background, by whether Claude Code told it ended
  BgOn: ['Started a background task', 'Started %s', 'background task', 'background tasks'],
  BgDone: ['Finished a background task', 'Finished %s', 'background task', 'background tasks'],
};
const DOING = {
  Runs: 'Running a command', Reads: 'Reading a file', Edits: 'Editing a file', Writes: 'Writing a file', Searches: 'Searching the code',
  Helper: 'A helper is at work', Web: 'Looking on the web', Skill: 'Using a skill', Asks: 'Asking a question', Tool: 'Using a tool',
};
const didOf = (it) => (it.bg ? (it.running ? 'BgOn' : 'BgDone') : DID[STEP_KIND[it.tool]] ? STEP_KIND[it.tool] : 'Tool');
/** «Ran 2 commands, read a file» — the steps of a run by kind, in the order Claude came to them. */
export function didWords(steps) {
  const n = new Map();
  for (const it of steps) n.set(didOf(it), (n.get(didOf(it)) || 0) + 1);
  return [...n].map(([k, count], i) => {
    const [one, many, a, b] = DID[k];
    const w = count === 1 ? tr(one) : tr(many).replace('%s', `${count} ${plural(count, a, b)}`);
    return i ? w.charAt(0).toLowerCase() + w.slice(1) : w;
  }).join(', ');
}
/** How long a step goes on since `iso` — «12 s», «3 min 19 s», «2 h 5 min». */
export function sinceWords(iso, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 1000));
  if (!Number.isFinite(s)) return '';
  if (s < 60) return `${s} ${tr('s')}`;
  return s < 3600 ? `${Math.floor(s / 60)} ${tr('min')} ${s % 60} ${tr('s')}` : `${Math.floor(s / 3600)} ${tr('h')} ${Math.floor(s / 60) % 60} ${tr('min')}`;
}
const baseName = (f) => String(f).slice(String(f).lastIndexOf('/') + 1);
function runHTML(steps, id, open, { working, now = null, pic = null }) {
  const failed = steps.filter((s) => s.error).length;
  const one = steps.length === 1 ? steps[0] : null;
  const edits = steps.filter((s) => EDIT_TOOLS.has(s.tool) && !s.error && s.ms !== undefined);
  const sized = edits.length > 0 && edits.every((s) => s.diff);
  const sum = sized ? counts(edits.reduce((x, s) => x + s.diff.add, 0), edits.reduce((x, s) => x + s.diff.del, 0)) : '';
  let head;
  if (now) {
    head = `<span class="chat-pulse"></span><span class="chat-run-t">${esc(tr(DOING[STEP_KIND[now.tool]] || DOING.Tool))}</span>`
      + `<span class="chat-run-time" data-since="${esc(now.at)}">${esc(sinceWords(now.at))}</span>`;
  } else if (one && edits.length === 1) {
    head = `<span class="chat-run-t">${esc(tr(one.tool === 'Write' ? 'Wrote' : 'Updated'))} <span class="chat-run-file" title="${esc(one.text)}">${esc(baseName(one.text))}</span></span>${sum}`;
  } else head = `<span class="chat-run-t">${esc(didWords(steps))}</span>${sum}`;
  // a picture Claude read shows at the line's end, as in the app, and opens whole on a click (not the fold: `data-pic`)
  const seen = pic && steps.findLast((s) => s.pic);
  const thumb = seen ? `<img class="chat-run-pic" data-pic="${esc(seen.pic)}" src="${esc(pic(seen.pic))}" alt="" title="${esc(tr('Open the picture'))}" loading="lazy" decoding="async">` : '';
  return `<button type="button" class="chat-run${open ? ' open' : ''}${now ? ' now' : ''}" data-fold="${esc(id)}" aria-expanded="${open}">${head}`
    + `${failed ? `<span class="chat-x">✗ ${failed}</span>` : ''}${ic('chevron', 11)}${thumb}</button>`
    + (open ? `<div class="chat-unfold chat-runbox" data-of="${esc(id)}">${steps.map((s) => stepRow(s, working)).join('')}</div>` : '');
}
function itemsHTML(items, at, { opened, working, fold = true, live = false, pic = null }) {
  let out = '';
  const runs = runsOf(items);
  runs.forEach((r, i) => {
    if (r.it) { out += itemHTML(r.it); return; }
    if (!fold) { out += r.steps.map((s) => stepRow(s, working)).join(''); return; }
    const id = `${at}|${i}`;
    // Claude calls tools side by side: the one still unanswered may be any of the run's, not its last
    const now = live && i === runs.length - 1 ? r.steps.findLast((s) => s.ms === undefined && !s.running) || null : null;
    out += runHTML(r.steps, id, opened.has(id), { working, now, pic });
  });
  return out;
}

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
export function turnFiles(items) {
  const by = new Map();
  for (const it of items || []) {
    if (it.kind !== 'tool' || !EDIT_TOOLS.has(it.tool) || it.error || !it.text || it.ms === undefined) continue;
    const f = by.get(it.text) || { file: it.text, add: 0, del: 0, sure: true };
    f.add += it.diff?.add || 0;
    f.del += it.diff?.del || 0;
    f.sure &&= Boolean(it.diff);
    by.set(it.text, f);
  }
  return [...by.values()];
}
const FILES_OPEN = 3; // a turn that changed this many files or fewer shows their list at once
const counts = (add, del, sure = true) => (sure ? `<span class="chat-add">+${add}</span><span class="chat-del">−${del}</span>` : '');
function filesHTML(files, at, opened) {
  const id = `${at}|files`;
  // shown by default when short; the person's click turns the default over
  const open = (files.length <= FILES_OPEN) !== opened.has(id);
  const add = files.reduce((n, f) => n + f.add, 0);
  const del = files.reduce((n, f) => n + f.del, 0);
  return `<div class="chat-files"><button type="button" class="chat-files-h${open ? ' open' : ''}" data-fold="${esc(id)}" aria-expanded="${open}">${ic('chevron', 11)}`
    + `<span>${esc(tr('Files changed:'))} ${files.length}</span>${counts(add, del, files.every((f) => f.sure))}</button>`
    + (open ? `<div class="chat-unfold" data-of="${esc(id)}">` + files.map((f) => {
      const cut = f.file.lastIndexOf('/');
      return `<div class="chat-file" title="${esc(f.file)}"><span class="chat-file-n">${esc(f.file.slice(cut + 1))}</span>`
        + `<span class="chat-file-d">${esc(cut > 0 ? f.file.slice(0, cut) : '')}</span>${counts(f.add, f.del, f.sure)}</div>`;
    }).join('') + '</div>' : '')
    + '</div>';
}

/** Whether a turn is drawn as one bar: it is over, and not by a stop (a stopped turn keeps its runs and «Stopped»). */
export const barred = (t) => !t.open && (Boolean(t.ms) || !t.items.some((it) => it.kind === 'stop'));
export function carryOpened(turns, opened) {
  for (const t of turns || []) {
    if (!barred(t)) continue;
    const runs = [...opened].filter((id) => id.startsWith(`${t.at}|`) && /^\d+$/.test(id.slice(String(t.at).length + 1)));
    if (!runs.length) continue;
    for (const id of runs) opened.delete(id);
    opened.add(`${t.at}|work`);
  }
}
const SHOT_W = 220; // a thumbnail of the person's picture at most (.chat-shot img)
const SHOT_H = 160;
export function turnHTML(t, { opened = new Set(), working = false, shot = null, pic = null, asking = false } = {}) {
  let out = '';
  if (t.compact) out += `<div class="chat-sep">${esc(tr('The conversation was compacted'))}</div>`;
  if (t.user || t.images) {
    const shots = shot && t.shots?.length ? t.shots : [];
    // as many «[Image #N]» as pictures shown leave the words — the rest stay with the «📎» that counts them
    let strip = shots.length;
    const words = strip ? String(t.user || '').replace(/\[Image #\d+\]\s*/g, (x) => (strip-- > 0 ? '' : x)).trim() : t.user;
    const unseen = (t.images || 0) - shots.length; // a picture the board cannot show is still counted
    const pics = shots.length ? `<div class="chat-shots">${shots.map((x) => {
      // the place is kept before the picture decodes: a thumbnail growing late pushed the turn being read
      const k = x.w > 0 && x.h > 0 ? Math.min(1, SHOT_W / x.w, SHOT_H / x.h) : 0;
      const size = k ? ` width="${Math.max(1, Math.round(x.w * k))}" height="${Math.max(1, Math.round(x.h * k))}"` : '';
      return `<button type="button" class="chat-shot" data-shot="${esc(shot(x.ref))}" title="${esc(tr('Open the picture'))}"><img src="${esc(shot(x.ref))}" alt=""${size} decoding="async"></button>`;
    }).join('')}</div>` : '';
    const bubble = words || unseen > 0 ? `<div class="chat-bubble">${esc(words || '')}${unseen > 0 ? `<span class="chat-img">${ic('attach', 11)} ${unseen}</span>` : ''}</div>` : '';
    out += `<div class="chat-user${pics ? ' has-shots' : ''}">${pics}${bubble}</div>`;
  }
  const worked = t.ms ? `${esc(tr('Worked for'))} ${esc(dur(t.ms) || `${Math.round(t.ms / 1000)} ${tr('s')}`)}` : esc(tr('Done'));
  if (!barred(t)) {
    // a step waiting on a question or a permission is not run — Claude waits for the person (`asking`)
    out += itemsHTML(t.items, t.at, { opened, working, live: working && Boolean(t.open) && !asking, pic });
    return `<div class="chat-turn" data-at="${esc(t.at)}">${out}</div>`;
  }
  const last = t.items.at(-1)?.kind === 'text' ? t.items.at(-1) : null;
  const said = (it) => it.kind === 'said' || answered(it); // the person's words stay in sight
  const log = t.items.filter((it) => it !== last && !said(it));
  const files = turnFiles(t.items);
  const steps = t.items.filter((it) => it.kind === 'tool' && !answered(it));
  if (log.length) {
    const id = `${t.at}|work`;
    const open = opened.has(id);
    const failed = steps.filter((s) => s.error).length;
    const chips = [steps.length ? `${steps.length} ${esc(plural(steps.length, 'step', 'steps'))}` : '', files.length ? `${files.length} ${esc(plural(files.length, 'file', 'files'))}` : '']
      .filter(Boolean).map((x) => `<span class="chat-chip">${x}</span>`).join('');
    out += `<button type="button" class="chat-done${open ? ' open' : ''}" data-fold="${esc(id)}" aria-expanded="${open}">${ic('chevron', 11)}${ic('check', 11)}<span class="chat-done-t">${worked}</span>`
      + `<span class="chat-chips">${failed ? `<span class="chat-chip chat-x">✗ ${failed}</span>` : ''}${chips}</span></button>`;
    if (open) out += `<div class="chat-log-in chat-unfold" data-of="${esc(id)}">${itemsHTML(log, t.at, { opened, working, fold: false })}</div>`;
  } else {
    out += `<div class="chat-worked">${ic('check', 11)} ${worked}</div>`;
  }
  out += t.items.filter(said).map(itemHTML).join('');
  if (files.length) out += filesHTML(files, t.at, opened);
  if (last) out += itemHTML(last);
  return `<div class="chat-turn" data-at="${esc(t.at)}">${out}</div>`;
}

/** A moment the board keeps in UTC ('YYYY-MM-DD HH:MM:SS') as local time — "22 Oct 17:49". */
export function localStamp(utc) {
  const d = new Date(`${String(utc || '').replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${two(d.getHours())}:${two(d.getMinutes())}`;
}
const AWAY_LOOK_MS = 5000; // a transcript not written yet (a Claude just started) is asked for again — nothing rings for it
const LIT_LOOK_MS = 5000;
const SENT_LOOK_MS = 1500;

export function workingLine(d) {
  if (!(d.working || (d.send && d.state === 'busy'))) return '';
  const { helpers, commands } = running(d.turns);
  const turn = d.turns?.at(-1);
  const turnOn = Boolean(turn?.open);
  // the card's head) — it waits for the person; «Claude works» there had the owner ask it, and it said nothing ran
  const left = !turnOn && d.turns?.length && !helpers && commands && d.own === false;
  const words = tr(turnOn || !d.turns?.length ? 'Claude is working…' : left ? 'Waits for you · commands in the background' : 'Claude works in the background…')
    + (helpers ? ` · ${tr('helpers at work:')} ${helpers}` : '');
  // a step with no answer yet, not one handed to the background — the one Claude waits on now
  const now = turnOn ? turn.items.at(-1) : null;
  const step = now?.kind === 'tool' && now.ms === undefined && !now.running
    ? `<span class="chat-working-now" title="${esc(now.text)}">${esc(tr(STEP_KIND[now.tool] || 'Tool'))} · ${esc(now.text)}</span>` : '';
  return `<div class="chat-working"><span class="chat-pulse"></span><span class="chat-working-t">${esc(words)}</span>${step}</div>`;
}

export function liveHTML(d) {
  const lit = workingLine(d);
  if (!lit) return '';
  const going = (d.turns || []).flatMap((t) => t.items.filter((it) => it.kind === 'tool' && it.running));
  return `${going.length ? `<div class="chat-going">${going.map((it) => stepRow(it, true)).join('')}</div>` : ''}${lit}`;
}

// says it under itself
const STATE_NOTE = {
  question: 'Claude asks a question — answer it above; messages wait',
};
export function conversationText(d) {
  const out = [];
  for (const t of d?.turns || []) {
    if (t.user) out.push(`**${tr('Me')}:** ${t.user}`);
    for (const it of t.items || []) {
      if (it.kind === 'text') out.push(`**Claude:** ${it.text}`);
      else if (it.kind === 'said') out.push(`**${tr('Me')}:** ${it.text}`);
      else if (answered(it)) out.push(it.answers.map((p) => `**${tr('Me')}:** ${p.q} — ${p.a}`).join('\n'));
    }
  }
  return out.join('\n\n');
}

// keys of an open question — the terminal's own (TERM_KEYS in drawer.js; not imported: drawer.js imports this module)
const ASK_KEYS = [
  { text: '1', label: '1' }, { text: '2', label: '2' }, { text: '3', label: '3' },
  { key: 'Up', label: '↑' }, { key: 'Down', label: '↓' }, { key: 'Enter', label: '↵' }, { key: 'Escape', label: 'Esc' },
];

/** The person's words a chat answer holds, each as `at|text` — to tell the words of a message just sent from those
    the chat had before. */
export function userWords(d) {
  const out = [];
  for (const t of d?.turns || []) {
    if (t.user !== null && t.user !== undefined) out.push({ key: `${t.at}|${t.user}`, text: t.user });
    for (const it of t.items || []) if (it.kind === 'said') out.push({ key: `${it.at}|${it.text}`, text: it.text });
  }
  return out;
}
const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim();
export function sentArrived(sent, d) {
  const head = flat(sent.text).slice(0, 60);
  return userWords(d).some((w) => !sent.seen.has(w.key) && (!head || flat(w.text).includes(head)));
}

let runClock = null;
function tickRuns() {
  const els = [...document.querySelectorAll('.chat-run-time[data-since]')].filter((el) => el.offsetParent !== null);
  if (!els.length) { clearInterval(runClock); runClock = null; return; }
  for (const el of els) el.textContent = sinceWords(el.dataset.since);
}

const UNFOLD_MS = 180;
export function unfold(el, open, ms = UNFOLD_MS) {
  if (!el?.animate || globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  const h = `${el.scrollHeight}px`;
  el.style.overflow = 'hidden';
  const a = el.animate(open ? [{ height: '0px', opacity: 0 }, { height: h, opacity: 1 }] : [{ height: h, opacity: 1 }, { height: '0px', opacity: 0 }],
    { duration: ms, easing: 'cubic-bezier(.4, 0, .2, 1)', fill: open ? 'none' : 'forwards' });
  const done = () => { el.style.overflow = ''; };
  if (open) a.finished.then(done, () => {}); else a.addEventListener?.('cancel', done);
  return a;
}

/** Draw a chat into `box` and keep it current. `key` — the task, `session` — one of its sessions (null: the newest).
    `scroller` — what scrolls the chat (the card: the whole card scrolls, the field stays at its bottom edge; a column: the
    chat's own list). Returns {setKey(key, session), refresh(), show(on), destroy(), session}. */
export function mountChat(box, { key = null, session = null, scroller = null, full = null } = {}) {
  const tool = (cls, icon, title, extra = '') => `<button type="button" class="chat-tool ${cls}" title="${esc(tr(title))}" aria-label="${esc(tr(title))}"${extra}>${ic(icon, 15)}</button>`;
  box.innerHTML = '<div class="chat"><div class="chat-top"></div><div class="chat-log"></div>'
    + '<div class="chat-dock"><div class="chat-live"></div><div class="chat-ask hidden"></div><div class="chat-note muted"></div><div class="chat-queue"></div>'
    + '<div class="comment-form chat-form"><div class="chat-imgs hidden"></div><div class="chat-box">'
    + '<input type="file" class="hidden" accept="image/png,image/jpeg,image/webp,image/gif" multiple>'
    + `<textarea rows="1" placeholder="${esc(tr('Message Claude…'))}" title="${esc(`${tr('↵ sends, ⇧↵ — new line')}; ${NOW_KEY}↵ — ${tr('at once, even while Claude works')}`)}"></textarea>`
    + '<div class="chat-tools">'
    + tool('chat-more', 'more', 'More actions', ' aria-haspopup="menu"') + tool('chat-attach', 'attach', 'Attach a picture')
    + `<button type="button" class="chat-model hidden" aria-haspopup="menu" title="${esc(tr('The model Claude answers with'))}"><span class="chat-model-l"></span>${ic('chevron', 10)}</button>`
    + '<span class="chat-tools-gap"></span>'
    + tool('chat-full', 'expand', 'The task on the full screen') + tool('chat-term', 'terminal', 'Show the terminal')
    + `<button type="button" class="chat-tool chat-stop hidden" title="${esc(tr('Stop Claude — what it does now stops at once'))}" aria-label="${esc(tr('Stop'))}">${ic('stop', 14)}</button>`
    + `<button type="button" class="chat-send" title="${esc(tr('Send'))}" aria-label="${esc(tr('Send'))}">↑</button></div></div>`
    + '<div class="chat-menu hidden" role="menu"></div></div></div></div>';
  const ask = box.querySelector('.chat-ask');
  const top = box.querySelector('.chat-top');
  const log = box.querySelector('.chat-log');
  const liveEl = box.querySelector('.chat-live');
  const queueEl = box.querySelector('.chat-queue');
  const note = box.querySelector('.chat-note');
  const form = box.querySelector('.chat-form');
  const input = form.querySelector('textarea');
  const imgsEl = box.querySelector('.chat-imgs');
  const picker = form.querySelector('input[type=file]');
  const stopBtn = form.querySelector('.chat-stop');
  const sendBtn = form.querySelector('.chat-send');
  const menu = box.querySelector('.chat-menu');
  const moreBtn = box.querySelector('.chat-more');
  const modelBtn = box.querySelector('.chat-model');
  const fullBtn = box.querySelector('.chat-full');
  const termBtn = box.querySelector('.chat-term');
  const inCard = Boolean(scroller);
  const isFull = () => (inCard ? drawerIsFull() : Boolean(full?.on()));
  const fullWords = (on) => (on ? (inCard ? 'Back to the card' : 'Back to the column') : (inCard ? 'The task on the full screen' : 'The chat on the full screen'));
  const c = {
    key, asked: session, session: null, turns: TURNS_STEP, v: null, data: null, flight: null, again: false,
    shown: true, stale: false, opened: new Set(), folding: new Set(), follow: true, refused: '', atEnd: true,
  };
  const section = () => (scroller || box.closest?.('.col-full') ? null : box.closest?.('.now-view') || null);
  let place = null;
  function notePlace() {
    const sc = section();
    if (!sc || !globalThis.matchMedia?.(NARROW).matches) { place = null; return; }
    // typing in a chat — its field, or the answer of its own in the question's form (the form is what goes): its field box
    const f = document.activeElement;
    let el = f && sc.contains(f) ? f.closest('.chat')?.querySelector('.chat-form') || (f.matches('textarea, input') ? f : null) : null;
    if (!el) {
      const v = sc.getBoundingClientRect();
      el = document.elementFromPoint(v.left + v.width / 2, v.top + v.height / 2)?.closest('.now-col') || null;
    }
    place = el ? { el, top: el.getBoundingClientRect().top } : null;
  }
  const onSectionScroll = (e) => { if (e.target === section()) notePlace(); };
  document.addEventListener?.('scroll', onSectionScroll, true);
  let askH = 0;
  const askWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const h = ask.offsetHeight;
    const shrunk = askH > h;
    askH = h;
    const sc = section();
    if (!shrunk || !sc || !place?.el.isConnected) { notePlace(); return; }
    const moved = place.el.getBoundingClientRect().top - place.top;
    if (Math.abs(moved) >= 1) sc.scrollTop += moved;
    notePlace();
  }) : null;
  askWatch?.observe(ask);
  const grow = () => {
    if (!input.getClientRects().length) { input.style.height = ''; return; }
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };
  const sc = scroller || log;
  const END_GAP = 60;
  const gapToEnd = () => sc.scrollHeight - sc.scrollTop - sc.clientHeight;
  const onScroll = () => { if (c.shown && !c.holds) c.atEnd = gapToEnd() < END_GAP; };
  sc.addEventListener('scroll', onScroll, { passive: true });
  const sizes = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => { if (c.shown && c.atEnd && !c.holds && log.getClientRects().length) sc.scrollTop = sc.scrollHeight; }) : null;
  for (const el of [sc, log, box.querySelector('.chat-dock')]) sizes?.observe(el);

  // (it shows them itself), the bubble goes
  function sentHTML(d) {
    const waiting = d.waiting || [];
    const inQueue = (w) => { const h = flat(w.text).slice(0, 60); return Boolean(h) && waiting.some((x) => flat(x.text).includes(h)); };
    // words met in the queue are not lost while they wait; gone from it untaken (back in Claude Code's field, Claude
    // stopped) — the bubble goes too, nothing is sending them
    for (const w of sentWords.get(c.key) || []) if (inQueue(w)) { w.queued = true; w.drawn = true; }
    const left = (sentWords.get(c.key) || []).filter((w) => !sentArrived(w, d) && (inQueue(w) || (!w.queued && Date.now() - w.at < SENT_HOLD_MS))
      && !(w.qid && (d.queue || []).some((q) => q.id === w.qid)));
    const going = left.filter((w) => !inQueue(w)); // a word waiting in the queue is told by the transcript's change (session.chat)
    if (left.length) sentWords.set(c.key, left); else sentWords.delete(c.key);
    clearTimeout(c.sentTimer);
    if (going.length) c.sentTimer = setTimeout(() => { c.v = null; refresh(); }, SENT_LOOK_MS);
    // the board clips a long question and trims it; Claude Code's text escapes its quotes
    const firstQ = (pairs) => String(pairs[0]?.q || '').replace(/\\"/g, '"').replace(/\s+/g, ' ').trim().slice(0, 100);
    // hook brings it) — meet the bubble; the same question answered earlier hid the bubble of the new answer
    const steps = (d.turns || []).flatMap((t) => t.items.filter(answered));
    const inChat = (x) => steps.some((it) => firstQ(it.answers) === firstQ(x.pairs) && Date.parse(it.at) >= (x.since || 0) - ASKED_SLACK_MS);
    const answers = (sentAnswers.get(c.key) || []).filter((x) => !inChat(x) && Date.now() - x.at < SENT_HOLD_MS);
    if (answers.length) sentAnswers.set(c.key, answers); else sentAnswers.delete(c.key);
    if (answers.length && !going.length) c.sentTimer = setTimeout(() => { c.v = null; refresh(); }, SENT_LOOK_MS);
    const enter = (x) => { const first = !x.drawn; x.drawn = true; return first ? ' chat-enter' : ''; };
    // a word of the queue comes in smoothly once — not when it is the bubble of «sending…» it takes the place of
    const seenWait = c.waitDrawn || new Set();
    const sentOf = (x) => left.find((w) => w.drawn && flat(x.text).includes(flat(w.text).slice(0, 60)));
    c.waitDrawn = new Set(waiting.map((x) => `${x.at}|${x.text}`));
    const waitHTML = waiting.map((x) => {
      const sent = sentOf(x); // its pictures, as the bubble it takes the place of showed them
      return `<div class="chat-user chat-sending chat-queued${seenWait.has(`${x.at}|${x.text}`) || sent ? '' : ' chat-enter'}"><div class="chat-bubble">${esc(x.text)}`
        + (sent?.images_n ? `<span class="chat-img">${ic('attach', 11)} ${sent.images_n}</span>` : '')
        + `<span class="chat-wait-l">${esc(tr('Claude reads it when the step it is on ends'))}</span></div></div>`;
    }).join('');
    return answers.map((x) => answersHTML(x.pairs, enter(x))).join('') + waitHTML + going.map((w) => `<div class="chat-user chat-sending${enter(w)}"><div class="chat-bubble">${esc(w.text)}`
      + (w.images_n ? `<span class="chat-img">${ic('attach', 11)} ${w.images_n}</span>` : '')
      + `<span class="chat-wait-l">${esc(tr('sending…'))}</span></div></div>`).join('');
  }

  const turnsShown = () => [...(log.querySelectorAll?.('.chat-turn[data-at]') || [])];
  function seenTurn() {
    const top = sc.getBoundingClientRect?.().top ?? 0;
    for (const el of turnsShown()) {
      const r = el.getBoundingClientRect();
      if (r.bottom > top) return { at: el.dataset.at, off: r.top - top };
    }
    return null;
  }
  function holdTurn(anchor, keepTop) {
    const el = anchor && turnsShown().find((x) => x.dataset.at === anchor.at);
    if (!el) { sc.scrollTop = keepTop; return; }
    const top = sc.getBoundingClientRect().top;
    sc.scrollTop = Math.max(0, el.getBoundingClientRect().top - top + sc.scrollTop - anchor.off);
  }

  c.holdReading = () => {
    if (!c.shown || c.atEnd) return () => {};
    const anchor = seenTurn();
    const keep = sc.scrollTop;
    // counted: a move cut short gives its hold back while the next one still holds (a flag let the end pin the chat)
    c.holds = (c.holds || 0) + 1;
    // every frame of the move, not only at its end — WebKit showed the last words midway and jumped back
    const frames = typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function';
    let frame = 0;
    const each = () => { holdTurn(anchor, keep); frame = requestAnimationFrame(each); };
    if (frames) frame = requestAnimationFrame(each);
    let given = false;
    return () => {
      if (given) return;
      given = true;
      if (frames) cancelAnimationFrame(frame);
      c.holds -= 1;
      if (c.holds) return; // the next move holds on
      holdTurn(anchor, keep);
      c.atEnd = gapToEnd() < END_GAP;
    };
  };

  function paint() {
    notePlace();
    const d = c.data;
    if (!d) {
      log.innerHTML = `<div class="chat-empty muted">${esc(tr('Loading…'))}</div>`;
      for (const el of [top, note, form, ask]) el.classList.add('hidden');
      dropAsk();
      queueEl.innerHTML = '';
      liveEl.innerHTML = liveEl.dataset.html = '';
      return;
    }
    c.session = d.session;
    // a task Claude worked on in several sessions: which one the chat shows
    const newest = [...(d.sessions || [])].sort((a, b) => String(b.last_seen).localeCompare(String(a.last_seen)))[0]?.session_id;
    // drawn anew only when the sessions change — a live repaint would shut a list the reader has open
    const sessions = d.sessions || [];
    const sig = sessions.length > 1 ? JSON.stringify([d.session, newest, sessions.map((s) => [s.session_id, s.last_seen])]) : '';
    if (top.dataset.sig !== sig) {
      top.dataset.sig = sig;
      top.innerHTML = sig ? `<div class="chat-sess muted">${esc(tr('Session'))} <div class="chat-sess-sel"></div></div>` : '';
      const host = top.querySelector('.chat-sess-sel');
      if (host) {
        // its list the chat's own menu, a check by the one shown (style.css, `.chat-sess-sel`)
        buildSelect(host, {
          value: d.session,
          options: sessions.map((s) => ({ value: s.session_id, label: `${localStamp(s.last_seen)}${s.session_id === newest ? ` · ${tr('the newest')}` : ''}`,
            ...(s.session_id === d.session ? { rightHTML: `<span class="chat-mi-on">${ic('check', 12)}</span>` } : {}) })),
          onChange: (v) => { c.asked = v; c.v = null; c.turns = TURNS_STEP; c.follow = true; refresh(); },
        });
        const chev = host.querySelector('.kbsel-chev');
        if (chev) chev.innerHTML = ic('chevron', 11);
      }
    }
    top.classList.toggle('hidden', !sig);
    const atEnd = c.atEnd;
    const keepFrom = sc.scrollHeight - sc.scrollTop;
    const keepTop = sc.scrollTop;
    const anchor = atEnd ? null : seenTurn();
    const lit = liveHTML(d);
    const sending = sentHTML(d);
    if (!d.session) {
      log.innerHTML = `<div class="chat-empty muted">${esc(tr('Claude has not worked on this task yet'))}</div>`;
    } else if (d.away) {
      // the board's own Claude writes its transcript here — it has not yet; any other is elsewhere
      log.innerHTML = `${sending ? '' : `<div class="chat-empty muted">${esc(tr(d.send || d.working ? 'No messages yet' : 'The transcript of this work is not on this computer'))}</div>`}${sending}`;
      clearTimeout(c.awayTimer);
      c.awayTimer = setTimeout(() => { c.v = null; refresh(); }, AWAY_LOOK_MS);
    } else if (!d.turns.length) {
      log.innerHTML = sending || `<div class="chat-empty muted">${esc(tr('No messages yet'))}</div>`;
    } else {
      const working = Boolean(lit);
      carryOpened(d.turns, c.opened);
      log.innerHTML = (d.earlier_n ? `<button type="button" class="tl-toggle chat-earlier"><span class="tl-toggle-label">${esc(tr('Show earlier'))} (${d.earlier_n})</span></button>` : '')
        + d.turns.map((t) => turnHTML(t, { opened: c.opened, working, asking: d.state === 'question', shot: (ref) => `/api/tasks/${seg(c.key)}/chat/image/${seg(ref)}?session=${encodeURIComponent(c.session)}`,
          pic: (id) => `/api/tasks/${seg(c.key)}/chat/picture/${seg(id)}?session=${encodeURIComponent(c.session)}` })).join('')
        + sending;
    }
    // drawn only when it changed: the pulse would start anew on every look, five seconds apart
    if (liveEl.dataset.html !== lit) { liveEl.dataset.html = lit; liveEl.innerHTML = lit; }
    if (!runClock && log.querySelector('.chat-run-time')) runClock = setInterval(tickRuns, 1000);
    // stopped (Esc) or ended its turn rings no event once its last line is written: the light stayed on for good
    clearTimeout(c.helperTimer);
    if (lit) c.helperTimer = setTimeout(refresh, LIT_LOOK_MS);
    if (d.session && !d.away && d.turns.length) {
      log.querySelectorAll('[data-code]').forEach((b) => { b.onclick = () => codeAction(c, b); });
      log.querySelectorAll('[data-shot]').forEach((b) => { b.onclick = () => openLightbox(b.dataset.shot); });
      log.querySelectorAll('[data-pic]').forEach((b) => {
        b.onclick = (e) => { e.stopPropagation(); openLightbox(`/api/tasks/${seg(c.key)}/chat/picture/${seg(b.dataset.pic)}?session=${encodeURIComponent(c.session)}`); };
      });
      log.querySelector('.chat-earlier')?.addEventListener('click', () => { c.earlier = true; c.turns += TURNS_STEP; c.follow = false; refresh(); });
      log.querySelectorAll('[data-fold]').forEach((b) => {
        b.onclick = () => {
          const id = b.dataset.fold;
          if (c.folding.has(id)) return; // closing already
          const flip = () => {
            c.folding.delete(id);
            if (c.opened.has(id)) c.opened.delete(id); else c.opened.add(id);
            c.keep = true; // a fold opened or closed keeps the reader where they are
            paint();
          };
          const shown = foldBody(id);
          const going = shown && unfold(shown, false);
          if (going) { c.folding.add(id); going.finished.then(flip, flip); return; }
          flip();
          // the chat was drawn anew: the head clicked is gone from the page — its fold is found again
          if (!shown) reveal([...log.querySelectorAll('[data-fold]')].find((x) => x.dataset.fold === id), foldBody(id), unfold(foldBody(id), true));
        };
      });
    }
    paintAsk(d);
    const waiting = d.queue || [];
    queueEl.innerHTML = waiting.length ? `<div class="chat-q-h">${esc(tr('waits until Claude is free'))}: ${waiting.length}</div>`
      + waiting.map((q) => `<div class="chat-q-row" title="${esc(q.text)}"><span class="chat-q-t">${esc(q.text)}</span>`
        + (q.images_n ? `<span class="chat-img">${ic('attach', 11)} ${q.images_n}</span>` : '')
        + `<button type="button" class="chat-now-btn" data-now="${esc(q.id)}" title="${esc(tr('Send now — Claude takes it into the turn going on'))}">${esc(tr('Now'))}</button>`
        + `<button type="button" class="chat-unq" data-q="${esc(q.id)}" title="${esc(tr('Take it back'))}" aria-label="${esc(tr('Take it back'))}">✕</button></div>`).join('') : '';
    queueEl.querySelectorAll('[data-q]').forEach((b) => { b.onclick = () => unqueue(b.dataset.q); });
    queueEl.querySelectorAll('[data-now]').forEach((b) => { b.onclick = () => queuedNow(b.dataset.now, b); });
    form.classList.toggle('hidden', !d.send);
    paintTools(d);
    stopBtn.classList.toggle('hidden', !(d.send && d.state === 'busy'));
    paintImages();
    // question» stood after the question was answered and the queue had gone
    if (c.refused !== c.refusedSaid) { c.refusedSaid = c.refused; c.refusedState = d.state; } else if (c.refused && d.state !== c.refusedState) c.refused = c.refusedSaid = '';
    // a refusal goes before the line of a Claude outside the board: an answer to its question, refused, said nothing here
    const ended = d.ended ? tr(d.ended.lost ? 'The terminal of this session is gone — its conversation is kept: Continue brings Claude back to it here.'
      : d.ended.interrupted ? 'The session was interrupted from outside — its conversation is kept: Continue brings Claude back to it here.'
        : 'Claude has finished in its terminal — Continue brings it back to the conversation.') : '';
    note.textContent = !d.session ? ''
      : c.refused || ended || (!d.send ? tr('This Claude does not run inside the board — its chat can only be read here.')
        : tr(STATE_NOTE[d.state] || ''));
    if (d.session && ended && !c.refused && c.key) {
      const again = document.createElement('button');
      again.type = 'button';
      again.className = 'btn-primary chat-resume';
      again.textContent = tr('Continue');
      again.title = tr('Start Claude again in this terminal with its conversation — it waits for your word');
      again.onclick = async () => { if (await resumeOnBoard({ key: c.key, session: d.session, btn: again })) { c.v = null; refresh(); } };
      note.append(' ', again);
    }
    note.classList.toggle('hidden', !note.textContent);
    // under them, and with it the light "Claude is working…"
    // scroll of a list whose content is put anew, and the chat flew to its first words
    if (c.keep) { c.keep = false; sc.scrollTop = keepTop; }
    else if (c.follow || atEnd) sc.scrollTop = sc.scrollHeight;
    else if (c.earlier) sc.scrollTop = Math.max(0, sc.scrollHeight - keepFrom); // turns came in above: kept from the end
    else holdTurn(anchor, keepTop);
    c.earlier = false;
    c.follow = false;
    c.atEnd = gapToEnd() < END_GAP; // a fold opened at the end leaves the reader above it, not held to the end
  }

  function reveal(head, body, opening) {
    const frame = sc.getBoundingClientRect?.();
    if (!head?.getBoundingClientRect || !body?.getBoundingClientRect || !frame) return; // the stand-ins of tests have no layout
    const dockEl = box.querySelector('.chat-dock');
    const dock = dockEl && sc.contains(dockEl) ? dockEl.getBoundingClientRect().height : 0; // the card's field over its bottom
    const at = (el) => el.getBoundingClientRect().top - frame.top + sc.scrollTop;
    const view = sc.clientHeight - dock;
    const tabs = sc.querySelector?.('.d-tabs:not(.hidden)');
    const lid = tabs && globalThis.getComputedStyle?.(tabs).position === 'sticky'
      ? parseFloat(getComputedStyle(tabs).top) + parseFloat(getComputedStyle(sc).paddingTop) + tabs.offsetHeight : 0;
    const top = at(head) - 8 - lid;
    const bottom = at(body) + body.scrollHeight + 8;
    const from = sc.scrollTop;
    const to = Math.max(from, Math.min(bottom - view, top));
    if (to <= from + 1) return;
    c.holds = (c.holds || 0) + 1;
    const done = () => { c.holds -= 1; if (!c.holds) c.atEnd = gapToEnd() < END_GAP; };
    if (!opening) { sc.scrollTop = to; done(); return; }
    const ease = (t) => { // the curve of unfold(): cubic-bezier(.4, 0, .2, 1), close enough by a smoothstep
      const x = Math.min(1, Math.max(0, t));
      return x * x * (3 - 2 * x);
    };
    const t0 = performance.now();
    const step = (now) => {
      const t = (now - t0) / UNFOLD_MS;
      sc.scrollTop = from + (to - from) * ease(t);
      if (t < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  }

  const foldBody = (id) => [...log.querySelectorAll('.chat-unfold')].find((x) => x.dataset.of === id) || null;

  function dropAsk() {
    if (!c.askId) return;
    // before the answer's own POST does): dropping the form here cut the fade 20ms in
    if (!c.askFading && isSending(c.askId)) fadeAsk(c.askId);
    if (c.askFading) {
      const f = c.askFading;
      if (!f.waits) { f.waits = true; const done = () => { if (c.askFading === f) { c.askFading = null; dropAsk(); } }; f.going.finished.then(done, done); }
      return;
    }
    if (c.askLeft !== c.askId) keepTyped(); // not answered from here: answered in Claude's window or no longer waited for
    c.askId = null;
    c.askGone = Date.now();
    ask.classList.remove('form');
    ask.innerHTML = '';
    renderAsks();
  }
  function keepTyped({ wait = false } = {}) {
    const fields = [...ask.querySelectorAll('.ask-other, .ask-qnote, .ask-reason')];
    const words = leftoverWords([...fields.map((el) => el.value), c.screenLeft || '']);
    fields.forEach((el) => { el.value = ''; }); // taken once: the form may be read again before it is drawn anew
    c.screenLeft = '';
    if (!words || !c.key) return;
    // review: one look without the question on the screen may be a flicker (a reprint for a new width) — the words wait
    // for the next look, and a question back takes them into its field again (paintChoice)
    if (wait) { c.screenLeft = words; return; }
    input.value = intoField(input.value, words);
    drafts.set(c.key, input.value);
    grow();
    ready();
    c.refused = tr('The question is gone — answered in Claude\'s own window, or Claude stopped waiting. What you typed is back in the field.');
  }
  function answeredHere(a, body) {
    const key = c.key;
    if (body?.answers) {
      const qs = Array.isArray(a.input?.questions) ? a.input.questions : [];
      const pairs = qs.filter((q) => body.answers[q.question] !== undefined).map((q) => {
        const v = body.answers[q.question];
        return { ...(q.header ? { h: q.header } : {}), q: q.question, a: Array.isArray(v) ? v.join(', ') : String(v) };
      });
      // `ask` — whose answer it is (dropped if it never reached Claude); `since` — the answered step to wait for is of
      const since = Date.parse(a.created_at) || Date.now();
      if (pairs.length) sentAnswers.set(key, [...(sentAnswers.get(key) || []), { pairs, at: Date.now(), ask: a.id, since }]);
    }
    fadeAsk(a.id);
    c.follow = true;
    if (c.data) paint();
  }
  // the answered form folds away; hidden once it has faded — a repaint meanwhile (the bubble) must not cut the fade short
  function fadeAsk(id) {
    if (c.askFading) return;
    const going = unfold(ask, false, ASK_FADE_MS);
    c.askFading = going ? { going } : null;
    const hide = () => { if (c.askId === id) { c.askLeft = id; ask.classList.add('hidden'); } going?.cancel(); };
    if (going) going.finished.then(hide, hide); else hide();
  }
  function answerLost(a, why) {
    for (const [k, list] of sentAnswers) {
      const left = list.filter((x) => x.ask !== a.id);
      if (left.length) sentAnswers.set(k, left); else sentAnswers.delete(k);
    }
    if (c.key !== a.key) return;
    c.refused = tr(why);
    if (c.data) paint();
  }
  const ASK_FADE_MS = 260;
  const ASK_GONE_MS = 3000; // the screen still shows an answered question a moment — not drawn again as a tail
  // the question Claude asks right now, answered from the chat: as a form when it came as data, else what its screen
  // shows of it and the terminal's keys
  function markMore() {
    const box = ask.querySelector(':scope > .ask');
    if (!box) return;
    const more = () => box.classList.toggle('more', box.scrollTop + box.clientHeight < box.scrollHeight - 4);
    box.onscroll = more;
    more();
  }
  function paintAsk(d) {
    notePlace();
    const a = d.session ? questionAsk(c.key, d.session) : null;
    if (a) {
      if (c.askId !== a.id) {
        c.askId = a.id;
        c.askLeft = null;
        c.askFading = null;
        ask.innerHTML = '';
        ask.classList.add('form');
        ask.append(askBlock(a, { onSent: (body) => answeredHere(a, body), onLost: (why) => answerLost(a, why) }));
        renderAsks();
        requestAnimationFrame(markMore);
      }
      // answered here: the form went, the request stays the chat's until the hook takes the answer
      ask.classList.toggle('hidden', c.askLeft === a.id);
      return;
    }
    if (c.askId) { dropAsk(); setTimeout(() => { c.v = null; refresh(); }, ASK_GONE_MS); if (c.askFading) return; } // the form fades out first
    const on = Boolean(d.send && d.state === 'question' && (d.question || d.choice)) && !(Date.now() - (c.askGone || 0) < ASK_GONE_MS);
    ask.classList.toggle('hidden', !on);
    if (!on) { keepTyped({ wait: Boolean(ask.querySelector('.ask-other')) }); ask.innerHTML = ''; c.choiceSig = null; return; }
    if (d.choice) { paintChoice(d.choice); return; }
    c.choiceSig = null;
    ask.classList.remove('form');
    ask.innerHTML = `<div class="chat-ask-h">${esc(tr('Claude asks'))}</div><pre class="chat-ask-scr">${esc(d.question)}</pre>`
      + `<div class="chat-ask-keys">${ASK_KEYS.map((k, i) => `<button type="button" class="btn-ghost term-key" data-k="${i}">${esc(k.label)}</button>`).join('')}</div>`;
    const scr = ask.querySelector('.chat-ask-scr');
    scr.scrollTop = scr.scrollHeight;
    ask.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = async () => {
        const k = ASK_KEYS[Number(b.dataset.k)];
        try { await api('POST', `/api/tasks/${seg(c.key)}/terminal`, k.key ? { key: k.key } : { text: k.text }, { quiet: true }); } catch (e) {
          note.textContent = refusalLine('Not sent', e, tr);
          note.classList.remove('hidden');
        }
        c.v = null;
        setTimeout(refresh, 500); // the screen answers a moment later
      };
    });
  }

  function paintChoice(ch) {
    const sig = JSON.stringify(ch);
    if (c.choiceSig === sig && ask.firstElementChild) return;
    c.choiceSig = sig;
    const typed = ask.querySelector('.ask-other')?.value || c.screenLeft || '';
    c.screenLeft = '';
    ask.classList.add('form');
    const tabs = ch.tabs.length ? `<div class="ask-q-head">${ch.tabs.map((t) => `<span class="ask-tab${t.done ? ' done' : ''}">${esc(t.label)}</span>`).join(' · ')}</div>` : '';
    const opts = ch.options.map((o) => (o.other
      ? `<div class="ask-opt ask-opt-other"><span>${esc(tr('Something else'))}:</span><textarea class="ask-other" rows="1" placeholder="${esc(tr('Your own answer'))}"></textarea>`
        + `<button type="button" class="btn-primary ask-other-go" data-n="${o.n}">${esc(tr('Answer'))}</button></div>`
      : `<button type="button" class="ask-opt ask-pick${o.checked ? ' on' : ''}" data-n="${o.n}">`
        + `<span class="ask-opt-n">${o.checked === undefined ? o.n : (o.checked ? '☑' : '☐')}</span>`
        + `<span class="ask-opt-b"><span class="ask-opt-l">${esc(plainLabel(o.label))}${plainLabel(o.label) !== o.label ? `<span class="ask-rec">${esc(tr('recommended'))}</span>` : ''}</span>`
        + `${o.note ? `<span class="ask-opt-desc">${esc(o.note)}</span>` : ''}</span></button>`)).join('');
    // the arrows the footer names: ← → between the tabs of several questions, ↑ ↓ ↵ Esc as in the terminal
    const keys = [...(ch.tabs.length ? [{ key: 'Left', label: '←' }, { key: 'Right', label: '→' }] : []), ...ASK_KEYS.filter((k) => k.key)];
    ask.innerHTML = `<div class="ask ask-screen"><div class="ask-head">${ic('bot', 13)}<span>${esc(tr('Claude asks'))}</span><span class="ask-meta">${esc(tr('in its terminal'))}</span></div>`
      + `<div class="ask-q">${tabs}${ch.text ? `<div class="ask-q-text">${esc(ch.text)}</div>` : ''}${opts}</div>`
      + `<div class="chat-ask-keys">${keys.map((k, i) => `<button type="button" class="btn-ghost term-key" data-k="${i}">${esc(k.label)}</button>`).join('')}</div></div>`;
    requestAnimationFrame(markMore);
    const other = ask.querySelector('.ask-other');
    if (other) { other.value = typed; other.oninput = () => { other.style.height = 'auto'; other.style.height = `${Math.min(other.scrollHeight, 160)}px`; }; }
    const press = async (body) => {
      try { await api('POST', `/api/tasks/${seg(c.key)}/terminal`, body, { quiet: true }); return true; } catch (e) {
        note.textContent = refusalLine('Not sent', e, tr);
        note.classList.remove('hidden');
        return false;
      }
    };
    const after = () => { c.v = null; setTimeout(refresh, 500); }; // the screen answers a moment later
    const answered = () => { if (other) other.value = ''; after(); }; // review: not «answered elsewhere» words to put back
    ask.querySelectorAll('.ask-pick').forEach((b) => {
      b.onclick = async () => { b.disabled = true; if (await press({ text: b.dataset.n })) answered(); else b.disabled = false; };
    });
    const go = ask.querySelector('.ask-other-go');
    if (go) {
      go.onclick = async () => {
        const text = other.value.trim();
        if (!text) { other.focus(); return; }
        go.disabled = true;
        // its number opens the field of one's own answer in the terminal; the words go into it, Enter sends them
        if (await press({ text: go.dataset.n })) {
          await new Promise((r) => { setTimeout(r, 400); });
          if (await press({ text, key: 'Enter' })) { other.value = ''; after(); return; }
        }
        go.disabled = false;
      };
    }
    ask.querySelectorAll('[data-k]').forEach((b) => {
      b.onclick = async () => { if (await press({ key: keys[Number(b.dataset.k)].key })) answered(); };
    });
  }

  async function load() {
    if (!c.key) return;
    const q = new URLSearchParams();
    if (c.asked) q.set('session', c.asked);
    if (c.turns !== TURNS_STEP) q.set('turns', String(c.turns));
    if (c.v) q.set('seen', c.v);
    const key = c.key;
    const asked = c.asked;
    let r;
    try { r = await api('GET', `/api/tasks/${seg(key)}/chat?${q}`, undefined, { quiet: true }); } catch (e) {
      if (key === c.key && mounted.has(c) && c.data && asked === c.asked && asked !== c.shownAsked) {
        c.asked = c.shownAsked;
        c.refused = refusalLine('Could not load the chat', e, tr);
        top.dataset.sig = ''; // the chip is drawn again for the session shown
        paint();
        return;
      }
      if (key === c.key && mounted.has(c) && !c.data) {
        log.innerHTML = `<div class="chat-empty muted">${esc(refusalLine('Could not load the chat', e, tr))}</div>`;
        clearTimeout(c.awayTimer);
        c.awayTimer = setTimeout(() => { c.v = null; refresh(); }, AWAY_LOOK_MS);
      }
      if (key === c.key && mounted.has(c) && c.data && workingLine(c.data)) { clearTimeout(c.helperTimer); c.helperTimer = setTimeout(refresh, LIT_LOOK_MS); }
      return;
    }
    if (key !== c.key || !mounted.has(c)) return; // another task meanwhile, or gone
    c.shownAsked = asked; // what the chat on screen was asked for: a pick that fails goes back to it
    if (r.same) {
      if (workingLine(c.data)) { clearTimeout(c.helperTimer); c.helperTimer = setTimeout(refresh, LIT_LOOK_MS); }
      return;
    }
    c.v = r.v || null;
    c.data = r;
    paint();
  }
  // one request at a time; a refresh asked meanwhile runs once after it
  function refresh() {
    if (!c.shown || document.hidden) { c.stale = true; return undefined; }
    c.stale = false;
    if (c.flight) { c.again = true; return c.flight; }
    c.flight = load().finally(() => {
      c.flight = null;
      if (c.again) { c.again = false; refresh(); }
    });
    return c.flight;
  }
  c.refresh = refresh;
  c.paintAsk = paintAsk;

  const images = () => draftImages.get(c.key) || [];
  function paintImages() {
    const list = c.data?.send ? images() : [];
    const sig = list.map((x) => `${x.uid}:${x.id || ''}:${x.url ? 1 : 0}`).join(',');
    if (imgsEl.dataset.sig === sig) return; // a live repaint of the chat leaves the thumbnails be
    imgsEl.dataset.sig = sig;
    // jumped it to the end
    const now = Date.now();
    const slide = (p) => {
      p.entered ??= now;
      const t = now - p.entered;
      return t < THUMB_IN_MS ? [' in', t ? ` style="animation-delay: -${t}ms"` : ''] : ['', ''];
    };
    imgsEl.innerHTML = list.map((p, i) => {
      const [inCls, delay] = slide(p);
      return `<span class="chat-thumb${p.id ? '' : ' loading'}${inCls}"${delay}${p.id ? '' : ` title="${esc(tr('uploading…'))}"`}>${p.url ? `<img src="${esc(p.url)}" alt="">` : ''}`
        + `<button type="button" data-i="${i}" title="${esc(tr('Remove from the message'))}" aria-label="${esc(tr('Remove from the message'))}">✕</button></span>`;
    }).join('');
    imgsEl.classList.toggle('hidden', !list.length);
    form.classList.toggle('has-imgs', list.length > 0);
    ready();
    // attachment of the card does: the file itself, not its small copy
    imgsEl.querySelectorAll('.chat-thumb').forEach((th, i) => { const img = th.querySelector('img'); if (img) img.onclick = () => openLightbox(list[i].full || list[i].url); });
    imgsEl.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = () => {
        const gone = images()[Number(b.dataset.i)];
        if (gone?.full) URL.revokeObjectURL(gone.full);
        const rest = images().filter((_, i) => i !== Number(b.dataset.i));
        if (rest.length) draftImages.set(c.key, rest); else draftImages.delete(c.key);
        paintImages();
        input.focus();
      };
    });
  }
  const list = (key) => draftImages.get(key) || [];
  async function addImages(files) {
    const key = c.key;
    for (const f of files) {
      if (list(key).length >= IMAGES_MAX) { note.textContent = tr('At most 10 pictures in one message'); note.classList.remove('hidden'); return; }
      // words without the picture (3 of 3 in Chromium), and the picture stayed for the next message
      const pic = { uid: ++thumbSeq, id: null, url: '', full: globalThis.URL?.createObjectURL ? URL.createObjectURL(f) : '' };
      pic.up = uploadAttachment(f, key).then((r) => {
        if (r?.id) pic.id = r.id; // the thumbnail stays — it is the same picture; a message sent meanwhile waits for it
        const rest = list(key);
        if (!rest.includes(pic)) return; // taken off the message, or sent with it, meanwhile
        if (!r?.id) { // refused: said by the upload
          const left = rest.filter((x) => x !== pic);
          if (left.length) draftImages.set(key, left); else draftImages.delete(key);
        }
        for (const o of mounted) if (o.key === key) o.paintImages();
      });
      draftImages.set(key, [...list(key), pic]);
      c.refused = '';
      paintImages();
      thumbOf(f).then((url) => { pic.url = url; for (const o of mounted) if (o.key === key) o.paintImages(); });
    }
  }
  c.paintImages = paintImages;
  c.input = input;
  c.grow = grow;
  // the chat takes a picture only while it can talk; else the card's own paste makes it an attachment, as before
  const pictures = (list) => [...(list || [])].filter((f) => f && f.type?.startsWith('image/'));
  input.addEventListener('paste', (e) => {
    const files = pictures([...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()));
    if (!files.length || !c.data?.send) return;
    e.preventDefault();
    e.stopPropagation(); // the card would take it as well (onDrawerPaste)
    addImages(files);
  });
  // WebKit does not name the type of a file while it is dragged: any file is let in, only pictures are taken on the drop —
  // a file dropped past a handler the browser would open in place of the board
  for (const el of [form, imgsEl]) {
    el.addEventListener('dragover', (e) => { if (c.data?.send && [...(e.dataTransfer?.items || [])].some((i) => i.kind === 'file')) e.preventDefault(); });
    el.addEventListener('drop', (e) => {
      if (!c.data?.send || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      e.stopPropagation();
      addImages(pictures(e.dataTransfer.files));
    });
  }
  form.querySelector('.chat-attach').onclick = () => picker.click();
  stopBtn.onclick = async () => {
    if (stopBtn.disabled || !c.key) return;
    stopBtn.disabled = true; // one click, one Esc: a second one is Claude Code's rewind
    try {
      await api('POST', `/api/tasks/${seg(c.key)}/chat/stop`, undefined, { quiet: true });
      c.refused = '';
    } catch (e) {
      c.refused = refusalLine('Not stopped', e, tr);
      note.textContent = c.refused;
      note.classList.remove('hidden');
    }
    setTimeout(() => { stopBtn.disabled = false; }, 1500);
    c.v = null;
    refresh();
  };
  picker.onchange = () => { const files = pictures(picker.files); picker.value = ''; addImages(files); };

  async function send({ now = false } = {}) {
    const text = input.value.trim();
    let pics = images();
    if ((!text && !pics.length) || !c.key || !c.data?.send) return;
    const key = c.key;
    const sent = { text, images_n: pics.length, seen: new Set(userWords(c.data).map((w) => w.key)), at: Date.now(), qid: null };
    sentWords.set(key, [...(sentWords.get(key) || []), sent]);
    flyAway(text);
    input.value = '';
    drafts.delete(key);
    draftImages.delete(key);
    paintImages();
    grow();
    ready();
    c.follow = true;
    paint();
    const back = () => {
      sentWords.set(key, (sentWords.get(key) || []).filter((w) => w !== sent));
      // the field of the task on the page now — this chat's, or a column's of the same task when the card went elsewhere
      const shown = c.key === key ? c : [...mounted].find((o) => o.key === key);
      const typed = (shown ? shown.input.value : drafts.get(key) || '').trim();
      const prev = backAt.get(key);
      const after = prev && prev.at < sent.at && typed.startsWith(prev.text);
      const head = after ? `${prev.text}\n${text}` : text;
      const words = [head, after ? typed.slice(prev.text.length).trim() : typed].filter(Boolean).join('\n');
      if (text) backAt.set(key, { at: after ? sent.at : Math.max(sent.at, prev?.at || 0), text: head });
      if (words) drafts.set(key, words); else drafts.delete(key);
      for (const o of mounted) if (o.key === key) { o.input.value = words; o.grow(); }
      if (pics.length && !(draftImages.get(key) || []).length) { draftImages.set(key, pics); for (const o of mounted) if (o.key === key) o.paintImages(); }
    };
    let r;
    try {
      await Promise.all(pics.map((p) => p.up));
      pics = pics.filter((p) => p.id);
      if (!text && !pics.length) { back(); return; } // the only picture was refused — said by the upload
      r = await api('POST', `/api/tasks/${seg(key)}/chat`, { text, ...(pics.length ? { images: pics.map((p) => p.id) } : {}), ...(now ? { now: true } : {}) }, { quiet: true });
    } catch (e) {
      back();
      if (key !== c.key) { refusedFor.set(key, refusalLine('Not sent', e, tr)); return; } // said when the person is back
      c.refused = refusalLine('Not sent', e, tr);
      note.textContent = c.refused;
      note.classList.remove('hidden');
      c.v = null;
      refresh(); // the bubble goes; a 409 asks for the chat anew as well
      return;
    }
    if (r?.queued) sent.qid = r.id; // the queue shows them now
    for (const p of pics) if (p.full) URL.revokeObjectURL?.(p.full);
    c.refused = '';
    c.v = null;
    c.follow = true;
    refresh();
    for (const o of mounted) if (o !== c && o.key === key) o.refresh();
  }
  async function queuedNow(id, btn) {
    btn.disabled = true;
    const key = c.key;
    const q = (c.data?.queue || []).find((x) => x.id === id);
    // the words the chat has now — the answer may come after the transcript already shows these ones
    const seen = new Set(userWords(c.data).map((w) => w.key));
    try {
      await api('POST', `/api/tasks/${seg(key)}/chat/queue/${seg(id)}/now`, undefined, { quiet: true });
      if (key !== c.key) return;
      c.refused = '';
      if (q) sentWords.set(key, [...(sentWords.get(key) || []), { text: q.text, images_n: q.images_n || 0, seen, at: Date.now(), qid: null }]);
    } catch (e) {
      if (key !== c.key) { refusedFor.set(key, refusalLine('Not sent', e, tr)); return; }
      c.refused = refusalLine('Not sent', e, tr);
      note.textContent = c.refused;
      note.classList.remove('hidden');
    }
    c.v = null;
    c.follow = true;
    refresh();
  }
  async function unqueue(id) {
    if (c.modelWant?.qid === id) { c.modelWant = c.modelWant.prev || null; paintTools(c.data); }
    try {
      await api('DELETE', `/api/tasks/${seg(c.key)}/chat/queue/${seg(id)}`, undefined, { quiet: true });
      c.refused = '';
    } catch (e) {
      if (e?.status !== 404) { c.refused = refusalLine('Not taken back', e, tr); say(c.refused); } else c.refused = '';
    }
    c.v = null;
    refresh();
  }
  input.onkeydown = (e) => {
    if (e.key === 'Escape') {
      input.blur();
      // goes on to the layer `col-full` (a menu of the chat above it is a layer too and closes first)
      if (!inCard && full?.on()) return;
      e.stopPropagation(); return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) { e.preventDefault(); send({ now: true }); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (matchKey(e, 'search') && (e.metaKey || e.ctrlKey)) return; // ⌘F opens the board's search from this field too
    e.stopPropagation(); // the board's keys (arrows, N, Backspace) are not for the field
  };
  input.oninput = () => { grow(); c.refused = ''; if (input.value) drafts.set(c.key, input.value); else drafts.delete(c.key); ready(); };
  form.querySelector('.chat-send').onclick = send;

  const still = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  // the send button wakes up (the accent) once there is something to send
  function ready() { sendBtn?.classList.toggle('ready', Boolean(input.value.trim() || images().length)); }

  function shownModel(d) {
    const want = c.modelWant;
    if (want && (sameModel(d?.model, want.id) || Date.now() - want.at > MODEL_WAIT_MS)) c.modelWant = null;
    return c.modelWant?.id || d?.model || null;
  }
  // a new name rolls in: the old one goes up and fades, the new comes from below (the owner's reference)
  // the name it goes to is kept apart from the one still shown: a change back mid-roll must not be taken for no change
  function rollLabel(el, text) {
    if (!el || (el.dataset.to ?? el.textContent) === text) return;
    el.dataset.to = text;
    const was = el.textContent;
    if (!was || !el.animate || still()) { el.textContent = text; return; }
    const t = { duration: 140, easing: 'cubic-bezier(.4, 0, .2, 1)' };
    const land = () => { el.textContent = el.dataset.to; };
    el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(-70%)', opacity: 0 }], t).finished.then(() => {
      land();
      el.animate([{ transform: 'translateY(70%)', opacity: 0 }, { transform: 'none', opacity: 1 }], { ...t, duration: 180 });
    }, land);
  }
  function paintTools(d) {
    const label = modelLabel(shownModel(d));
    if (modelBtn) {
      modelBtn.classList.toggle('hidden', !label);
      rollLabel(modelBtn.querySelector('.chat-model-l'), label);
    }
    if (fullBtn) {
      const on = isFull();
      if (fullBtn.dataset.full !== String(on)) {
        fullBtn.dataset.full = String(on);
        fullBtn.innerHTML = ic(on ? 'shrink' : 'expand', 15);
        fullBtn.title = tr(fullWords(on));
        fullBtn.setAttribute?.('aria-label', fullBtn.title);
      }
    }
    termBtn?.classList.toggle('hidden', !d.send); // only the board's own Claude has a terminal to show
    ready();
  }
  const onFull = () => { if (c.data) paintTools(c.data); };
  const FULL_EVENT = inCard ? 'kb:drawer-full' : 'kb:column-full';
  document.addEventListener?.(FULL_EVENT, onFull);

  /* The menu over the field: ⋯ (the chat's and its Claude's actions), the model, the skills. It comes up from the
     button and fades out; Esc and a click past it close it. */
  let menuFor = null;
  const outside = (e) => { if (!menu?.contains(e.target) && !(menuFor && menuFor.contains(e.target))) closeMenu(); };
  function closeMenu(now = false) {
    if (!menu || menu.classList.contains('hidden')) return;
    menuFor?.setAttribute('aria-expanded', 'false');
    menuFor = null;
    popLayer(menu);
    document.removeEventListener('pointerdown', outside, true);
    const hide = () => { if (!menuFor) menu.classList.add('hidden'); };
    if (now || !menu.animate || still()) { hide(); return; }
    menu.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(4px)' }], { duration: 120, easing: 'ease-in' }).finished.then(hide, hide);
  }
  function openMenu(html, anchor) {
    if (!menu) return;
    const again = menuFor === anchor && !menu.classList.contains('hidden');
    menuFor?.setAttribute('aria-expanded', 'false');
    menu.innerHTML = html;
    menu.classList.remove('hidden');
    menuFor = anchor;
    anchor.setAttribute('aria-expanded', 'true');
    // over the button that opened it, kept inside the field's width
    const f = form.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(a.left - f.left, f.width - menu.offsetWidth))}px`;
    if (!again && menu.animate && !still()) {
      menu.animate([{ opacity: 0, transform: 'translateY(6px) scale(.98)' }, { opacity: 1, transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2, .7, .2, 1)' });
    }
    pushLayer(menu, () => closeMenu());
    document.addEventListener('pointerdown', outside, true);
    menu.querySelectorAll('[data-act]').forEach((b) => { b.onclick = () => act(b.dataset.act, b.dataset.v); });
  }
  const item = (act, icon, label, { v = '', hint = '', sub = false, on = false } = {}) => `<button type="button" class="chat-mi${on ? ' on' : ''}" role="menuitem" data-act="${act}" data-v="${esc(v)}">`
    + `${icon ? ic(icon, 14) : '<span class="chat-mi-ic"></span>'}<span class="chat-mi-l">${esc(tr(label))}</span>`
    + `${hint ? `<span class="chat-mi-h">${esc(hint)}</span>` : ''}${on ? `<span class="chat-mi-on">${ic('check', 12)}</span>` : ''}${sub ? `<span class="chat-mi-sub">${ic('chevron', 11)}</span>` : ''}</button>`;
  const head = (label) => `<div class="chat-mh">${esc(tr(label))}</div>`;
  const back = (label) => `<button type="button" class="chat-mi chat-mi-back" data-act="more">${ic('chevron', 11)}<span class="chat-mi-l">${esc(tr(label))}</span></button>`;
  function moreHTML() {
    const d = c.data || {};
    const on = isFull();
    let out = head('Chat');
    if (d.send) out += item('view', 'terminal', 'The terminal instead of the chat');
    out += item('full', on ? 'shrink' : 'expand', fullWords(on));
    out += item('copy', 'copy', 'Copy the conversation');
    out += item('reload', 'sort', 'Read the chat again');
    if (d.send) {
      out += `<div class="chat-msep"></div>${head('Claude')}`;
      out += item('models', 'bot', 'Model', { hint: modelLabel(shownModel(d)), sub: true });
      out += item('skills', 'bolt', 'Skills', { sub: true });
      out += item('compact', 'doc', 'Compact the conversation', { hint: '/compact' });
      if (d.state === 'busy') out += item('stop', 'stop', 'Stop Claude');
    }
    return out;
  }
  function modelsHTML(withBack) {
    const now = shownModel(c.data);
    return (withBack ? back('Model') : head('Model'))
      + MODELS.map((m) => item('model', '', m.label, { v: m.id, hint: m.cost, on: sameModel(now, m.id) })).join('');
  }
  let skills = null; // the board's skills, read once a page
  async function skillsHTML() {
    let failed = null;
    if (!skills) {
      try { skills = ((await api('GET', '/api/skills', undefined, { quiet: true }))?.items || []).filter((x) => x.exists !== false).map((x) => x.name); } catch (e) { failed = e; }
    }
    if (failed) return back('Skills') + `<div class="chat-mh">${esc(refusalLine('Could not read the skills', failed, tr))}</div>`;
    if (!skills?.length) return back('Skills') + `<div class="chat-mh">${esc(tr('No skills found'))}</div>`;
    return back('Skills') + skills.map((n) => item('skill', '', `/${n}`, { v: n })).join('');
  }
  const say = (text) => { note.textContent = text; note.classList.toggle('hidden', !text); };
  // a command typed into the board's Claude as one would by hand — not a message: no bubble waits for it
  async function command(text) {
    let r;
    try { r = await api('POST', `/api/tasks/${seg(c.key)}/chat`, { text }, { quiet: true }); } catch (e) {
      c.refused = refusalLine('Not sent', e, tr);
      say(c.refused);
      return false;
    }
    if (c.refused) { c.refused = ''; if (c.data) paint(); }
    return r || {};
  }
  async function act(what, v) {
    if (what === 'more') { openMenu(moreHTML(), moreBtn); return; }
    if (what === 'models') { openMenu(modelsHTML(true), moreBtn); return; }
    if (what === 'skills') {
      const anchor = menuFor;
      const html = await skillsHTML();
      if (menuFor === anchor && anchor) openMenu(html, anchor); // closed while the skills were read: it stays closed
      return;
    }
    closeMenu();
    if (what === 'view') setClaudeView('terminal');
    else if (what === 'full') {
      if (inCard) setDrawerFull(!drawerIsFull());
      else if (full) { full.set(!full.on()); if (full.on() && !form.classList.contains('hidden')) input.focus(); }
      else if (c.key) openDrawerFull(c.key);
    } else if (what === 'copy') {
      const ok = await copyText(conversationText(c.data));
      say(tr(ok === false ? 'Could not copy' : 'The conversation is copied'));
      setTimeout(() => { if (note.textContent === tr('The conversation is copied')) say(''); }, 2500);
    } else if (what === 'reload') { c.v = null; refresh(); }
    else if (what === 'model') {
      if (!v || sameModel(shownModel(c.data), v)) return;
      const was = c.modelWant;
      c.modelWant = { id: v, at: Date.now(), prev: was?.id ? { ...was, prev: null } : null }; // ✕ on a queued pick goes back to it
      paintTools(c.data);
      const r = await command(`/model ${v}`);
      if (!r) { c.modelWant = was; paintTools(c.data); } else if (r.queued && c.modelWant?.id === v) c.modelWant.qid = r.id; // waits in the queue
    } else if (what === 'skill') {
      input.value = `/${v} ${input.value.replace(/^\/\S*\s*/, '')}`;
      drafts.set(c.key, input.value);
      grow();
      ready();
      input.focus();
    } else if (what === 'compact') {
      if (await styledConfirm(tr('Compact the conversation? Claude retells it to itself in short and goes on from the retelling — what it read word for word is gone.'), { okLabel: tr('Compact') })) command('/compact');
    } else if (what === 'stop') stopBtn.onclick();
  }
  if (moreBtn) moreBtn.onclick = () => (menuFor === moreBtn ? closeMenu() : openMenu(moreHTML(), moreBtn));
  if (modelBtn) modelBtn.onclick = () => { if (!c.data?.send) return; if (menuFor === modelBtn) closeMenu(); else openMenu(modelsHTML(false), modelBtn); };
  if (fullBtn) fullBtn.onclick = () => act('full');
  if (termBtn) termBtn.onclick = () => act('view');

  function flyAway(text) {
    if (!text || !input.animate || still() || !input.getClientRects().length) return;
    const r = input.getBoundingClientRect();
    const cs = getComputedStyle(input);
    const g = document.createElement('div');
    g.className = 'chat-fly';
    g.textContent = text;
    Object.assign(g.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, maxHeight: `${r.height}px`, padding: cs.padding, font: cs.font, lineHeight: cs.lineHeight });
    document.body.append(g);
    const shots = imgsEl.classList.contains('hidden') ? null : imgsEl.cloneNode(true);
    if (shots) {
      const ir = imgsEl.getBoundingClientRect();
      shots.classList.add('chat-fly-imgs');
      Object.assign(shots.style, { left: `${ir.left}px`, top: `${ir.top}px`, width: `${ir.width}px`, height: `${ir.height}px` });
      document.body.append(shots);
    }
    for (const el of [g, shots].filter(Boolean)) {
      const a = el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(-44px)' }], { duration: 340, easing: 'cubic-bezier(.3, .7, .3, 1)', fill: 'forwards' });
      a.finished.then(() => el.remove(), () => el.remove());
    }
  }

  c.setKey = (k, s = null) => {
    if (k === c.key && s === c.asked) return;
    // the switch, it went into the field of the next task, ready to be sent to another Claude
    if (k !== c.key) keepTyped(); // into this task's field and draft, before the field is the next task's
    // a refusal not read yet waits for its task, not for this chat — it was kept under the NEW key and shown in its chat
    if (c.refused && c.key && k !== c.key) refusedFor.set(c.key, c.refused);
    c.key = k; c.asked = s; c.v = null; c.data = null; c.turns = TURNS_STEP; c.opened = new Set(); c.follow = true;
    c.refused = refusedFor.get(k) || '';
    refusedFor.delete(k);
    input.value = drafts.get(k) || '';
    grow();
    paint();
    paintImages();
    refresh();
  };
  c.show = (on) => {
    const was = c.shown;
    c.shown = on;
    if (on) grow();
    if (on && (c.stale || !c.data)) refresh();
    if (was !== on && c.askId) renderAsks();
  };
  c.destroy = () => { closeMenu(true); document.removeEventListener?.(FULL_EVENT, onFull); mounted.delete(c); sizes?.disconnect(); sc.removeEventListener('scroll', onScroll); document.removeEventListener?.('scroll', onSectionScroll, true); askWatch?.disconnect(); if (c.askId) { c.askId = null; renderAsks(); } clearTimeout(c.awayTimer); clearTimeout(c.helperTimer); clearTimeout(c.sentTimer); box.innerHTML = ''; };
  mounted.add(c);
  input.value = drafts.get(key) || '';
  paint();
  refresh();
  return c;
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  for (const c of mounted) if (c.stale) c.refresh();
});
