
const sameSet = (a, b) => a.length === b.length && new Set([...a, ...b]).size === new Set(a).size;
export function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && sameSet(a, b);
  return a === b;
}
const copy = (v) => (Array.isArray(v) ? [...v] : v);

export function changedFields(next, snap) {
  const out = {};
  for (const [k, v] of Object.entries(next)) if (!sameValue(v, snap[k])) out[k] = copy(v);
  return out;
}

export function pullExternal(snap, form, fresh, skip = []) {
  const write = {};
  const next = { ...snap };
  for (const [k, v] of Object.entries(fresh)) {
    if (!(k in snap)) continue;
    if (sameValue(v, form[k])) { next[k] = copy(v); continue; }
    if (skip.includes(k)) continue;
    if (!sameValue(form[k], snap[k])) continue;
    write[k] = copy(v);
    next[k] = copy(v);
  }
  return { write, snap: next };
}

export function createUnsentEdits() {
  const byKey = new Map();
  return {
    get: (key) => byKey.get(key),
    get size() { return byKey.size; },
    fail(key, fields) {
      const next = { ...(byKey.get(key) || {}) };
      for (const [k, v] of Object.entries(fields)) next[k] = copy(v);
      byKey.set(key, next);
    },
    settle(key, sent) {
      const cur = byKey.get(key);
      if (!cur) return true;
      for (const [k, v] of Object.entries(sent)) if (sameValue(cur[k], v)) delete cur[k];
      if (Object.keys(cur).length) return false;
      byKey.delete(key);
      return true;
    },
    supersede(key, names) {
      const cur = byKey.get(key);
      if (!cur) return true;
      for (const k of names) delete cur[k];
      if (Object.keys(cur).length) return false;
      byKey.delete(key);
      return true;
    },
    drop(key) { byKey.delete(key); },
  };
}

/** Whether a failed request is worth repeating: there was no connection, or the server failed (5xx). A refusal
    (4xx: the task is gone, the change does not pass the checks) is not cured by sending it again. */
export const canRetry = (e) => Boolean(e?.offline) || e?.status >= 500;

export const RESEND_MS = 3000;
export const RESEND_MAX_MS = 60000;
/** How long to wait before the next try, `n` — how many tries in a row already failed. */
export const resendDelay = (n) => Math.min(RESEND_MAX_MS, RESEND_MS * 2 ** Math.max(0, n));

/** Runs the sends of one key (a task) one after another, each once the one before it is answered or failed; the
    promise of each is its own result. Keys do not wait for each other. A send that does not answer at all (a
    connection that died without a word) holds the next one at most `waitMs`: the edits behind it must not wait
    forever unseen. */
export const TURN_WAIT_MS = 15000;
export function createTurns(waitMs = TURN_WAIT_MS) {
  const last = new Map();
  const capped = (p) => new Promise((ok) => { const t = setTimeout(ok, waitMs); p.then(() => { clearTimeout(t); ok(); }); });
  return (key, send) => {
    const before = last.get(key);
    const run = (before ? capped(before) : Promise.resolve()).then(send);
    const settled = run.then(() => {}, () => {});
    last.set(key, settled);
    settled.then(() => { if (last.get(key) === settled) last.delete(key); });
    return run;
  };
}

export function createRetryQueue() {
  const jobs = new Map();
  const retriable = canRetry;
  return {
    get size() { return jobs.size; },
    note(key, run) { jobs.set(key, run); },
    drop(key) { jobs.delete(key); },
    async retry() {
      const batch = [...jobs];
      jobs.clear();
      for (const [key, run] of batch) {
        try { await run(); } catch (e) {
          if (retriable(e) && !jobs.has(key)) jobs.set(key, run);
        }
      }
    },
  };
}

/** Comments that did not reach the server, per task and in the order typed, until the resend delivers them —
    the card shows them as not sent yet. The same text for the same task while it still waits is that comment
    again, not a second one: a second entry went out as a duplicate once the connection came back. */
