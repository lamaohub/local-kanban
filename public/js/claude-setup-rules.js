// answer of GET /api/claude. A leaf — no imports, no DOM — so test/claude-setup.test.js runs it in node. Every text is
// English and has a translation; values (paths, numbers) are kept apart from the texts, so the texts translate whole.

export const INSTALL_CLAUDE_URL = 'https://code.claude.com/docs/en/setup';
export const INSTALL_CLAUDE_CMD = 'curl -fsSL https://claude.ai/install.sh | bash';
const CLAUDE_FROM = {
  KB_CLAUDE_BIN: 'Set by KB_CLAUDE_BIN. Starts tasks inside the board.',
  app: 'Not on PATH — the board uses the copy of Claude Code inside the Claude app. Starts tasks inside the board and in Terminal.',
  place: 'Not on PATH — the board found it where the installer puts it. Starts tasks inside the board and in Terminal.',
};
export const CLAUDE_APP_URL = 'https://claude.ai/download';
export const PRIVACY_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
// the same instructions in more detail, and editable without a release: the README of the repository, as the sync
// section links it (no local copy of the README to open — it ships inside the package)
export const README_HOOKS_URL = 'https://github.com/lamaohub/local-kanban#connect-the-board-to-claude-code-optional';

const row = (id, state, title, note, extra = {}) => ({ id, state, title, note, ...extra });

function programs(d) {
  const rows = [];
  // without the program, the Claude app still starts tasks — then it is one way of working of several; without both,
  // nothing is left that starts Claude
  const badBin = !d.claude?.path && d.claude?.from === 'KB_CLAUDE_BIN';
  rows.push(badBin
    ? row('claude', d.app?.path ? 'opt' : 'off', 'Claude Code (claude)', 'KB_CLAUDE_BIN points where there is no program: ▶ cannot start Claude inside the board or in Terminal.',
      { value: d.claude.set, fix: { text: d.claude.on_path ? 'Fix KB_CLAUDE_BIN, or remove it — then the board takes claude from PATH.' : 'Fix KB_CLAUDE_BIN: point it at the claude program.' } })
    : d.claude?.path
    ? row('claude', 'ok', 'Claude Code (claude)', CLAUDE_FROM[d.claude.from] || 'Starts tasks inside the board and in Terminal.', { value: d.claude.path })
    : row('claude', d.app?.path ? 'opt' : 'off', 'Claude Code (claude)', 'Not found: ▶ cannot start Claude inside the board or in Terminal — only the Claude app or copying the prompt are left.',
      { say: true, fix: { cmd: INSTALL_CLAUDE_CMD, href: INSTALL_CLAUDE_URL, label: 'How to install Claude Code' } }));
  rows.push(d.tmux?.path
    ? row('tmux', 'ok', 'tmux', 'Keeps Claude running inside the board — its screen is on the Terminal tab of the card.', { value: d.tmux.path })
    : row('tmux', 'opt', 'tmux', 'Not found: Claude cannot run inside the board — ▶ opens the Claude app or Terminal instead.',
      d.platform === 'darwin' ? { fix: { cmd: 'brew install tmux' } } : { fix: { text: 'Install tmux with the package manager of your system.' } }));
  if (d.app?.supported) {
    rows.push(d.app.path
      ? row('app', 'ok', 'Claude app', '▶ can open a task in the Claude app, and ↗ the session that worked on it.', { value: d.app.path })
      : row('app', 'opt', 'Claude app', 'Not installed: ▶ and ↗ cannot open the Claude app.', { fix: { href: CLAUDE_APP_URL, label: 'Download the Claude app' } }));
  }
  rows.push(d.terminal?.ok
    ? row('terminal', 'ok', 'Terminal', d.platform === 'darwin' ? '▶ can start Claude in a Terminal window.' : '▶ can start Claude in a terminal window (x-terminal-emulator).')
    : row('terminal', 'opt', 'Terminal', 'No x-terminal-emulator: ▶ cannot open a terminal window.', { fix: { text: 'Install a terminal that provides x-terminal-emulator.' } }));
  // under pm2, else the app the board was started from; Full Disk Access for it stops the asking
  const m = d.macos;
  if (m && m.full_disk === true) rows.push(row('macos', 'ok', 'macOS access', 'The board has Full Disk Access: macOS does not ask about the data of other apps for Claude inside the board.'));
  else if (m && m.full_disk === false && m.pm2 !== false) rows.push(row('macos', 'opt', 'macOS access', 'macOS asks "node would like to access data from other apps" whenever Claude inside the board reaches the data of another app, and does not keep the answer: for macOS, Claude runs inside node, the program the board runs in.',
    { value: m.node, say: true, fix: { text: 'To stop it: give this node Full Disk Access — press +, then ⇧⌘G and paste the path above. Full Disk Access is for everything run with this node.', href: PRIVACY_URL, label: 'Open Full Disk Access' } }));
  else if (m && m.full_disk === false) rows.push(row('macos', 'opt', 'macOS access', 'macOS asks whenever Claude inside the board reaches the data of another app, in the name of the app the board was started from, and may not keep the answer.',
    { say: true, fix: { text: 'To stop it: give Full Disk Access to the app you started the board from (Terminal, iTerm…).', href: PRIVACY_URL, label: 'Open Full Disk Access' } }));
  return rows;
}

