// Claude. A leaf — no imports, no DOM — so test/call-rules.test.js runs it in node. The owner: «a notification like a
// call that has to be taken», «talk in a living way, no long sentences, easy to follow», «everything on the Mac».

/** What a call can be about: a task handed in (review), one waiting for the word to ship (ready), Claude at its prompt
    waiting for the person (waiting), a question on the screen of its terminal (question), a request to the board — a
    permission, a question, a plan (ask). */
export const CALL_WHYS = new Set(['review', 'ready', 'waiting', 'question', 'ask']);

/** The longest the board reads at once: a few short sentences, a call is no place for a report. */
export const SAY_SENTENCES = 3;
export const SAY_CHARS = 320;

/* The words of a call, both languages side by side: commands, yes and no, the numbers of options, what goes to
   Claude. The only place with Russian in this file. */
const WORDS = {
  fold: [['ё', 'е']],
  hangup: ['отбой', 'положи трубку', 'клади трубку', 'до свидания', 'пока', 'всё пока', 'все пока', 'спасибо пока', 'hang up', 'bye', 'goodbye', 'end the call'],
  later: ['потом', 'позже', 'отложи', 'отложить', 'не сейчас', 'пропусти', 'дальше', 'следующая', 'later', 'not now', 'skip', 'next'],
  accept: ['принять', 'принимаю', 'прими', 'принято', 'приму', 'принимай', 'accept', 'accept it', 'accepted'],
  yes: ['да', 'ага', 'угу', 'давай', 'можно', 'разрешаю', 'разреши', 'разрешить', 'конечно', 'ок', 'окей', 'хорошо', 'согласен', 'одобряю', 'одобрить', 'одобрено', 'yes', 'yeah', 'yep', 'ok', 'okay', 'sure', 'allow', 'approve', 'go ahead'],
  no: ['нет', 'не надо', 'нельзя', 'не разрешаю', 'запрещаю', 'запретить', 'отказ', 'отклонить', 'отклоняю', 'не одобряю', 'no', 'nope', 'deny', "don't", 'do not', 'reject'],
  yesStart: /^(?:да|yes)(?:\s|$)/, // \b knows only Latin letters
  noStart: /^(?:нет|no)(?:\s|$)/,
  recommended: /\((?:recommended|рекомендую)\)/i,
  ordinals: [
    ['1', 'один', 'одна', 'первый', 'первое', 'первая', 'первую', 'first', 'one'],
    ['2', 'два', 'две', 'второй', 'второе', 'вторая', 'вторую', 'second', 'two'],
    ['3', 'три', 'третий', 'третье', 'третья', 'третью', 'third', 'three'],
    ['4', 'четыре', 'четвертый', 'четвертое', 'четвертая', 'четвертую', 'fourth', 'four'],
    ['5', 'пять', 'пятый', 'пятое', 'пятая', 'пятую', 'fifth', 'five'],
    ['6', 'шесть', 'шестой', 'шестое', 'шестая', 'sixth', 'six'],
  ],
  spoken: {
    ru: ['Первый', 'Второй', 'Третий', 'Четвёртый', 'Пятый', 'Шестой'],
    en: ['One', 'Two', 'Three', 'Four', 'Five', 'Six'],
  },
  howToAnswer: {
    ru: 'Голосовой звонок с доски. Отвечай вслух и по-живому: одна-две короткие простые фразы, без кода, путей, ссылок и списков. Нужно решение — спроси одним коротким вопросом.',
    en: 'A voice call from the board. Answer out loud, like talking: one or two short plain sentences, no code, paths, links or lists. Need a decision — ask one short question.',
  },
};

/** Words of Claude turned into something to say aloud: no code, no links, no paths, no Markdown — the first few
    sentences of what is left. '' when nothing sayable is left. */