export function createUnsentComments() {
  let seq = 0;
  const byKey = new Map();
  return {
    /** → { id, body, again } — again: this text already waits for this task, nothing new is queued */
    add(key, body) {
      const list = byKey.get(key) || [];
      const same = list.find((c) => c.body === body);
      if (same) return { ...same, again: true };
      const c = { id: ++seq, body };
      byKey.set(key, [...list, c]);
      return { ...c, again: false };
    },
    list: (key) => (byKey.get(key) || []).map((c) => ({ ...c })),
    get: (key, id) => {
      const c = (byKey.get(key) || []).find((x) => x.id === id);
      return c ? { ...c } : null;
    },
    /** delivered, or taken back by the person */
    done(key, id) {
      const list = (byKey.get(key) || []).filter((c) => c.id !== id);
      if (list.length) byKey.set(key, list);
      else byKey.delete(key);
    },
    get size() { let n = 0; for (const l of byKey.values()) n += l.length; return n; },
  };
}

/** What the board says when the server refused a change of a task — in its own words: the server's are English
    and technical ("task not found"), and a Russian board showed them as they came. `text` — the English source
    (the Russian line is in I18N_RU); `gone` — the task is not there any more, its card leaves the board;
    `refresh` — the board is read again (it showed something old).
    `reason` — the same refusal said after the name of the action that failed, as `refusalLine` builds it ("Could not
    start Claude: …"); `claudeGone` — the board's Claude no longer runs on the task, nothing was typed into it.
    A 404 names WHAT is missing — the task of the request, the task to link to, the project, the board's Claude, a
    thing of the task — and only the first one is "this task was deleted". */
