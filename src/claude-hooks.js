
export const HOOK_TIMEOUT_S = 1800; // Claude Code stops the hook after 30 minutes (its `timeout` in settings.json)
// kb stops waiting a minute before Claude Code would kill it, and the board drops the request a minute before
// that (ASK_LIFETIME_MS in claude-asks.js): each side ends its wait itself, in this order
export const HOOK_WAIT_MS = HOOK_TIMEOUT_S * 1000 - 60_000;

/** A word for /bin/sh: plain words as they are, anything else in single quotes. */
export function shellWord(s) {
  const v = String(s);
  return /^[\w@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`;
}

/** How Claude Code runs kb: the node and the kb file by absolute path — a hook does not get the person's shell
    PATH everywhere (the desktop app's is not the terminal's) — and the board's address when it is not the default. */
export function kbCommand({ node, kb, url = '' }) {
  return `${url ? `KB_URL=${shellWord(url)} ` : ''}${shellWord(node)} ${shellWord(kb)}`;
}

// kbCommand taken apart again: its words are already quoted for the shell and go back into a command as they are
const WORD = String.raw`(?:'(?:[^']|'\\'')*'|[\w@%+=:,./-]+)`;
const KB_FORM = new RegExp(String.raw`^(?:KB_URL=(${WORD}) )?(${WORD}) (${WORD})$`);

export function hookCommand(kb) {
  const m = KB_FORM.exec(kb);
  if (!m) return `${kb} hook permission`;
  const [, url, node, file] = m;
  return `[ -x ${node} ] && [ -f ${file} ] && ${url ? `KB_URL=${url} ` : ''}exec ${node} ${file} hook permission || true`;
}

/** The node to write into settings.json. The running one by its own path is often a versioned one
    (/opt/homebrew/Cellar/node/24.9.0/bin/node, ~/.nvm/versions/node/v24.9.0/…) that the next upgrade deletes; a
    PATH entry that leads to the same binary (/opt/homebrew/bin/node) survives the upgrade. `realpath` throws or
    returns null for a path that is not there. */
export function nodeOnPath({ execPath, PATH = '', realpath, delimiter = ':', exe = 'node' }) {
  let self;
  try { self = realpath(execPath); } catch { return execPath; }
  for (const dir of String(PATH).split(delimiter)) {
    if (!dir || !dir.startsWith('/')) continue; // a relative PATH entry means nothing to the hook's shell
    const p = `${dir.replace(/\/+$/, '')}/${exe}`;
    try { if (realpath(p) === self) return p; } catch { /* not in this folder */ }
  }
  return execPath;
}

// ours: a kb (bare or by path, quoted or not) followed by `statusline` / `hook permission`
const OURS = {
  statusline: /(?:^|[\s/'"])kb['"]?\s+statusline(?:\s|$)/,
  hook: /(?:^|[\s/'"])kb['"]?\s+hook\s+permission(?:\s|$)/,
};
export const isOurs = (command, what) => typeof command === 'string' && OURS[what].test(command);

/* In front of the person's status line. Their command goes into a group of its own on its own lines, so that
   whatever it is — `cd ~/x && ./line.sh`, `input=$(cat); echo …`, a trailing `# comment` — the whole of it
   reads what kb passes on; a bare `kb … | cd x && ./line.sh` would give the JSON to `cd` alone. And when kb
   cannot run at all (the node it was written with is gone after an upgrade), `cat` passes the JSON on, so
   their line keeps working until the next `local-kanban hooks install`. */
export const chainStatusLine = (kb, theirs) => `{ ${kb} statusline 2>/dev/null || cat; } | {\n${theirs}\n}`;
const CHAINED = [
  /^\{\s*(.*?kb['"]?\s+statusline)(?:\s+2>\/dev\/null)?\s*\|\|\s*cat\s*;\s*\}\s*\|\s*\{\n([\s\S]*)\n\}$/, // chainStatusLine
  /^(.*?kb['"]?\s+statusline)(?:\s+2>\/dev\/null)?\s*\|(?!\|)\s*([\s\S]+)$/,                                     // `kb statusline | theirs` by hand
];
/** Our status line taken apart: {theirs} — the person's command we stand in front of, '' for kb on its own (`--line`,
    or bare: no pipe, list or group, so nothing of the person's) — or null for one of ours written some other way. */
function ourStatusLine(command) {
  for (const re of CHAINED) {
    const m = re.exec(command);
    if (m && m[2].trim()) return { theirs: m[2] };
  }
  return /kb['"]?\s+statusline(?:\s+--line)?\s*$/.test(command) && !/[|;&{}]/.test(command) ? { theirs: '' } : null;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ourHooks = (groups) => (Array.isArray(groups) ? groups : []).flatMap((g) => (isObj(g) && Array.isArray(g.hooks) ? g.hooks : []))
  .filter((h) => isObj(h) && isOurs(h.command, 'hook'));

export const DEFAULT_BOARD_PORT = 3100;
const KB_URL_AT = /(?:^|[\s;&|{(])KB_URL=('(?:[^']|'\\'')*'|"[^"]*"|[^\s;&|]+)/;

/** The port an entry's kb speaks to, or null for an address that does not read as one. */
export function entryPort(command) {
  const m = KB_URL_AT.exec(String(command || ''));
  if (!m) return DEFAULT_BOARD_PORT;
  let v = m[1];
  if (v.startsWith("'")) v = v.slice(1, -1).replace(/'\\''/g, "'");
  else if (v.startsWith('"')) v = v.slice(1, -1);
  try {
    const u = new URL(v);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch { return null; }
}

/** The ports the board's entries in these settings speak to — the status line and every hook of the board — each once. */
export function boardPorts(settings) {
  if (!isObj(settings)) return [];
  const commands = [];
  if (isObj(settings.statusLine) && isOurs(settings.statusLine.command, 'statusline')) commands.push(settings.statusLine.command);
  if (isObj(settings.hooks)) for (const groups of Object.values(settings.hooks)) for (const h of ourHooks(groups)) commands.push(h.command);
  return [...new Set(commands.map(entryPort).filter((p) => p !== null))];
}

/** The address of another board, when the board's entries are there and none of them speaks to `port` — else null. */
export function otherBoard(settings, port) {
  const ports = boardPorts(settings);
  return ports.length && !ports.includes(Number(port)) ? `http://127.0.0.1:${ports[0]}` : null;
}

/** What install would do: {settings, changes}. `changes` — [{part, action, from?, to?}], `action` one of
    `add`, `chain`, `update` (ours, written with another node, kb or address — rewritten), `already`, `skip`.
    Never touches what is not ours. */
export function planInstall(settings, kb) {
  const s = isObj(settings) ? structuredClone(settings) : {};
  const changes = [];
  const sl = s.statusLine;
  if (isObj(sl) && isOurs(sl.command, 'statusline')) {
    const ours = ourStatusLine(sl.command);
    const want = ours && (ours.theirs ? chainStatusLine(kb, ours.theirs) : `${kb} statusline --line`);
    if (!want) changes.push({ part: 'statusLine', action: 'skip', ours: true });
    else if (want === sl.command) changes.push({ part: 'statusLine', action: 'already' });
    else {
      s.statusLine = { ...sl, command: want };
      changes.push({ part: 'statusLine', action: 'update', from: sl.command, to: want });
    }
  } else if (isObj(sl) && (sl.type === undefined || sl.type === 'command') && typeof sl.command === 'string' && sl.command.trim()) {
    s.statusLine = { ...sl, command: chainStatusLine(kb, sl.command) };
    changes.push({ part: 'statusLine', action: 'chain', from: sl.command, to: s.statusLine.command });
  } else if (sl === undefined || sl === null) {
    s.statusLine = { type: 'command', command: `${kb} statusline --line` };
    changes.push({ part: 'statusLine', action: 'add', to: s.statusLine.command });
  } else {
    // a status line this file does not understand (another type, an empty command): left exactly as it is
    changes.push({ part: 'statusLine', action: 'skip' });
  }
  if (s.hooks !== undefined && !isObj(s.hooks)) {
    changes.push({ part: 'PermissionRequest', action: 'skip' });
    return { settings: s, changes };
  }
  s.hooks = s.hooks || {};
  const list = s.hooks.PermissionRequest;
  const want = hookCommand(kb);
  const mine = ourHooks(list);
  if (mine.length) {
    const stale = mine.filter((h) => h.command !== want || h.timeout !== HOOK_TIMEOUT_S);
    if (!stale.length) changes.push({ part: 'PermissionRequest', action: 'already' });
    else {
      // rewritten in place: the group, its matcher and whatever sits next to it stay where they are
      const from = stale[0].command;
      s.hooks.PermissionRequest = list.map((g) => (isObj(g) && Array.isArray(g.hooks)
        ? { ...g, hooks: g.hooks.map((h) => (isObj(h) && isOurs(h.command, 'hook') ? { ...h, command: want, timeout: HOOK_TIMEOUT_S } : h)) }
        : g));
      const older = stale.every((h) => h.command === `${kb} hook permission`);
      changes.push({ part: 'PermissionRequest', action: 'update', from, to: want, ...(older ? { older: true } : {}) });
    }
  } else if (list !== undefined && !Array.isArray(list)) {
    changes.push({ part: 'PermissionRequest', action: 'skip' });
  } else {
    const entry = { matcher: '*', hooks: [{ type: 'command', command: want, timeout: HOOK_TIMEOUT_S }] };
    s.hooks.PermissionRequest = [...(list || []), entry];
    changes.push({ part: 'PermissionRequest', action: 'add', to: want });
  }
  return { settings: s, changes };
}

/** `value` as the text of a settings file laid out the way `text` — the file as it was — is laid out: its indent
    (any number of spaces, or tabs), its line ends, a newline at the end or none, everything on one line. A file
    Claude Code wrote (two spaces) or one kept by hand in another style comes back byte for byte after an install
    and an uninstall. With nothing to go by (no file, `{}`) — two spaces and a newline, as Claude Code writes it. */
export function formatLike(text, value) {
  const src = typeof text === 'string' ? text : '';
  const body = src.trim();
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const nested = /\n([ \t]+)\S/.exec(src); // the first indented line: a key one level in
  let indent = 2;
  if (nested) indent = nested[1].slice(0, 10);
  else if (body.startsWith('{') && body !== '{}' && !body.includes('\n')) indent = 0; // all of it on one line
  let out = JSON.stringify(value, null, indent);
  if (eol !== '\n') out = out.replace(/\n/g, eol); // a newline inside a JSON string is written as \n, never raw
  return out + (!body || /\n$/.test(src) ? eol : '');
}

/** What uninstall would do: {settings, changes} — only our entries leave; the status line we stood in front of
    comes back; groups, events and the hooks object left empty by that are removed too. */
export function planUninstall(settings) {
  const s = isObj(settings) ? structuredClone(settings) : {};
  const changes = [];
  const sl = s.statusLine;
  if (isObj(sl) && isOurs(sl.command, 'statusline')) {
    const ours = ourStatusLine(sl.command);
    if (!ours) {
      changes.push({ part: 'statusLine', action: 'skip', ours: true });
    } else if (ours.theirs) {
      s.statusLine = { ...sl, command: ours.theirs };
      changes.push({ part: 'statusLine', action: 'restore', from: sl.command, to: ours.theirs });
    } else {
      delete s.statusLine;
      changes.push({ part: 'statusLine', action: 'remove', from: sl.command });
    }
  }
  if (isObj(s.hooks)) {
    for (const event of Object.keys(s.hooks)) {
      const groups = s.hooks[event];
      if (!Array.isArray(groups)) continue;
      let removed = 0;
      const kept = [];
      for (const g of groups) {
        if (!isObj(g) || !Array.isArray(g.hooks)) { kept.push(g); continue; }
        const hs = g.hooks.filter((h) => !(isObj(h) && isOurs(h.command, 'hook')));
        removed += g.hooks.length - hs.length;
        if (hs.length) kept.push(hs.length === g.hooks.length ? g : { ...g, hooks: hs });
      }
      if (!removed) continue;
      changes.push({ part: event, action: 'remove' });
      if (kept.length) s.hooks[event] = kept;
      else delete s.hooks[event];
    }
    if (!Object.keys(s.hooks).length && isObj(settings) && isObj(settings.hooks) && changes.some((c) => c.part !== 'statusLine')) delete s.hooks;
  }
  return { settings: s, changes };
}
