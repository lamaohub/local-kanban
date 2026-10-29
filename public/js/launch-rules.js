/* Which tasks the board hands to Claude, and what it says when the server would not start Claude on one.
   A leaf without DOM, like order.js: test/launch-manual.test.js runs it in node. Its one import is a leaf too. */
import { CHECK_LABEL, leadCheck } from './review-rules.js';

export const EFFORT_LABELS = { low: 'Low — faster and cheaper', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max — slowest and dearest' };
export const EFFORTS = Object.keys(EFFORT_LABELS); // one list: a level cannot come without its words
export const effortOf = (v) => (EFFORTS.includes(v) ? v : undefined);
export const startEffort = (check, general, ofCheck) => (check && effortOf(ofCheck)) || effortOf(general);

/** A task the person does by hand: the noclaude label ("by hand" in the title sets it). */
export const isManual = (t) => Array.isArray(t?.labels) && t.labels.includes('noclaude');

const isCheck = (t) => Array.isArray(t?.labels) && t.labels.includes(CHECK_LABEL);
export function waitsForCheck(t, all) {
  if (!isCheck(t)) return false;
  const lead = leadCheck([t, ...all.filter((o) => o.project === t.project && o.id !== t.id)]);
  return Boolean(lead) && lead.id !== t.id;
}

export const forClaude = (tasks, all = tasks) => tasks.filter((t) => !isManual(t) && !waitsForCheck(t, all));

export const checksOnly = (keys = [], tasks = []) => keys.length > 0 && keys.every((k) => isCheck(tasks.find((t) => t.key === k)));

/** The server refused a start because tasks of it are done by hand (`reason: 'manual'`, their keys in `manual`).
    The tab did not know: the label came while its stream was down. What to say — English, the Russian is in
    I18N_RU — and whether to offer the rest: the board is read again, and ▶ then starts only what is left. */
export function manualRefusal(refused, asked = []) {
  const keys = Array.isArray(refused) ? refused : [];
  const rest = asked.some((k) => !keys.includes(k));
  return {
    head: 'Tasks done by hand (the noclaude label) are not started in Claude:',
    keys: keys.join(', '),
    tail: rest ? 'The board is up to date now — press ▶ again to start the rest.' : '',
  };
}

const LAUNCH_MODES = ['board', 'desktop', 'terminal', 'copy'];
/** The way ▶ starts Claude; `notBoard` — the board has just refused, the next way is asked for. */
export function launchPick(stored, avail = {}, notBoard = false) {
  if (LAUNCH_MODES.includes(stored) && !(notBoard && stored === 'board')) return stored;
  if (avail.board && !notBoard) return 'board';
  return avail.desktop ? 'desktop' : (avail.terminal && avail.cli ? 'terminal' : 'copy');
}
/** The refusal of the board is the last word only when "inside the board" was picked by hand. */
export const boardOnly = (stored) => stored === 'board';
/** What the setting shows in Settings: the picked way, else "inside the board" — or "automatically" on a computer
    where the board cannot start Claude itself, since ▶ goes elsewhere there. */
export const launchShown = (stored, avail = {}) => stored ?? (avail.board === false ? 'auto' : 'board');

export const KB_DEFAULT_PORT = '3100';
/** The prompt for a Claude that is not given KB_URL: `text`, plus a line with this board's address when its port is
    not kb's default. `tr` — the board's words (the line is English, the Russian is in I18N_RU). */
export function withBoardAddress(text, port, tr = (s) => s) {
  const p = String(port || '');
  if (!/^\d+$/.test(p) || p === KB_DEFAULT_PORT) return text;
  const url = `http://127.0.0.1:${p}`;
  return `${text}\n${tr('This board is at')} ${url}, ${tr('so run kb as')} KB_URL=${url} kb …`;
}