export function speakable(text, { sentences = SAY_SENTENCES, chars = SAY_CHARS } = {}) {
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' '); // blocks of code, a cut-off one too
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' '); // pictures
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'); // a link says its words
  s = s.replace(/https?:\/\/\S+/g, ' ');
  // code in a line: a path says its file's name, a short word itself, anything longer nothing
  s = s.replace(/`([^`\n]*)`/g, (m, inner) => (/[/\\]/.test(inner) ? ` ${inner.split(/[/\\]/).filter(Boolean).pop() || ''} ` : inner.length <= 24 ? inner : ' '));
  s = s.replace(/(?:~|\.{1,2})?(?:\/[\w.@-]+){2,}\/?/g, (p) => p.split('/').filter(Boolean).pop() || ' '); // a path — its last name
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' '); // tables
  s = s.replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/gm, ''); // heads, quotes, list marks
  s = s.replace(/^\s*[-*_]{3,}\s*$/gm, ' ');
  s = s.replace(/(\*\*|__|\*|_|~~)(?=\S)([^\n]*?\S)\1/g, '$2'); // emphasis
  s = s.replace(/[*#|<>`]+/g, ' ');
  // a line without an end of its own is a sentence of its own (a list item, a head)
  s = s.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?…:;]$/.test(l) ? l : `${l}.`)).join(' ');
  s = s.replace(/\s+/g, ' ').replace(/\s+([.,!?…:;])/g, '$1').trim();
  if (!s) return '';
  // a sentence ends at its mark before a space — «chat.js» and «2.5» are not two sentences
  const parts = s.match(/\S.*?(?:[.!?…]+(?=\s|$)|$)/g) || [s];
  let out = '';
  let taken = 0;
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    if (out && (taken >= sentences || out.length + p.length + 1 > chars)) break;
    out = out ? `${out} ${p}` : p;
    taken += 1;
  }
  if (taken > 1 && taken < parts.length) out = out.replace(/\s+\S{1,4}[.!?…]+$/u, (m) => (/^\s+\p{Lu}\p{Ll}{0,2}\.$|^\s+\p{Ll}{1,3}\.$/u.test(m) ? '' : m));
  if (out.length > chars) out = `${out.slice(0, chars).replace(/\s+\S*$/, '')}…`;
  return out;
}