function environment(d) {
  const e = d.env || {};
  const rows = [];
  if ((e.settings || []).includes('CLAUDE_CODE_SIMPLE')) {
    rows.push(row('bare', 'warn', 'Bare mode (CLAUDE_CODE_SIMPLE)', "Set in the env of settings.json: Claude Code starts in the bare mode — it reads no sign-in to your subscription, no hooks and no skills, so the board's Claude cannot sign in, follow the board's skill or ask in the card.",
      { value: d.settings?.path, fix: { text: 'Remove CLAUDE_CODE_SIMPLE from "env" in settings.json, then check again.' } }));
  } else if ((e.taken_off || []).includes('CLAUDE_CODE_SIMPLE')) {
    rows.push(row('bare', 'ok', 'Bare mode (CLAUDE_CODE_SIMPLE)', 'Set where the board was started. The board starts Claude without it: in the bare mode Claude reads no sign-in, no hooks and no skills. Your own claude in a terminal keeps it.'));
  }
  const keys = [...new Set([...(e.keys || []), ...(e.settings || []).filter((k) => k !== 'CLAUDE_CODE_SIMPLE')])];
  if (keys.length) {
    const inSettings = (e.settings || []).some((k) => keys.includes(k));
    const inBoard = (e.keys || []).length > 0;
    const where = inSettings && inBoard ? 'both' : inSettings ? 'settings' : 'board';
    rows.push(row('key', 'warn', 'API key', keys.includes('ANTHROPIC_API_KEY') && !keys.includes('ANTHROPIC_AUTH_TOKEN')
      ? "Reaches the board's Claude. Claude Code asks once whether to use it, and Yes means it works on this key, paid for by the API, instead of your Claude subscription — the answer is remembered."
      : "Reaches the board's Claude and is used instead of your Claude subscription, without asking.",
    { value: keys.join(', '), fix: { text: where === 'both'
      ? 'To work on the subscription, remove the key from "env" in settings.json and start the board from a terminal without the other one (unset it first); check which way Claude signs in with /status, and change the answer about the key with "Use custom API key" in /config.'
      : where === 'settings'
      ? 'To work on the subscription, remove it from "env" in settings.json; check which way Claude signs in with /status.'
      : 'To work on the subscription, start the board from a terminal without it (unset it first); check which way Claude signs in with /status, and change the answer about the key with "Use custom API key" in /config.' } }));
  }
  return rows;
}

const FOLDER_FROM = {
  KB_CLAUDE_DIR: 'Set by KB_CLAUDE_DIR — the board reads and writes here, whatever folder Claude Code itself uses.',
  CLAUDE_CONFIG_DIR: 'Set by CLAUDE_CONFIG_DIR, the variable Claude Code uses itself.',
  default: 'Claude Code\'s own folder.',
};
export const folderFrom = (from) => FOLDER_FROM[from] || FOLDER_FROM.default;

