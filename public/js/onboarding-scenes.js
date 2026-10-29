import { ALL_STATUSES, esc, ic, tr } from './core.js';
import { scanReady } from './onboarding-rules.js';

const STATUS = Object.fromEntries(ALL_STATUSES);

/** A part that comes in after `d` ms. */
const a = (html, d, cls = '') => `<div class="onb-a${cls ? ` ${cls}` : ''}" style="--d:${d}ms">${html}</div>`;
const dot = (st) => `<span class="dot s-${st}"></span>`;
/** A window of the picture: a title bar and a body. */
const win = (title, body, { cls = '', d = 0, right = '' } = {}) => `<div class="onb-win onb-a${cls ? ` ${cls}` : ''}" style="--d:${d}ms">`
  + `<div class="onb-win-h"><span class="onb-lights"><i></i><i></i><i></i></span><span class="onb-win-t">${title}</span>${right}</div>`
  + `<div class="onb-win-b">${body}</div></div>`;
const caption = (text, d = 0) => `<div class="onb-cap onb-a" style="--d:${d}ms">${esc(text)}</div>`;

// the example tasks of every picture: one project, the same card going through it
const TASK = 'Fix the flaky refresh test';
const KEY = 'MA-3';
const OTHERS = ['Label the yearly toggle', 'Write release notes', 'Move tokens to CSS variables'];

/** Welcome, first item: ▶ sends a card to Claude, and the card walks To do → Doing → Review by itself. */
export function sceneTake() {
  const col = (st, n, cards = '') => `<div class="onb-mcol"><div class="onb-mcol-h">${dot(st)}${esc(STATUS[st])}<span class="onb-n">${n}</span></div>${cards}</div>`;
  const card = (t) => `<div class="onb-mcard">${esc(tr(t))}</div>`;
  const mover = `<div class="onb-mover"><div class="onb-mcard onb-mcard-hot"><span class="onb-key">${KEY}</span> ${esc(tr(TASK))}`
    + '<div class="onb-mstate">'
    + `<span class="onb-st1">${ic('play', 11)} ${esc(tr('sent to Claude'))}</span>`
    + `<span class="onb-st2">${dot('doing')} ${esc(tr('Claude is working'))}</span>`
    + `<span class="onb-st3">${dot('review')} ${esc(tr('ready for your check'))}</span>`
    + '</div></div></div>';
  return win('<b>my-app</b>', `<div class="onb-mboard">${mover}`
    + col('todo', 3, `<div class="onb-mslot"></div>${card(OTHERS[0])}${card(OTHERS[1])}`)
    + col('doing', 0) + col('review', 0) + '</div>', { cls: 'onb-win-wide' })
    + caption(tr('Claude moves the card itself — kb take, kb mv, kb review.'), 400);
}

const askForm = (d) => a(`<div class="onb-q-h">${dot('todo')}${esc(tr('Claude asks'))}</div>`
  + `<div class="onb-q-t">${esc(tr('Keep the global fixtures, or inline them?'))}</div>`
  + `<div class="onb-q-opt on"><i></i>${esc(tr('Keep global'))}<span class="onb-rec">${esc(tr('recommended'))}</span></div>`
  + `<div class="onb-q-opt"><i></i>${esc(tr('Inline them'))}</div>`, d, 'onb-q');

/** Welcome, second item, and what ▶ inside the board does: the card's Claude — its chat (the person's words, what Claude
    says, its steps folded, a question as a form) or, with `view` 'terminal', its terminal and the same question. */
export function sceneWatch({ d0 = 0, view = 'chat' } = {}) {
  if (view === 'chat') {
    const chat = a(`<div class="onb-chat-me">${KEY} ${esc(tr(TASK))}</div>`, d0 + 250)
      + a(esc(tr('Looking at the refresh test.')), d0 + 700, 'onb-chat-cl')
      + a(`${esc(tr('Ran 3 commands'))} ${ic('chevron', 10)}`, d0 + 1100, 'onb-chat-fold')
      + a(esc(tr('The refresh does not wait for the lock.')), d0 + 1500, 'onb-chat-cl');
    return win(`${dot('doing')}<b>${KEY}</b> ${esc(tr(TASK))}`,
      `<div class="onb-tabs"><span>${esc(tr('Comments'))}</span><span class="on">${ic('chat', 12)} ${esc(tr('Chat'))}</span></div>`
      + `<div class="onb-chat">${chat}</div>${askForm(d0 + 2000)}`, { d: d0 });
  }
  const lines = [
    ['$ claude', 'onb-t-cmd'],
    [`> ${KEY} ${TASK}`, 'onb-t-in'],
    ['● Read src/auth/refresh.ts', ''],
    ['● Update src/auth/refresh.ts  +12 −4', ''],
    ['● Bash npm test  17 passed', ''],
  ];
  const term = lines.map(([t, c], i) => a(esc(t), d0 + 250 + i * 450, `onb-t-line ${c}`)).join('');
  return win(`${dot('doing')}<b>${KEY}</b> ${esc(tr(TASK))}`,
    `<div class="onb-tabs"><span>${esc(tr('Comments'))}</span><span class="on">${ic('terminal', 12)} ${esc(tr('Terminal'))}</span></div>`
    + `<div class="onb-term">${term}</div>${askForm(d0 + 250 + lines.length * 450 + 350)}`, { d: d0 });
}