const said = (text, reason, flags) => ({ text, reason, gone: false, refresh: false, claudeGone: false, ...flags });
const TASK_GONE = said('This task no longer exists — it was deleted.', 'the task no longer exists — it was deleted', { gone: true, refresh: true });
const CLAUDE_GONE = said('Claude of the board no longer runs on this task — nothing was sent.', 'Claude of the board no longer runs on this task', { claudeGone: true });
const REFUSED = said('Not saved: the board did not accept it.', 'the board did not accept it');
const KNOWN = [
  [/^that category already exists$/, 'a section with this name already exists'],
  [/^category name: up to 40 characters$/, 'a section name is up to 40 characters'],
  [/^the ".*" category cannot be (renamed|deleted)$/, 'this section is built in — it cannot be renamed or deleted'],
  [/^category not found$/, 'this section no longer exists', { refresh: true }],
  [/^the project already has a folder$/, 'the project already has a folder'],
  [/^no free folder name for this project$/, 'there is no free folder name for this project'],
  [/^could not create the folder/, 'the computer did not let the board create the folder — the details are in Settings → Errors'],
  [/^no such folder$/, 'no such folder on this computer'],
  [/^not a folder$/, 'this path is not a folder'],
  [/^cannot read the folder/, 'the folder is there, but the board cannot read it — check its permissions'],
  [/^folder is already on the board$/, 'this folder is already on the board'],
  [/^(slug is taken|slug exists)$/, 'a project with this key already exists'],
  [/^folder name: /, 'a folder name is latin letters, digits, “.”, “-” and “_”, not starting with “.” or “-”'],
  [/^folder .* already exists in /, 'a folder with this name already exists'],
  [/^git URL: /, 'a git address starts with https:// or git@'],
  [/^the file is not there$/, 'the file is not there any more'],
  [/^the file on disk is not the one the page was (editing|showing)$/, 'the file on disk is not the one opened here — open it again'],
  [/^the project folder is not there$/, 'the project folder is not on this computer'],
  [/^this is a check board opened from a backup/, 'this is a check board opened from a backup — it changes nothing'],
  [/^owner: /, 'the owner is latin letters, digits and hyphens, not starting with a hyphen'],
  [/^repo: expected owner\/name$/, 'the repository is written as owner/name'],
  [/^an update is already running$/, 'an update is already running'],
  [/^(not an SQLite database file|an SQLite database, but not a board|could not read the database)/, 'this file is not a backup of a board'],
  [/^database is corrupted/, 'the backup file is damaged'],
  [/^empty file$/, 'the file is empty'],
  [/^another backup is already being opened$/, 'another backup is being opened right now — wait for it'],
  [/^there is no such skill$/, 'there is no such skill any more', { refresh: true }],
  [/^could not get the shared version/, 'could not get the shared version — no network, and the board does not ship this skill'],
  [/ does not exist — check KB_CLAUDE_DIR; /, 'no such folder — check KB_CLAUDE_DIR; the board does not make it'],
  [/ is already checking this project$/, 'another check of this project is open — finish or cancel it first', { refresh: true }],
  [/^too many messages wait for this Claude already$/, 'too many messages already wait for this Claude — take one back or wait until it is free'],
  [/^Claude asks a question — answer it first$/, 'Claude asks a question — answer it first'],
  [/^Claude is not at work — there is nothing to stop$/, 'Claude is not at work any more — there is nothing to stop'],
  [/^Claude is being stopped already$/, 'Claude is being stopped already'],
  [/^Claude's input field is not on its screen/, 'Claude\'s input field is not on its screen — it may be asking a question; nothing was typed'],
  [/^the words did not show in Claude's input field/, 'the words did not show in Claude\'s input field — nothing was sent, try again'],
  [/^the words are in Claude's input field, but Enter did not send them/, 'the words are in Claude\'s input field but did not go — press Enter in its terminal'],
  [/^Claude did not write this command in this chat/, 'Claude did not write this command in this chat — nothing was run'],
  [/^no terminal to open on this computer/, 'there is no terminal to open on this computer — copy the command instead'],
  [/^the project has no folder on this computer — the command would run/, 'the project has no folder on this computer — set it in the project, or copy the command'],
  [/^the terminal did not open/, 'the terminal did not open — copy the command instead; the details are in Settings → Errors'],
];
export function refusalText(e) {
  const status = e?.status;
  const msg = String(e?.message || '');
  if (e?.offline) return said('No connection to the board — try again', 'no connection to the board — try again');
  const known = status && KNOWN.find(([re]) => re.test(msg));
  if (known) return said(REFUSED.text, known[1], known[2]);
  if (status === 404) {
    if (/^the task to link to was not found/.test(msg)) return said('That task no longer exists — it was deleted.', 'that task no longer exists — it was deleted', { refresh: true });
    if (/^project not found/.test(msg)) return said('Not saved: the project no longer exists.', 'the project no longer exists', { refresh: true });
    if (/^no Claude of the board works on this task/.test(msg)) return { ...CLAUDE_GONE };
    if (!msg || /^(task not found|404)$/.test(msg)) return { ...TASK_GONE };
    return { ...REFUSED, refresh: true }; // a thing of the task is gone (an attachment, a comment): the card is read again
  }
  if (status === 409 && /^Claude has exited in this terminal/.test(msg)) return { ...CLAUDE_GONE };
  if (status === 409 && e?.body?.reason === 'starting') return said(REFUSED.text, 'Claude is already being started on these tasks');
  if (status === 409 && /^the Claude app is not installed/.test(msg)) {
    return said(REFUSED.text, 'the Claude app is not installed on this computer — pick Terminal or Copy in Settings');
  }
  if (status === 413) return said('Not saved: it is larger than the board takes.', 'it is larger than the board takes');
  // this way of doing it is not there on this computer (no terminal to open, the app outside macOS)
  if (status === 501) return said(REFUSED.text, 'this computer cannot do it — pick another way in Settings');
  // the server logs what failed (and the page logs a refusal it did not expect): the person finds it there
  if (status >= 500) {
    return said('Not saved: the board answered with an error — the details are in Settings → Errors.', 'the board answered with an error — the details are in Settings → Errors');
  }
  // the card showed an old column: the task is back in Backlog or To do, and from there it goes through work
  if (status === 400 && /^cannot go straight from /.test(msg)) {
    return said('Not saved: the task has to go through work first — the board showed it in an old column.', 'the task has to go through work first', { refresh: true });
  }
  if (status === 400 && /^images only/.test(msg)) return said(REFUSED.text, 'only PNG, JPEG, WebP and GIF images can be attached');
  if (status === 400 && /^limit of (attachments per task|images in comments)/.test(msg)) return said(REFUSED.text, 'the task already holds as many images as it can');
  return { ...REFUSED };
}

export const IMAGE_MAX_BYTES = 6 * 1024 * 1024;
/** The refusal the server would give an image this large (said by refusalText as 413), or null when it fits. */
export const imageTooLarge = (blob) => (blob?.size > IMAGE_MAX_BYTES ? { status: 413, message: 'larger than the board takes' } : null);

/** A refusal said after the action that failed: "Could not attach: the task already holds as many images as it can".
    `tr` — the board's translation (the module stays a leaf without imports); `head` is in I18N_RU like the reason. */
export const refusalLine = (head, e, tr) => `${tr(head)}: ${tr(refusalText(e).reason)}`;

export const errorLine = (head, e, tr) => (e?.status || e?.offline ? refusalLine(head, e, tr) : String(e?.message || tr(head)));