function folder(d) {
  const f = d.folder || {};
  const rows = [f.exists
    ? row('folder', 'ok', 'Claude folder', FOLDER_FROM[f.from] || FOLDER_FROM.default, { value: f.path })
    : row('folder', 'off', 'Claude folder', 'Not there: Claude Code has not run on this computer with this folder — the board finds no sessions, transcripts or skills.',
      { value: f.path, fix: f.from === 'KB_CLAUDE_DIR' ? { text: 'Check KB_CLAUDE_DIR: it points at a folder that does not exist.' } : { href: INSTALL_CLAUDE_URL, label: 'How to install Claude Code' } })];
  // not touch it) used to show as fine here, since only the file being there was looked at
  if (!d.skill?.exists) {
    rows.push(row('skill', 'off', 'The board\'s skill (kanban)', 'Not installed: Claude does not know how to work with the board, and ▶ starts every task with this skill.',
      { fix: !f.exists && f.from === 'KB_CLAUDE_DIR' ? { text: 'No such folder — check KB_CLAUDE_DIR. The board does not make it.' } : { section: 'skills', label: 'Install it in Skills' } }));
  } else if (d.skill.state === 'differs') {
    rows.push(row('skill', 'warn', 'The board\'s skill (kanban)', 'Not the version this board ships — a copy left from an earlier version, or changed by hand: Claude may follow rules the board no longer has. Update it in Skills; the current file is kept among the backups.',
      { value: d.skill.path, fix: { section: 'skills', label: 'Update it in Skills' } }));
  } else {
    rows.push(row('skill', 'ok', 'The board\'s skill (kanban)', d.skill.symlink ? 'Claude knows the board\'s commands. It is a link to a file elsewhere.' : 'Claude knows the board\'s commands.', { value: d.skill.path }));
  }
  const r = d.registry || {};
  rows.push(r.exists
    ? row('registry', 'ok', 'Live sessions', 'The working / waiting for you badges of the cards follow them.', { count: { n: r.live_n, label: 'running now' } })
    : row('registry', 'opt', 'Live sessions', 'No registry yet: it appears once Claude Code runs here. Until then the cards show no working / waiting for you badges.'));
  const t = d.transcripts || {};
  rows.push(t.exists
    ? row('transcripts', 'ok', 'Transcripts', 'The card\'s Claude\'s work feed and what a task cost are read from them.', { count: { n: t.projects_n, label: 'projects' } })
    : row('transcripts', 'opt', 'Transcripts', 'None yet: the cards show no Claude\'s work and no cost.'));
  return rows;
}

const SETTINGS_ERROR = {
  'not-json': 'settings.json is not valid JSON — the board does not touch it. Fix the file, then check again.',
  'not-object': 'settings.json does not hold a JSON object — the board does not touch it.',
  unreadable: 'settings.json cannot be read — the board does not touch it.',
};

function connection(d) {
  const s = d.settings || {};
  if (s.error) return [row('settings', 'warn', 'settings.json', SETTINGS_ERROR[s.error] || SETTINGS_ERROR.unreadable, { value: s.path })];
  const rows = [];
  const sl = s.status_line;
  const chained = (s.uninstall || []).some((c) => c.part === 'statusLine' && c.action === 'restore');
  const odd = (s.install || []).some((c) => c.part === 'statusLine' && c.action === 'skip' && c.ours);
  const other = s.other_board || null;
  if (sl === 'already') rows.push(row('statusline', 'ok', 'Status line', chained ? 'Goes through the board, in front of your own: the limits come to the sidebar.' : 'Goes through the board: the limits come to the sidebar.'));
  else if (sl === 'update' && other) rows.push(row('statusline', 'warn', 'Status line', 'Connected to another board: the limits go to it. Connecting here takes them over from it.', { value: other, fix: { connect: true } }));
  else if (sl === 'update') rows.push(row('statusline', 'warn', 'Status line', 'Connected with other paths (the board or Node moved) — it may not run. Connect again to bring it up to date.', { fix: { connect: true } }));
  else if (sl === 'chain') rows.push(row('statusline', 'opt', 'Status line', 'Your own status line runs without the board: the limits do not come to the sidebar. Connecting puts the board in front of it.', { fix: { connect: true } }));
  else if (sl === 'skip' && odd) rows.push(row('statusline', 'warn', 'Status line', 'Goes through the board, but is written in a way the board cannot take apart: Connect and Disconnect leave it as it is. Fix it by hand.', { fix: { href: README_HOOKS_URL, label: 'How, in the README' } }));
  else if (sl === 'skip') rows.push(row('statusline', 'warn', 'Status line', 'Set up in a way the board does not change. Put kb statusline in front of it by hand.', { fix: { href: README_HOOKS_URL, label: 'How, in the README' } }));
  else rows.push(row('statusline', 'opt', 'Status line', 'Not connected: the limits do not come to the sidebar.', { fix: { connect: true } }));
  const h = s.hook;
  if (h === 'already') rows.push(row('hook', 'ok', 'Claude\'s questions', 'Come to the card of the task: answer there or in Claude\'s window.'));
  else if (h === 'update' && other) rows.push(row('hook', 'warn', 'Claude\'s questions', 'Connected to another board: Claude\'s questions go to it. Connecting here takes them over from it.', { value: other, fix: { connect: true } }));
  else if (h === 'update' && (s.install || []).some((c) => c.part === 'PermissionRequest' && c.older)) rows.push(row('hook', 'ok', 'Claude\'s questions', 'Come to the card of the task. Written by an earlier version of the board — Connect brings the entry up to date.', { fix: { connect: true }, say: true }));
  else if (h === 'update') rows.push(row('hook', 'warn', 'Claude\'s questions', 'Connected with other paths (the board or Node moved) — they may not come. Connect again to bring it up to date.', { fix: { connect: true } }));
  else if (h === 'skip') rows.push(row('hook', 'warn', 'Claude\'s questions', 'The hooks in settings.json are set up in a way the board does not change. Add the hook by hand.', { fix: { href: README_HOOKS_URL, label: 'How, in the README' } }));
  else rows.push(row('hook', 'opt', 'Claude\'s questions', 'Not connected: Claude asks only in its own window.', { fix: { connect: true } }));
  const at = d.limits?.at || null;
  // Disconnect, or with the Claude folder gone, and still said so
  const through = sl === 'already' || odd;
  if (at && through && d.limits.fresh) rows.push(row('limits', 'ok', 'Limits', 'Last reading from the status line — it runs.', { value: at, time: true }));
  else if (at && through) rows.push(row('limits', 'warn', 'Limits', 'The last reading is old: no terminal session has sent one since. A new one comes after Claude\'s answer in a terminal session; the Claude app has no status line.', { value: at, time: true }));
  else if (at) rows.push(row('limits', 'opt', 'Limits', 'Last reading from before: the status line does not go through the board now, so no new ones come.', { value: at, time: true, say: true }));
  else rows.push(row('limits', through ? 'warn' : 'opt', 'Limits', through
    ? 'No reading yet. It comes after Claude\'s first answer in a terminal session, for Pro and Max; the Claude app has no status line.'
    : 'No reading: the status line does not go through the board.'));
  return rows;
}