export function sceneNow() {
  const col = (head, key, title, body, d) => a(`<div class="onb-ncol-h">${head}</div><div class="onb-ncol-t"><span class="onb-key">${key}</span> ${esc(tr(title))}</div>${body}`, d, 'onb-ncol');
  const one = col(`${dot('doing')}${esc(tr('Working'))}`, KEY, TASK,
    `<div class="onb-chat-me">${esc(tr('Run the whole suite'))}</div><div class="onb-chat-cl">${esc(tr('Running the tests…'))}</div>`, 200);
  const two = col(`<span class="onb-off"></span>${esc(tr('Session interrupted'))}`, 'SITE-7', 'Dark theme for the site',
    `<div class="onb-chat-cl">${esc(tr('Moving the colours to variables.'))}</div>`
    + a(`<span class="onb-btn onb-btn-main onb-press">${esc(tr('Continue'))}</span>`, 1300, 'onb-btns'), 500);
  return win(`${ic('bot', 12)} <b>${esc(tr('Claude now'))}</b> · ${esc(tr('Terminals'))}`, `<div class="onb-ncols">${one}${two}</div>`, { cls: 'onb-win-wide' })
    + caption(tr('Every Claude at work side by side — an interrupted one goes on with Continue.'), 700);
}

/** Welcome, third item: the card in Review — Claude's checklist and report, the person's two buttons, then Done. */
export function sceneAccept() {
  const checks = ['Find why the test fails now and then', 'Make the refresh wait for the lock', 'Run the whole suite']
    .map((t, i) => a('<span class="onb-check">✓</span>' + `${esc(tr(t))}`, 300 + i * 300, 'onb-cl')).join('');
  return win(`${dot('review')}<b>${KEY}</b> ${esc(tr(TASK))}`,
    checks
    + a(`<span class="onb-who">${ic('bot', 12)} Claude</span>${esc(tr('The refresh did not wait for the lock. Now it waits, and all 17 tests pass.'))}`, 1400, 'onb-note')
    + a(`<span class="onb-btn onb-btn-main onb-press">${esc(tr('Accept'))}</span><span class="onb-btn">${esc(tr('Send back'))}</span>`, 2000, 'onb-btns')
    + a(`${dot('done')}${esc(tr('Done — accepted by you'))}`, 3100, 'onb-final'))
    + caption(tr('Claude stops at Review; Done and Cancelled are only yours.'), 600);
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (t) => `${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
/** Step Claude, the first tab: the board looks at this computer. `lines` — null while GET /api/claude has not answered,
    [] when it failed: then the picture says the check did not happen and shows no marks. */
export function sceneScan(lines, now = new Date()) {
  const t = (ms) => `<span class="onb-time">[${clock(new Date(now.getTime() + ms))}]</span>`;
  const mark = { ok: ic('check', 11), no: '–', warn: '!' };
  const step = 380;
  let body = a(`${t(0)}${esc(tr('Starting the check…'))}`, 100, 'onb-log');
  if (lines && !lines.length) {
    return win(`<b>${esc(tr('This computer'))}</b>`, `<div class="onb-scan-h">${esc(tr('Looking for Claude Code'))}</div>${body}`
      + a(`<span class="onb-log-t">${esc(tr('The board could not check this computer — see Settings → Claude Code.'))}</span>`, 400, 'onb-log onb-log-dim'), { cls: 'onb-win-scan' });
  }
  if (lines) {
    body += lines.map((l, i) => a(`${t(300 + i * step)}<span class="onb-log-t">${esc(l.text)}</span><span class="onb-mark onb-mark-${l.mark}">${mark[l.mark]}</span>`, 400 + i * step, `onb-log${l.mark === 'ok' ? '' : ' onb-log-dim'}`)).join('');
    body += a(`${t(400 + lines.length * step)}<span class="onb-log-done">${esc(tr('Check complete.'))}</span>`, 500 + lines.length * step, 'onb-log');
  }
  const found = lines ? lines.filter((l) => l.mark === 'ok').length : 0;
  const end = lines ? 600 + lines.length * step : 0;
  const pill = (text, d, on) => `<div class="onb-pill onb-a${on ? ' on' : ''}" style="--d:${d}ms">${on ? ic('check', 11) : ''}${esc(text)}</div>`;
  return win(`<b>${esc(tr('This computer'))}</b>`, `<div class="onb-scan-h">${esc(tr('Looking for Claude Code'))}</div>${body}`, { cls: 'onb-win-scan' })
    + (lines ? `<div class="onb-pills">${pill(tr('Checking'), 300, true)}<i class="onb-a" style="--d:${end / 2}ms"></i>`
      + pill(`${tr('Found')}: ${found}/${lines.length}`, end / 2, found > 0) + `<i class="onb-a" style="--d:${end}ms"></i>`
      + (scanReady(lines) ? pill(tr('Ready to work'), end, true) : pill(tr('Only copying the prompt'), end, false)) + '</div>' : '');
}

export function sceneAccess(lines, { still = false } = {}) {
  const mark = { ok: ic('check', 11), no: '–', warn: '!' };
  const step = 320;
  const body = a(`<span class="onb-log-t">${esc(tr('Checking what the board needs…'))}</span>`, 100, 'onb-log')
    + lines.map((l, i) => a(`<span class="onb-log-t">${esc(tr(l.text))}</span><span class="onb-mark onb-mark-${l.mark}">${mark[l.mark]}</span>`,
      350 + i * step, `onb-log${l.mark === 'ok' ? '' : ' onb-log-dim'}`)).join('');
  const ok = lines.filter((l) => l.mark === 'ok').length;
  return `<div class="onb-access${still ? ' onb-still' : ''}">`
    + win(`<b>${esc(tr('This computer'))}</b>`, `<div class="onb-scan-h">${esc(tr('Permissions'))}</div>${body}`, { cls: 'onb-win-scan' })
    + caption(`${tr('Given')}: ${ok}/${lines.length} · ${tr('everything here is in Settings too')}`, 350 + lines.length * step)
    + '</div>';
}

export function sceneWay(way, prompt, note, view = 'chat') {
  const p = esc(prompt);
  let body;
  if (way === 'board') body = sceneWatch({ view });
  else if (way === 'terminal') {
    body = win(`<b>${esc(tr('Terminal'))}</b> — my-app`, `<div class="onb-term">`
      + a(`$ claude '${p}'`, 150, 'onb-t-line onb-t-cmd')
      + a(`● Bash kb show ${KEY}`, 800, 'onb-t-line') + a('● Read src/auth/refresh.ts', 1250, 'onb-t-line')
      + a(`● Bash kb mv ${KEY} doing`, 1700, 'onb-t-line') + '</div>');
  } else if (way === 'desktop') {
    body = win('<b>Claude</b>', a(`<div class="onb-app-box"><span class="onb-app-text">${p}</span><span class="onb-caret"></span></div>`, 200, 'onb-app')
      + a(`<span class="onb-btn">↵ ${esc(tr('you press Enter'))}</span>`, 900, 'onb-btns onb-btns-end'));
  } else {
    body = win(`<b>${esc(tr('Clipboard'))}</b>`, a(`<div class="onb-clip">${p}</div>`, 200)
      + a(`<span class="onb-chip-ok">${ic('check', 11)} ${esc(tr('Copied'))}</span>`, 700, 'onb-btns'));
  }
  return body + caption(note, 300);
}

const PREVIEW = 'The refresh runs twice when the token expires…';

/** Step "what to show": the board itself, as the switches leave it. `set` — the values of VIEW_CHOICES; `changed` — the
    key just switched: its part is marked "adds this" / "hides this". */
export function sceneView(set, changed = null) {
  const tag = (key, on) => (changed === key ? `<span class="onb-tag">${esc(tr(on ? 'adds this' : 'hides this'))}</span>` : '');
  // what was just switched off leaves an empty outline in its place for a moment, named — or nothing would show the change
  const gone = (key, cls) => (changed === key && !set[key] ? `<span class="${cls} onb-gone">${tag(key, false)}</span>` : '');
  const mark = (key) => (changed === key ? ' onb-changed' : '');
  const card = (t, st) => `<div class="onb-mcard">${dot(st)}<span>${esc(tr(t))}</span>${set.compactCards ? '' : `<small>${esc(tr(PREVIEW))}</small>`}</div>`;
  const side = '<div class="onb-vside">'
    + `<div class="onb-vproj">${ic('grid', 11)} ${esc(tr('All projects'))}</div><div class="onb-vproj on">my-app</div><div class="onb-vproj">site</div>`
    + gone('showLimits', 'onb-vlim') + (set.showLimits ? `<div class="onb-vlim${mark('showLimits')}"><span>5h</span><i><b style="width:41%"></b></i><span>7d</span><i><b style="width:12%"></b></i>${tag('showLimits', true)}</div>` : '')
    + '</div>';
  const board = '<div class="onb-vboard">'
    + `<div class="onb-mcol"><div class="onb-mcol-h">${dot('todo')}${esc(STATUS.todo)}</div>${card(OTHERS[0], 'todo')}${card(OTHERS[1], 'todo')}</div>`
    + `<div class="onb-mcol"><div class="onb-mcol-h">${dot('doing')}${esc(STATUS.doing)}</div>${card(TASK, 'doing')}</div>`
    + `${changed === 'compactCards' ? `<span class="onb-tag onb-tag-board">${esc(tr(set.compactCards ? 'descriptions hidden' : 'adds this'))}</span>` : ''}</div>`;
  const drawer = '<div class="onb-vdrawer">'
    + `<div class="onb-vd-t">${dot('doing')}<b>${KEY}</b></div><div class="onb-vd-tabs"><span class="on">${esc(tr('Comments'))}</span>`
    + `<span>${esc(tr('Chat'))}</span></div>`
    + '<div class="onb-vd-line"></div><div class="onb-vd-line short"></div>'
    + gone('showUsage', 'onb-vd-usage') + (set.showUsage ? `<div class="onb-vd-usage${mark('showUsage')}">84k ${esc(tr('tokens'))} · ≈ $1.20${tag('showUsage', true)}</div>` : '')
    + '</div>';
  return win('<b>my-app</b>', `<div class="onb-view">${side}${board}${drawer}</div>`, { cls: 'onb-win-wide' });
}

/** Step GitHub: the card on the board and its issue — the board keeps the work, GitHub mirrors it one way. */
export function sceneSync(repo) {
  const board = win(`<b>local-kanban</b>`, `<div class="onb-mcard onb-mcard-row">${dot('doing')}<span><span class="onb-key">${KEY}</span> ${esc(tr(TASK))}</span></div>`
    + a(`<span class="onb-who">${ic('bot', 12)} Claude</span>${esc(tr('Moved to Doing'))}`, 500, 'onb-note'), { cls: 'onb-win-half' });
  const gh = win(`<b>GitHub</b> · ${esc(repo || 'you/tasks')}`, a(`<div class="onb-issue"><span class="onb-open">${esc(tr('Open issue'))}</span><b>#41</b> [my-app] ${esc(tr(TASK))}</div>`, 900)
    + a(`<div class="onb-gh-row">${ic('chart', 11)} kb: my-app → ${esc(STATUS.doing)}</div>`, 1300)
    + a(`<div class="onb-gh-row">${ic('comment', 11)} ${esc(tr('Moved to Doing'))}</div>`, 1700), { cls: 'onb-win-half', d: 300 });
  return `<div class="onb-pair">${board}<div class="onb-wire onb-a" style="--d:600ms"></div>${gh}</div>`
    + `<div class="onb-pair-caps">${caption(tr('The board keeps the work'), 200)}${caption(tr('GitHub mirrors it, one way'), 500)}</div>`;
}

/** Step demo: the example project fills its columns. */
export function sceneDemo() {
  const cols = [['backlog', ['Dark theme for the site']], ['todo', [OTHERS[1], 'Add a search box']], ['doing', [TASK]], ['review', [OTHERS[2]]], ['done', ['Set up the project']]];
  let d = 200;
  const html = cols.map(([st, cards]) => `<div class="onb-mcol"><div class="onb-mcol-h">${dot(st)}${esc(STATUS[st])}</div>`
    + cards.map((t) => a(`<span>${esc(tr(t))}</span>`, (d += 220), 'onb-mcard')).join('') + '</div>').join('');
  return win('<b>demo</b>', `<div class="onb-mboard onb-mboard-5">${html}</div>`, { cls: 'onb-win-wide' })
    + caption(tr('Links, checklists and labels — delete it with one click in the project settings.'), 400);
}
