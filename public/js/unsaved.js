
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

/** The fields of a sent edit a refusal is about: a PATCH is all or nothing, so the rest of the edit came back with them. The
    answer names the field; one that does not, on an edit that moves the status, is about the move. A move sent with a refused
    label goes with it: it was allowed by that label, and alone it would lock the card in a column nobody moved it to. Pure. */
export function refusedFields(e, sent) {
  if (!e?.status || canRetry(e)) return [];
  const named = e.body?.field;
  if (named) {
    if (!(named in sent)) return [];
    return named === 'labels' && 'status' in sent ? ['labels', 'status'] : [named];
  }
  return 'status' in sent ? ['status'] : [];
}

/* A refused title, description or priority stays in the form as typed — the card says it is not saved — but goes again only
   once it is changed: left differing from the snapshot, every resend and autosave took it with the rest, the server refused
   the whole PATCH again, and the resend called itself — two thousand requests in ten seconds while the card stayed open,
   and the rest of the edit never got there. Labels and status go back to the server's instead (takeBackRefused in
   drawer.js). Pure. */
export function createRefusedTyped() {
  const byKey = new Map(); // task key → { field: the value the server refused }
  return {
    keep(key, fields, sent) {
      const kept = byKey.get(key) || {};
      for (const f of fields) if (f !== 'labels' && f !== 'status' && f in sent) kept[f] = sent[f];
      if (Object.keys(kept).length) byKey.set(key, kept);
    },
    /** The edit without what the server refused and the form still holds unchanged; a field changed since goes again. */
    without(key, patch, form) {
      const kept = byKey.get(key);
      if (!kept) return patch;
      for (const f of Object.keys(kept)) {
        if (form[f] !== kept[f]) delete kept[f];
        else delete patch[f];
      }
      if (!Object.keys(kept).length) byKey.delete(key);
      return patch;
    },
    has: (key) => byKey.has(key),
  };
}

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
export function commentToken() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`; }

export function createUnsentComments() {
  let seq = 0;
  const byKey = new Map();
  return {
    /** → { id, body, again } — again: this text already waits for this task, nothing new is queued */
    add(key, body, token = commentToken()) {
      const list = byKey.get(key) || [];
      const same = list.find((c) => c.body === body);
      if (same) return { ...same, again: true };
      const c = { id: ++seq, body, token };
      byKey.set(key, [...list, c]);
      return { ...c, again: false };
    },
    list: (key) => (byKey.get(key) || []).map((c) => ({ ...c })),
    get: (key, id) => {
      const c = (byKey.get(key) || []).find((x) => x.id === id);
      return c ? { ...c } : null;
    },
    /** the key this text waits under: pressed again, it is that comment (undefined — it does not wait) */
    tokenOf: (key, body) => (byKey.get(key) || []).find((c) => c.body === body)?.token,
    /** the entry a comment of the server answers to, by the key it was written under */
    byToken: (key, token) => (byKey.get(key) || []).find((c) => c.token === token) ?? null,
    /** delivered, or taken back by the person */
    done(key, id) {
      const list = (byKey.get(key) || []).filter((c) => c.id !== id);
      if (list.length) byKey.set(key, list);
      else byKey.delete(key);
    },
    get size() { let n = 0; for (const l of byKey.values()) n += l.length; return n; },
  };
}

/** The keys of the sends with no answer yet, by task and text. A press past the hold, or a second press after a lost answer,
    is that same comment under that same key; an answer ends it, and the same words after it are a new comment. The server's
    event may beat the failure of the send it belongs to: `heard` remembers that, and `written` says the comment needs no
    queue, only its answer was lost. */
export function createCommentKeys() {
  const out = new Map();
  const at = (task, text) => `${task}\n${text}`;
  return {
    /** `waiting` — the key this text already waits under in the queue of resends */
    of(task, text, waiting) {
      const s = out.get(at(task, text)) ?? { token: waiting ?? commentToken(), heard: false };
      out.set(at(task, text), s);
      return s.token;
    },
    heard(token) { for (const s of out.values()) if (s.token === token) s.heard = true; },
    written: (task, text) => Boolean(out.get(at(task, text))?.heard),
    done(task, text) { out.delete(at(task, text)); },
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
// the Wi-Fi door no longer knows this device. The page does not reload over words typed (`setDoorClosed` in core.js), so
// the way to the door's form is said here
const DOOR_CLOSED = said('Not saved: this device no longer has the key of the board, it may have been changed. Copy what you typed, then reload the page and enter the key.',
  'this device no longer has the key of the board, it may have been changed — copy what you typed, then reload the page and enter the key');
const KNOWN = [
  [/^the project has no folder on this computer — set it in the project$/, 'the project has no folder on this computer'],
  [/^the file is no longer there$/, 'the file is no longer on this computer'],
  [/^the file is too large to show$/, 'the file is too large to show here'],
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
  [/^a guest starts Claude inside the board only$/, 'a guest starts Claude only inside the board'],
  [/^the project has no CLAUDE\.md of its own$/, 'the project has no CLAUDE.md of its own any more'],
  [/^the CLAUDE\.md of this project is within the norms/, 'the CLAUDE.md of this project is within the norms now — there is nothing to fix'],
  [/^tmux did not answer in time — try again$/, 'tmux did not answer in time — try again in a few seconds'],
  [/^tmux was updated while the board's terminals still run on the old one/, 'tmux was updated under the running terminals of the board — close them, the command is in Settings → Errors'],
  [/^unknown labels: /, 'this board has no such label'],
];
export function refusalText(e) {
  const status = e?.status;
  const msg = String(e?.message || '');
  if (e?.offline) return said('No connection to the board — try again', 'no connection to the board — try again');
  if (status === 401 && e?.body?.reason === 'share') return { ...DOOR_CLOSED };
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
  // a project that ships on the word: the text says what holds, and names no road out of work
  if (status === 409 && e?.body?.reason === 'ready-first') {
    if (e.body.field === 'labels') return said('Not saved: noclaude and check are not put on a task in work — this project ships on your word.', 'noclaude and check are not put on a task in work — this project ships on your word');
    return said('Not saved: the task goes to Ready to ship first — this project ships on your word.', 'the task goes to Ready to ship first — this project ships on your word', { refresh: true });
  }
  if (status === 403 && e?.body?.reason === 'guest') return said('Not saved: only the owner of the board can do this.', 'only the owner of the board can do this');
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