/** The section: [{id, title, rows}] — the programs ▶ starts tasks with, the Claude folder, the connection. */
export function setupView(d) {
  return [
    { id: 'programs', title: 'Starting tasks', rows: [...programs(d || {}), ...environment(d || {})] },
    { id: 'folder', title: 'Claude folder', rows: folder(d || {}) },
    { id: 'connection', title: 'Connection', rows: connection(d || {}) },
  ];
}

const WRITES = new Set(['add', 'chain', 'update', 'restore', 'remove']);
/** Whether there is something to write: for `install` / `uninstall` from the answer's settings. */
export const hasChange = (changes) => Array.isArray(changes) && changes.some((c) => WRITES.has(c.action));

/** What the Connect / Disconnect buttons may do: {connect, disconnect, why} — `why` an English sentence when the page
    cannot connect at all (the file is broken or cannot be written). */
export function hooksButtons(s = {}) {
  if (s.error) return { connect: false, disconnect: false, why: SETTINGS_ERROR[s.error] || SETTINGS_ERROR.unreadable };
  if (!s.writable) {
    if (s.why === 'no-folder') return { connect: false, disconnect: false, why: 'No such folder — check KB_CLAUDE_DIR. The board does not make it.' };
    return { connect: false, disconnect: false, why: s.why === 'folder'
      ? 'The Claude folder cannot take a settings.json — the board cannot connect from here. Make the folder writable, or add the entries by hand.'
      : 'settings.json is read-only — the board cannot connect from here. Make it writable, or add the entries by hand.' };
  }
  return { connect: hasChange(s.install), disconnect: hasChange(s.uninstall), why: null };
}

/** The lines the confirmation shows: exactly what will be written, the way `local-kanban hooks` prints it. */
export function changeLines(changes) {
  const out = [];
  for (const c of changes || []) {
    if (c.action === 'add') out.push(`+ ${c.part}: ${c.to}`);
    else if (c.action === 'chain' || c.action === 'update' || c.action === 'restore') out.push(`~ ${c.part}: ${c.from}\n  → ${c.to}`);
    else if (c.action === 'remove') out.push(`- ${c.part}${c.from ? `: ${c.from}` : ''}`);
  }
  return out;
}

/** What the page says when connecting or taking off was refused — by the `reason` of the board's answer. */
export function hooksRefusal(e) {
  if (e?.offline) return 'No connection to the board — nothing was written. Try again.';
  const r = e?.body?.reason;
  if (r === 'changed') return 'settings.json changed since this page read it — nothing was written. Look at the change again.';
  if (r === 'read-only') return 'settings.json is read-only — nothing was written. Make it writable, or add the entries by hand.';
  if (r === 'folder') return 'The folder of settings.json is not writable — nothing was written. Make it writable, or add the entries by hand.';
  if (r === 'no-folder') return 'No such folder — check KB_CLAUDE_DIR. Nothing was written.';
  if (r === 'no-copy') return 'The board could not keep a copy of settings.json among its backups — nothing was written.';
  if (r === 'not-json' || r === 'not-object' || r === 'unreadable') return 'Nothing was written: the board does not touch settings.json as it is now — see above.';
  return 'Could not write settings.json — nothing was changed.';
}