export function plain(text) {
  let s = String(text ?? '').toLowerCase();
  for (const [a, b] of WORDS.fold) s = s.split(a).join(b);
  return s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const words = (s) => (s ? s.split(' ') : []);
const { hangup: HANGUP, later: LATER, accept: ACCEPT, yes: YES, no: NO, ordinals: ORDINALS } = WORDS;

// a command is a short utterance — the same word inside a long one is words for Claude («accept it, but first fix X»)
const COMMAND_WORDS_MAX = 4;

function says(said, list) {
  const w = words(said);
  if (!w.length || w.length > COMMAND_WORDS_MAX) return false;
  return list.some((p) => said === p || said.startsWith(`${p} `) || said.endsWith(` ${p}`) || said.includes(` ${p} `));
}

/** What the person meant, for a call about `why`: {act: 'hangup' | 'later' | 'accept' | 'say', words}. `accept` only
    for a task handed in — elsewhere the word is words for Claude. Anything not a short command is words for Claude. */
export function intentOf(text, why) {
  const said = plain(text);
  if (!said) return { act: 'none', words: '' };
  if (says(said, HANGUP)) return { act: 'hangup', words: '' };
  if (says(said, LATER)) return { act: 'later', words: '' };
  if (why === 'review' && says(said, ACCEPT) && !says(said, NO)) return { act: 'accept', words: '' };
  return { act: 'say', words: String(text).trim() };
}

export function yesNo(text) {
  const said = plain(text);
  if (!said) return null;
  if (says(said, NO)) return false;
  if (says(said, YES)) return true;
  return null;
}

export function pickOption(text, labels) {
  const said = plain(text);
  const list = (labels || []).map((l) => plain(String(l ?? '').replace(WORDS.recommended, '')));
  if (!said || !list.length) return -1;
  const w = words(said);
  if (w.length <= COMMAND_WORDS_MAX) {
    for (let i = 0; i < Math.min(ORDINALS.length, list.length); i += 1) if (ORDINALS[i].some((x) => w.includes(x))) return i;
  }
  const exact = list.findIndex((l) => l && (said === l || said.includes(l)));
  if (exact >= 0) return exact;
  // at least half the label's words said, and more of them than of any other label (a tie is no pick)
  const scores = list.map((l) => {
    const lw = words(l).filter((x) => x.length > 2);
    return lw.length ? lw.filter((x) => w.includes(x)).length / lw.length : 0;
  });
  const top = Math.max(...scores);
  if (top >= 0.5 && scores.filter((x) => x === top).length === 1) return scores.indexOf(top);
  const yn = yesNo(said);
  if (yn !== null) {
    const i = list.findIndex((l) => (yn ? WORDS.yesStart : WORDS.noStart).test(l));
    if (i >= 0) return i;
  }
  return -1;
}

/** The words that go to Claude in a call: what the person said, with how to answer — out loud, short, plain. */
export function callWords(said, lang) {
  return `[${(WORDS.howToAnswer[lang] || WORDS.howToAnswer.en)}] ${String(said ?? '').trim()}`;
}

/** How the board names the n-th option aloud (0 — the first), in the board's language. */
export const spokenOrdinal = (i, lang) => (WORDS.spoken[lang] || WORDS.spoken.en)[i] || String(i + 1);

/** Claude's answer to words sent at `sentAt` (ms), out of GET /api/tasks/:id/chat: {kind: 'question', choice} — it asks
    on its screen; {kind: 'wait'} — still at it, or the words not taken yet; {kind: 'text', text} — the last words of
    the turn; {kind: 'none'} — the turn ended with nothing said. `slackMs` — clocks of the page and the board. */
export function replyOf(chat, sentAt, slackMs = 5000) {
  if (!chat || chat.same) return { kind: 'wait' };
  if (chat.state === 'question' && chat.choice?.options?.length) return { kind: 'question', choice: chat.choice };
  const turns = (chat.turns || []).filter((t) => Number(t.at) >= sentAt - slackMs);
  const turn = turns.at(-1);
  if (!turn) return { kind: 'wait' };
  if (turn.open || chat.working || chat.state === 'busy' || (chat.queue || []).length) return { kind: 'wait' };
  const last = (turn.items || []).findLast((it) => it.kind === 'text' && String(it.text || '').trim());
  return last ? { kind: 'text', text: last.text } : { kind: 'none' };
}

/** The last words of Claude in a chat (any turn) — what a call about a Claude waiting for the person reads. */
export function lastWords(chat) {
  for (const t of [...(chat?.turns || [])].reverse()) {
    const last = (t.items || []).findLast((it) => it.kind === 'text' && String(it.text || '').trim());
    if (last) return last.text;
  }
  return '';
}

/** The last report of Claude on a task (the list of GET /api/tasks/:id/comments, oldest first): its newest comment by
    claude, '' if none. */
export function lastReport(comments) {
  const mine = (Array.isArray(comments) ? comments : []).filter((c) => c && c.author === 'claude' && String(c.body || '').trim());
  return mine.length ? mine.at(-1).body : '';
}

/** What an event of the board's stream calls about: [{id, key, project, title, why}]. `memory` — what the call saw of
    the stream before ({claude: Map id → state, questions: Set of ids, seen}), updated here. The rules are the sound's
    (sse.js): a real move into Review or Ready (by `prev_status`); a Claude that stopped working to wait for the person
    (not at the limit, not a broken answer — nothing to talk over there — and not in Ready: the move there rang); a
    question that came up on a terminal; a request to the board. The first picture of Claude's states calls about
    nothing: it was so before the page looked. */
export function callsOf(ev, memory) {
  const d = ev?.data || {};
  if (ev?.type === 'task.updated') {
    const moved = (d.status === 'review' || d.status === 'ready') && d.prev_status && d.prev_status !== d.status;
    return moved ? [{ id: d.id, key: d.key, project: d.project, title: d.title || '', why: d.status }] : [];
  }
  if (ev?.type === 'ask.created') return d.task_id && d.key ? [{ id: d.task_id, key: d.key, project: d.project, title: d.title || '', why: 'ask' }] : [];
  if (ev?.type !== 'task.live') return [];
  const out = [];
  const now = new Map();
  for (const t of Array.isArray(d.tasks) ? d.tasks : []) {
    if (!t || t.id === undefined) continue;
    now.set(String(t.id), t.claude);
    const was = memory.claude.get(String(t.id));
    if (memory.seen && (was === 'busy' || was === 'background') && (t.claude === 'waiting' || t.claude === 'idle')
      && !t.broke && t.status !== 'ready' && t.key) out.push({ id: t.id, key: t.key, project: t.project, title: t.title || '', why: 'waiting' });
  }
  memory.claude = now;
  const qs = Array.isArray(d.questions) ? d.questions : [];
  for (const q of qs) {
    if (memory.seen && q?.key && !memory.questions.has(String(q.id))) out.push({ id: q.id, key: q.key, project: q.project, title: q.title || '', why: 'question' });
  }
  memory.questions = new Set(qs.map((q) => String(q?.id)));
  memory.seen = true;
  return out;
}

/** A fresh memory for `callsOf`. */
export const callMemory = () => ({ claude: new Map(), questions: new Set(), seen: false });

/** A call waiting in line: one a task. A newer reason replaces the older one of the same task (the newest news). */
export function lineUp(line, item) {
  if (!item || !CALL_WHYS.has(item.why) || !item.key) return line;
  const rest = line.filter((x) => String(x.id) !== String(item.id));
  return [...rest, item];
}
